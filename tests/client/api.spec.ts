import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCreateApi, clientCreateGateway, clientReadBaseUrl } from '../../client/api'
import { ClientError } from '../../contracts/client'
import type { AppBootstrap } from '../../contracts/control'

const bootstrap: AppBootstrap = {
  identity: { userId: 'user', displayName: 'Tester', hostAdmin: false },
  settings: { revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 4 } },
  metadata: { version: '056', promptKinds: ['verifyRoute'], executableKinds: ['verify'], scores: [0, 0.5, 1] },
}
const snapshot = { mapId: 'map', workspaceId: 'workspace', revision: 7, name: 'Map', nodes: [], edges: [], run: null, updatedAt: '' }
function success(data: unknown, requestId = 'response') { return Response.json({ ok: true, requestId, replayed: false, data }) }
const servers: Server[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolve()) })))
})
async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return 'http://127.0.0.1:' + address.port
}

describe('public Fetch client', () => {
  it('uses fixed API paths and preserves mutation identity, result and revision', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success(snapshot))
      .mockResolvedValueOnce(success({ snapshot, createdNodeIds: [], createdEdgeIds: [] }, 'request-1'))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320/', token: 'test-token', fetch: fetcher })
    expect(await client.read('map.get', { mapId: 'map' })).toEqual(snapshot)
    const result = await client.dispatch('request-1', 'graph.apply', { mapId: 'map', expectedRevision: 6, changes: { name: 'Renamed' } })
    expect(result.data.snapshot.revision).toBe(7)
    expect(fetcher.mock.calls.map(call => String(call[0]))).toEqual(['http://localhost:4320/api/v1/query', 'http://localhost:4320/api/v1/command'])
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer test-token' } })
    expect(JSON.parse(String(fetcher.mock.calls[1][1]!.body))).toMatchObject({ requestId: 'request-1', params: { expectedRevision: 6 } })
    client.close()
  })

  it('never rebases or retries a 409 and rejects missing or mismatched success results', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, requestId: 'request', error: { code: 'REVISION_CONFLICT', message: 'Changed', retryable: false, currentRevision: 9 } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ok: true, requestId: 'response', replayed: false }))
      .mockResolvedValueOnce(success({}))
      .mockResolvedValueOnce(success({ snapshot, createdNodeIds: [], createdEdgeIds: [] }, 'wrong-request'))
      .mockResolvedValueOnce(success({ ...snapshot, nodes: null }))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'test-token', fetch: fetcher })
    await expect(client.dispatch('request', 'graph.apply', { mapId: 'map', expectedRevision: 1, changes: { name: 'Name' } })).rejects.toMatchObject({ code: 'REVISION_CONFLICT', status: 409, retryable: false, currentRevision: 9 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.dispatch('request', 'graph.apply', { mapId: 'map', expectedRevision: 1, changes: { name: 'Name' } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('aborts pending requests on caller cancellation, timeout and close', async () => {
    const fetcher: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
    const api = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher, timeoutMs: 1000 })
    const stop = new AbortController()
    const cancelled = api.read('map.get', { mapId: 'map' }, stop.signal)
    stop.abort()
    await expect(cancelled).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    const pending = api.read('map.get', { mapId: 'map' })
    api.close()
    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    const timed = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher, timeoutMs: 10 })
    await expect(timed.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT', retryable: true })
  })

  it('rejects a minimized News DTO before it reaches the UI and accepts an explicit empty context', async () => {
    const broken = {
      id: 'news-1', revision: 0, createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
      data: { kind: 'news', content: 'Stored News with missing context' },
    }
    const valid = { ...broken, data: { ...broken.data, context: {} } }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ ...snapshot, nodes: [broken] }))
      .mockResolvedValueOnce(success({ ...snapshot, nodes: [valid] }))
      .mockResolvedValueOnce(success({ snapshot: { ...snapshot, nodes: [broken] }, createdNodeIds: [], createdEdgeIds: [] }, 'mutation'))
    const api = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(api.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ name: 'ClientError', code: 'INVALID_RESPONSE', message: expect.stringContaining('news.context') })
    expect((await api.read('map.get', { mapId: 'map' })).nodes[0]).toEqual(valid)
    await expect(api.dispatch('mutation', 'graph.apply', { mapId: 'map', expectedRevision: 7, changes: { name: 'Map' } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    api.close()
  })

  it('refuses redirects without requesting the redirect destination or sending its token there', async () => {
    let hits = 0
    const destination = await listen(createServer((_request, response) => { hits++; response.end('should not be reached') }))
    const origin = await listen(createServer((_request, response) => { response.writeHead(302, { location: destination + '/private' }); response.end() }))
    const api = clientCreateApi({ baseUrl: origin, token: 'private-client-token' })
    await expect(api.read('app.bootstrap', {})).rejects.toBeInstanceOf(ClientError)
    expect(hits).toBe(0)
    api.close()
  })

  it('rejects arbitrary endpoint URLs and oversized response bodies', async () => {
    for (const value of ['file:///private/data', 'http://user:pass@example.test', 'https://example.test/path', 'http://example.test?target=private']) expect(() => clientReadBaseUrl(value)).toThrow()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': String(17 * 1024 * 1024) } }))
    const api = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(api.read('app.bootstrap', {})).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })
})

describe('connection gateway', () => {
  it('keeps browser credentials in memory and drops the old session before any replacement attempt', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success(bootstrap))
      .mockResolvedValueOnce(Response.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'Invalid token', retryable: false } }, { status: 401 }))
    const gateway = clientCreateGateway({ baseUrl: 'http://localhost:4320', fetch: fetcher })
    expect(await gateway.getConnection()).toEqual({ baseUrl: 'http://localhost:4320', configured: false, remembered: false, canRemember: false })
    await gateway.connect({ baseUrl: 'http://localhost:4320', token: 'memory-token', remember: true })
    expect(await gateway.getConnection()).toMatchObject({ configured: true, remembered: false, canRemember: false })
    expect(JSON.stringify(await gateway.getConnection())).not.toContain('memory-token')
    await expect(gateway.connect({ baseUrl: 'http://localhost:5000', token: 'invalid', remember: false })).rejects.toMatchObject({ status: 401 })
    expect(await gateway.getConnection()).toMatchObject({ baseUrl: 'http://localhost:5000', configured: false, remembered: false })
    await expect(gateway.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'NOT_CONNECTED' })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('distinguishes normal app close from explicit credential forgetting', async () => {
    const store = { load: vi.fn(async () => null), save: vi.fn(async () => true), clear: vi.fn(async () => {}), canRemember: () => true }
    const gateway = clientCreateGateway({ baseUrl: 'http://localhost:4320', store, fetch: vi.fn<typeof fetch>().mockResolvedValue(success(bootstrap)) })
    await gateway.connect({ baseUrl: 'http://localhost:4320', token: 'stored-token', remember: true })
    expect(await gateway.getConnection()).toMatchObject({ remembered: true })
    expect(store.clear).toHaveBeenCalledTimes(1)
    gateway.close()
    expect(store.clear).toHaveBeenCalledTimes(1)
    await gateway.disconnect()
    expect(store.clear).toHaveBeenCalledTimes(2)
  })
})
