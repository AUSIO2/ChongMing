// 真实HTTP和SQLite验证模型Key只交付当前Work，公开图/配置保持无密钥。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { WorkspaceView } from '../../../../contracts/control'
import type { GraphBranchSnapshot } from '../../../../contracts/graph-branch'
import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { modelCreateSecretCodec } from '../../../../backend/adapters/identity/model-secrets'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { workReadItems } from '../../../../backend/modules/graph/work-state'

let directory: string, origin: string, userToken: string
let database: ReturnType<typeof sqliteCreatePersistence>
let application: ReturnType<typeof applicationCreateLocalService>
let server: ReturnType<typeof apiCreateServer>
const internalToken = 'fixture-internal-host-only-110', apiKey = 'fixture-workspace-model-key-110'

beforeEach(async () => {
  // 每例持有独立真实应用，不注入鉴权结果，不读取服务器密钥。
  directory = await mkdtemp(path.join(tmpdir(), 'chongming-model-http-'))
  database = sqliteCreatePersistence(directory)
  application = applicationCreateLocalService(database, { modelSecrets: modelCreateSecretCodec(Buffer.alloc(32, 7)) })
  await application.initialize(); await application.control.seed()
  const owner = await application.auth.createUser({ id: randomUUID(), displayName: '模型配置Owner', hostAdmin: false })
  userToken = (await application.auth.createToken(owner.userId)).token
  server = apiCreateServer(application, { internalToken })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No test listener')
  origin = `http://127.0.0.1:${address.port}`
})
afterEach(async () => {
  // 停止HTTP再关闭存储，只释放本例自有目录。
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
  await application?.closeMessaging(); await database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function post(
  /* 当前用例明确选择的正式路径。 */ route: string,
  /* 发送的协议对象，不含任何生产值。 */ body: object,
  /* 默认为公开用户；私有Work路由显式换成Host身份。 */ token: string | null = userToken,
  /* 当前Work holder/fence的专用请求头。 */ proof: Record<string, string> = {},
) {
  // 不在日志中展开Authorization或Key；仅把真实响应交给当前断言。
  const response = await fetch(origin + route, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(token ? { authorization: 'Bearer ' + token } : {}), ...proof }, body: JSON.stringify(body) })
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') }
}

it('私有模型凭据路由先校验Host身份，用户令牌和匿名请求均不可读取', async () => {
  // 路由存在但凭证不正确时应401，不能因其他公共查询已登录而放行。
  const body = { mapId: randomUUID(), operationId: 'operation' }
  expect((await post('/internal/v1/model/read', body, null)).status).toBe(401)
  expect((await post('/internal/v1/model/read', body)).status).toBe(401)
})

it('独立本机服务可配置loopback模型地址，不需要开启私网来源读取', async () => {
  // 本地模型和来源读取是独立用途，不为连本地模型放宽新闻URL访问策略。
  const workspace = (await application.dispatch(userToken, { requestId: randomUUID(), method: 'workspace.create', params: {
    id: randomUUID(), name: '本地模型', description: '', agentSource: 'library',
  } })).data as WorkspaceView
  const saved = await post('/api/v1/command', { requestId: randomUUID(), method: 'model.update', params: {
    scope: { kind: 'workspace', workspaceId: workspace.id }, expectedRevision: 0,
    configuration: { provider: 'openai', model: 'local-fixture-model', baseUrl: 'http://127.0.0.1:11434/v1', apiKey },
  } })
  expect(saved.status).toBe(200)
  expect(saved.body.data.effective.baseUrl).toBe('http://127.0.0.1:11434/v1')
})

it('工作区模型在新Run冻结，只有当前有效Work proof能取得Key，data_read及公开图不包含Key', async () => {
  // 全旅程沿原权限/分支/Work租约，模型不实际发出网络请求。
  const workspace = (await application.dispatch(userToken, { requestId: randomUUID(), method: 'workspace.create', params: {
    id: randomUUID(), name: 'HTTP模型配置', description: '', agentSource: 'library',
  } })).data as WorkspaceView
  const scope = { kind: 'workspace', workspaceId: workspace.id }
  const updated = await post('/api/v1/command', { requestId: randomUUID(), method: 'model.update', params: {
    scope, expectedRevision: 0, configuration: { provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: null, apiKey },
  } })
  expect(updated.status).toBe(200)
  expect(updated.body.data.effective).toMatchObject({ apiKeyConfigured: true, apiKeySource: 'workspace' })
  expect(JSON.stringify(updated.body).includes(apiKey)).toBe(false)
  const publicModel = await post('/api/v1/query', { method: 'model.get', params: { scope } })
  expect(publicModel.status).toBe(200)
  expect(JSON.stringify(publicModel.body).includes(apiKey)).toBe(false)
  const mapId = randomUUID(), nodeId = randomUUID()
  await application.dispatch(userToken, { requestId: randomUUID(), method: 'map.create', params: {
    id: mapId, workspaceId: workspace.id, expectedRevision: workspace.revision, name: '私有模型图',
  } })
  await application.dispatch(userToken, { requestId: randomUUID(), method: 'graph.apply', params: { mapId,
    branch: { rootIds: [nodeId], expectedVersion: null }, changes: { nodes: { put: [{ id: nodeId,
      typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '固定测试陈述。', category: null } }] } },
  } })
  const branch = await application.read(userToken, { method: 'branch.get', params: { mapId, rootIds: [nodeId] } }) as GraphBranchSnapshot
  await application.dispatch(userToken, { requestId: randomUUID(), method: 'run.start', params: { mapId, id: randomUUID(),
    branch: { rootIds: [nodeId], expectedVersion: branch.version }, scope: { nodeIds: [nodeId] }, mode: 'auto', regenerate: false, plan: { steps: [{
      id: 'check', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [nodeId] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] },
  } })
  const document = await database.graph().read(mapId)
  if (!document) throw new Error('Expected saved map')
  const work = workReadItems(document)[0]
  if (!work) throw new Error('Expected ready work')
  const claim = await post('/internal/v1/work', { method: 'claim', params: { mapId, workId: work.workId,
    hostId: 'fixture-host', holderId: randomUUID(), deploymentId: application.messaging().deploymentId } }, internalToken)
  expect(claim.status).toBe(200)
  expect(claim.body.data.status).toBe('claimed')
  const grant = claim.body.data.grant
  const proof = { 'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence) }
  const body = { mapId, operationId: work.operationId }
  const data = await post('/internal/v1/data/read', body, internalToken, proof)
  expect(data.status).toBe(200)
  expect(data.body.data.stage.agent.profile).toMatchObject({ model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' })
  expect(JSON.stringify(data.body).includes(apiKey)).toBe(false)
  const model = await post('/internal/v1/model/read', body, internalToken, proof)
  expect(model.status).toBe(200)
  expect(model.cache).toContain('no-store')
  expect(model.body.data.apiKey === apiKey).toBe(true)
  expect((await post('/internal/v1/model/read', body, internalToken, { ...proof, 'x-work-fence': String(grant.fence + 1) })).status).toBe(409)
  expect((await post('/internal/v1/model/read', { ...body, operationId: 'another-operation' }, internalToken, proof)).status).toBe(404)
  expect(JSON.stringify(await application.readSnapshot(userToken, mapId)).includes(apiKey)).toBe(false)
  expect(JSON.stringify(await database.records('model_connections').list()).includes(apiKey)).toBe(false)
})
