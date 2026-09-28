// 通过 Mongo 事务验证工作区权限、幂等收据、成员约束与 Agent 配置继承及快照隔离。
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { randomUUID } from 'node:crypto'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentInput, AgentList, AgentProfile, AppBootstrap, ControlCommand, ControlQuery, Preferences, WorkspaceView } from '../../../../contracts/control'
import { authCreateService, type AuthService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService, type ControlService, type WorkspaceDocument } from '../../../../backend/modules/workspace/workspace-service'
import { controlReadAgent, controlReadCommand } from '../../../../backend/modules/workspace/workspace-input'
import { GRAPH_COLLECTION } from '../../../../backend/modules/graph/graph-record'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { verificationConfiguration } from '../../fixtures/verification'
import { DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'

let replica: MongoMemoryReplSet
let connection: Connection
let auth: AuthService
let control: ControlService
const ownerId = randomUUID(), otherId = randomUUID(), viewerId = randomUUID(), adminId = randomUUID()
let ownerToken: string, otherToken: string, viewerToken: string, adminToken: string

async function controlTestCommand(/* 执行管理写入的测试用户令牌，用真实认证事务建立权限上下文。 */ token: string, /* 本用例要提交的公开管理命令名。 */ method: ControlCommand['method'], /* 待测试的原始命令参数，先走真实输入解析器，允许构造无效值场景。 */ params: unknown, /* 可复用的幂等请求编号，省略时为本次调用新建 UUID。 */ requestId = randomUUID()) {
  // 在指定令牌的认证事务中提交已解析的管理命令，并允许测试复用请求编号。
  return auth.transact(token, /* 认证事务提供的身份及存储会话，交给真实控制服务提交命令。 */ ctx => /* 使用当前事务身份执行通过输入验证的管理命令。 */  control.dispatch(ctx, controlReadCommand({ requestId, method, params })))
}
async function controlTestRead(/* 发起管理查询的测试用户令牌。 */ token: string, /* 已按公共协议构造的管理查询对象。 */ query: ControlQuery) {
  // 读取令牌身份后执行管理查询，复用真实权限检查。
   return control.read(await auth.read(token), query) }
async function controlTestWorkspace(/* 创建工作区的测试令牌，缺省为 Owner 身份。 */ token = ownerToken, /* 新工作区的 Agent 来源策略，缺省复制共享库，也可显式选空配置。 */ agentSource: 'empty' | 'library' = 'library'): Promise<WorkspaceView> {
  // 以指定用户创建随机编号工作区，可选择空配置或复制共享 Agent 库。
  return (await controlTestCommand(token, 'workspace.create', { id: randomUUID(), name: 'Control test', description: '', agentSource })).data as WorkspaceView
}
function controlTestAgent(/* 服务端返回的 Agent 资料，去掉只读元数据后生成提交输入。 */ profile: AgentProfile): AgentInput {
  // 移除服务端管理的版本及更新时间，把 Agent 资料转换为可提交输入。
  const { revision: _revision, deletable: _deletable, updatedAt: _updatedAt, ...input } = profile
  return input
}
async function controlTestLibrary(): Promise<AgentList> {
  // 以管理员身份读取共享 Agent 库及其当前版本。
  return await controlTestRead(adminToken, { method: 'agent.list', params: { scope: { kind: 'library' } } }) as AgentList
}

beforeAll(async () => {
  // 启动隔离 Mongo 副本集并初始化身份、共享配置与四种测试用户令牌。
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  connection = await storeCreateConnection(replica.getUri(`control_${randomUUID().replace(/-/g, '')}`))
  auth = authCreateService(persistenceCreateMongo(connection))
  control = controlCreateService(persistenceCreateMongo(connection), DEFAULT_RUN_CONFIGURATION)
  await auth.initialize()
  await control.initialize()
  await control.seed(verificationConfiguration())
  for (const [id, displayName, hostAdmin] of [[ownerId, 'Owner', false], [otherId, 'Other', false], [viewerId, 'Viewer', false], [adminId, 'Admin', true]] as const) {
    await auth.createUser({ id, displayName, hostAdmin })
  }
  ownerToken = (await auth.createToken(ownerId)).token
  otherToken = (await auth.createToken(otherId)).token
  viewerToken = (await auth.createToken(viewerId)).token
  adminToken = (await auth.createToken(adminId)).token
}, 30_000)

afterAll(async () => {
  // 关闭数据库连接，并保证测试副本集最终停止和清理。
  try { if (connection) await connection.close() }
  finally { if (replica) await replica.stop({ doCleanup: true, force: true }) }
})

describe('Shared Control transactions', () => {
  // 组织工作区管理事务、权限、版本和配置隔离的回归场景。
  it('strictly validates Agent metadata and rejects undeclared credential and endpoint fields', async () => {
    // 验证 Agent 元数据严格校验，拒绝凭据和端点字段，公开元数据不暴露授权字段。
    const profile = (await controlTestLibrary()).items.find(/* 共享库中的候选 Agent，选择核验子角色作为验证基准。 */ agent => /* 选择核验子 Agent 作为输入验证基准。 */  agent.kind === 'verifySubAgent')!
    const input = controlTestAgent(profile)
    expect(controlReadAgent(input)).toEqual(input)
    expect(() => /* 向 Agent 输入注入密钥字段，预期在边界被拒绝。 */  controlReadAgent({ ...input, apiKey: 'must-not-enter-shared-documents' })).toThrow()
    expect(() => /* 向 Agent 输入注入未声明的端点字段，预期被拒绝。 */  controlReadAgent({ ...input, baseUrl: 'https://unregistered.invalid' })).toThrow()
    expect(() => /* 尝试把业务提交工具写入自定义工具列表，预期校验失败。 */  controlReadAgent({ ...input, tools: ['data_propose'] })).toThrow()
    expect(() => /* 提供未声明的提示词变量，预期校验失败。 */  controlReadAgent({ ...input, promptVars: ['unknown-variable'] })).toThrow()
    expect(() => /* 向共享模型设置夹带密钥，预期命令输入验证拒绝。 */  controlReadCommand({ requestId: randomUUID(), method: 'settings.update', params: {
      expectedRevision: 0, llm: { provider: 'openai', model: 'fixture', apiKey: 'secret' }, tools: [], limits: { maxAgentSlots: 2 },
    } })).toThrow()
    const bootstrap = await controlTestRead(ownerToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    expect(bootstrap.metadata.variables.verifySubAgent).toEqual(['hint', 'context', 'claimContent', 'originalContent'])
    expect(bootstrap.metadata.outputs.map(/* 引导元数据中的输出模板，提取种类用于清单断言。 */ output => /* 提取输出模板的提示词种类，核对公开元数据清单。 */  output.kind)).toEqual(['parseExtract', 'splitRoute', 'splitSubAgent', 'splitMerge', 'verifyRoute', 'verifySubAgent', 'verifyMerge'])
    expect(bootstrap.metadata.executableKinds).toEqual(['parse', 'split', 'verify'])
    for (const output of bootstrap.metadata.outputs) {
      const example = JSON.parse(output.content)
      expect(Object.keys(example)).toEqual(['proposal'])
      expect(example.proposal).not.toHaveProperty('mapId')
      expect(example.proposal).not.toHaveProperty('fence')
    }
  })

  it('scopes Workspace access, replays before revision checks, and protects deletion with a tombstone', async () => {
    // 验证工作区按成员隔离，收据重放先于版本冲突检查，删除墓碑阻止编号复用。
    const id = randomUUID(), requestId = randomUUID()
    const params = { id, name: 'Created once', description: 'Shared workspace', agentSource: 'empty' }
    const created = await controlTestCommand(ownerToken, 'workspace.create', params, requestId)
    const replay = await controlTestCommand(ownerToken, 'workspace.create', params, requestId)
    expect(replay).toMatchObject({ replayed: true, data: { id, revision: 0 } })
    expect(replay.data).toEqual(created.data)
    await expect(controlTestCommand(ownerToken, 'workspace.create', { ...params, name: 'Changed' }, requestId))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(controlTestRead(adminToken, { method: 'workspace.get', params: { workspaceId: id } }))
      .rejects.toMatchObject({ status: 404 })
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: id, expectedRevision: 0, userId: viewerId, role: 'viewer' })
    await expect(controlTestCommand(viewerToken, 'workspace.update', { workspaceId: id, expectedRevision: 1, name: 'Forbidden', description: '' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(controlTestCommand(ownerToken, 'workspace.update', { workspaceId: id, expectedRevision: 0, name: 'Stale', description: '' }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const renamed = await controlTestCommand(ownerToken, 'workspace.update', { workspaceId: id, expectedRevision: 1, name: 'Renamed', description: '' })
    expect(renamed.data).toMatchObject({ revision: 2, name: 'Renamed' })
    const mapId = randomUUID()
    await connection.db!.collection(GRAPH_COLLECTION).insertOne({ _id: mapId, workspaceId: id, nodes: [], run: { status: 'running' } })
    await expect(controlTestCommand(ownerToken, 'workspace.delete', { workspaceId: id, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    await connection.db!.collection(GRAPH_COLLECTION).updateOne({ _id: mapId }, { $set: { 'run.status': 'completed' } })
    const deletionId = randomUUID()
    expect(await controlTestCommand(ownerToken, 'workspace.delete', { workspaceId: id, expectedRevision: 2 }, deletionId))
      .toMatchObject({ data: { workspaceId: id, deleted: true }, replayed: false })
    expect(await controlTestCommand(ownerToken, 'workspace.delete', { workspaceId: id, expectedRevision: 2 }, deletionId))
      .toMatchObject({ data: { workspaceId: id, deleted: true }, replayed: true })
    await expect(controlTestRead(ownerToken, { method: 'workspace.get', params: { workspaceId: id } })).rejects.toMatchObject({ status: 404 })
    await expect(controlTestCommand(ownerToken, 'workspace.create', params)).rejects.toMatchObject({ status: 410 })
  })

  it('prevents the last Owner downgrade and serializes two concurrent Owner changes', async () => {
    // 验证最后一名 Owner 不能降权，并发降权只能成功一次以保留负责人。
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    await expect(controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: ownerId, role: 'viewer' }))
      .rejects.toMatchObject({ code: 'LAST_OWNER' })
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: otherId, role: 'owner' })
    const results = await Promise.allSettled([
      controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 1, userId: ownerId, role: 'viewer' }),
      controlTestCommand(otherToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 1, userId: otherId, role: 'viewer' }),
    ])
    expect(results.filter(/* 两项并发 Owner 变更之一的 settled 结果。 */ result => /* 统计并发成员变更中成功提交的事务。 */  result.status === 'fulfilled')).toHaveLength(1)
    const doc = await connection.db!.collection<WorkspaceDocument>('control_workspaces').findOne({ _id: workspace.id })
    expect(doc!.members.filter(/* 持久化工作区成员记录，用于统计最终 Owner 数量。 */ member => /* 统计持久化成员中仍保留 Owner 角色的人数。 */  member.role === 'owner')).toHaveLength(1)
    expect(doc!.revision).toBe(2)
  })

  it('touches the authorization fence without changing public revision and isolates validated preferences', async () => {
    // 验证授权检查推进写栅栏却不改变公开版本，个人偏好独立且拒绝跨工作区引用。
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: viewerId, role: 'viewer' })
    const collection = connection.db!.collection<WorkspaceDocument>('control_workspaces')
    const before = (await collection.findOne({ _id: workspace.id }))!
    await auth.transact(viewerToken, /* viewer 用户的认证事务上下文，用于观察 requireRole 的写栅栏副作用。 */ ctx => /* 在事务中取得 viewer 授权，以观察授权栅栏的持久化副作用。 */  control.requireRole(ctx, workspace.id, 'viewer'))
    const touched = (await collection.findOne({ _id: workspace.id }))!
    expect(touched.revision).toBe(before.revision)
    expect(touched.writeFence).toBe(before.writeFence + 1)
    const mapId = randomUUID(), nodeId = randomUUID(), foreignMapId = randomUUID()
    await connection.db!.collection(GRAPH_COLLECTION).insertMany([
      { _id: mapId, workspaceId: workspace.id, nodes: [{ id: nodeId }] },
      { _id: foreignMapId, workspaceId: randomUUID(), nodes: [] },
    ])
    const params = { workspaceId: workspace.id, expectedRevision: 0, openMapIds: [mapId], currentMapId: mapId, nodeSelection: { [mapId]: nodeId } }
    const requestId = randomUUID()
    const changed = await controlTestCommand(viewerToken, 'preferences.set', params, requestId)
    expect(changed.data).toMatchObject({ revision: 1, currentMapId: mapId })
    expect(await controlTestCommand(viewerToken, 'preferences.set', params, requestId)).toMatchObject({ replayed: true, data: changed.data })
    const ownerView = await controlTestRead(ownerToken, { method: 'workspace.get', params: { workspaceId: workspace.id } }) as WorkspaceView
    expect(ownerView.preferences).toEqual({ workspaceId: workspace.id, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} })
    expect(ownerView.revision).toBe(before.revision)
    await expect(controlTestCommand(viewerToken, 'preferences.set', { ...params, expectedRevision: 1, openMapIds: [foreignMapId], currentMapId: foreignMapId }))
      .rejects.toMatchObject({ code: 'INVALID_PREFERENCES' })
    const current = await controlTestRead(viewerToken, { method: 'workspace.get', params: { workspaceId: workspace.id } }) as WorkspaceView
    expect(current.preferences as Preferences).toEqual(changed.data)
  })

  it('keeps private Agent copies stable, checks both copy versions and freezes resolved configuration', async () => {
    // 验证共享库更新不污染工作区副本或已取得配置，复制时检查源与目标版本及固定角色。
    const workspace = await controlTestWorkspace()
    const source = await controlTestLibrary()
    const sourceAgent = source.items.find(/* 共享库候选配置，定位待复制的核验子 Agent。 */ agent => /* 定位用于复制更新的共享核验子 Agent。 */  agent.kind === 'verifySubAgent')!
    const copy = workspace.agents.find(/* 工作区候选 Agent，按提示词路径匹配共享库来源。 */ agent => /* 按提示词路径找到工作区中的独立副本。 */  agent.promptPath === sourceAgent.promptPath)!
    expect(copy.id).not.toBe(sourceAgent.id)
    const frozen = await control.configuration(await auth.read(ownerToken), workspace.id)
    expect(frozen.agents.find(/* 已取得配置中的候选 Agent，按工作区副本编号定位。 */ agent => /* 从已解析配置中定位副本，核对元数据保留。 */  agent.id === copy.id)).toMatchObject({
      promptVars: copy.promptVars, defaultPriority: copy.defaultPriority, claimCategory: copy.claimCategory,
    })
    const update = { scope: { kind: 'library' }, expectedRevision: source.revision, agentId: sourceAgent.id,
      expectedAgentRevision: sourceAgent.revision, agent: { ...controlTestAgent(sourceAgent), content: 'Updated library investigation instructions' } }
    await expect(controlTestCommand(ownerToken, 'agent.update', update)).rejects.toMatchObject({ status: 403 })
    const updated = (await controlTestCommand(adminToken, 'agent.update', update)).data as AgentList
    expect(await control.configuration(await auth.read(ownerToken), workspace.id)).toEqual(frozen)
    await expect(controlTestCommand(ownerToken, 'agent.copy', { workspaceId: workspace.id, expectedRevision: 0, libraryRevision: source.revision, agentIds: [sourceAgent.id], mode: 'merge' }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const copied = (await controlTestCommand(ownerToken, 'agent.copy', { workspaceId: workspace.id, expectedRevision: 0,
      libraryRevision: updated.revision, agentIds: [sourceAgent.id], mode: 'merge' })).data as WorkspaceView
    expect(copied.agents.find(/* 再次复制后的工作区候选配置，按来源提示词路径检查版本与内容。 */ agent => /* 按提示词路径寻找再次复制后的工作区 Agent。 */  agent.promptPath === sourceAgent.promptPath)).toMatchObject({ id: copy.id, revision: copy.revision + 1, content: update.agent.content })
    expect(frozen.agents.find(/* 旧配置快照中的候选 Agent，定位目标副本检查其内容未改变。 */ agent => /* 定位旧配置中的副本，验证其内容未随后续更新改变。 */  agent.id === copy.id)!.content).toBe(copy.content)
    expect((await control.configuration(await auth.read(ownerToken), workspace.id)).agents.find(/* 重新解析配置中的候选 Agent，定位目标副本检查更新已可见。 */ agent => /* 定位重新读取配置中的副本，验证新内容已被解析。 */  agent.id === copy.id)!.content).toBe(update.agent.content)
    await expect(controlTestCommand(ownerToken, 'agent.copy', { workspaceId: workspace.id, expectedRevision: copied.revision,
      libraryRevision: updated.revision, agentIds: [sourceAgent.id], mode: 'replace' })).rejects.toMatchObject({ code: 'FIXED_ROLE' })
    const otherWorkspace = await controlTestWorkspace(ownerToken, 'empty')
    await controlTestCommand(ownerToken, 'agent.create', { scope: { kind: 'workspace', workspaceId: otherWorkspace.id }, expectedRevision: 0,
      agent: { ...controlTestAgent(sourceAgent), id: randomUUID(), kind: 'splitSubAgent', promptVars: ['content'] },
    })
    await expect(controlTestCommand(ownerToken, 'agent.copy', { workspaceId: otherWorkspace.id, expectedRevision: 1,
      libraryRevision: updated.revision, agentIds: [sourceAgent.id], mode: 'merge' })).rejects.toMatchObject({ code: 'AGENT_IDENTITY_CHANGED' })
  })

  it('supports custom Agent CRUD and inherited defaults without allowing identity changes or reuse', async () => {
    // 验证自定义 Agent 增删改、共享默认值继承以及身份字段和已删除编号不可复用。
    const workspace = await controlTestWorkspace()
    const original = workspace.agents.find(/* 工作区候选配置，选择核验子 Agent 作为自定义配置基础。 */ agent => /* 选择现有核验子 Agent 作为自定义配置基础。 */  agent.kind === 'verifySubAgent')!
    const scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const agent: AgentInput = { ...controlTestAgent(original), id: randomUUID(), promptPath: 'custom/verification', provider: null, model: null, tools: [] }
    const created = (await controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: 0, agent })).data as AgentList
    const item = created.items.find(/* 新建返回列表中的候选 Agent，按本次生成的编号定位。 */ item => /* 从创建结果中定位新 Agent 及其版本。 */  item.id === agent.id)!
    await expect(controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision, agentId: item.id,
      expectedAgentRevision: item.revision, agent: { ...agent, promptPath: 'another/path' } })).rejects.toMatchObject({ code: 'AGENT_IDENTITY_CHANGED' })
    const updated = (await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision, agentId: item.id,
      expectedAgentRevision: item.revision, agent: { ...agent, name: 'Human-readable custom angle' } })).data as AgentList
    const changed = updated.items.find(/* 更新返回列表中的候选配置，按目标编号读取最新版本。 */ profile => /* 从更新结果中取得当前 Agent，用于后续版本条件。 */  profile.id === item.id)!
    expect(changed).toMatchObject({ revision: 1, name: 'Human-readable custom angle' })
    const fixed = updated.items.find(/* 更新列表中的候选配置，寻找不可删除的核验路由固定角色。 */ profile => /* 定位不可删除的固定核验路由角色。 */  profile.kind === 'verifyRoute')!
    await expect(controlTestCommand(ownerToken, 'agent.delete', { scope, expectedRevision: updated.revision,
      agentId: fixed.id, expectedAgentRevision: fixed.revision })).rejects.toMatchObject({ code: 'FIXED_ROLE' })
    const bootstrap = await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    const settingParams = { expectedRevision: bootstrap.settings.revision, llm: { provider: 'other-provider', model: 'new-default' },
      tools: bootstrap.settings.tools, limits: bootstrap.settings.limits }
    const requestId = randomUUID()
    await expect(controlTestCommand(ownerToken, 'settings.update', settingParams)).rejects.toMatchObject({ status: 403 })
    await controlTestCommand(adminToken, 'settings.update', settingParams, requestId)
    expect(await controlTestCommand(adminToken, 'settings.update', settingParams, requestId)).toMatchObject({ replayed: true })
    expect((await control.configuration(await auth.read(ownerToken), workspace.id)).agents.find(/* 重新解析的候选 Agent，定位自定义配置检查共享模型继承。 */ profile => /* 读取新建 Agent 的解析配置，核对共享模型默认值继承。 */  profile.id === item.id))
      .toMatchObject(settingParams.llm)
    const deleted = (await controlTestCommand(ownerToken, 'agent.delete', { scope, expectedRevision: updated.revision,
      agentId: item.id, expectedAgentRevision: changed.revision })).data as AgentList
    expect(deleted.items.some(/* 删除后返回的候选 Agent，检查已删除编号不再出现。 */ profile => /* 检查删除结果中是否仍存在该 Agent。 */  profile.id === item.id)).toBe(false)
    await expect(controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: deleted.revision, agent }))
      .rejects.toMatchObject({ code: 'AGENT_ID_REUSED' })
  })

  it('blocks removal of used tools, keeps seed idempotent, and leaves empty Workspaces explicitly unconfigured', async () => {
    // 验证使用中的工具不可移除，重复播种不改配置，空工作区必须明确报告配置不完整。
    const bootstrap = await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    await expect(controlTestCommand(adminToken, 'settings.update', { expectedRevision: bootstrap.settings.revision,
      llm: bootstrap.settings.llm, tools: [], limits: bootstrap.settings.limits })).rejects.toMatchObject({ code: 'TOOL_IN_USE' })
    await control.seed()
    expect(await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} })).toEqual(bootstrap)
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    await expect(control.configuration(await auth.read(ownerToken), workspace.id)).rejects.toMatchObject({ code: 'CONFIGURATION_INCOMPLETE' })
    const library = await controlTestLibrary()
    expect(library.items.filter(/* 共享库中的候选 Agent，按不可删除标记筛出固定角色。 */ agent => /* 筛出不可删除的固定角色。 */  !agent.deletable).map(/* 已筛为固定角色的 Agent，提取提示词种类用于角色清单断言。 */ agent => /* 提取固定角色类型以核对必要角色清单。 */  agent.kind).sort())
      .toEqual(['parseExtract', 'splitMerge', 'splitRoute', 'verifyMerge', 'verifyRoute'])
    expect(library.items.filter(/* 共享库候选配置，筛选拆分子 Agent。 */ agent => /* 筛选共享库中的拆分子 Agent。 */  agent.kind === 'splitSubAgent').map(/* 已筛为拆分子角色的 Agent，提取陈述类别检查默认覆盖。 */ agent => /* 提取拆分 Agent 的陈述类别，核对默认类别覆盖。 */  agent.claimCategory).sort()).toEqual(['causal', 'data', 'quote'])
  })

  it('makes default seeded profiles inherit later settings while explicit seeds retain overrides', async () => {
    // 验证默认种子随共享设置更新而继承新模型，显式种子仍保留覆盖值且旧配置不变。
    const explicitLibrary = await controlTestLibrary()
    const explicitConfiguration = verificationConfiguration()
    const explicitRouter = explicitLibrary.items.find(/* 显式种子库中的候选 Agent，定位核验路由并验证模型覆盖值。 */ agent => /* 定位显式种子中的核验路由配置。 */  agent.kind === 'verifyRoute')!
    expect(explicitRouter).toMatchObject({ provider: explicitConfiguration.router.provider, model: explicitConfiguration.router.model })

    const freshConnection = await storeCreateConnection(replica.getUri(`control_default_${randomUUID().replace(/-/g, '')}`))
    try {
      const freshAuth = authCreateService(persistenceCreateMongo(freshConnection))
      const freshControl = controlCreateService(persistenceCreateMongo(freshConnection), DEFAULT_RUN_CONFIGURATION)
      await freshAuth.initialize()
      await freshControl.initialize()
      await freshControl.seed()
      const userId = randomUUID()
      await freshAuth.createUser({ id: userId, displayName: 'Default configuration owner', hostAdmin: true })
      const token = (await freshAuth.createToken(userId)).token
      const ctx = await freshAuth.read(token)
      const seeded = await freshControl.read(ctx, { method: 'agent.list', params: { scope: { kind: 'library' } } }) as AgentList
      expect(seeded.items.length).toBeGreaterThan(0)
      expect(seeded.items.every(/* 默认播种出的 Agent，验证提供方和模型均为 null 以继承共享值。 */ agent => /* 确认默认播种的 Agent 未显式固定提供方或模型。 */  agent.provider === null && agent.model === null)).toBe(true)
      const workspace = await freshAuth.transact(token, /* 新测试数据库中的认证事务上下文，用于创建复制默认库的工作区。 */ context => /* 在新数据库的认证事务中创建复制默认库的工作区。 */  freshControl.createWorkspace(context, {
        id: randomUUID(), name: 'Uses shared defaults', description: '', agentSource: 'library',
      }))
      const frozen = await freshControl.configuration(ctx, workspace.id)
      const bootstrap = await freshControl.read(ctx, { method: 'app.bootstrap', params: {} }) as AppBootstrap
      const llm = { provider: 'new-shared-provider', model: 'new-shared-model' }
      await freshAuth.transact(token, /* 同一测试用户的认证事务上下文，用于原子更新共享模型设置。 */ context => /* 在认证事务中更新共享模型设置，触发后续配置解析采用新默认值。 */  freshControl.dispatch(context, {
        requestId: randomUUID(), method: 'settings.update', params: {
          expectedRevision: bootstrap.settings.revision, llm, tools: bootstrap.settings.tools, limits: bootstrap.settings.limits,
        },
      }))
      const next = await freshControl.configuration(ctx, workspace.id)
      expect([next.router, next.merger, ...next.agents, next.parse!, next.split!.router, next.split!.merger, ...next.split!.agents]
        .every(/* 最新解析的执行角色配置，检查其是否采用更新后的共享模型。 */ agent => /* 确认重新解析的全部 Agent 使用更新后的共享提供方和模型。 */  agent.provider === llm.provider && agent.model === llm.model)).toBe(true)
      expect(next.split!.agents.map(/* 已解析的拆分 Agent，提取陈述类别和优先级检查元数据保留。 */ agent => /* 提取拆分 Agent 的类别与优先级，核对元数据不受默认模型变化影响。 */  [agent.claimCategory, agent.defaultPriority]))
        .toEqual([['data', 'high'], ['quote', 'medium'], ['causal', 'low']])
      expect(frozen.router).toMatchObject(bootstrap.settings.llm)
      expect(frozen.router.model).not.toBe(next.router.model)
    } finally { await freshConnection.close() }
  })

  it('freezes custom split and parse profiles with their full metadata and never substitutes library profiles at runtime', async () => {
    // 验证工作区自定义解析/拆分配置完整保留，运行时不替换成共享库配置且旧快照隔离。
    const workspace = await controlTestWorkspace(ownerToken)
    const scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const list = await controlTestRead(ownerToken, { method: 'agent.list', params: { scope } }) as AgentList
    const original = list.items.find(/* 工作区候选 Agent，选择拆分子角色作为自定义更新目标。 */ agent => /* 选择工作区拆分子 Agent 作为自定义更新目标。 */  agent.kind === 'splitSubAgent')!
    const agent = { ...controlTestAgent(original), content: 'Custom {{content}}', tools: ['archive_lookup'],
      provider: 'split-provider', model: 'split-model', promptVars: ['content', 'hint'], defaultPriority: 'low' as const, claimCategory: 'quote' as const }
    const updated = (await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: list.revision,
      agentId: original.id, expectedAgentRevision: original.revision, agent })).data as AgentList
    const frozen = await control.configuration(await auth.read(ownerToken), workspace.id)
    expect(frozen.parse).toMatchObject({ promptVars: ['rawContent'] })
    expect(frozen.split!.agents.find(/* 旧配置中的拆分候选 Agent，按更新目标编号定位并核对元数据。 */ profile => /* 从已取得的拆分配置中寻找目标 Agent，核对完整元数据。 */  profile.id === original.id)).toMatchObject({
      content: agent.content, tools: agent.tools, provider: agent.provider, model: agent.model,
      promptVars: agent.promptVars, defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
    })
    const current = updated.items.find(/* 更新响应中的候选 Agent，用于取得下一次修改所需版本。 */ profile => /* 取得更新响应中的 Agent 版本，用于下一次条件更新。 */  profile.id === original.id)!
    await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: updated.revision,
      agentId: original.id, expectedAgentRevision: current.revision, agent: { ...agent, content: 'Changed later' } })
    expect(frozen.split!.agents.find(/* 已保存旧快照中的拆分候选，验证后续修改不会反向污染内容。 */ profile => /* 定位旧配置中的拆分 Agent，确认后续修改不会反向改变旧快照。 */  profile.id === original.id)!.content).toBe(agent.content)
    expect((await control.configuration(await auth.read(ownerToken), workspace.id)).split!.agents.find(/* 最新读取配置中的拆分候选，验证第二次修改已可见。 */ profile => /* 定位新读取配置中的拆分 Agent，确认后续修改已可见。 */  profile.id === original.id)!.content).toBe('Changed later')
  })
})
