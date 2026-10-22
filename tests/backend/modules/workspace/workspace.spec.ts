// 通过 Mongo 事务验证工作区权限、幂等收据、成员约束与 Agent 配置继承及快照隔离。
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { randomUUID } from 'node:crypto'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentInput, AgentList, AgentProfile, AppBootstrap, ControlCommand, ControlQuery, DefinitionPublishResult, DefinitionView, LibraryDefinitionView, Preferences, WorkspaceView } from '../../../../contracts/control'
import type { DefinitionPackage, ExecutionCatalog } from '../../../../contracts/data-definition'
import type { GraphAgentProfile } from '../../../../contracts/graph-agent'
import { authCreateService, type AuthService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService, type ControlService, type WorkspaceDocument } from '../../../../backend/modules/workspace/workspace-service'
import { controlReadAgent, controlReadCommand, controlReadQuery } from '../../../../backend/modules/workspace/workspace-input'
import { GRAPH_COLLECTION } from '../../../../backend/modules/graph/graph-record'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { verificationConfiguration } from '../../fixtures/verification'
import { DEFAULT_DEFINITION_PACKAGE, DEFAULT_WORKSPACE_SEED } from '../../../../apps/config/default-prompts'

// 工作区用例直接构造的最小图记录；UUID 字符串主键不采用 Mongo 默认的 ObjectId。
interface ControlTestGraph {
  _id: string
  workspaceId: string
  nodes: Array<{ id: string }>
  runs?: Array<{ status: string }>
}

interface ControlTestLibrary {
  _id: string
  revision: number
  writeFence: number
  receipts: unknown[]
  definitionPackages?: DefinitionPackage[]
}

function controlTestDefinitionPackage(): DefinitionPackage {
  // 每个用例使用独立的包和类型身份，不改变默认库或其它工作区的发布记录。
  const id = `fixture.c13-${randomUUID()}`
  return { id, version: 1, title: 'C13独立定义', schemaDialect: 'http://json-schema.org/draft-07/schema#',
    dependencies: { packages: [], agents: [] }, transitions: [], dataTypes: [{ id: `${id}.note`, version: 1, title: '独立笔记',
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      successorTypes: [], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] } }] }
}

function controlTestBoundAgent(
  /* 此用例覆盖的已发布绑定、职责或变量；其余输入使用独立通用配置。 */ changes: Partial<AgentInput> = {},
): AgentInput {
  // 通用配置使用独立身份和路径，绑定已有阶段但不要求成为该阶段当前执行者。
  const id = randomUUID()
  return { id, name: 'C14通用智能体', description: '参与已发布的精确阶段', content: '按保存阶段合同完成处理。',
    kind: 'generic', promptPath: `custom/${id}`, provider: null, model: null, tools: [], promptVars: [],
    defaultPriority: 'medium', claimCategory: null, role: 'producer',
    bindings: [{ transition: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'assess' }], ...changes }
}

async function controlTestLibraryRecord(): Promise<ControlTestLibrary> {
  // 独立读取实际存储，核对只读查询没有修改revision、授权栅栏或收据。
  const database = connection.db
  if (!database) throw new Error('Workspace fixture database is missing')
  const record = await database.collection<ControlTestLibrary>('control_library').findOne({ _id: 'global' })
  if (!record) throw new Error('Workspace fixture library is missing')
  return record
}

async function controlTestWorkspaceRecord(
  /* 此用例自有工作区身份，用于核对失败事务没有部分写入。 */ workspaceId: string,
): Promise<WorkspaceDocument> {
  // 读取完整真实工作区记录，连同包、收据和授权栅栏一起核对事务原子性。
  const database = connection.db
  if (!database) throw new Error('Workspace fixture database is missing')
  const record = await database.collection<WorkspaceDocument>('control_workspaces').findOne({ _id: workspaceId })
  if (!record) throw new Error('Workspace fixture workspace is missing')
  return record
}

let replica: MongoMemoryReplSet
let connection: Connection
let auth: AuthService
let control: ControlService
const ownerId = randomUUID(), otherId = randomUUID(), viewerId = randomUUID(), adminId = randomUUID()
let ownerToken: string, otherToken: string, viewerToken: string, adminToken: string

/**
 * 在指定令牌的认证事务中提交已解析的管理命令，并允许测试复用请求编号。
 *
 * @param token 执行管理写入的测试用户令牌，用真实认证事务建立权限上下文。
 * @param method 本用例要提交的公开管理命令名。
 * @param params 待测试的原始命令参数，先走真实输入解析器，允许构造无效值场景。
 * @param requestId 可复用的幂等请求编号，省略时为本次调用新建 UUID。
 */
async function controlTestCommand(token: string, method: ControlCommand['method'], params: unknown, requestId = randomUUID()) {
  return auth.transact(token, ctx => /* 使用当前事务身份执行通过输入验证的管理命令。 */  control.dispatch(ctx, controlReadCommand({ requestId, method, params })))
}
/**
 * 读取令牌身份后执行管理查询，复用真实权限检查。
 *
 * @param token 发起管理查询的测试用户令牌。
 * @param query 已按公共协议构造的管理查询对象。
 */
async function controlTestRead(token: string, query: ControlQuery) {
   return control.read(await auth.read(token), query) }
/**
 * 以指定用户创建随机编号工作区，可选择空配置或复制共享 Agent 库。
 *
 * @param token 创建工作区的测试令牌，缺省为 Owner 身份。
 * @param agentSource 新工作区的 Agent 来源策略，缺省复制共享库，也可显式选空配置。
 */
async function controlTestWorkspace(token = ownerToken, agentSource: 'empty' | 'library' = 'library'): Promise<WorkspaceView> {
  return (await controlTestCommand(token, 'workspace.create', { id: randomUUID(), name: 'Control test', description: '', agentSource })).data as WorkspaceView
}
/**
 * 移除服务端管理的版本及更新时间，把 Agent 资料转换为可提交输入。
 *
 * @param profile 服务端返回的 Agent 资料，去掉只读元数据后生成提交输入。
 */
