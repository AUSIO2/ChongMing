import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphWorkGrant } from '../../contracts/graph'
import { hostCreateWorker } from '../../backend/host'

afterEach(() => vi.restoreAllMocks())

describe('Host work lifecycle', () => {
  it('releases and polls again after transient work access errors without failing the Run', async () => {
    const hostId = randomUUID(), mapId = randomUUID(), runId = randomUUID()
    const methods: string[] = []
    let nextPoll!: () => void
    const polled = new Promise<void>(resolve => { nextPoll = resolve })
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const command = JSON.parse(Buffer.concat(chunks).toString())
      methods.push(command.method)
      response.setHeader('content-type', 'application/json')
      if (command.method === 'claim' && methods.length === 1) {
        const grant: GraphWorkGrant = {
          workId: 'route', mapId, runId, operationId: `${runId}:verify:claim`, actor: { role: 'router' },
          routeRevision: 0, hostId, holderId: command.params.holderId, fence: 1,
          leaseMs: 30_000, expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }
        response.end(JSON.stringify({ ok: true, data: grant }))
      } else if (command.method === 'release') {
        response.end(JSON.stringify({ ok: true, data: { released: true } }))
      } else {
        response.end(JSON.stringify({ ok: true, data: null }))
        nextPoll()
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    const runner = vi.fn(async () => { throw Object.assign(new Error('Data API temporarily unavailable'), { name: 'WorkAccessError' }) })
    const worker = hostCreateWorker({
      hostId, dataApiUrl: `http://127.0.0.1:${address.port}`, token: 'host-test-token',
      dshHome: '/unused-host-test', pollMs: 10_000,
    }, runner)
    try {
      await worker.start()
      await polled
      await worker.close()
      expect(runner).toHaveBeenCalledTimes(1)
      expect(methods).toEqual(['claim', 'release', 'claim'])
    } finally {
      await worker.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('aborts on lease loss and waits for DSH cleanup before releasing or completing close', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const hostId = randomUUID()
    const mapId = randomUUID()
    const runId = randomUUID()
    const events: string[] = []
    let claimed = false
    let started!: () => void
    let aborted!: () => void
    let finishCleanup!: () => void
    const start = new Promise<void>(resolve => { started = resolve })
    const abort = new Promise<void>(resolve => { aborted = resolve })
    const cleanup = new Promise<void>(resolve => { finishCleanup = resolve })
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const command = JSON.parse(Buffer.concat(chunks).toString())
      expect(request.headers.authorization).toBe('Bearer host-test-token')
      events.push(command.method)
      response.setHeader('content-type', 'application/json')
      if (command.method === 'claim') {
        const grant: GraphWorkGrant | null = claimed ? null : {
          workId: 'worker:1:angle-a', mapId, runId, operationId: `${runId}:verify:claim`,
          actor: { role: 'worker', slotId: 'angle-a' }, routeRevision: 1,
          hostId, holderId: command.params.holderId, fence: 1,
          leaseMs: 900, expiresAt: new Date(Date.now() + 900).toISOString(),
        }
        claimed = true
        response.end(JSON.stringify({ ok: true, data: grant }))
      } else if (command.method === 'renew') {
        response.statusCode = 409
        response.end(JSON.stringify({ ok: false, error: { code: 'LEASE_LOST', message: 'Lease was taken over' } }))
      } else {
        response.end(JSON.stringify({ ok: true, data: { released: true } }))
      }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Test server did not bind')
    const worker = hostCreateWorker({
      hostId, dataApiUrl: `http://127.0.0.1:${address.port}`, token: 'host-test-token',
      dshHome: '/unused-host-test', pollMs: 10_000, requestTimeoutMs: 1000,
    }, async input => {
      expect(input.grant.hostId).toBe(hostId)
      expect(input.grant.holderId).toMatch(/^[0-9a-f-]{36}$/)
      expect(input.env?.CHONGMING_HOST_ID).toBe(hostId)
      started()
      await new Promise<void>(resolve => {
        if (input.signal?.aborted) resolve()
        else input.signal!.addEventListener('abort', () => resolve(), { once: true })
      })
      events.push('runner.aborted')
      aborted()
      await cleanup
      events.push('runner.exited')
      throw input.signal!.reason
    })
    try {
      await worker.start()
      await start
      await abort
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
    } finally {
      finishCleanup()
      await worker.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
