// 无SMTP的真实HTTP账户旅程，用户名账户必须沿用原私有工作区和图权限。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'

let directory: string, baseUrl: string
let database: ReturnType<typeof sqliteCreatePersistence>
let application: ReturnType<typeof applicationCreateLocalService>
let server: ReturnType<typeof apiCreateServer>

beforeAll(async () => {
  // 不注入mailer，公开注册必须在实际无邮件部署条件下工作。
  directory = await mkdtemp(path.join(tmpdir(), 'chongming-username-http-'))
  database = sqliteCreatePersistence(directory)
  application = applicationCreateLocalService(database)
  await application.initialize()
  await application.control.seed()
  server = apiCreateServer(application)
  await new Promise<void>((/* 测试独占本机随机端口。 */ resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Username HTTP fixture did not bind')
  baseUrl = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  // HTTP先关闭，再回收本例自有持久化和目录，不影响预览或生产。
  if (server) await new Promise<void>((/* 等待HTTP资源释放。 */ resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  await application?.closeMessaging()
  await database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function post(
  /* 本次认证或业务路径。 */ route: string,
  /* 本次严格JSON边界的请求。 */ body: unknown,
  /* 仅已认证业务附带的测试令牌。 */ token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // 保留真实HTTP信封，不通过测试直接注入用户身份。
  const response = await fetch(baseUrl + route, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Username HTTP response is not an object')
  return { status: response.status, body: value as Record<string, unknown> }
}
function data(/* 已接收的真实HTTP成功信封。 */ reply: { body: Record<string, unknown> }): Record<string, unknown> {
  // 先确认成功，禁止把错误响应误当业务对象继续旅程。
  expect(reply.body.ok).toBe(true)
  const value = reply.body.data
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Username HTTP data is not an object')
  return value as Record<string, unknown>
}
function text(/* 成功数据中应为字符串的字段。 */ value: unknown): string {
  // 缺少会话凭据必须立即失败，不使用类型断言掩盖接口问题。
  if (typeof value !== 'string') throw new Error('Username HTTP field is not a string')
  return value
}

it('无邮件注册直接进入私有工作区，保存图后仍隔离其他账户并支持重新登录和退出', async () => {
  const password = 'username-http-password-2026'
  const registration = await post('/api/v1/auth/register-username', { username: ' HTTP-reader ', displayName: '用户名读者', password, remember: false })
  expect(registration.status).toBe(200)
  const initial = data(registration), access = text(initial.accessToken)
  expect(initial.identity).toMatchObject({ displayName: '用户名读者', hostAdmin: false })
  const bootstrap = data(await post('/api/v1/query', { method: 'app.bootstrap', params: {} }, access))
  expect(bootstrap.identity).toEqual(initial.identity)
  const workspaces = data(await post('/api/v1/query', { method: 'workspace.list', params: {} }, access))
  expect(workspaces.items).toEqual([expect.objectContaining({ name: '用户名读者的工作区', role: 'owner' })])
  const workspace: unknown = Array.isArray(workspaces.items) ? workspaces.items[0] : null
  if (!workspace || typeof workspace !== 'object' || !('id' in workspace) || !('revision' in workspace)
    || typeof workspace.revision !== 'number') throw new Error('Username default workspace is missing identity or revision')
  const mapId = randomUUID(), nodeId = randomUUID()
  expect((await post('/api/v1/command', { requestId: randomUUID(), method: 'map.create', params: {
    workspaceId: text(workspace.id), expectedRevision: workspace.revision, id: mapId, name: '用户名私有图',
  } }, access)).status).toBe(201)
  expect((await post('/api/v1/command', { requestId: randomUUID(), method: 'graph.apply', params: {
    mapId, branch: { rootIds: [nodeId], expectedVersion: null }, changes: { nodes: { put: [{ id: nodeId,
      typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '用户名账户沿用原固定类型与分支保存。', category: null } }] } },
  } }, access)).status).toBe(200)
  expect(data(await post('/api/v1/query', { method: 'map.get', params: { mapId } }, access)).nodes)
    .toEqual([expect.objectContaining({ id: nodeId })])
  const other = data(await post('/api/v1/auth/register-username', { username: 'other-reader', displayName: '其他读者', password, remember: false }))
  expect((await post('/api/v1/query', { method: 'map.get', params: { mapId } }, text(other.accessToken))).status).toBe(404)
  const login = data(await post('/api/v1/auth/login-username', { username: 'http-READER', password, remember: false }))
  expect(login.identity).toEqual(initial.identity)
  const rotated = data(await post('/api/v1/auth/refresh', { refreshToken: text(login.refreshToken) }))
  expect((await post('/api/v1/auth/logout', {}, text(rotated.accessToken))).status).toBe(200)
  expect((await post('/api/v1/auth/refresh', { refreshToken: text(rotated.refreshToken) })).status).toBe(401)
})

it('用户名入口拒绝提权及非法输入，邮箱流程仍需发信服务而原管理员令牌可用', async () => {
  const input = { username: 'valid-reader', displayName: '读者', password: 'username-http-password-2026', remember: false }
  expect((await post('/api/v1/auth/register-username', { ...input, hostAdmin: true })).status).toBe(400)
  expect((await post('/api/v1/auth/register-username', { ...input, username: 'reader@example.test' })).status).toBe(400)
  expect((await post('/api/v1/auth/register-username', { ...input, remember: 'true' })).status).toBe(400)
  expect((await post('/api/v1/auth/register-username', { ...input, password: 'short' })).status).toBe(400)
  const old = await application.auth.createUser({ id: randomUUID(), displayName: '原管理员', hostAdmin: true })
  const manual = await application.auth.createToken(old.userId)
  expect(data(await post('/api/v1/query', { method: 'app.bootstrap', params: {} }, manual.token)).identity)
    .toMatchObject({ userId: old.userId, hostAdmin: true })
  expect((await post('/api/v1/auth/register', { email: 'reader@example.test', displayName: '邮箱用户', password: input.password })).status).toBe(503)
})