function controlTestAgent(profile: AgentProfile): AgentInput {
  const { revision: _revision, deletable: _deletable, updatedAt: _updatedAt, ...input } = profile
  return input
}
async function controlTestLibrary(): Promise<AgentList> {
  // 以管理员身份读取共享 Agent 库及其当前版本。
  return await controlTestRead(adminToken, { method: 'agent.list', params: { scope: { kind: 'library' } } }) as AgentList
}

function controlTestExecutionProfile(
  /* 本次已读取的精确执行目录，包含历史和当前 Agent 版本。 */ catalog: ExecutionCatalog,
  /* 需要核对的已保存 Agent 身份和内容版本。 */ agent: Pick<AgentProfile, 'id' | 'revision'>,
): GraphAgentProfile {
  // 根据精确引用取得执行快照，避免误把历史版本当成当前配置。
  const definition = catalog.agents.find(
    /* 执行目录中的一个精确配置版本。 */ item =>
      /* 同时匹配 Agent 身份与内容版本。 */ item.ref.id === agent.id && item.ref.version === agent.revision,
  )
  if (!definition) throw new Error('Fixture execution profile is missing')
  return definition.profile
}

beforeAll(async () => {
  // 启动隔离 Mongo 副本集并初始化身份、共享配置与四种测试用户令牌。
  replica = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  connection = await storeCreateConnection(replica.getUri(`control_${randomUUID().replace(/-/g, '')}`))
  auth = authCreateService(persistenceCreateMongo(connection))
  control = controlCreateService(persistenceCreateMongo(connection), DEFAULT_WORKSPACE_SEED)
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
  it.each(['customKind', 'toString', 'constructor'])('keeps custom Agent kind %s outside the legacy variable table', (
    /* 不属于已登记旧角色、但满足管理协议名称格式的自定义 kind。 */ kind,
  ) => {
    // 原型上的函数不属于旧角色变量表，自定义 kind 继续沿通用协议保留显式变量。
    const input: AgentInput = { id: 'custom-agent', name: 'Custom', description: '自定义配置', content: '执行自定义阶段',
      tools: [], provider: null, model: null, promptPath: 'custom/agent', kind,
      promptVars: ['customText'], defaultPriority: 'medium', claimCategory: null }
    expect(controlReadAgent(input)).toEqual(input)
  })

  it('strictly validates Agent metadata and rejects undeclared credential and endpoint fields', async () => {
    // 验证 Agent 元数据严格校验，拒绝凭据和端点字段，公开元数据不暴露授权字段。
    const profile = (await controlTestLibrary()).items.find(agent => /* 选择核验子 Agent 作为输入验证基准。 */  agent.kind === 'verifySubAgent')!
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
    expect(Object.keys(bootstrap.metadata).sort()).toEqual(['capabilities', 'clientLeases', 'variables'])
    expect(bootstrap.metadata.capabilities).toEqual({ evidenceLibrary: false, mapRename: true, publicationPreview: true, runHistory: true, libraryDefinitions: true, modelConnections: true })
  })

  it('validates bound Agent variables against exact stages while retaining unbound kind rules', async () => {
    // 已知旧 kind 也能使用绑定阶段的自定义变量；缺失绑定、错误角色组合和未声明变量仍被拒绝。
    const workspace = await controlTestWorkspace()
    const scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const original = workspace.agents.find(
      /* 初始工作区中的一个 Agent。 */ agent => /* 使用旧 kind 验证它不再覆盖通用绑定许可。 */ agent.kind === 'verifySubAgent',
    )
    if (!original) throw new Error('Fixture Agent is missing')
    const view = await controlTestRead(ownerToken, { method: 'definition.get', params: { workspaceId: workspace.id } }) as DefinitionView
    const source = view.catalog.transitions.find(
      /* 工作区当前发布的一个转换。 */ transition => /* 复制单阶段解析定义以添加独立变量。 */ transition.id === 'factcheck.parse-source',
    )
    if (!source) throw new Error('Fixture parse transition is missing')
    const transition = structuredClone(source)
    transition.id = 'test.custom-agent-variables'
    transition.execution.stages[0].promptBindings = { ...transition.execution.stages[0].promptBindings,
      customText: { source: 'source-text', port: 'source', path: '/locator' } }
    const packageItem: DefinitionPackage = { id: 'test.agent-variables', version: 1, title: 'Custom variables',
      schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [], transitions: [transition],
      dependencies: { packages: view.catalog.packages.map(
        /* 当前工作区默认包的精确发布记录。 */ item => /* 声明所复制转换使用的类型依赖。 */ item.ref,
      ), agents: [transition.execution.stages[0].agentRef] } }
    const published = (await controlTestCommand(ownerToken, 'definition.publish', {
      workspaceId: workspace.id, expectedRevision: workspace.revision, package: packageItem,
    })).data as DefinitionPublishResult
    const bound: AgentInput = { ...controlTestAgent(original), role: 'producer', promptVars: ['customText'],
      bindings: [{ transition: { id: transition.id, version: transition.version }, stageId: transition.execution.stages[0].id }] }
    const saved = (await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: published.workspaceRevision,
      agentId: original.id, expectedAgentRevision: original.revision, agent: bound })).data as AgentList
    const current = saved.items.find(
      /* 保存响应中的一个 Agent。 */ agent => /* 定位已接受自定义阶段变量的配置。 */ agent.id === original.id,
    )
    if (!current) throw new Error('Saved bound Agent is missing')
    expect(current).toMatchObject({ role: 'producer', bindings: bound.bindings, promptVars: ['customText'] })
    await expect(controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: saved.revision,
      agentId: current.id, expectedAgentRevision: current.revision, agent: { ...bound, promptVars: ['undeclared'] } }))
      .rejects.toMatchObject({ code: 'DEFINITION_INVALID' })
    expect(() => /* 缺少角色时不能借 bindings 绕过组合验证。 */ controlReadAgent({ ...bound, role: undefined })).toThrow(/provided together/)
    expect(() => /* 缺少绑定时不能借 role 绕过组合验证。 */ controlReadAgent({ ...bound, bindings: undefined })).toThrow(/provided together/)
    expect(() => /* 两项都缺失时继续执行旧 kind 白名单验证。 */ controlReadAgent({ ...bound, role: undefined, bindings: undefined })).toThrow(/not available/)
  })

  it.each(['review.part', 's'.repeat(128)])('binds a new Agent to a genuinely published stage named %s', async (/* 定义协议允许的带点号或128字符阶段名。 */ stageId) => {
    // 先真实发布合法阶段，再通过管理输入创建绑定，防止测试只绕过定义校验拼装目录。
    const workspace = await controlTestWorkspace()
    const view = await controlTestRead(ownerToken, { method: 'definition.get', params: { workspaceId: workspace.id } }) as DefinitionView
    const source = view.catalog.transitions.find(
      /* 当前工作区真实发布的转换。 */ item => /* 单阶段来源解析可独立更名而无依赖重写。 */ item.id === 'factcheck.parse-source',
    )
    if (!source) throw new Error('Fixture parse transition is missing')
    const transition = structuredClone(source), stage = transition.execution.stages[0]
    if (!stage) throw new Error('Fixture parse stage is missing')
    transition.id = `fixture.c14-${randomUUID()}`
    stage.id = stageId
    transition.execution.resultStage = stageId
    const packageItem: DefinitionPackage = { id: `${transition.id}.package`, version: 1, title: 'C14合法阶段引用',
      schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes: [], transitions: [transition],
      dependencies: { packages: view.catalog.packages.map(
        /* 当前工作区精确包引用。 */ item => /* 所有端口类型继续通过已发布包获得。 */ item.ref,
      ), agents: [stage.agentRef] } }
    const published = (await controlTestCommand(ownerToken, 'definition.publish', {
      workspaceId: workspace.id, expectedRevision: workspace.revision, package: packageItem,
    })).data as DefinitionPublishResult
    const exact = await controlTestRead(ownerToken, { method: 'definition.get', params: {
      workspaceId: workspace.id, packageId: packageItem.id, packageVersion: 1,
    } }) as DefinitionView
    expect(exact.package?.transitions[0]?.execution.stages[0]?.id).toBe(stageId)
    const before = await controlTestWorkspaceRecord(workspace.id)
    const agent = controlTestBoundAgent({ bindings: [{ transition: { id: transition.id, version: 1 }, stageId }] })
    expect(agent.id).not.toBe(stage.agentRef.id)
    const saved = (await controlTestCommand(ownerToken, 'agent.create', { scope: { kind: 'workspace', workspaceId: workspace.id },
      expectedRevision: published.workspaceRevision, agent })).data as AgentList
    expect(saved.items.find(
      /* 真实保存响应中的配置。 */ item => /* 按新身份找到本次建立的通用Agent。 */ item.id === agent.id,
    )).toMatchObject({ revision: 0, role: 'producer', bindings: agent.bindings })
    const after = await controlTestWorkspaceRecord(workspace.id)
    expect(after.definitionPackages).toEqual(before.definitionPackages)
    expect(after.revision).toBe(before.revision + 1)
  })

  it.each([
    { role: 'producer', transitionId: 'factcheck.verify-claim', stageId: 'assess' },
    { role: 'planner', transitionId: 'factcheck.verify-claim', stageId: 'route' },
    { role: 'selector', transitionId: 'factcheck.split-news', stageId: 'merge' },
  ] as const)('creates and updates a generic $role bound to an existing stage without activating it', async (/* 此职责已有的精确转换及阶段。 */ choice) => {
    // 三类配置均从版本0建立，更新生成新revision且不改旧转换执行者或冻结配置。
    const workspace = await controlTestWorkspace(), scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const frozen = await control.executionCatalog(await auth.read(ownerToken), workspace.id)
    const transition = frozen.definitions.transitions.find(
      /* 冻结目录中的已发布转换。 */ item => /* 精确定位本职责现成阶段。 */ item.id === choice.transitionId && item.version === 1,
    )
    const stage = transition?.execution.stages.find(
      /* 当前转换中的真实阶段。 */ item => /* 按已声明阶段身份核对原执行者。 */ item.id === choice.stageId,
    )
    if (!stage) throw new Error('Fixture role stage is missing')
    const agent = controlTestBoundAgent({ role: choice.role,
      bindings: [{ transition: { id: choice.transitionId, version: 1 }, stageId: choice.stageId }] })
    expect(stage.agentRef.id).not.toBe(agent.id)
    const created = (await controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: workspace.revision, agent })).data as AgentList
    const first = created.items.find(
      /* 创建成功返回的当前配置。 */ item => /* 新配置应以版本0保存。 */ item.id === agent.id,
    )
    if (!first) throw new Error('Created generic Agent is missing')
    expect(first).toMatchObject({ revision: 0, role: choice.role, bindings: agent.bindings, deletable: true })
    const next = (await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision,
      agentId: first.id, expectedAgentRevision: first.revision, agent: { ...controlTestAgent(first), name: '通用配置新版本' } })).data as AgentList
    expect(next.items.find(
      /* 更新成功返回的配置。 */ item => /* 元数据更新保留完整精确绑定。 */ item.id === first.id,
    )).toMatchObject({ revision: 1, role: choice.role, bindings: first.bindings })
    const current = await control.executionCatalog(await auth.read(ownerToken), workspace.id)
    expect(current.definitions).toEqual({ ...frozen.definitions, revision: next.revision })
    for (const oldAgent of frozen.agents) expect(current.agents.find(
      /* 当前目录中的一个精确执行快照。 */ item => /* 已发布旧配置仍保留同一精确版本。 */ item.ref.id === oldAgent.ref.id && item.ref.version === oldAgent.ref.version,
    )).toEqual(oldAgent)
  })

  it('rejects invalid generic bindings and prompt variables without any partial Agent or receipt write', async () => {
    // 边界组合与目录存在性由原真实管理流程校验，失败事务连授权栅栏也不提交。
    const workspace = await controlTestWorkspace(), before = await controlTestWorkspaceRecord(workspace.id)
    const base = controlTestBoundAgent({ promptVars: ['claimContent'] })
    const binding = base.bindings?.[0]
    if (!binding) throw new Error('Fixture generic binding is missing')
    const cases = [
      { changes: { bindings: [] }, code: 'INVALID_ARGUMENT' },
      { changes: { bindings: [binding, structuredClone(binding)] }, code: 'INVALID_ARGUMENT' },
      { changes: { bindings: [{ ...binding, transition: { ...binding.transition, version: 999 } }] }, code: 'DEFINITION_NOT_FOUND' },
      { changes: { bindings: [{ ...binding, stageId: 'not-published' }] }, code: 'DEFINITION_INVALID' },
      { changes: { role: 'planner' }, code: 'DEFINITION_INVALID' },
      { changes: { promptVars: ['notDeclared'] }, code: 'DEFINITION_INVALID' },
      { changes: { promptVars: ['context'], bindings: [binding, { ...binding, stageId: 'merge' }] }, code: 'DEFINITION_INVALID' },
    ] satisfies Array<{ changes: Partial<AgentInput>; code: string }>
    for (const attempt of cases) {
      await expect(controlTestCommand(ownerToken, 'agent.create', { scope: { kind: 'workspace', workspaceId: workspace.id },
        expectedRevision: workspace.revision, agent: { ...base, ...attempt.changes } })).rejects.toMatchObject({ code: attempt.code })
      expect(await controlTestWorkspaceRecord(workspace.id)).toEqual(before)
    }
    const saved = (await controlTestCommand(ownerToken, 'agent.create', { scope: { kind: 'workspace', workspaceId: workspace.id },
      expectedRevision: workspace.revision, agent: { ...base, promptVars: ['claimContent'], bindings: [binding, { ...binding, stageId: 'merge' }] } })).data as AgentList
    expect(saved.items.find(
      /* 成功保存的多阶段通用配置。 */ item => /* 变量同时为两个同职责阶段允许才可保存。 */ item.id === base.id,
    )).toMatchObject({ role: 'producer', promptVars: ['claimContent'], bindings: [binding, { ...binding, stageId: 'merge' }] })
  })

  it('keeps id, kind and promptPath immutable when editing a saved generic Agent', async () => {
    // 新通用配置同样遵守原身份锁，职责字段不会被误写成kind身份修改。
    const workspace = await controlTestWorkspace(), scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const agent = controlTestBoundAgent()
    const created = (await controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: workspace.revision, agent })).data as AgentList
    const before = await controlTestWorkspaceRecord(workspace.id)
    for (const field of ['id', 'kind', 'promptPath'] as const) {
      await expect(controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision,
        agentId: agent.id, expectedAgentRevision: 0, agent: { ...agent, [field]: `${agent[field]}-changed` } }))
        .rejects.toMatchObject({ code: 'AGENT_IDENTITY_CHANGED' })
      expect(await controlTestWorkspaceRecord(workspace.id)).toEqual(before)
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
    await connection.db!.collection<ControlTestGraph>(GRAPH_COLLECTION).insertOne({ _id: mapId, workspaceId: id, nodes: [], runs: [{ status: 'running' }] })
    await expect(controlTestCommand(ownerToken, 'workspace.delete', { workspaceId: id, expectedRevision: 2 }))
      .rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    await connection.db!.collection<ControlTestGraph>(GRAPH_COLLECTION).updateOne({ _id: mapId }, { $set: { 'runs.0.status': 'completed' } })
    const deletionId = randomUUID()
    expect(await controlTestCommand(ownerToken, 'workspace.delete', { workspaceId: id, expectedRevision: 2 }, deletionId))
      .toMatchObject({ data: { workspaceId: id, deleted: true }, replayed: false })
    expect(await controlTestCommand(ownerToken, 'workspace.delete', { workspaceId: id, expectedRevision: 2 }, deletionId))
      .toMatchObject({ data: { workspaceId: id, deleted: true }, replayed: true })
    await expect(controlTestRead(ownerToken, { method: 'workspace.get', params: { workspaceId: id } })).rejects.toMatchObject({ status: 404 })
    await expect(controlTestCommand(ownerToken, 'workspace.create', params)).rejects.toMatchObject({ status: 410 })
  })

  it('copies the default definition catalog and publishes immutable packages with workspace CAS', async () => {
    // 验证新工作区取得已重绑 Agent 的默认目录，并按 Owner、版本和幂等收据发布新包。
    const workspace = await controlTestWorkspace()
    const defaults = await controlTestRead(ownerToken, { method: 'definition.get', params: { workspaceId: workspace.id } }) as DefinitionView
    expect(defaults.catalog).toMatchObject({ revision: 0 })
    expect(defaults.catalog.dataTypes).toHaveLength(DEFAULT_DEFINITION_PACKAGE.dataTypes.length)
    expect(defaults.catalog.transitions).toHaveLength(DEFAULT_DEFINITION_PACKAGE.transitions.length)
    const exact = await controlTestRead(ownerToken, { method: 'definition.get', params: {
      workspaceId: workspace.id, packageId: DEFAULT_DEFINITION_PACKAGE.id, packageVersion: DEFAULT_DEFINITION_PACKAGE.version,
    } }) as DefinitionView
    expect(exact.package).toMatchObject({ id: DEFAULT_DEFINITION_PACKAGE.id, version: DEFAULT_DEFINITION_PACKAGE.version })
    const packageItem: DefinitionPackage = {
      id: 'example.notes', version: 1, title: 'Notes', schemaDialect: 'http://json-schema.org/draft-07/schema#',
      dataTypes: [{
        id: 'example.note', version: 1, title: 'Note', schema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
        successorTypes: [], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] },
      }], transitions: [], dependencies: { packages: [], agents: [] },
    }
    const requestId = randomUUID()
    const published = await controlTestCommand(ownerToken, 'definition.publish', { workspaceId: workspace.id, expectedRevision: 0, package: packageItem }, requestId)
    expect(published).toMatchObject({ replayed: false, data: { workspaceId: workspace.id, workspaceRevision: 1,
      package: { ref: { id: packageItem.id, version: packageItem.version } } } })
    expect(await controlTestCommand(ownerToken, 'definition.publish', { workspaceId: workspace.id, expectedRevision: 0, package: packageItem }, requestId))
      .toMatchObject({ replayed: true, data: published.data as DefinitionPublishResult })
    const changed = structuredClone(packageItem); changed.title = 'Changed'
    await expect(controlTestCommand(ownerToken, 'definition.publish', { workspaceId: workspace.id, expectedRevision: 1, package: changed }))
      .rejects.toMatchObject({ code: 'DEFINITION_VERSION_CONFLICT' })
    await expect(controlTestRead(otherToken, { method: 'definition.get', params: { workspaceId: workspace.id } }))
      .rejects.toMatchObject({ status: 404 })
    const current = await controlTestRead(ownerToken, { method: 'definition.get', params: { workspaceId: workspace.id } }) as DefinitionView
    expect(current.catalog.dataTypes.some(type => /* 按精确类型身份确认发布结果可读。 */ type.id === 'example.note' && type.version === 1)).toBe(true)
  })

  it('reads actual shared definitions for an authenticated non-administrator without mixing a private workspace package', async () => {
    // 共享读取不要求工作区成员或管理员，目录取真实库，工作区新包不会串入。
    const workspace = await controlTestWorkspace(), packageItem = controlTestDefinitionPackage()
    await controlTestCommand(ownerToken, 'definition.publish', { workspaceId: workspace.id, expectedRevision: workspace.revision, package: packageItem })
    const stored = await controlTestLibraryRecord()
    const libraryView = await controlTestRead(otherToken, { method: 'definition.library.get', params: {} }) as LibraryDefinitionView
    expect(libraryView.scope).toEqual({ kind: 'library' })
    expect(libraryView.catalog.revision).toBe(stored.revision)
    expect(libraryView.catalog.packages).toHaveLength(stored.definitionPackages?.length ?? 0)
    expect(libraryView.catalog.packages.some((/* 已发布的共享包摘要。 */ item) => /* 工作区独有包不属于共享库。 */ item.ref.id === packageItem.id)).toBe(false)
    const privateView = await controlTestRead(ownerToken, { method: 'definition.get', params: { workspaceId: workspace.id } }) as DefinitionView
    expect(privateView.catalog.packages.some((/* 工作区已发布包摘要。 */ item) => /* 同一独有包在正确作用域可见。 */ item.ref.id === packageItem.id)).toBe(true)
    await expect(controlTestRead(otherToken, { method: 'definition.get', params: { workspaceId: workspace.id } })).rejects.toMatchObject({ status: 404 })
  })

  it('returns the exact shared package as an independent copy and never falls back to another version or workspace', async () => {
    // 读取精确包不默认latest；修改返回副本不改变共享保存内容。
    const stored = await controlTestLibraryRecord(), original = stored.definitionPackages?.[0]
    if (!original) throw new Error('Fixture shared definition package is missing')
    const query = { method: 'definition.library.get' as const, params: { packageId: original.id, packageVersion: original.version } }
    const exact = await controlTestRead(viewerToken, query) as LibraryDefinitionView
    expect(exact.package).toEqual(original)
    if (!exact.package) throw new Error('Exact shared package is missing')
    exact.package.title = 'Changed only in the returned view'
    exact.catalog.dataTypes.splice(0)
    const reread = await controlTestRead(viewerToken, query) as LibraryDefinitionView
    expect(reread.package).toEqual(original)
    expect(reread.catalog.dataTypes.length).toBeGreaterThan(0)
    await expect(controlTestRead(viewerToken, { method: 'definition.library.get', params: { packageId: original.id, packageVersion: original.version + 1 } }))
      .rejects.toMatchObject({ status: 404, code: 'DEFINITION_NOT_FOUND' })
    await expect(controlTestRead(viewerToken, { method: 'definition.library.get', params: { packageId: 'fixture.not-published', packageVersion: 1 } }))
      .rejects.toMatchObject({ status: 404, code: 'DEFINITION_NOT_FOUND' })
  })

  it('keeps repeated shared catalog and exact reads free of revision, fence and receipt writes', async () => {
    // 同时读取目录和精确包也不取得写授权，不调用用于复制的库栅栏步骤。
    const before = await controlTestLibraryRecord(), original = before.definitionPackages?.[0]
    if (!original) throw new Error('Fixture shared definition package is missing')
    for (const token of [ownerToken, otherToken, viewerToken]) {
      await controlTestRead(token, { method: 'definition.library.get', params: {} })
      await controlTestRead(token, { method: 'definition.library.get', params: { packageId: original.id, packageVersion: original.version } })
    }
    expect(await controlTestLibraryRecord()).toEqual(before)
  })

  it('requires authentication before shared definition reads', async () => {
    // 共享可见性不等于匿名接口，认证失败在进入管理读取之前拒绝。
    await expect(controlTestRead('not-a-valid-token', { method: 'definition.library.get', params: {} }))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' })
  })

  it('accepts only paired exact shared package parameters and an empty directory query', () => {
    // 共享目录不接收工作区身份，精确包与工作区get使用同样的正版本规则。
    expect(controlReadQuery({ method: 'definition.library.get', params: {} })).toEqual({ method: 'definition.library.get', params: {} })
    expect(controlReadQuery({ method: 'definition.library.get', params: { packageId: 'fixture.exact-package', packageVersion: 1 } }))
      .toEqual({ method: 'definition.library.get', params: { packageId: 'fixture.exact-package', packageVersion: 1 } })
  })

  it.each([
    { packageId: 'fixture.exact-package' }, { packageVersion: 1 },
    { packageId: 'fixture.exact-package', packageVersion: 0 }, { packageId: 'fixture.exact-package', packageVersion: 1.5 },
    { packageId: 'fixture.exact-package', packageVersion: '1' }, { workspaceId: 'borrowed-workspace' },
  ])('rejects malformed shared definition query parameters %# without treating them as an unknown method', (/* 不符合共享精确查询合同的原始参数。 */ params) => {
    // 缺参数、错版本或多字段必须归为输入错误，不能因为目录方法缺失而假通过。
    expect(() => /* 在真实管理输入边界解析本次畸形参数。 */ controlReadQuery({ method: 'definition.library.get', params }))
      .toThrowError(expect.objectContaining({ status: 400, code: 'INVALID_ARGUMENT' }))
  })

  it('preserves the full workspace record when publication fails dependencies, immutable versions, permissions or revision checks', async () => {
    // 已有发布规则作实际事务绿对照，每次失败均不留下包、收据或授权栅栏的部分提交。
    const workspace = await controlTestWorkspace(), packageItem = controlTestDefinitionPackage()
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: viewerId, role: 'viewer' })
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 1, userId: otherId, role: 'editor' })
    const published = await controlTestCommand(ownerToken, 'definition.publish', { workspaceId: workspace.id, expectedRevision: 2, package: packageItem })
    expect(published.data).toMatchObject({ workspaceRevision: 3 })
    expect((await controlTestRead(viewerToken, { method: 'definition.get', params: { workspaceId: workspace.id } }) as DefinitionView).catalog.revision).toBe(3)
    const before = await controlTestWorkspaceRecord(workspace.id)
    const missingDependency = controlTestDefinitionPackage()
    missingDependency.dependencies.packages = [{ id: 'fixture.missing-dependency', version: 1 }]
    const repeatedDefinitions = { ...packageItem, version: 2 }
    const cases = [
      { token: ownerToken, expectedRevision: 3, package: missingDependency, code: 'DEFINITION_NOT_FOUND' },
      { token: ownerToken, expectedRevision: 3, package: repeatedDefinitions, code: 'DEFINITION_INVALID' },
      { token: ownerToken, expectedRevision: 3, package: { ...packageItem, title: 'Changed immutable version' }, code: 'DEFINITION_VERSION_CONFLICT' },
      { token: ownerToken, expectedRevision: 2, package: controlTestDefinitionPackage(), code: 'REVISION_CONFLICT' },
      { token: viewerToken, expectedRevision: 3, package: controlTestDefinitionPackage(), code: 'FORBIDDEN' },
      { token: otherToken, expectedRevision: 3, package: controlTestDefinitionPackage(), code: 'FORBIDDEN' },
    ]
    for (const attempt of cases) {
      await expect(controlTestCommand(attempt.token, 'definition.publish', { workspaceId: workspace.id, expectedRevision: attempt.expectedRevision, package: attempt.package }))
        .rejects.toMatchObject({ code: attempt.code })
      expect(await controlTestWorkspaceRecord(workspace.id)).toEqual(before)
    }
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
    expect(results.filter(result => /* 统计并发成员变更中成功提交的事务。 */  result.status === 'fulfilled')).toHaveLength(1)
    const doc = await connection.db!.collection<WorkspaceDocument>('control_workspaces').findOne({ _id: workspace.id })
    expect(doc!.members.filter(member => /* 统计持久化成员中仍保留 Owner 角色的人数。 */  member.role === 'owner')).toHaveLength(1)
    expect(doc!.revision).toBe(2)
  })

  it('touches the authorization fence without changing public revision and isolates validated preferences', async () => {
    // 验证授权栅栏不改变公开版本，个人偏好独立，且幂等冲突、旧版本和跨工作区引用均不覆盖已保存偏好。
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: viewerId, role: 'viewer' })
    const collection = connection.db!.collection<WorkspaceDocument>('control_workspaces')
    const before = (await collection.findOne({ _id: workspace.id }))!
    await auth.transact(viewerToken, ctx => /* 在事务中取得 viewer 授权，以观察授权栅栏的持久化副作用。 */  control.requireRole(ctx, workspace.id, 'viewer'))
    const touched = (await collection.findOne({ _id: workspace.id }))!
    expect(touched.revision).toBe(before.revision)
    expect(touched.writeFence).toBe(before.writeFence + 1)
    const mapId = randomUUID(), nodeId = randomUUID(), foreignMapId = randomUUID()
    await connection.db!.collection<ControlTestGraph>(GRAPH_COLLECTION).insertMany([
      { _id: mapId, workspaceId: workspace.id, nodes: [{ id: nodeId }] },
      { _id: foreignMapId, workspaceId: randomUUID(), nodes: [] },
    ])
    const params = { workspaceId: workspace.id, expectedRevision: 0, openMapIds: [mapId], currentMapId: mapId, nodeSelection: { [mapId]: nodeId } }
    const requestId = randomUUID()
    const changed = await controlTestCommand(viewerToken, 'preferences.set', params, requestId)
    expect(changed.data).toMatchObject({ revision: 1, currentMapId: mapId })
    expect(await controlTestCommand(viewerToken, 'preferences.set', params, requestId)).toMatchObject({ replayed: true, data: changed.data })
    await expect(controlTestCommand(viewerToken, 'preferences.set', { ...params, currentMapId: null }, requestId))
      .rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(controlTestCommand(viewerToken, 'preferences.set', params))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 1 })
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
    const sourceAgent = source.items.find(agent => /* 定位用于复制更新的共享核验子 Agent。 */  agent.kind === 'verifySubAgent')!
    const copy = workspace.agents.find(agent => /* 按提示词路径找到工作区中的独立副本。 */  agent.promptPath === sourceAgent.promptPath)!
    expect(copy.id).not.toBe(sourceAgent.id)
    const frozen = await control.executionCatalog(await auth.read(ownerToken), workspace.id)
    expect(controlTestExecutionProfile(frozen, copy)).toMatchObject({
      promptVars: copy.promptVars, defaultPriority: copy.defaultPriority, claimCategory: copy.claimCategory,
    })
    const update = { scope: { kind: 'library' }, expectedRevision: source.revision, agentId: sourceAgent.id,
      expectedAgentRevision: sourceAgent.revision, agent: { ...controlTestAgent(sourceAgent), content: 'Updated library investigation instructions' } }
    await expect(controlTestCommand(ownerToken, 'agent.update', update)).rejects.toMatchObject({ status: 403 })
    const updated = (await controlTestCommand(adminToken, 'agent.update', update)).data as AgentList
    expect(await control.executionCatalog(await auth.read(ownerToken), workspace.id)).toEqual(frozen)
    await expect(controlTestCommand(ownerToken, 'agent.copy', { workspaceId: workspace.id, expectedRevision: 0, libraryRevision: source.revision, agentIds: [sourceAgent.id], mode: 'merge' }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    const copied = (await controlTestCommand(ownerToken, 'agent.copy', { workspaceId: workspace.id, expectedRevision: 0,
      libraryRevision: updated.revision, agentIds: [sourceAgent.id], mode: 'merge' })).data as WorkspaceView
    expect(copied.agents.find(agent => /* 按提示词路径寻找再次复制后的工作区 Agent。 */  agent.promptPath === sourceAgent.promptPath)).toMatchObject({ id: copy.id, revision: copy.revision + 1, content: update.agent.content })
    expect(controlTestExecutionProfile(frozen, copy).content).toBe(copy.content)
    expect(controlTestExecutionProfile(await control.executionCatalog(await auth.read(ownerToken), workspace.id), { id: copy.id, revision: copy.revision + 1 }).content).toBe(update.agent.content)
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
    const original = workspace.agents.find(agent => /* 选择现有核验子 Agent 作为自定义配置基础。 */  agent.kind === 'verifySubAgent')!
    const scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const agent: AgentInput = { ...controlTestAgent(original), id: randomUUID(), promptPath: 'custom/verification', provider: null, model: null, tools: [] }
    const created = (await controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: 0, agent })).data as AgentList
    const item = created.items.find(item => /* 从创建结果中定位新 Agent 及其版本。 */  item.id === agent.id)!
    await expect(controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision, agentId: item.id,
      expectedAgentRevision: item.revision, agent: { ...agent, promptPath: 'another/path' } })).rejects.toMatchObject({ code: 'AGENT_IDENTITY_CHANGED' })
    const updated = (await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision, agentId: item.id,
      expectedAgentRevision: item.revision, agent: { ...agent, name: 'Human-readable custom angle' } })).data as AgentList
    const changed = updated.items.find(profile => /* 从更新结果中取得当前 Agent，用于后续版本条件。 */  profile.id === item.id)!
    expect(changed).toMatchObject({ revision: 1, name: 'Human-readable custom angle' })
    const fixed = updated.items.find(profile => /* 定位不可删除的固定核验路由角色。 */  profile.kind === 'verifyRoute')!
    await expect(controlTestCommand(ownerToken, 'agent.delete', { scope, expectedRevision: updated.revision,
      agentId: fixed.id, expectedAgentRevision: fixed.revision })).rejects.toMatchObject({ code: 'FIXED_ROLE' })
    const bootstrap = await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    const settingParams = { expectedRevision: bootstrap.settings.revision, llm: { provider: 'other-provider', model: 'new-default' },
      tools: bootstrap.settings.tools, limits: bootstrap.settings.limits }
    const requestId = randomUUID()
    await expect(controlTestCommand(ownerToken, 'settings.update', settingParams)).rejects.toMatchObject({ status: 403 })
    await controlTestCommand(adminToken, 'settings.update', settingParams, requestId)
    expect(await controlTestCommand(adminToken, 'settings.update', settingParams, requestId)).toMatchObject({ replayed: true })
    expect(controlTestExecutionProfile(await control.executionCatalog(await auth.read(ownerToken), workspace.id), changed))
      .toMatchObject(settingParams.llm)
    const deleted = (await controlTestCommand(ownerToken, 'agent.delete', { scope, expectedRevision: updated.revision,
      agentId: item.id, expectedAgentRevision: changed.revision })).data as AgentList
    expect(deleted.items.some(profile => /* 检查删除结果中是否仍存在该 Agent。 */  profile.id === item.id)).toBe(false)
    await expect(controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: deleted.revision, agent }))
      .rejects.toMatchObject({ code: 'AGENT_ID_REUSED' })
  })

  it('blocks removal of used tools, keeps seed idempotent, and leaves empty Workspaces explicitly unconfigured', async () => {
    // 验证使用中的工具不可移除，重复播种不改配置，空工作区返回空执行目录，不虚构固定角色配置。
    const bootstrap = await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    await expect(controlTestCommand(adminToken, 'settings.update', { expectedRevision: bootstrap.settings.revision,
      llm: bootstrap.settings.llm, tools: [], limits: bootstrap.settings.limits })).rejects.toMatchObject({ code: 'TOOL_IN_USE' })
    await control.seed()
    expect(await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} })).toEqual(bootstrap)
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    const emptyCatalog = await control.executionCatalog(await auth.read(ownerToken), workspace.id)
    expect(emptyCatalog).toMatchObject({ agents: [], definitions: { transitions: [] } })
    // 空工作区仍保留基础数据类型，缺少 Agent 时不提供可执行转换。
    expect(emptyCatalog.definitions.dataTypes.length).toBeGreaterThan(0)
    const library = await controlTestLibrary()
    expect(library.items.filter(agent => /* 筛出不可删除的固定角色。 */  !agent.deletable).map(agent => /* 提取固定角色类型以核对必要角色清单。 */  agent.kind).sort())
      .toEqual(['parseExtract', 'splitMerge', 'splitRoute', 'verifyMerge', 'verifyRoute'])
    expect(library.items.filter(agent => /* 筛选共享库中的拆分子 Agent。 */  agent.kind === 'splitSubAgent').map(agent => /* 提取拆分 Agent 的陈述类别，核对默认类别覆盖。 */  agent.claimCategory).sort()).toEqual(['causal', 'data', 'quote'])
  })

  it('keeps published Agent versions frozen and resolves shared defaults for new versions', async () => {
    // 验证默认种子保留继承设置，精确旧版本不变，新 Agent 版本采用最新共享模型。
    const explicitLibrary = await controlTestLibrary()
    const explicitConfiguration = verificationConfiguration()
    const explicitRouter = explicitLibrary.items.find(agent => /* 定位显式种子中的核验路由配置。 */  agent.kind === 'verifyRoute')!
    expect(explicitRouter).toMatchObject({ provider: explicitConfiguration.router.provider, model: explicitConfiguration.router.model })

    const freshConnection = await storeCreateConnection(replica.getUri(`control_default_${randomUUID().replace(/-/g, '')}`))
    try {
      const freshAuth = authCreateService(persistenceCreateMongo(freshConnection))
      const freshControl = controlCreateService(persistenceCreateMongo(freshConnection), DEFAULT_WORKSPACE_SEED)
      await freshAuth.initialize()
      await freshControl.initialize()
      await freshControl.seed()
      const userId = randomUUID()
      await freshAuth.createUser({ id: userId, displayName: 'Default configuration owner', hostAdmin: true })
      const token = (await freshAuth.createToken(userId)).token
      const ctx = await freshAuth.read(token)
      const seeded = await freshControl.read(ctx, { method: 'agent.list', params: { scope: { kind: 'library' } } }) as AgentList
      expect(seeded.items.length).toBeGreaterThan(0)
      expect(seeded.items.every(agent => /* 确认默认播种的 Agent 未显式固定提供方或模型。 */  agent.provider === null && agent.model === null)).toBe(true)
      const workspace = await freshAuth.transact(token, context => /* 在新数据库的认证事务中创建复制默认库的工作区。 */  freshControl.createWorkspace(context, {
        id: randomUUID(), name: 'Uses shared defaults', description: '', agentSource: 'library',
      }))
      const frozen = await freshControl.executionCatalog(ctx, workspace.id)
      const bootstrap = await freshControl.read(ctx, { method: 'app.bootstrap', params: {} }) as AppBootstrap
      const llm = { provider: 'new-shared-provider', model: 'new-shared-model' }
      await freshAuth.transact(token, context => /* 在认证事务中更新共享模型设置，触发后续配置解析采用新默认值。 */  freshControl.dispatch(context, {
        requestId: randomUUID(), method: 'settings.update', params: {
          expectedRevision: bootstrap.settings.revision, llm, tools: bootstrap.settings.tools, limits: bootstrap.settings.limits,
        },
      }))
      const next = await freshControl.executionCatalog(ctx, workspace.id)
      // 同一精确版本保持发布时的模型，设置变化不会追溯改写旧快照。
      expect(next.agents).toEqual(frozen.agents)
      const splitAgents = workspace.agents.filter(
        /* 工作区中已保存的 Agent。 */ agent => /* 选择拆分工作者以核对元数据。 */ agent.kind === 'splitSubAgent',
      )
      expect(splitAgents.map(
        /* 要检查精确快照的拆分 Agent。 */ agent => {
          // 提取冻结版本的类别和优先级。
          const profile = controlTestExecutionProfile(next, agent)
          return [profile.claimCategory, profile.defaultPriority]
        },
      )).toEqual([['data', 'high'], ['quote', 'medium'], ['causal', 'low']])
      const original = workspace.agents.find(
        /* 工作区已有 Agent。 */ agent => /* 取核查工作者作为新版本的配置来源。 */ agent.kind === 'verifySubAgent',
      )
      if (!original) throw new Error('Fixture worker is missing')
      expect(controlTestExecutionProfile(frozen, original)).toMatchObject(bootstrap.settings.llm)
      const updated = await freshAuth.transact(token,
        /* 保存配置新版本的授权事务。 */ context =>
          /* 更新 Agent 名称以创建一个使用当前共享设置的新内容版本。 */ freshControl.dispatch(context, {
            requestId: randomUUID(), method: 'agent.update', params: {
              scope: { kind: 'workspace', workspaceId: workspace.id }, expectedRevision: workspace.revision,
              agentId: original.id, expectedAgentRevision: original.revision,
              agent: { ...controlTestAgent(original), name: 'Uses the new shared model' },
            },
          }),
      )
      const current = (updated.data as AgentList).items.find(
        /* Agent 更新后的保存结果。 */ agent => /* 定位推进版本后的同一身份。 */ agent.id === original.id,
      )
      if (!current) throw new Error('Updated fixture worker is missing')
      const afterUpdate = await freshControl.executionCatalog(ctx, workspace.id)
      expect(controlTestExecutionProfile(afterUpdate, current)).toMatchObject(llm)
      expect(controlTestExecutionProfile(afterUpdate, original)).toEqual(controlTestExecutionProfile(frozen, original))
    } finally { await freshConnection.close() }
  })

  it('freezes custom split and parse profiles with their full metadata and never substitutes library profiles at runtime', async () => {
    // 验证工作区自定义解析/拆分配置完整保留，运行时不替换成共享库配置且旧快照隔离。
    const workspace = await controlTestWorkspace(ownerToken)
    const scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const list = await controlTestRead(ownerToken, { method: 'agent.list', params: { scope } }) as AgentList
    const original = list.items.find(agent => /* 选择工作区拆分子 Agent 作为自定义更新目标。 */  agent.kind === 'splitSubAgent')!
    const agent = { ...controlTestAgent(original), content: 'Custom {{content}}', tools: ['archive_lookup'],
      provider: 'split-provider', model: 'split-model', promptVars: ['content', 'hint'], defaultPriority: 'low' as const, claimCategory: 'quote' as const }
    const updated = (await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: list.revision,
      agentId: original.id, expectedAgentRevision: original.revision, agent })).data as AgentList
    const frozen = await control.executionCatalog(await auth.read(ownerToken), workspace.id)
    const parser = list.items.find(
      /* 已保存的工作区 Agent。 */ profile => /* 定位解析阶段的精确版本。 */ profile.kind === 'parseExtract',
    )
    if (!parser) throw new Error('Fixture parser is missing')
    expect(controlTestExecutionProfile(frozen, parser)).toMatchObject({ promptVars: ['rawContent'] })
    expect(controlTestExecutionProfile(frozen, { id: original.id, revision: original.revision + 1 })).toMatchObject({
      content: agent.content, tools: agent.tools, provider: agent.provider, model: agent.model,
      promptVars: agent.promptVars, defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
    })
    const current = updated.items.find(profile => /* 取得更新响应中的 Agent 版本，用于下一次条件更新。 */  profile.id === original.id)!
    await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: updated.revision,
      agentId: original.id, expectedAgentRevision: current.revision, agent: { ...agent, content: 'Changed later' } })
    expect(controlTestExecutionProfile(frozen, { id: original.id, revision: original.revision + 1 }).content).toBe(agent.content)
    expect(controlTestExecutionProfile(await control.executionCatalog(await auth.read(ownerToken), workspace.id), { id: original.id, revision: original.revision + 2 }).content).toBe('Changed later')
  })
})
