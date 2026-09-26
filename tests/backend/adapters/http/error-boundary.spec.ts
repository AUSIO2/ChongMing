import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DiagnosticEvent, DiagnosticReporter } from '../../../../contracts/diagnostics'
import { createGraphApi, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
const events: Array<DiagnosticEvent & { errorId: string }> = []
const reporter: DiagnosticReporter = {
  report(event) { const errorId = event.errorId ?? crypto.randomUUID(); events.push({ ...event, errorId }); return errorId },
  async close() {},
}
beforeAll(async () => { api = await createGraphApi(60_000, undefined, reporter) }, 90_000)
afterAll(async () => { await api?.close() }, 30_000)

describe('public request error boundary', () => {
  it('returns a safe error id while retaining the original failure only inside the reporter', async () => {
    const secret = 'secret-request-body-and-local-path'
    vi.spyOn(api.application, 'read').mockRejectedValueOnce(new Error(secret))
    const result = await api.post('/api/v1/query', { method: 'workspace.list', params: {} })
    expect(result).toMatchObject({ status: 500, body: { ok: false, error: {
      code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: true, errorId: expect.any(String),
    } } })
    expect(JSON.stringify(result.body)).not.toContain(secret)
    expect(events[events.length - 1]).toMatchObject({ name: 'request.failed', severity: 'error', errorId: result.body.error.errorId,
      context: { route: '/api/v1/query' }, error: expect.objectContaining({ message: secret }) })
    expect(await api.post('/api/v1/query', { method: 'workspace.list', params: {} })).toMatchObject({ status: 200 })
  })

  it('marks readiness false and rejects new public writes once controlled shutdown begins', async () => {
    api.server.beginShutdown()
    const health = await fetch(api.url + '/health')
    expect(health.status).toBe(503)
    expect(await health.json()).toEqual({ ok: true, ready: false })
    const stopped = await api.post('/api/v1/command', {})
    expect(stopped).toMatchObject({ status: 503, body: { error: { code: 'SERVICE_STOPPING', errorId: expect.any(String) } } })
  })
})
