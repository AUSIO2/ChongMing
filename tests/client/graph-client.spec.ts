// 公共 HTTP 客户端测试：覆盖响应校验、请求取消、固定端点及凭据生命周期。
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCreateApi, clientCreateGateway, clientReadBaseUrl } from '../../client/graph-client'
import { ClientError } from '../../contracts/client'
import type { AppBootstrap } from '../../contracts/control'

const bootstrap: AppBootstrap = {
  identity: { userId: 'user', displayName: 'Tester', hostAdmin: false },
  settings: { revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 4 } },
  metadata: { version: '056', promptKinds: ['verifyRoute'], executableKinds: ['verify'], scores: [0, 0.5, 1], variables: {}, outputs: [],
    definitions: { queryMethod: 'definition.get', publishMethod: 'definition.publish' } },
}
const snapshot = { mapId: 'map', workspaceId: 'workspace', revision: 7, ownershipRevision: 0, ownerships: [], runControls: [], name: 'Map', nodes: [], edges: [], runs: [], updatedAt: '' }
/**
 * 构造包含请求标识、重放标记和业务数据的成功 HTTP 响应。
 *
 * @param data 嵌入成功响应的测试业务数据，可故意缺失字段用于协议校验。
 * @param requestId 响应中的关联请求身份，默认 response；可指定错误身份验证匹配检查。
 */
function success(
  data: unknown,
  requestId = 'response'
) {
  return Response.json({ ok: true, requestId, replayed: false, data })
}
const servers: Server[] = []
afterEach(async () => {
  // 每个用例后恢复模拟并关闭已创建的测试服务器。
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map(server => /* 为每个测试服务器建立可等待的关闭操作。 */ new Promise<void>((
    resolve,
    reject
  ) => {
      // 先断开现有连接，再等待服务器停止监听。
      server.closeAllConnections(); server.close(error => /* 根据服务器关闭结果完成或拒绝清理 Promise。 */ error ? reject(error) : resolve())
  })))
})
/**
 * 在本机随机端口启动并登记测试服务，返回可请求的源地址。
 *
 * @param server 尚未监听的测试服务器，启动后登记给 afterEach 统一清理。
 */
