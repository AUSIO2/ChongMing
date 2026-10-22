// 复现Host真实未知HTTP授权准入；队列与runner只使用已存在的注入接口，无数据库/broker/模型。
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import workerModule from '../../backend/execution/host-worker.ts'
import type { WorkTransport, WorkChannel } from '../../backend/ports/messaging.ts'
import type { GraphWorkGrant } from '../../contracts/graph-work.ts'
import type { DshWorkInput } from '../../backend/execution/dsh/work-executor.ts'

const { hostCreateWorker } = workerModule
const results: unknown[] = []
for (const field of ['runId', 'operationId', 'stageId', 'slotId', 'specHash'] as const) {
  const namespace = 'audit', deploymentId = randomUUID(), mapId = randomUUID(), workId = 'audit-work', hostId = 'audit-host'
  const stop = new AbortController()
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  let executed!: (value: DshWorkInput) => void
  const received = new Promise<DshWorkInput>(resolve => { executed = resolve })
  const link: WorkChannel = {
    signal: stop.signal, closed,
    async consumeWork(handler, lifetime) {
      await handler({ version: 1, deploymentId, mapId, workId }, stop.signal)
      if (!lifetime?.aborted) await new Promise<void>(resolve => lifetime?.addEventListener('abort', () => resolve(), { once: true }))
    },
    async close() { stop.abort(); resolveClosed() },
  }
  const queue: WorkTransport = { namespace, open: async () => link }
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/internal/v1/messaging') {
      response.end(JSON.stringify({ ok: true, data: { version: 1, enabled: true, deploymentId, namespace: `${namespace}.${deploymentId}` } }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const grant = { mapId, workId, hostId, holderId: command.params.holderId, runId: 'run', operationId: 'operation',
      stageId: 'stage', slotId: 'slot', specHash: 'spec', fence: 1, leaseMs: 30_000, expiresAt: '2099-01-01T00:00:00.000Z', [field]: 17 }
    response.end(JSON.stringify({ ok: true, data: command.method === 'claim' ? { status: 'claimed', grant } : { released: true } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Owned grant audit listener missing')
  const worker = hostCreateWorker({ hostId, queue, token: 'audit-only', dataApiUrl: `http://127.0.0.1:${address.port}`, dshHome: '/unused-audit-home' },
    async input => {
      executed(input)
      return { workId, mapId, runId: input.grant.runId, operationId: input.grant.operationId, sessionId: null, status: 'accepted', finalResponse: '' }
    })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await worker.start()
    const input = await Promise.race([received, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Invalid grant did not reach runner')), 2000) })])
    results.push({ field, returnedType: 'number', enteredRunner: true, runnerValue: input.grant[field] })
  } finally {
    clearTimeout(timer)
    await worker.close()
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}
console.log(JSON.stringify({ case: 'host-initial-grant-string-fields', method: 'real Host + owned HTTP responses + existing WorkTransport/runner seams; no broker or model', results }, null, 2))
