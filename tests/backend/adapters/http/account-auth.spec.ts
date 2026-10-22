// 真实SQLite与HTTP的账户旅程；邮件只送入本测试内存，不连接外部SMTP。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'

import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import type { AccountMailer } from '../../../../backend/ports/account-mailer'

const mailbox: Array<{ kind: string; email: string; code: string }> = []
const mailer: AccountMailer = {
  async sendVerification(/* 仅本机测试环境签发的邮件内容。 */ mail) {
    // 用收件箱证明服务确实通过邮件端口交付验证码。
    mailbox.push({ kind: 'verify-email', email: mail.email, code: mail.code })
  },
  async sendPasswordReset(/* 本机测试的重置邮件内容。 */ mail) {
    // 不向真实地址发信。
    mailbox.push({ kind: 'reset-password', email: mail.email, code: mail.code })
  },
}
let directory: string, baseUrl: string
let database: ReturnType<typeof sqliteCreatePersistence>
let application: ReturnType<typeof applicationCreateLocalService>
let server: ReturnType<typeof apiCreateServer>

beforeAll(async () => {
  // 账户接口采用真实现行应用装配，测试不注入鉴权结果或替换图模块。
  directory = await mkdtemp(path.join(tmpdir(), 'chongming-account-http-'))
  database = sqliteCreatePersistence(directory)
  application = applicationCreateLocalService(database, { accountMailer: mailer, authChallengeSecret: 'http-private-challenge-key-for-account-tests' })
  await application.initialize()
  await application.control.seed()
  server = apiCreateServer(application)
  await new Promise<void>((/* 随机本机端口完成监听后开始旅程。 */ resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('账户测试没有监听地址')
  baseUrl = `http://127.0.0.1:${address.port}`
})
afterAll(async () => {
  // 按HTTP、消息、数据库顺序收回自有环境，保留其他开发服务。
  if (server) await new Promise<void>((/* 服务关闭时完成清理等待。 */ resolve) => { server.close(() => resolve()); server.closeAllConnections() })
  await application?.closeMessaging()
  await database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function post(
  /* 公开认证或原业务路径。 */ route: string,
  /* 本次真实JSON请求内容。 */ body: unknown,
  /* 仅需要鉴权的请求附带的本测试访问令牌。 */ token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // 不在失败断言中展开请求头、密码或响应令牌。
  const response = await fetch(baseUrl + route, { method: 'POST', headers: { 'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  const value: unknown = await response.json()
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账户测试响应不是对象')
  return { status: response.status, body: value as Record<string, unknown> }
}

function data(
  /* 已通过HTTP接收的成功响应。 */ reply: { body: Record<string, unknown> },
): Record<string, unknown> {
  // 只从已确认成功的对象取业务字段，避免类型断言掩盖失败信封。
  expect(reply.body.ok).toBe(true)
  const value = reply.body.data
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('账户测试响应缺少data')
  return value as Record<string, unknown>
}

function text(
  /* 经过对象边界检查的成功业务字段。 */ value: unknown,
): string {
  // 实际字段必须是字符串，不能把undefined当作测试令牌继续旅程。
  if (typeof value !== 'string') throw new Error('账户测试字段不是字符串')
  return value
}

it('匿名账户旅程验证邮箱、隔离默认工作区、轮换刷新并撤销退出会话', async () => {
  // 账号始终通过公开HTTP签发，默认工作区与图读写使用现有权限和分支协议。
  const email = 'http-account@example.test', password = 'a-long-account-test-password'
  const registration = await post('/api/v1/auth/register', { email, displayName: '账户旅程', password })
  expect(registration.status).toBe(202)
  const mail = mailbox.find((/* 仅选择本账号的验证邮件。 */ item) => item.kind === 'verify-email' && item.email === email)
  if (!mail) throw new Error('注册没有通过邮件端口发送验证码')
  expect((await post('/api/v1/auth/login', { email, password, remember: false })).status).toBe(403)
  const verified = await post('/api/v1/auth/verify-email', { email, code: mail.code, remember: false })
  expect(verified.status).toBe(200)
  const initial = data(verified), initialAccess = text(initial.accessToken), initialRefresh = text(initial.refreshToken)
  const workspaces = data(await post('/api/v1/query', { method: 'workspace.list', params: {} }, initialAccess))
  expect(workspaces.items).toEqual(expect.arrayContaining([expect.objectContaining({ name: '账户旅程的工作区', role: 'owner' })]))
  const items: unknown[] = Array.isArray(workspaces.items) ? workspaces.items : []
  const workspace = items[0]
  if (!workspace || typeof workspace !== 'object' || !('id' in workspace) || !('revision' in workspace)
    || typeof workspace.revision !== 'number') throw new Error('账户默认工作区缺少身份或版本')
  const mapId = randomUUID(), nodeId = randomUUID()
  expect((await post('/api/v1/command', { requestId: randomUUID(), method: 'map.create', params: {
    workspaceId: text(workspace.id), expectedRevision: workspace.revision, id: mapId, name: '邮箱账户的私有图',
  } }, initialAccess)).status).toBe(201)
  expect((await post('/api/v1/command', { requestId: randomUUID(), method: 'graph.apply', params: {
    mapId, branch: { rootIds: [nodeId], expectedVersion: null }, changes: { nodes: { put: [{ id: nodeId,
      typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '邮箱账户沿用原图保存与分支协议。', category: null } }] } },
  } }, initialAccess)).status).toBe(200)
  const snapshot = data(await post('/api/v1/query', { method: 'map.get', params: { mapId } }, initialAccess))
  expect(snapshot.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ id: nodeId })]))
  const stranger = await application.auth.createUser({ id: randomUUID(), displayName: '独立用户', hostAdmin: false })
  const strangerToken = await application.auth.createToken(stranger.userId)
  // 非成员沿用现有隐藏私有工作区存在性的404语义。
  expect((await post('/api/v1/query', { method: 'map.get', params: { mapId } }, strangerToken.token)).status).toBe(404)
  const rotated = await post('/api/v1/auth/refresh', { refreshToken: initialRefresh })
  expect(rotated.status).toBe(200)
  const next = data(rotated), access = text(next.accessToken)
  expect(text(next.refreshToken) === initialRefresh).toBe(false)
  expect((await post('/api/v1/auth/refresh', { refreshToken: initialRefresh })).status).toBe(401)
  expect((await post('/api/v1/auth/logout', {}, access)).status).toBe(200)
  expect((await post('/api/v1/auth/refresh', { refreshToken: text(next.refreshToken) })).status).toBe(401)
  expect((await post('/api/v1/query', { method: 'app.bootstrap', params: {} }, access)).status).toBe(401)
})

it('账户请求拒绝未知字段和无认证改密，旧管理员令牌与图权限继续使用', async () => {
  // 新auth路由不能成为HostAdmin提权入口，也不能改变旧手工令牌的认证含义。
  expect((await post('/api/v1/auth/register', { email: 'bad@example.test', displayName: '无效',
    password: 'a-long-account-test-password', hostAdmin: true })).status).toBe(400)
  expect((await post('/api/v1/auth/change-password', { currentPassword: 'a-long-account-test-password',
    newPassword: 'another-long-account-test-password', remember: false })).status).toBe(401)
  const identity = await application.auth.createUser({ id: randomUUID(), displayName: '原管理员', hostAdmin: true })
  const legacy = await application.auth.createToken(identity.userId)
  expect((await post('/api/v1/query', { method: 'app.bootstrap', params: {} }, legacy.token)).status).toBe(200)
  expect((await post('/api/v1/query', { method: 'app.bootstrap', params: {} })).status).toBe(401)
})