async function listen(server: Server): Promise<string> {
  servers.push(server)
  await new Promise<void>(resolve => /* 开始监听临时端口，监听成功后结束等待。 */ server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test server did not bind')
  return 'http://127.0.0.1:' + address.port
}

describe('public Fetch client', () => {
  // 验证公开 Fetch 客户端的协议校验、取消、路径和认证边界。
  it('requires the new Run scope and control state and carries both control commands', async () => {
    // 验证 Run 控制字段必须齐全，且暂停与恢复命令返回对应状态。
    const run = { id: 'run', scope: { nodeIds: ['node'] }, plan: { steps: [] },
      definitions: { revision: 1, packages: [], index: [], dataTypes: [], transitions: [] }, agents: [], tools: [], maxAgentSlots: 4,
      paused: true, regenerate: false, status: 'waiting', mode: 'human-in-loop', steps: [], operations: [], createdAt: '', updatedAt: '' }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ ...snapshot, runs: [{ ...run, paused: undefined }] }))
      .mockResolvedValueOnce(success({ ...snapshot, runs: [{ ...run, operations: undefined, operation: {} }] }))
      .mockResolvedValueOnce(success({ snapshot: { ...snapshot, runs: [run] }, createdNodeIds: [], createdEdgeIds: [] }, 'pause'))
      .mockResolvedValueOnce(success({ snapshot: { ...snapshot, runs: [{ ...run, paused: false }] }, createdNodeIds: [], createdEdgeIds: [] }, 'resume'))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    const params = { mapId: 'map', runId: 'run', control: { leaseId: '11111111-1111-4111-8111-111111111111',
      holderId: '22222222-2222-4222-8222-222222222222', fence: 1 } }
    expect((await client.dispatch('pause', 'run.pause', params)).data.snapshot.runs[0]?.paused).toBe(true)
    expect((await client.dispatch('resume', 'run.resume', params)).data.snapshot.runs[0]?.paused).toBe(false)
    client.close()
  })

  it('uses fixed API paths and preserves mutation identity, result and revision', async () => {
    // 验证查询和命令使用固定端点，并保留请求身份、分支版本与返回结果。
    const branch = { scope: { rootIds: ['node'], nodeIds: ['node'], edgeIds: [] }, version: 'branch-version-1', rootRevisions: { node: 0 }, mapRevision: 7 }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success(snapshot))
      .mockResolvedValueOnce(success(branch))
      .mockResolvedValueOnce(success({ snapshot, createdNodeIds: [], createdEdgeIds: [] }, 'request-1'))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320/', token: 'test-token', fetch: fetcher })
    expect(await client.read('map.get', { mapId: 'map' })).toEqual(snapshot)
    expect(await client.read('branch.get', { mapId: 'map', rootIds: ['node'] })).toEqual(branch)
    const result = await client.dispatch('request-1', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: branch.version }, changes: { name: 'Renamed' } })
    expect(result.data.snapshot.revision).toBe(7)
    expect(fetcher.mock.calls.map(call =>
      /* 提取 Fetch 调用 URL，供路径断言。 */
      String(call[0]))).toEqual(['http://localhost:4320/api/v1/query', 'http://localhost:4320/api/v1/query', 'http://localhost:4320/api/v1/command'])
    for (const [, init] of fetcher.mock.calls) expect(init).toMatchObject({ redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer test-token' } })
    expect(JSON.parse(String(fetcher.mock.calls[2][1]!.body))).toMatchObject({ requestId: 'request-1', params: { branch: { rootIds: ['node'], expectedVersion: 'branch-version-1' } } })
    client.close()
  })

  it('rejects incomplete branch snapshots before exposing an edit proof', async () => {
    const valid = { scope: { rootIds: ['node'], nodeIds: ['node'], edgeIds: [] }, version: 'branch-version', rootRevisions: { node: 0 }, mapRevision: 7 }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ ...valid, version: '' }))
      .mockResolvedValueOnce(success({ ...valid, scope: { ...valid.scope, rootIds: [] } }))
      .mockResolvedValueOnce(success(valid))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(client.read('branch.get', { mapId: 'map', rootIds: ['node'] })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.read('branch.get', { mapId: 'map', rootIds: ['node'] })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.read('branch.get', { mapId: 'map', rootIds: ['node'] })).resolves.toEqual(valid)
    client.close()
  })

  it('rejects a write response that combines a current snapshot with an older committed branch proof', async () => {
    const branch = { scope: { rootIds: ['node'], nodeIds: ['node'], edgeIds: [] }, version: 'old', rootRevisions: { node: 0 }, mapRevision: 6 }
    const current = { ...snapshot, nodes: [{ id: 'node', revision: 0, typeId: 'demo.node', typeVersion: 1, payload: {}, createdAt: '', updatedAt: '' }] }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success({ snapshot: current, createdNodeIds: [], createdEdgeIds: [], branch }, 'request'))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(client.dispatch('request', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: 'base' },
      changes: { name: 'Name' } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    client.close()
  })

  it('never rebases or retries a 409 and rejects missing or mismatched success results', async () => {
    // 验证 409 不会自动重试或改写版本，缺失或错配的成功响应会被拒绝。
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ ok: false, requestId: 'request', error: { code: 'BRANCH_VERSION_CONFLICT', message: 'Changed', retryable: false } }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ ok: true, requestId: 'response', replayed: false }))
      .mockResolvedValueOnce(success({}))
      .mockResolvedValueOnce(success({ snapshot, createdNodeIds: [], createdEdgeIds: [] }, 'wrong-request'))
      .mockResolvedValueOnce(success({ ...snapshot, nodes: null }))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'test-token', fetch: fetcher })
    await expect(client.dispatch('request', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: 'old' }, changes: { name: 'Name' } })).rejects.toMatchObject({ code: 'BRANCH_VERSION_CONFLICT', status: 409, retryable: false })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.dispatch('request', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: 'old' }, changes: { name: 'Name' } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('aborts pending requests on caller cancellation, timeout and close', async () => {
    /**
     * 验证调用者取消、客户端关闭和超时分别中断请求并报告对应错误。
     *
     * @param _url 模拟 Fetch 收到的地址；本用例只验证生命周期，不读取它。
     * @param init 模拟 Fetch 收到的请求选项，含需要监听的 AbortSignal。
     */
    const fetcher: typeof fetch = (
      _url,
      init
    ) => /* 返回等待取消的网络 Promise，模拟未完成请求。 */ new Promise((
      _resolve,
      reject
    ) => {
      // 安装取消监听，使网络请求可由客户端生命周期结束。
      init!.signal!.addEventListener('abort', () => /* 收到取消信号时拒绝模拟请求。 */ reject(new Error('aborted')), { once: true })
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

  it('rejects an incomplete generic node envelope and accepts arbitrary JSON payload fields', async () => {
    // 客户端只验证通用信封；业务 payload 的精确 schema 由服务端注册定义保证。
    const broken = {
      id: 'node-1', revision: 0, typeId: 'demo.note', createdAt: '2026-09-11T00:00:00.000Z', updatedAt: '2026-09-11T00:00:00.000Z',
      payload: { anyRegisteredField: 'value' },
    }
    const valid = { ...broken, typeVersion: 3 }
    const definitions = { workspaceId: 'workspace', catalog: { revision: 2, packages: [], index: [], dataTypes: [], transitions: [] } }
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(success({ ...snapshot, nodes: [broken] }))
      .mockResolvedValueOnce(success({ ...snapshot, nodes: [valid] }))
      .mockResolvedValueOnce(success(definitions))
      .mockResolvedValueOnce(success({ snapshot: { ...snapshot, nodes: [broken] }, createdNodeIds: [], createdEdgeIds: [] }, 'mutation'))
    const api = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(api.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ name: 'ClientError', code: 'INVALID_RESPONSE' })
    expect((await api.read('map.get', { mapId: 'map' })).nodes[0]).toEqual(valid)
    expect(await api.read('definition.get', { workspaceId: 'workspace' })).toEqual(definitions)
    await expect(api.dispatch('mutation', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: 'version' }, changes: { name: 'Map' } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    api.close()
  })

  it('refuses redirects without requesting the redirect destination or sending its token there', async () => {
    // 验证重定向被拒绝，目标服务没有收到请求或令牌。
    let hits = 0
    const destination = await listen(createServer((
      _request,
      response
    ) => {
      // 统计重定向目标是否意外被访问。
      hits++; response.end('should not be reached')
    }))
    const origin = await listen(createServer((_request, response) => {
      // 返回跨服务重定向，检验客户端禁止跟随跳转。
      response.writeHead(302, { location: destination + '/private' }); response.end()
    }))
    const api = clientCreateApi({ baseUrl: origin, token: 'private-client-token' })
    await expect(api.read('app.bootstrap', {})).rejects.toBeInstanceOf(ClientError)
    expect(hits).toBe(0)
    api.close()
  })

  it('rejects arbitrary endpoint URLs and oversized response bodies', async () => {
    // 验证带凭据、路径或查询的源地址以及超大 JSON 响应被拒绝。
    for (const value of ['file:///private/data', 'http://user:pass@example.test', 'https://example.test/path', 'http://example.test?target=private']) expect(() =>
      /* 执行指定地址的规范化，供抛错断言。 */
      clientReadBaseUrl(value)).toThrow()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { headers: { 'content-length': String(17 * 1024 * 1024) } }))
    const api = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(api.read('app.bootstrap', {})).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })
})

describe('connection gateway', () => {
  // 验证网关连接替换、凭据记忆和显式退出的生命周期。
  it('keeps browser credentials in memory and drops the old session before any replacement attempt', async () => {
    // 验证浏览器凭据只留内存，替换登录失败也不会恢复旧会话。
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
    // 验证普通关闭保留已保存凭据，显式断开才清除它们。
    const store = { load: vi.fn(async () =>
      /* 模拟凭据存储中没有可恢复的连接。 */
      null), save: vi.fn(async () =>
      /* 模拟凭据成功保存并可在以后恢复。 */
      true), clear: vi.fn(async () => {
      // 记录凭据清除调用，不需要真实持久化。
    }), canRemember: () => /* 声明测试凭据存储支持记住登录。 */ true }
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
