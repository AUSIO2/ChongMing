// 公共 HTTP 客户端测试：覆盖响应校验、请求取消、固定端点及凭据生命周期。
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_COMMAND_METHODS, CLIENT_QUERY_METHODS, clientCreateApi, clientCreateGateway, clientReadBaseUrl } from '../../client/graph-client'
import { ClientError } from '../../contracts/client'
import type { AppBootstrap } from '../../contracts/control'
import { readerReadSourceNotes } from '../../apps/ui/features/reader/reader-sources'
import { LIBRARY_TEST_PACKAGE, libraryTestCatalog } from '../backend/fixtures/library-claims'

const bootstrap: AppBootstrap = {
  identity: { userId: 'user', displayName: 'Tester', hostAdmin: false },
  settings: { revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 4 } },
  metadata: { variables: {} },
}
const snapshot = { mapId: 'map', workspaceId: 'workspace', revision: 7, ownershipRevision: 0, ownerships: [], runControls: [], name: 'Map', nodes: [], edges: [], runs: [], updatedAt: '2026-10-20T00:00:00.000Z' }
const runPage = { mapId: 'map', directoryVersion: 'directory-v1', nextCursor: null, items: [
  { runId: 'current-run', status: 'waiting', archived: false, mode: 'human-in-loop', paused: true,
    createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:01:00.000Z',
    stepCount: 2, operationCount: 1, pendingReviewCount: 1, outputCount: 0 },
  { runId: 'archived-run', status: 'completed', archived: true, mode: 'auto', paused: false,
    createdAt: '2026-10-19T01:00:00.000Z', updatedAt: '2026-10-19T01:01:00.000Z',
    stepCount: 1, operationCount: 1, pendingReviewCount: 0, outputCount: 4 },
] }
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
const publicationPreviewParams = { mapId: 'map', runId: 'run', operationId: 'operation', reviewId: 'review', expectedReviewRevision: 1 }
const publicationPreview = {
  mapId: 'map', runId: 'run', operationId: 'operation', reviewId: 'review', reviewRevision: 1,
  specHash: 'frozen-specification', publicationVersion: 'publication-version',
  ports: [
    { port: 'opinions', typeRef: { id: 'factcheck.opinion', version: 1 }, count: 1 },
    { port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 }, count: 1 },
  ],
  items: [
    { workId: 'research', key: 'opinion', stageId: 'research', slotId: 'research-slot', port: 'opinions',
      typeRef: { id: 'factcheck.opinion', version: 1 }, directlySelected: false, referencedBy: [{ workId: 'result', key: 'verdict' }] },
    { workId: 'result', key: 'verdict', stageId: 'result', slotId: 'result-slot', port: 'verification',
      typeRef: { id: 'factcheck.verification', version: 1 }, directlySelected: true, referencedBy: [] },
  ],
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
  it.each([new Uint8Array([0xff]), new Uint8Array([0xe4, 0xb8])])('rejects malformed UTF-8 as a permanent response error', async (/* 无效字节或流末尾未完成的UTF-8序列。 */ bytes) => {
    // 解码错误属于响应格式，不能当作可重试网络故障。
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(bytes)) })
    try { await expect(client.read('app.bootstrap', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false }) }
    finally { client.close() }
  })

  it('preserves the JSON response limit when cancelling its body also fails', async () => {
    // 超限已确定后，取消流的次生错误不改变公开错误码。
    const response = new Response(new ReadableStream({
      start(/* 响应流写入端。 */ controller) { controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1)) },
      cancel() { throw new Error('cleanup failed') },
    }))
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(response) })
    try {
      await expect(client.read('app.bootstrap', {})).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE', retryable: false })
      expect(response.body?.locked).toBe(false)
    } finally { client.close() }
  })

  it('stops a malformed UTF-8 stream and preserves its error when cancellation fails', async () => {
    // 首个无效字节即可终止响应，不等待未结束的服务端流。
    const cancel = vi.fn(() => { throw new Error('cleanup failed') })
    const response = new Response(new ReadableStream({
      start(/* 响应流写入端。 */ controller) { controller.enqueue(new Uint8Array([0xff])) }, cancel,
    }))
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(response) })
    try {
      await expect(client.read('app.bootstrap', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false })
      expect(cancel).toHaveBeenCalledOnce()
      expect(response.body?.locked).toBe(false)
    } finally { client.close() }
  })

  it.each([
    { method: 'app.bootstrap' as const, data: { ...bootstrap, settings: null } },
    { method: 'app.bootstrap' as const, data: { ...bootstrap, metadata: [] } },
    { method: 'agent.list' as const, data: { scope: [], revision: 0, items: [] } },
    { method: 'agent.list' as const, data: { scope: { kind: 'library' }, revision: 0, items: {} } },
    { method: 'asset.list' as const, data: { items: {}, nextCursor: null } },
    { method: 'workspace.list' as const, data: { items: {}, nextCursor: null } },
  ])('keeps required response boundaries for $method', async (/* 各方法中必须在唯一校验点拒绝的畸形字段。 */ { method, data }) => {
    // 删除通用重复检查后，实际方法仍拒绝损坏的对象与列表。
    const client = clientCreateApi({ baseUrl: 'https://fixture.example', token: 'token',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success(data)) })
    try {
      let pending: Promise<unknown>
      if (method === 'agent.list') pending = client.read(method, { scope: { kind: 'library' } })
      else if (method === 'asset.list') pending = client.read(method, { workspaceId: 'workspace' })
      else pending = client.read(method, {})
      await expect(pending).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    }
    finally { client.close() }
  })

  it.each([
    { kind: 'editor', expiresAt: null, leaseMs: 1000 },
    { kind: 'editor', expiresAt: 'invalid date', leaseMs: 1000 },
    { kind: 'run', expiresAt: '2026-10-19T00:00:00.000Z', leaseMs: null },
  ])('rejects ownership with inconsistent $kind lease fields', async (
    /* 与占有类型不一致的期限或时长字段。 */ lease,
  ) => {
    // 编辑占有必须有真实期限，Run 占有必须明确无期限，不由界面补默认值。
    const ownership = { leaseId: 'lease', rootIds: ['node'], ownerUserId: 'user', holderId: 'holder', fence: 1,
      scope: { rootIds: ['node'], nodeIds: ['node'], edgeIds: [] }, ...lease }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success({ ...snapshot, ownerships: [ownership] })) })
    try { await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it.each([{ validity: ['current'] }, { validity: ['stale'] }])('rejects coerced node validity $validity', async (
    /* 字符串化后看似合法、实际不符合节点状态协议的数组。 */ { validity },
  ) => {
    // 状态必须保持字符串原型，不能通过隐式转换绕过边界检查。
    const node = { id: 'node', revision: 0, typeId: 'demo.node', typeVersion: 1, payload: {},
      createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', validity }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success({ ...snapshot, nodes: [node] })) })
    try { await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it.each([
    { label: 'legacy node', metadata: {} },
    { label: 'manual creation', metadata: { manualOrigin: { userId: 'creator' } } },
  ])('preserves $label provenance', async (/* 旧节点或服务端记录的人工创建身份。 */ { metadata }) => {
    // 可选创建来源不改变旧节点兼容行为，也不能在客户端凭空补默认值。
    const node = { id: 'node', revision: 0, typeId: 'demo.node', typeVersion: 1, payload: {},
      createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', ...metadata }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success({ ...snapshot, nodes: [node] })) })
    try { expect((await client.read('map.get', { mapId: 'map' })).nodes).toEqual([node]) } finally { client.close() }
  })

  it.each([null, [], 'manual', {}, { userId: 1 }, { userId: '' }, { userId: ' ' }])(
    'rejects malformed manual creation provenance %#', async (/* 不能解释为真实创建用户的响应字段。 */ manualOrigin) => {
      // 畸形人工来源须在公开客户端边界被拒绝，避免界面错误归属。
      const node = { id: 'node', revision: 0, typeId: 'demo.node', typeVersion: 1, payload: {},
        createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z', manualOrigin }
      const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
        fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success({ ...snapshot, nodes: [node] })) })
      try { await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) } finally { client.close() }
    },
  )

  it.each([
    { label: 'legacy metadata without capabilities', metadata: { variables: {} } },
    { label: 'capabilities without evidenceLibrary', metadata: { variables: {}, capabilities: {} } },
    { label: 'enabled evidence library', metadata: { variables: {}, capabilities: { evidenceLibrary: true } } },
    { label: 'disabled evidence library', metadata: { variables: {}, capabilities: { evidenceLibrary: false } } },
    { label: 'enabled map rename', metadata: { variables: {}, capabilities: { mapRename: true } } },
    { label: 'disabled map rename', metadata: { variables: {}, capabilities: { mapRename: false } } },
    { label: 'enabled publication preview', metadata: { variables: {}, capabilities: { publicationPreview: true } } },
    { label: 'disabled publication preview', metadata: { variables: {}, capabilities: { publicationPreview: false } } },
    { label: 'enabled run history', metadata: { variables: {}, capabilities: { runHistory: true } } },
    { label: 'disabled run history', metadata: { variables: {}, capabilities: { runHistory: false } } },
    { label: 'enabled library definitions', metadata: { variables: {}, capabilities: { libraryDefinitions: true } } },
    { label: 'disabled library definitions', metadata: { variables: {}, capabilities: { libraryDefinitions: false } } },
    { label: 'unknown future capability keys', metadata: { variables: {}, capabilities: { evidenceLibrary: true, futureFeature: { mode: 'future' } } } },
  ])('accepts bootstrap $label', async (/* 当前兼容或明确声明能力的真实 JSON 响应元数据。 */ { metadata }) => {
    // HTTP 成功信封中的可选能力保持原值，旧服务及未来未知能力键都可连接。
    const data = { ...bootstrap, metadata }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success(data)) })
    try {
      expect(await client.read('app.bootstrap', {})).toEqual(data)
    } finally { client.close() }
  })

  it.each([
    { label: 'null capabilities', capabilities: null },
    { label: 'array capabilities', capabilities: [] },
    { label: 'string capabilities', capabilities: 'enabled' },
    { label: 'null evidenceLibrary', capabilities: { evidenceLibrary: null } },
    { label: 'number evidenceLibrary', capabilities: { evidenceLibrary: 1 } },
    { label: 'string evidenceLibrary', capabilities: { evidenceLibrary: 'true' } },
    { label: 'array evidenceLibrary', capabilities: { evidenceLibrary: [] } },
    { label: 'object evidenceLibrary', capabilities: { evidenceLibrary: {} } },
    { label: 'null mapRename', capabilities: { mapRename: null } },
    { label: 'number mapRename', capabilities: { mapRename: 1 } },
    { label: 'string mapRename', capabilities: { mapRename: 'true' } },
    { label: 'array mapRename', capabilities: { mapRename: [] } },
    { label: 'object mapRename', capabilities: { mapRename: {} } },
    { label: 'null publicationPreview', capabilities: { publicationPreview: null } },
    { label: 'number publicationPreview', capabilities: { publicationPreview: 1 } },
    { label: 'string publicationPreview', capabilities: { publicationPreview: 'true' } },
    { label: 'null runHistory', capabilities: { runHistory: null } },
    { label: 'number runHistory', capabilities: { runHistory: 1 } },
    { label: 'string runHistory', capabilities: { runHistory: 'true' } },
    { label: 'null libraryDefinitions', capabilities: { libraryDefinitions: null } },
    { label: 'string libraryDefinitions', capabilities: { libraryDefinitions: 'true' } },
    { label: 'number libraryDefinitions', capabilities: { libraryDefinitions: 1 } },
  ])('rejects bootstrap $label', async (/* HTTP JSON 信封中存在但类型损坏的能力声明。 */ { capabilities }) => {
    // 损坏能力不能被当作禁用或可用，统一沿已有客户端协议错误返回。
    const data = { ...bootstrap, metadata: { ...bootstrap.metadata, capabilities } }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success(data)) })
    try {
      await expect(client.read('app.bootstrap', {})).rejects.toMatchObject({ name: 'ClientError', code: 'INVALID_RESPONSE' })
    } finally { client.close() }
  })

  it('reads a real library definition scope and an exact package through the shared method directory', async () => {
    // 库目录与工作区目录身份不同，精确包版本保持原值。
    expect(CLIENT_QUERY_METHODS).toContain('definition.library.get')
    const data = { scope: { kind: 'library' }, catalog: libraryTestCatalog(), package: structuredClone(LIBRARY_TEST_PACKAGE) }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success(data)) })
    try {
      expect(await client.read('definition.library.get', { packageId: LIBRARY_TEST_PACKAGE.id, packageVersion: LIBRARY_TEST_PACKAGE.version })).toEqual(data)
    } finally { client.close() }
  })

  it.each([null, { id: 'stage-without-agent' }])('rejects a definition stage missing UI identity fields: %s', async (/* 目录中不能供页面安全读取的阶段。 */ stage) => {
    // 已读阶段列表仍须建立阶段ID与精确Agent身份，避免坏响应进入页面后才抛异常。
    const catalog = libraryTestCatalog()
    const transition = catalog.transitions[0]
    const data = { scope: { kind: 'library' }, catalog: { ...catalog, transitions: [{ ...transition,
      execution: { ...transition.execution, stages: [stage] } }] } }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success(data)) })
    try { await expect(client.read('definition.library.get', {})).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('accepts a definition stage whose exact Agent version is zero', async () => {
    // Agent精确版本与包、类型、转换版本分别核对，阶段Agent版本0不能被拒绝。
    const catalog = libraryTestCatalog()
    const stage = catalog.transitions[0].execution.stages[0]
    stage.agentRef.version = 0
    const data = { scope: { kind: 'library' }, catalog }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success(data)) })
    try { expect(await client.read('definition.library.get', {})).toEqual(data) }
    finally { client.close() }
  })

  it.each([
    { label: 'library scope replaced by a workspace', method: 'definition.library.get' as const, params: {},
      data: { scope: { kind: 'workspace', workspaceId: 'workspace' }, catalog: libraryTestCatalog() } },
    { label: 'workspace identity mismatch', method: 'definition.get' as const, params: { workspaceId: 'workspace' },
      data: { workspaceId: 'other-workspace', catalog: libraryTestCatalog() } },
    { label: 'missing requested exact package', method: 'definition.get' as const,
      params: { workspaceId: 'workspace', packageId: LIBRARY_TEST_PACKAGE.id, packageVersion: 1 },
      data: { workspaceId: 'workspace', catalog: libraryTestCatalog() } },
    { label: 'wrong exact package version', method: 'definition.library.get' as const,
      params: { packageId: LIBRARY_TEST_PACKAGE.id, packageVersion: 2 },
      data: { scope: { kind: 'library' }, catalog: libraryTestCatalog(), package: LIBRARY_TEST_PACKAGE } },
    { label: 'wrong exact package id', method: 'definition.library.get' as const,
      params: { packageId: 'another-package', packageVersion: 1 },
      data: { scope: { kind: 'library' }, catalog: libraryTestCatalog(), package: LIBRARY_TEST_PACKAGE } },
    { label: 'missing catalog arrays', method: 'definition.get' as const, params: { workspaceId: 'workspace' },
      data: { workspaceId: 'workspace', catalog: { revision: 0, packages: [], index: [] } } },
    { label: 'invalid catalog revision', method: 'definition.library.get' as const, params: {},
      data: { scope: { kind: 'library' }, catalog: { ...libraryTestCatalog(), revision: -1 } } },
    { label: 'invalid catalog package identity', method: 'definition.library.get' as const, params: {},
      data: { scope: { kind: 'library' }, catalog: { ...libraryTestCatalog(), packages: [{ ref: { id: 'package', version: 0 }, digest: 'digest' }] } } },
    { label: 'invalid definition index', method: 'definition.get' as const, params: { workspaceId: 'workspace' },
      data: { workspaceId: 'workspace', catalog: { ...libraryTestCatalog(), index: 'not-an-array' } } },
    { label: 'invalid type entry', method: 'definition.library.get' as const, params: {},
      data: { scope: { kind: 'library' }, catalog: { ...libraryTestCatalog(), dataTypes: [null] } } },
    { label: 'invalid transition entry', method: 'definition.get' as const, params: { workspaceId: 'workspace' },
      data: { workspaceId: 'workspace', catalog: { ...libraryTestCatalog(), transitions: [null] } } },
    { label: 'invalid exact package shape', method: 'definition.library.get' as const,
      params: { packageId: LIBRARY_TEST_PACKAGE.id, packageVersion: 1 },
      data: { scope: { kind: 'library' }, catalog: libraryTestCatalog(), package: { id: LIBRARY_TEST_PACKAGE.id, version: 1, dependencies: [] } } },
  ])('rejects definition response $label', async (/* 尚未可信的范围、目录或精确包响应。 */ { method, params, data }) => {
    // 公共边界拒绝身份错配与渲染所需结构损坏，不复制定义语义解析器。
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success(data)) })
    try {
      const reading = method === 'definition.get'
        ? client.read(method, { ...params, workspaceId: 'workspace' })
        : client.read(method, params)
      await expect(reading).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally { client.close() }
  })

  it.each(['definition.get', 'definition.library.get'] as const)('snapshots exact package params for %s response identity checks', async (/* 共用相同精确包规则的目录查询。 */ method) => {
    // 调用后编辑外部参数不能让客户端错认稍后返回的原精确包。
    const params = { workspaceId: 'workspace', packageId: LIBRARY_TEST_PACKAGE.id, packageVersion: 1 }
    let deliver: ((/* 已收到的HTTP响应。 */ response: Response) => void) | undefined
    const fetcher = vi.fn<typeof fetch>(() => /* 响应由测试在参数修改后主动交付。 */ new Promise<Response>((/* 保存响应完成端。 */ resolve) => { deliver = resolve }))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: fetcher })
    try {
      const response = { ...(method === 'definition.get' ? { workspaceId: 'workspace' } : { scope: { kind: 'library' } }),
        catalog: libraryTestCatalog(), package: structuredClone(LIBRARY_TEST_PACKAGE) }
      const assertion = expect(client.read(method, params)).resolves.toEqual(response)
      params.workspaceId = 'later-workspace'; params.packageId = 'later-package'; params.packageVersion = 9
      deliver?.(success(response))
      await assertion
    } finally { client.close() }
  })

  it('reads bounded run summaries without treating completion as archive membership', async () => {
    // 目录返回物理归档标记；完成但尚未搬移的记录仍可为未归档。
    expect(CLIENT_QUERY_METHODS).toContain('run.list')
    const page = { ...runPage, items: runPage.items.map((/* 后端按读取时保存的摘要。 */ item) =>
      /* 完成状态不能被客户端强制转换为已归档。 */ ({ ...item, status: 'completed', archived: false, pendingReviewCount: 0 })) }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success(page))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: fetcher })
    try {
      await expect(client.read('run.list', { mapId: 'map' })).resolves.toEqual(page)
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ method: 'run.list', params: { mapId: 'map' } })
    } finally { client.close() }
  })

  it.each([
    { label: 'another Map', patch: { mapId: 'another-map' } },
    { label: 'missing directory version', patch: { directoryVersion: undefined } },
    { label: 'non-array summaries', patch: { items: {} } },
    { label: 'over the requested page size', patch: { items: Array.from({ length: 26 }, (/* 当前摘要在超长页面的位置。 */ _, /* 保持身份唯一以只破坏数量边界。 */ index) =>
      /* 真实响应不能超过默认25条。 */ ({ ...runPage.items[0], runId: `run-${index}` })) } },
    { label: 'duplicate Run identity', patch: { items: [runPage.items[0], runPage.items[0]] } },
    { label: 'unknown status', patch: { items: [{ ...runPage.items[0], status: 'done' }] } },
    { label: 'coerced archive flag', patch: { items: [{ ...runPage.items[0], archived: 'true' }] } },
    { label: 'coerced paused flag', patch: { items: [{ ...runPage.items[0], paused: 0 }] } },
    { label: 'unknown mode', patch: { items: [{ ...runPage.items[0], mode: 'manual' }] } },
    { label: 'missing count', patch: { items: [{ ...runPage.items[0], stepCount: undefined }] } },
    { label: 'negative count', patch: { items: [{ ...runPage.items[0], outputCount: -1 }] } },
    { label: 'contradictory review count', patch: { items: [{ ...runPage.items[0], pendingReviewCount: 2 }] } },
    { label: 'invalid creation time', patch: { items: [{ ...runPage.items[0], createdAt: 'yesterday' }] } },
    { label: 'blank cursor', patch: { nextCursor: '' } },
    { label: 'oversized cursor', patch: { nextCursor: 'v'.repeat(1025) } },
  ])('rejects a run directory with $label', async (/* 仅破坏一项目录公开合同的响应补丁。 */ { patch }) => {
    // 坏摘要或跨Map响应不能被当作合法历史目录暴露给页面。
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success({ ...runPage, ...patch })) })
    try { await expect(client.read('run.list', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('registers publication preview and preserves the authoritative candidate identities', async () => {
    // 预览从统一查询端点读取，保留服务端集合与引用解释，不在客户端重算或分配节点身份。
    expect(CLIENT_QUERY_METHODS).toContain('run.publication.preview')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success(publicationPreview))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: fetcher })
    try {
      await expect(client.read('run.publication.preview', publicationPreviewParams)).resolves.toEqual(publicationPreview)
      expect(String(fetcher.mock.calls[0]?.[0])).toBe('http://localhost:4320/api/v1/query')
      expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({
        method: 'run.publication.preview', params: publicationPreviewParams,
      })
    } finally { client.close() }
  })

  it('binds publication preview to the sent identity when caller parameters later change', async () => {
    // 等待响应期间调用者复用参数对象，不得改变已发出查询的审核归属。
    let complete: (/* 返回给公开客户端的延后 HTTP 响应。 */ response: Response) => void = () => {
      // 查询开始后应由 Promise 的完成函数替代；提前调用视为夹具错误。
      throw new Error('Preview request was not started')
    }
    const response = new Promise<Response>((/* 延后完成本次 HTTP 查询的函数。 */ resolve) => {
      // 保存响应完成句柄，便于在原参数已变动后返回正确预览。
      complete = resolve
    })
    const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(response)
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: fetcher })
    try {
      const params = { ...publicationPreviewParams }
      const pending = client.read('run.publication.preview', params)
      params.reviewId = 'changed-after-send'
      complete(success(publicationPreview))
      await expect(pending).resolves.toEqual(publicationPreview)
    } finally { client.close() }
  })

  it.each([
    { label: 'missing review identity', patch: { reviewId: undefined } },
    { label: 'blank publication version', patch: { publicationVersion: ' ' } },
    { label: 'oversized publication version', patch: { publicationVersion: 'v'.repeat(2049) } },
    { label: 'blank frozen specification', patch: { specHash: '' } },
    { label: 'negative review revision', patch: { reviewRevision: -1 } },
    { label: 'wrong map identity', patch: { mapId: 'other-map' } },
    { label: 'wrong Run identity', patch: { runId: 'other-run' } },
    { label: 'wrong Operation identity', patch: { operationId: 'other-operation' } },
    { label: 'wrong review identity', patch: { reviewId: 'other-review' } },
    { label: 'wrong review revision', patch: { reviewRevision: 2 } },
    { label: 'non-array ports', patch: { ports: {} } },
    { label: 'missing port statistics', patch: { ports: [] } },
    { label: 'duplicate port statistics', patch: { ports: [...publicationPreview.ports, publicationPreview.ports[0]] } },
    { label: 'contradictory port count', patch: { ports: publicationPreview.ports.map(
      /* 只破坏意见端口的数量以检查条目与汇总一致。 */ port =>
        /* 保留其余端口的完整统计。 */ port.port === 'opinions' ? { ...port, count: 0 } : port,
    ) } },
    { label: 'duplicate candidate identity', patch: { items: [...publicationPreview.items, publicationPreview.items[0]] } },
    { label: 'blank candidate key', patch: { items: [{ ...publicationPreview.items[0], key: '' }, publicationPreview.items[1]] } },
    { label: 'missing candidate stage', patch: { items: [{ ...publicationPreview.items[0], stageId: undefined }, publicationPreview.items[1]] } },
    { label: 'invalid exact type', patch: { items: [{ ...publicationPreview.items[0], typeRef: { id: 'factcheck.opinion', version: 0 } }, publicationPreview.items[1]] } },
    { label: 'wrong port type', patch: { items: [{ ...publicationPreview.items[0], typeRef: { id: 'factcheck.verification', version: 1 } }, publicationPreview.items[1]] } },
    { label: 'non-boolean direct selection', patch: { items: [{ ...publicationPreview.items[0], directlySelected: 'false' }, publicationPreview.items[1]] } },
    { label: 'missing reference explanation', patch: { items: [{ ...publicationPreview.items[0], referencedBy: [] }, publicationPreview.items[1]] } },
    { label: 'reference outside publication', patch: { items: [{ ...publicationPreview.items[0], referencedBy: [{ workId: 'missing', key: 'candidate' }] }, publicationPreview.items[1]] } },
    { label: 'malformed candidate reference', patch: { items: [{ ...publicationPreview.items[0], referencedBy: [{ workId: 'result', key: 1 }] }, publicationPreview.items[1]] } },
    { label: 'duplicate candidate reference', patch: { items: [{ ...publicationPreview.items[0], referencedBy: [{ workId: 'result', key: 'verdict' }, { workId: 'result', key: 'verdict' }] }, publicationPreview.items[1]] } },
  ])('rejects publication preview with $label', async (
    /* 当前仅破坏一个公开字段或一条集合关系的服务端响应。 */ { patch },
  ) => {
    // 客户端不能把损坏或不属于本次审核的预览暴露给调用者。
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture',
      fetch: vi.fn<typeof fetch>().mockResolvedValueOnce(success({ ...publicationPreview, ...patch })) })
    try {
      await expect(client.read('run.publication.preview', publicationPreviewParams)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally { client.close() }
  })

  it('registers map rename for HTTP, CLI and desktop and preserves its versioned request', async () => {
    // 共用公开方法目录必须包含改名；请求沿原端点发送，不夹带分支或编辑租约。
    expect(CLIENT_COMMAND_METHODS).toContain('map.rename')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success({
      snapshot: { ...snapshot, name: '新图名称', revision: 8 }, createdNodeIds: [], createdEdgeIds: [],
    }, 'rename-request'))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: fetcher })
    try {
      const params = { mapId: 'map', expectedRevision: 7, name: '新图名称' }
      const result = await client.dispatch('rename-request', 'map.rename', params)
      expect(result.data.snapshot).toMatchObject({ mapId: 'map', name: '新图名称', revision: 8 })
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(String(fetcher.mock.calls[0][0])).toBe('http://localhost:4320/api/v1/command')
      expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ requestId: 'rename-request', method: 'map.rename', params })
    } finally { client.close() }
  })

  it('preserves source footnotes and rejects malformed or misplaced anchor metadata', async () => {
    const sourceAnchors = [{ path: '/content', sourceRevision: 0, startLine: 1, endLine: 1, quote: 'original' }]
    const edge = { id: 'edge', from: 'news', to: 'fact', kind: 'successor', revision: 0, sourceAnchors,
      createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success({ ...snapshot, edges: [edge] }))
      .mockResolvedValueOnce(success({ ...snapshot, edges: [{ ...edge, kind: 'reference' }] }))
      .mockResolvedValueOnce(success({ ...snapshot, edges: [{ ...edge, sourceAnchors: [{ ...sourceAnchors[0], startLine: 0 }] }] }))
      .mockResolvedValueOnce(success({ ...snapshot, edges: [{ ...edge, sourceAnchors: [{ ...sourceAnchors[0], quote: null }] }] }))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: fetcher })
    expect((await client.read('map.get', { mapId: 'map' })).edges[0].sourceAnchors).toEqual(sourceAnchors)
    for (let index = 0; index < 3; index++) await expect(client.read('map.get', { mapId: 'map' }))
      .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    client.close()
  })

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
    // 除proof版本外使用合法节点，匹配版本必须通过，避免无关日期校验使反例假绿。
    const branch = { scope: { rootIds: ['node'], nodeIds: ['node'], edgeIds: [] }, version: 'old', rootRevisions: { node: 0 }, mapRevision: 6 }
    const current = { ...snapshot, nodes: [{ id: 'node', revision: 0, typeId: 'demo.node', typeVersion: 1, payload: {}, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' }] }
    const paired = { ...branch, mapRevision: current.revision }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(success({ snapshot: current, createdNodeIds: [], createdEdgeIds: [], branch }, 'request'))
      .mockResolvedValueOnce(success({ snapshot: current, createdNodeIds: [], createdEdgeIds: [], branch: paired }, 'request'))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(client.dispatch('request', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: 'base' },
      changes: { name: 'Name' } })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    await expect(client.dispatch('request', 'graph.apply', { mapId: 'map', branch: { rootIds: ['node'], expectedVersion: 'base' },
      changes: { name: 'Name' } })).resolves.toMatchObject({ data: { branch: paired } })
    client.close()
  })

  it('keeps the stream protocol error when cancelling a rejected response also fails', async () => {
    // 取消未消费的错误正文只是清理，不能把INVALID_STREAM改成原始清理异常。
    const cancel = vi.fn(async () => { /* 单独注入次级流清理失败。 */ throw new Error('Injected cancel failure') })
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: async () =>
      /* 非事件流响应仍有未结束正文，需要明确取消。 */ new Response(new ReadableStream({ cancel }), { headers: { 'content-type': 'application/json' } }) })
    try {
      await expect(client.watch('10000000-0000-4000-8000-000000000001', () => { /* 错误响应不应产生事件。 */ })).rejects.toMatchObject({ code: 'INVALID_STREAM', retryable: false })
      expect(cancel).toHaveBeenCalledTimes(1)
    } finally { client.close() }
  })

  it.each([undefined, null, 3, 'invalid-date'])('rejects an edge createdAt that the reader cannot order: %s', async (
    /* 只损坏reader实际消费的边创建时间，其余形状保持合法。 */ createdAt,
  ) => {
    // 错误须停在公共响应边界，不以UI默认时间掩盖损坏的图边。
    const time = '2026-10-20T00:00:00.000Z'
    const nodes = ['news', 'fact'].map((/* 当前边的真实端点。 */ id) =>
      /* 除待测边日期外，正文保持完整合法。 */ ({ id, revision: 0, typeId: 'demo.text', typeVersion: 1, payload: {}, createdAt: time, updatedAt: time }))
    const edge = { id: 'edge', from: 'news', to: 'fact', kind: 'successor', revision: 0, createdAt, updatedAt: time }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: async () =>
      /* 交付由JSON正文解码的单一坏字段响应。 */ success({ ...snapshot, nodes, edges: [edge] }) })
    try { await expect(client.read('map.get', { mapId: 'map' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('exposes valid edge dates for deterministic source note order after the public response boundary', async () => {
    // 两条真实后继经过公开client后直接交给reader，验证正常排序无需再补时间。
    const time = '2026-10-20T00:00:00.000Z'
    const nodes = ['news', 'first', 'second'].map((/* 本图中的真实节点身份。 */ id) =>
      /* 提供完整合法节点，避免其他响应校验遮蔽边排序。 */ ({ id, revision: 0, typeId: 'demo.text', typeVersion: 1,
        payload: { content: id }, createdAt: time, updatedAt: time }))
    const edges = [{ id: 'later', from: 'news', to: 'second', kind: 'successor', revision: 0, createdAt: '2026-10-20T01:00:00.000Z', updatedAt: time },
      { id: 'earlier', from: 'news', to: 'first', kind: 'successor', revision: 0, createdAt: time, updatedAt: time }]
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'fixture', fetch: async () =>
      /* 真实HTTP JSON成功包，图边数组故意与创建顺序相反。 */ success({ ...snapshot, nodes, edges }) })
    try {
      const graph = await client.read('map.get', { mapId: 'map' })
      expect(readerReadSourceNotes(graph, { workspaceId: 'workspace', mapId: 'map', nodeId: 'news' }, null, 'outgoing')
        .map((/* 已按边时间排列的真实来源注释。 */ note) => /* 观察实际消费端的节点顺序。 */ note.child.nodeId)).toEqual(['first', 'second'])
    } finally { client.close() }
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

  it('distinguishes normal app close from explicit address forgetting for manual tokens', async () => {
    // 手工访问令牌不落盘；普通关闭保留服务地址，显式断开才清配置。
    const store = { load: vi.fn(async () =>
      /* 模拟凭据存储中没有可恢复的连接。 */
      null), save: vi.fn(async () =>
      /* 模拟凭据成功保存并可在以后恢复。 */
      true), clear: vi.fn(async () => {
      // 记录凭据清除调用，不需要真实持久化。
    }), canRemember: () => /* 声明测试凭据存储支持记住登录。 */ true }
    const gateway = clientCreateGateway({ baseUrl: 'http://localhost:4320', store, fetch: vi.fn<typeof fetch>().mockResolvedValue(success(bootstrap)) })
    await gateway.connect({ baseUrl: 'http://localhost:4320', token: 'stored-token', remember: true })
    expect(await gateway.getConnection()).toMatchObject({ remembered: false })
    expect(store.save).toHaveBeenCalledWith({ baseUrl: 'http://localhost:4320', remember: false })
    expect(store.clear).toHaveBeenCalledTimes(1)
    gateway.close()
    expect(store.clear).toHaveBeenCalledTimes(1)
    await gateway.disconnect()
    expect(store.clear).toHaveBeenCalledTimes(2)
  })
})
