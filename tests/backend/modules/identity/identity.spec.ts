// 通过真实 API 和事务竞争验证身份隔离、角色权限、令牌撤销及写授权栅栏。
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { createHash, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { authCreateService } from '../../../../backend/modules/identity/identity-service'
import { createGraphApi, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => {
  // 启动带真实身份存储的图 API，供令牌与权限测试使用。
  api = await createGraphApi() }, 30_000)
afterAll(async () => {
  // 关闭身份测试创建的服务及持久化资源。
  await api?.close() })

async function user(/* 新测试用户的显示名称。 */ name: string, /* 是否授予宿主管理员权限；默认普通用户。 */ hostAdmin = false) {
  // 创建可指定管理员身份的用户并签发测试令牌。
  const identity = await api.auth.createUser({ id: randomUUID(), displayName: name, hostAdmin })
  return { ...identity, ...await api.auth.createToken(identity.userId) }
}

function as(/* 发送公共请求时使用的用户令牌。 */ token: string, /* 选择公共查询还是写命令端点。 */ path: 'query' | 'command', /* 按 JSON 发送、由用例自行断言的请求体。 */ body: unknown) {
  // 以指定用户令牌调用公共查询或命令，保留 HTTP 结果。
  return api.rawPost(`/api/v1/${path}`, body, { authorization: `Bearer ${token}` })
}
async function editLease(token: string, mapId: string, rootIds: string[]) {
  const claimed = await as(token, 'command', { requestId: randomUUID(), method: 'branch.claim', params: { mapId, rootIds, holderId: randomUUID() } })
  if (claimed.body.data?.status !== 'claimed') throw new Error('Identity fixture branch is busy')
  const grant = claimed.body.data.grant
  return { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
}

async function makeMap() {
  // 创建包含一个事实的私有图，供跨用户读写权限用例复用。
  const workspace = await api.createWorkspace()
  const mapId = randomUUID(), claimId = randomUUID()
  expect((await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Private graph' })).status).toBe(201)
  expect((await api.command('graph.apply', { mapId, branch: { rootIds: [claimId], expectedVersion: null },
    changes: { nodes: { put: [{ id: claimId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Private claim', category: null } }] } },
  })).status).toBe(200)
  const definitions = await api.post('/api/v1/query', { method: 'definition.get', params: { workspaceId: workspace.id } })
  expect(definitions.status).toBe(200)
  const transition = definitions.body.data.catalog.transitions.find((item: any) => item.id === 'factcheck.verify-claim' && item.version === 1)
  const plan = { steps: [{ id: 'verify', transitionRef: { id: transition.id, version: transition.version }, dependsOn: [],
    input: [{ port: transition.ports.input[0].name, source: { kind: 'scope', nodeIds: [claimId] } }],
    context: transition.ports.context.map((port: any) => ({ port: port.name, source: { kind: 'scope', nodeIds: [] } })),
    grouping: { mode: 'each' }, onEmpty: 'fail' }] }
  return { workspaceId: workspace.id, mapId, claimId, plan }
}

async function member(/* 要修改成员列表的工作区身份。 */ workspaceId: string, /* 要新增、改权或移除的用户身份。 */ userId: string, /* 目标成员角色；null 表示移除成员。 */ role: 'editor' | 'viewer' | null) {
  // 读取当前工作区版本再修改成员角色，断言成员变更成功。
  const workspace = await api.post('/api/v1/query', { method: 'workspace.get', params: { workspaceId } })
  const result = await api.command('member.set', { workspaceId, expectedRevision: workspace.body.data.revision, userId, role })
  expect(result.status).toBe(200)
  return result
}

function pauseAuthorizationRead(/* 需要拦截一次授权读取的 Mongo 集合名称。 */ collectionName: string, /* 触发暂停的目标令牌、用户或工作区记录身份。 */ id: string) {
  // 暂停一次真实授权快照读取，让撤权能在原写请求触碰栅栏前提交。
  const prototype = Object.getPrototypeOf(api.connection.db!.collection(collectionName))
  const original = prototype.findOne
  let armed = true, enter!: () => void, release!: () => void
  const entered = new Promise<void>(/* 授权读取到达断点时完成 entered Promise 的回调。 */ resolve => {
    // 保存授权读取到达暂停点的通知回调。
    enter = resolve })
  const resumed = new Promise<void>(/* 用例允许原事务继续时完成 resumed Promise 的回调。 */ resolve => {
    // 保存放行原事务的回调，以精确安排撤权竞争。
    release = resolve })
  prototype.findOne = async function (/* Mongo 驱动绑定的集合接收者，用于限定只拦截目标集合。 */ this: { collectionName: string }, /* 原 findOne 调用的全部位置参数，保持驱动调用不变。 */ ...args: any[]) {
    // 先执行真实 Mongo 读取，再仅暂停目标事务的一次读取，保留其旧快照以触发写冲突。
    const result = await Reflect.apply(original, this, args)
    // 读取真实 Mongo 事务快照后暂停，让并发撤权先于本请求的授权栅栏写入提交。
    if (armed && this.collectionName === collectionName && args[1]?.session && result?._id === id) { armed = false; enter(); await resumed }
    return result
  }
  return { entered, release, restore() {
    // 放行任何挂起读取并恢复集合原方法，防止测试钩子泄漏。
    release(); prototype.findOne = original } }
}

describe('Authenticated public Graph API', () => {
  // 组织用户与 Host 身份隔离、工作区角色及并发撤权的 API 回归场景。
  it('requires user tokens and separates them from internal Host credentials', async () => {
    // 验证公共 API 只认用户令牌，内部 API 只认 Host 凭据，并拒绝外部注入执行配置或身份字段。
    const bootstrap = { method: 'app.bootstrap', params: {} }
    expect((await api.rawPost('/api/v1/query', bootstrap)).status).toBe(401)
    expect((await as('not-a-user-token', 'query', bootstrap)).status).toBe(401)
    expect((await as(api.token, 'query', bootstrap)).status).toBe(401)
    expect(await as(api.userToken, 'query', bootstrap)).toMatchObject({ status: 200, body: { data: { identity: api.owner } } })
    expect((await api.rawPost('/internal/v1/work', { method: 'claim', params: { hostId: 'pretend-host', holderId: randomUUID() } }, {
      authorization: `Bearer ${api.userToken}`,
    })).status).toBe(401)
    const context = await makeMap()
    const branch = await api.branch(context.mapId, [context.claimId])
    expect((await as(api.userToken, 'command', { requestId: randomUUID(), method: 'run.start', params: {
      mapId: context.mapId, id: randomUUID(), branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
      scope: { nodeIds: [context.claimId] }, plan: context.plan, regenerate: true, mode: 'auto',
      configuration: { agents: [] },
    } })).status).toBe(400)
    expect((await as(api.userToken, 'command', { requestId: randomUUID(), method: 'graph.apply', actorId: api.owner.userId,
      params: { mapId: context.mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, changes: { name: 'Spoofed actor' } },
    })).status).toBe(400)
  })

  it('enforces Viewer, Editor and Owner boundaries and hides other Workspaces even from HostAdmin', async () => {
    // 验证 Viewer、Editor、Owner 权限边界，且 HostAdmin 不能越过非成员工作区的可见性。
    const context = await makeMap()
    const editor = await user('Editor'), viewer = await user('Viewer'), outsider = await user('Outside owner')
    await member(context.workspaceId, editor.userId, 'editor')
    await member(context.workspaceId, viewer.userId, 'viewer')
    const query = { method: 'map.get', params: { mapId: context.mapId } }
    const branch = await api.branch(context.mapId, [context.claimId])
    expect((await as(viewer.token, 'query', query)).status).toBe(200)
    expect((await as(outsider.token, 'query', query)).status).toBe(404)
    expect((await as(outsider.token, 'query', { method: 'map.list', params: { workspaceId: context.workspaceId } })).status).toBe(404)
    expect((await as(viewer.token, 'command', { requestId: randomUUID(), method: 'graph.apply',
      params: { mapId: context.mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, changes: { name: 'Viewer cannot edit' } },
    })).status).toBe(403)
    const editorLease = await editLease(editor.token, context.mapId, branch.scope.rootIds)
    expect((await as(editor.token, 'command', { requestId: randomUUID(), method: 'graph.apply',
      params: { mapId: context.mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, lease: editorLease, changes: { name: 'Editor can edit' } },
    })).status).toBe(200)
    const workspace = (await api.post('/api/v1/query', { method: 'workspace.get', params: { workspaceId: context.workspaceId } })).body.data
    expect((await as(editor.token, 'command', { requestId: randomUUID(), method: 'workspace.update',
      params: { workspaceId: context.workspaceId, expectedRevision: workspace.revision, name: 'Editor cannot own', description: '' },
    })).status).toBe(403)
    expect((await as(editor.token, 'command', { requestId: randomUUID(), method: 'member.set',
      params: { workspaceId: context.workspaceId, expectedRevision: workspace.revision, userId: outsider.userId, role: 'owner' },
    })).status).toBe(403)
    const runBranch = await api.branch(context.mapId, [context.claimId])
    const run = { requestId: randomUUID(), method: 'run.start', params: {
      mapId: context.mapId, id: randomUUID(), branch: { rootIds: runBranch.scope.rootIds, expectedVersion: runBranch.version },
      lease: editorLease,
      scope: { nodeIds: [context.claimId] }, plan: context.plan, regenerate: true, mode: 'human-in-loop',
    } }
    expect((await as(viewer.token, 'command', run)).status).toBe(403)
    expect((await as(editor.token, 'command', run)).status).toBe(200)
    const ownWorkspace = await as(outsider.token, 'command', { requestId: randomUUID(), method: 'workspace.create', params: {
      id: randomUUID(), name: 'Outside private Workspace', description: '', agentSource: 'empty',
    } })
    expect(ownWorkspace.status).toBe(201)
    expect((await as(api.userToken, 'query', { method: 'workspace.get', params: { workspaceId: ownWorkspace.body.data.id } })).status).toBe(404)
    await member(context.workspaceId, viewer.userId, null)
    expect((await as(viewer.token, 'query', query)).status).toBe(404)
  })

  it('stores only token hashes and restores a disabled Owner without reviving revoked tokens', async () => {
    // 验证仅持久化令牌摘要，停用用户可恢复，但已经撤销的令牌不会重新生效。
    const account = await user('Revocable user')
    const second = await api.auth.createToken(account.userId)
    const workspaceId = randomUUID()
    expect((await as(account.token, 'command', { requestId: randomUUID(), method: 'workspace.create', params: {
      id: workspaceId, name: 'Recoverable Owner workspace', description: '', agentSource: 'empty',
    } })).status).toBe(201)
    const stored = await api.connection.collection('control_tokens').findOne({ _id: account.tokenId })
    expect(stored?.hash).toBe(createHash('sha256').update(account.token).digest('hex'))
    expect(JSON.stringify(stored)).not.toContain(account.token)
    const independent = authCreateService(persistenceCreateMongo(api.connection))
    expect((await independent.read(account.token)).actor.userId).toBe(account.userId)
    await api.auth.revokeToken(account.tokenId)
    expect((await as(account.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(401)
    await expect(independent.read(account.token)).rejects.toMatchObject({ status: 401 })
    expect((await as(second.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(200)
    await api.auth.disableUser(account.userId)
    expect((await as(second.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(401)
    await expect(api.auth.createToken(account.userId)).rejects.toMatchObject({ status: 404 })
    await api.auth.enableUser(account.userId)
    expect((await as(account.token, 'query', { method: 'app.bootstrap', params: {} })).status).toBe(401)
    expect((await independent.read(second.token)).actor.userId).toBe(account.userId)
    expect(await as(second.token, 'query', { method: 'workspace.get', params: { workspaceId } })).toMatchObject({
      status: 200, body: { data: { id: workspaceId, role: 'owner', members: [{ userId: account.userId, role: 'owner' }] } },
    })
  })

  it.each(['token', 'user', 'membership'] as const)('revalidates %s revocation after a real transaction conflict before writing the graph', async (/* 本轮竞争测试撤销的授权种类。 */ kind) => {
    // 在真实事务冲突中分别撤销令牌、用户和成员资格，确认写请求重新鉴权且不改变图。
    const context = await makeMap()
    const editor = await user(`Racing ${kind}`)
    await member(context.workspaceId, editor.userId, 'editor')
    const pause = kind === 'token' ? pauseAuthorizationRead('control_tokens', editor.tokenId)
      : kind === 'user' ? pauseAuthorizationRead('control_users', editor.userId)
        : pauseAuthorizationRead('control_workspaces', context.workspaceId)
    const before = await api.snapshot(context.mapId)
    const branch = await api.branch(context.mapId, [context.claimId])
    try {
      const pending = as(editor.token, 'command', { requestId: randomUUID(), method: 'graph.apply',
        params: { mapId: context.mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, changes: { name: 'Revoked transaction must not commit' } },
      })
      await pause.entered
      if (kind === 'token') await api.auth.revokeToken(editor.tokenId)
      else if (kind === 'user') await api.auth.disableUser(editor.userId)
      else await member(context.workspaceId, editor.userId, null)
      pause.release()
      const result = await pending
      expect(result.status).toBe(kind === 'membership' ? 404 : 401)
      expect(await api.snapshot(context.mapId)).toEqual(before)
    } finally { pause.restore() }
  }, 15_000)

  it('namespaces user receipts and never lets a replay bypass removed membership', async () => {
    // 验证收据按用户隔离，即使命中旧成功请求，成员被移除后也不能绕过授权重放。
    const context = await makeMap()
    const editor = await user('Receipt editor')
    await member(context.workspaceId, editor.userId, 'editor')
    const requestId = randomUUID()
    const initial = await api.branch(context.mapId, [context.claimId])
    const ownerLease = await editLease(api.userToken, context.mapId, initial.scope.rootIds)
    const ownerCommand = { requestId, method: 'graph.apply', params: { mapId: context.mapId,
      branch: { rootIds: initial.scope.rootIds, expectedVersion: initial.version }, lease: ownerLease, changes: { name: 'Owner write' } } }
    expect((await as(api.userToken, 'command', ownerCommand)).status).toBe(200)
    await as(api.userToken, 'command', { requestId: randomUUID(), method: 'branch.release', params: { mapId: context.mapId, lease: ownerLease } })
    const editorLease = await editLease(editor.token, context.mapId, initial.scope.rootIds)
    const editorCommand = { ...ownerCommand, params: { ...ownerCommand.params, lease: editorLease } }
    expect(await as(editor.token, 'command', editorCommand)).toMatchObject({ status: 200, body: { replayed: false } })
    expect(await as(editor.token, 'command', editorCommand)).toMatchObject({ status: 200, body: { replayed: true } })
    await member(context.workspaceId, editor.userId, null)
    expect((await as(editor.token, 'command', editorCommand)).status).toBe(404)
  })

  it('protects the last enabled HostAdmin under concurrent disables', async () => {
    // 并发停用两名管理员，验证恰有一项成功且系统始终保留一名启用管理员。
    const second = await user('Second HostAdmin', true)
    const results = await Promise.allSettled([api.auth.disableUser(api.owner.userId), api.auth.disableUser(second.userId)])
    expect(results.filter(/* 并发停用结果中当前判断是否成功的项。 */ result => /* 统计成功的停用操作，确认并发请求没有全部提交。 */ result.status === 'fulfilled')).toHaveLength(1)
    const failure = results.find(/* 并发停用结果中当前查找被拒绝操作的项。 */ result => /* 取出被拒绝的停用结果，核对最后管理员保护错误。 */ result.status === 'rejected') as PromiseRejectedResult
    expect(failure.reason).toMatchObject({ status: 409, code: 'LAST_ADMIN' })
    expect(await api.connection.collection('control_users').countDocuments({ hostAdmin: true, disabled: false })).toBe(1)
  })
})
