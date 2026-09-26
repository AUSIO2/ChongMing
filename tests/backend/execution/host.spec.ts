import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphWorkGrant } from '../../../contracts/graph'
import type { DshWorkInput } from '../../../backend/execution/dsh/work-executor'
import { hostCreateWorker } from '../../../backend/execution/host-worker'
import { queueOpen, queueCreateTransport } from '../../../backend/adapters/messaging/rabbitmq'
import { rabbitCreateFixture } from '../fixtures/rabbitmq'

afterEach(() => vi.restoreAllMocks())

async function hostCreateFixture(handler: (method: string, params: Record<string, string>) => { status?: number; data?: unknown; error?: unknown }, proxy = false) {
  const broker = await rabbitCreateFixture()
  const deploymentId = randomUUID(), mapId = randomUUID(), runId = randomUUID(), hostId = randomUUID()
  const queue = broker.queue
  const link = await queueOpen({ ...queue, namespace: queue.namespace + '.' + deploymentId })
  const sockets = new Set<Socket>()
  const address = new URL(queue.url)
  const brokerPort = Number(address.port || 5672), brokerHost = address.hostname
  const tunnel = proxy ? createTcpServer(socket => {
    const upstream = connect(brokerPort, brokerHost)
    sockets.add(socket); sockets.add(upstream)
    for (const current of [socket, upstream]) {
      current.on('error', () => { socket.destroy(); upstream.destroy() })
      current.on('close', () => { sockets.delete(current); socket.destroy(); upstream.destroy() })
    }
    socket.pipe(upstream); upstream.pipe(socket)
  }) : undefined
  if (tunnel) {
    await new Promise<void>(resolve => tunnel.listen(0, '127.0.0.1', resolve))
    const binding = tunnel.address()
    if (!binding || typeof binding === 'string') throw new Error('AMQP test tunnel did not bind')
    address.hostname = '127.0.0.1'; address.port = String(binding.port)
  }
  const workId = 'route'
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/internal/v1/messaging') {
      response.end(JSON.stringify({ ok: true, data: { version: 1, deploymentId, namespace: queue.namespace + '.' + deploymentId, enabled: true } }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const command = JSON.parse(Buffer.concat(chunks).toString())
    const result = handler(command.method, command.params)
    response.statusCode = result.status ?? 200
    response.end(JSON.stringify({ ok: !result.error, ...result }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const binding = server.address()
  if (!binding || typeof binding === 'string') throw new Error('Test server did not bind')
  return {
    input: { hostId, dataApiUrl: `http://127.0.0.1:${binding.port}`, token: 'host-test-token', dshHome: '/unused-host-test', queue: queueCreateTransport({ ...queue, url: address.toString() }) },
    disconnect: () => { for (const socket of sockets) socket.destroy() },
    grant(holderId: string, leaseMs = 30_000): GraphWorkGrant {
      return { workId, mapId, runId, operationId: `${runId}:verify:claim`, actor: { role: 'router' }, routeRevision: 0,
        hostId, holderId, fence: 1, leaseMs, expiresAt: new Date(Date.now() + leaseMs).toISOString() }
    },
    publish: () => link.publishWork({ version: 1, deploymentId, mapId, workId }),
    async close() {
      await link.close()
      for (const socket of sockets) socket.destroy()
      if (tunnel) await new Promise<void>((resolve, reject) => tunnel.close(error => error ? reject(error) : resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await broker.deleteNamespace(queue.namespace + '.' + deploymentId)
      await broker.close()
    },
  }
}

describe('Host work lifecycle through RabbitMQ', () => {
  it('releases and retries a delivery after transient work access errors without failing the Run', async () => {
    const methods: string[] = []
    const fixture = await hostCreateFixture((method, params) => {
      methods.push(method)
      if (method === 'claim') return { data: methods.length === 1
        ? { status: 'claimed', grant: fixture.grant(params.holderId) } : { status: 'obsolete' } }
      return { data: { released: true } }
    })
    const runner = vi.fn(async () => { throw Object.assign(new Error('Data API temporarily unavailable'), { name: 'WorkAccessError' }) })
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => expect(methods).toEqual(['claim', 'release', 'claim']), { timeout: 5000 })
      await worker.close()
      expect(runner).toHaveBeenCalledTimes(1)
    } finally { await worker.close(); await fixture.close() }
  })

  it('aborts on lease loss and waits for DSH cleanup before releasing or completing close', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: string[] = []
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    const fixture = await hostCreateFixture((method, params) => {
      events.push(method)
      if (method === 'claim') return { data: { status: 'claimed', grant: fixture.grant(params.holderId, 900) } }
      if (method === 'renew') return { status: 409, error: { code: 'LEASE_LOST', message: 'Lease was taken over' } }
      return { data: { released: true } }
    })
    const worker = hostCreateWorker({ ...fixture.input, requestTimeoutMs: 1000 }, async input => {
      expect(input.grant.hostId).toBe(fixture.input.hostId)
      expect(input.grant.holderId).toMatch(/^[0-9a-f-]{36}$/)
      expect(input.env?.CHONGMING_HOST_ID).toBe(fixture.input.hostId)
      await new Promise<void>(resolve => {
        if (input.signal!.aborted) resolve()
        else input.signal!.addEventListener('abort', () => resolve(), { once: true })
      })
      events.push('runner.aborted')
      await cleanup
      events.push('runner.exited')
      throw input.signal!.reason
    })
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => expect(events).toContain('runner.aborted'))
      expect(events).toContain('renew')
      expect(events).not.toContain('release')
      const closing = worker.close()
      expect(worker.close()).toBe(closing)
      let closed = false
      const observedClose = closing.then(() => { closed = true })
      await new Promise<void>(resolve => setImmediate(resolve))
      expect(closed).toBe(false)
      expect(events).not.toContain('release')
      finishCleanup()
      await observedClose
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('runner.exited'))
      expect(events.filter(event => event === 'claim')).toHaveLength(1)
      expect(events).not.toContain('fail')
    } finally { finishCleanup(); await worker.close(); await fixture.close() }
  })

  it('retains a busy delivery until its lease expires and ignores already accepted duplicates', async () => {
    const claims: number[] = []
    let accepted = false
    const fixture = await hostCreateFixture((method, params) => {
      if (method !== 'claim') return { data: { released: true } }
      claims.push(performance.now())
      if (claims.length === 1) return { data: { status: 'busy', retryAfterMs: 200 } }
      return { data: accepted ? { status: 'obsolete' } : { status: 'claimed', grant: fixture.grant(params.holderId) } }
    })
    const runner = vi.fn(async (input: DshWorkInput) => {
      accepted = true
      return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
    })
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1), { timeout: 3000 })
      expect(claims[1] - claims[0]).toBeGreaterThanOrEqual(190)
      await fixture.publish()
      await vi.waitFor(() => expect(claims).toHaveLength(3))
      await delay(50)
      expect(runner).toHaveBeenCalledTimes(1)
    } finally { await worker.close(); await fixture.close() }
  })

  it('rejects a different API namespace before consuming work', async () => {
    const fixture = await hostCreateFixture(() => { throw new Error('Unexpected claim') })
    const worker = hostCreateWorker({ ...fixture.input, queue: { ...fixture.input.queue, namespace: 'another-' + randomUUID() } })
    try { await expect(worker.start()).rejects.toThrow('does not match') }
    finally { await worker.close(); await fixture.close() }
  })

  it('terminates on an invalid work protocol response instead of retrying forever', async () => {
    let claims = 0
    const fixture = await hostCreateFixture(method => {
      if (method === 'claim') { claims++; return { data: { status: 'unexpected' } } }
      return { data: { released: true } }
    })
    const runner = vi.fn()
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start(); await fixture.publish()
      await expect(worker.finished()).resolves.toMatchObject({ name: 'HostProtocolError' })
      expect(claims).toBe(1)
      expect(runner).not.toHaveBeenCalled()
    } finally { await worker.close(); await fixture.close() }
  })

  it('aborts a disconnected delivery and drains DSH before reconnecting and accepting redelivery', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const events: string[] = []
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    const fixture = await hostCreateFixture((method, params) => {
      events.push(method)
      return { data: method === 'claim' ? { status: 'claimed', grant: fixture.grant(params.holderId) } : { released: true } }
    }, true)
    let executions = 0
    const runner = vi.fn(async (input: DshWorkInput) => {
      if (++executions > 1) {
        events.push('runner.replacement')
        return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
      }
      await new Promise<void>(resolve => input.signal!.addEventListener('abort', () => resolve(), { once: true }))
      events.push('runner.aborted')
      await cleanup
      events.push('runner.exited')
      throw input.signal!.reason
    })
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1))
      fixture.disconnect()
      await vi.waitFor(() => expect(events).toContain('runner.aborted'))
      await delay(300)
      expect(events.filter(event => event === 'claim')).toHaveLength(1)
      expect(events).not.toContain('release')
      finishCleanup()
      await vi.waitFor(() => expect(events).toContain('runner.replacement'), { timeout: 5000 })
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('runner.exited'))
      expect(events.indexOf('runner.replacement')).toBeGreaterThan(events.indexOf('release'))
      expect(events).not.toContain('fail')
    } finally { finishCleanup(); await worker.close(); await fixture.close() }
  })
})
