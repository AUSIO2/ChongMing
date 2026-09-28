// 管理工作区成员、Agent 库、共享配置与个人偏好，统一角色授权、版本和幂等收据。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import type { Persistence } from '../../ports/persistence'
import type { AgentInput, AgentList, AgentProfile, AgentScope, AppBootstrap, ClusterSettings, ControlCommand, ControlQuery, Page, Preferences, PromptKind, Role, WorkspaceSummary, WorkspaceView } from '../../../contracts/control'
import type { GraphAgentProfile, GraphRunConfiguration } from '../../../contracts/graph'
import type { RequestContext } from '../identity/identity-service'
import { configurationRead, configurationReadSeed, type GraphSeedConfiguration } from './agent-configuration'
import { CONTROL_PROMPT_KINDS, CONTROL_PROMPT_VARIABLES, controlReadAgent, controlReadCommand, controlReadQuery } from './workspace-input'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadString } from '../shared/input-validation'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../graph/graph-record'

interface ControlReceipt { userId: string; requestId: string; method: string; hash: string; resourceId?: string }
export interface WorkspaceDocument {
  _id: string; name: string; description: string; revision: number
  members: Array<{ userId: string; role: Role }>; agents: AgentProfile[]; receipts: ControlReceipt[]
  writeFence: number; createdAt: string; updatedAt: string; deletedAt: string | null
}
interface LibraryDocument { _id: string; revision: number; agents: AgentProfile[]; receipts: ControlReceipt[]; writeFence: number; updatedAt: string }
interface SettingsDocument extends ClusterSettings { _id: string; receipts: ControlReceipt[]; writeFence: number; updatedAt: string }
interface PreferencesDocument extends Preferences { _id: string; userId: string; receipts: ControlReceipt[] }
interface UserDocument { _id: string; displayName: string; disabled: boolean }
interface GraphRecord { _id: string; workspaceId: string; nodes: Array<{ id: string }>; run?: { status: string } | null; deletedAt?: string | Date | null }
type WorkspaceCreateInput = Extract<ControlCommand, { method: 'workspace.create' }>['params']
type ControlReadResult = AppBootstrap | Page<WorkspaceSummary> | WorkspaceView | AgentList
type ControlWriteResult = WorkspaceView | AgentList | ClusterSettings | Preferences
  | { workspaceId: string; deleted: true }
  | { userId: string; member: { userId: string; displayName: string; role: Role } | null; workspaceRevision: number }

const roleRank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 }
function controlIsWorker(/* 需要判断是否属于可增删子 Agent 角色的提示词类型。 */ kind: PromptKind): boolean {
  // 区分可增删的拆分/核查子 Agent 与每阶段固定角色。
  return kind === 'splitSubAgent' || kind === 'verifySubAgent' }
function controlRequireMutation(/* 必须携带已认证写身份和活动事务的请求上下文。 */ ctx: RequestContext): void {
  // 要求请求携带已授权写身份且位于活动事务中，阻止单独执行管理写入。
  if (!ctx.mutation || !ctx.session?.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', RuntimeMessage.CONTROL_WRITES_REQUIRE_AN_AUTHORIZED_TRANSACTION)
}
function controlRequireAdmin(/* 需要执行全局管理操作的已认证请求上下文。 */ ctx: RequestContext): void {
  // 要求当前身份具有宿主管理员权限，保护全局库和共享设置。
  if (!ctx.actor.hostAdmin) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.HOST_ADMINISTRATOR_PERMISSION_IS_REQUIRED)
}
function controlRequireRevision(/* 服务端当前持久化的资源版本。 */ actual: number, /* 客户端据以编辑资源的预期版本。 */ expected: number): void {
  // 比较预期版本与实际版本，冲突时附带当前版本供客户端刷新。
  if (actual !== expected) throw new GraphError(409, 'REVISION_CONFLICT', messageFormat(RuntimeMessage.EXPECTED_REVISION_VALUE_FOUND_VALUE, expected, actual), actual)
}
function controlReadRole(/* 包含当前用户身份和可选事务的请求上下文。 */ ctx: RequestContext, /* 需要检查成员资格且未逻辑删除的工作区记录。 */ workspace: WorkspaceDocument, /* 此次操作要求的最低成员角色。 */ minimum: Role): Role {
  // 读取当前用户的成员角色，隐藏不可见工作区并拒绝低于要求的权限。
  const member = workspace.members.find(/* 当前与请求用户身份比较的工作区成员。 */ member => /* 定位当前身份在目标工作区的成员记录。 */ member.userId === ctx.actor.userId)
  if (!member) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', RuntimeMessage.WORKSPACE_NOT_FOUND)
  if (roleRank[member.role] < roleRank[minimum]) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
  return member.role
}
function controlCreateReceipt(/* 提供当前用户身份的授权写请求上下文。 */ ctx: RequestContext, /* 需要生成幂等收据的已解析管理命令。 */ command: ControlCommand, /* 删除等命令绑定的可选资源身份，用于禁止身份复用。 */ resourceId?: string): ControlReceipt {
  // 把用户、请求方法和输入摘要绑定为管理收据，必要时记录被删除等操作的资源身份。
  return { userId: ctx.actor.userId, requestId: command.requestId, method: command.method,
    hash: storeCreateInputHash({ method: command.method, params: command.params }), ...(resourceId ? { resourceId } : {}) }
}
function controlReadReplay(/* 当前资源已提交的管理收据集合。 */ receipts: ControlReceipt[], /* 根据本次用户、请求和输入生成的候选收据。 */ receipt: ControlReceipt): boolean {
  // 按用户与请求 ID 判断是否重放，存在旧收据但方法或输入不同则报冲突。
  const prior = receipts.find(/* 当前与候选用户和请求身份比较的历史收据。 */ item => /* 将收据限制在当前用户的请求身份内，避免成员之间互相命中。 */ item.userId === receipt.userId && item.requestId === receipt.requestId)
  if (prior && (prior.method !== receipt.method || prior.hash !== receipt.hash)) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_USED_WITH_DIFFERENT_INPUT)
  return !!prior
}
function controlReadProfile(/* 经过边界解析、准备持久化的 Agent 输入。 */ agent: AgentInput, /* 该 Agent 的初始或更新后版本；省略时从零开始。 */ revision = 0): AgentProfile {
  // 校验 Agent 配置并附加版本、可删除性和更新时间。
  const { id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory } = agent
  return { ...controlReadAgent({ id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory }),
    revision, deletable: controlIsWorker(agent.kind), updatedAt: new Date().toISOString() }
}
function controlValidateProfiles(/* 同一库或工作区内需要共同验证唯一性和固定角色的 Agent 配置。 */ agents: AgentProfile[]): void {
  // 确保同一作用域内 Agent 身份和提示词路径唯一，固定角色每类至多一个。
  if (new Set(agents.map(/* 当前提取身份以检查重复项的 Agent。 */ agent => /* 提取 Agent 身份以检查重复配置。 */ agent.id)).size !== agents.length || new Set(agents.map(/* 当前提取提示词路径以检查冲突的 Agent。 */ agent => /* 提取提示词路径以检查路径占用冲突。 */ agent.promptPath)).size !== agents.length) {
    throw new GraphError(409, 'AGENT_EXISTS', RuntimeMessage.AGENT_ID_AND_PROMPTPATH_MUST_BE_UNIQUE_WITHIN_THEIR_SCOPE)
  }
  const fixed = agents.filter(/* 当前判断是否属于固定角色的 Agent。 */ agent => /* 筛选每阶段仅允许一个的固定角色。 */ !controlIsWorker(agent.kind))
  if (new Set(fixed.map(/* 当前提取固定角色类型以检查重复阶段的 Agent。 */ agent => /* 提取固定角色类型以检测同阶段重复定义。 */ agent.kind)).size !== fixed.length) throw new GraphError(409, 'AGENT_EXISTS', RuntimeMessage.ONLY_ONE_PROFILE_IS_ALLOWED_FOR_EACH_FIXED_ROLE)
}

export function controlCreateService(/* 提供所有管理记录、事务和图摘要的持久化入口。 */ database: Persistence, /* 部署默认的完整解析、拆分和核查配置，仅用于显式初始化。 */ seedDefaults: GraphSeedConfiguration) {
  // 组装工作区、配置库、共享设置和偏好服务，并集中管理角色授权与版本提交。
  const workspaces = database.records<WorkspaceDocument>('control_workspaces')
  const library = database.records<LibraryDocument>('control_library')
  const settings = database.records<SettingsDocument>('control_settings')
  const preferences = database.records<PreferencesDocument>('control_preferences')
  const users = database.records<UserDocument>('control_users')
  const graphs = database.records<GraphRecord>(GRAPH_COLLECTION)


  async function controlReadSettings(/* 限定共享设置读取事务和用户身份的请求上下文。 */ ctx: RequestContext): Promise<ClusterSettings> {
    // 读取已初始化的共享设置，投影模型、工具与执行限制。
    const doc = await settings.get('global', ctx.session)
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.AN_ADMINISTRATOR_MUST_SEED_SHARED_SETTINGS)
    return { revision: doc.revision, llm: doc.llm, tools: doc.tools, limits: doc.limits }
  }
  async function controlReadLibrary(/* 限定全局 Agent 库读取事务和用户身份的请求上下文。 */ ctx: RequestContext): Promise<LibraryDocument> {
    // 读取已初始化的全局 Agent 库；缺失时要求显式初始化。
    const doc = await library.get('global', ctx.session)
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.AN_ADMINISTRATOR_MUST_SEED_THE_AGENT_LIBRARY)
    return doc
  }
  async function controlReadCopyLibrary(/* 用于锁定全局 Agent 库版本的请求上下文。 */ ctx: RequestContext, /* 复制命令声明的可选库版本；省略时锁定刚读取版本。 */ expectedRevision?: number): Promise<LibraryDocument> {
    // 校验准备复制的库版本并更新写栅栏，使复制与并发库更新发生事务冲突。
    const doc = await controlReadLibrary(ctx)
    if (expectedRevision !== undefined) controlRequireRevision(doc.revision, expectedRevision)
    const locked = await library.change('global', /* 准备在版本匹配时推进写栅栏的当前库记录。 */ current => /* 仅对刚读取的库版本推进栅栏，不接受中途变化后的配置。 */ current.revision === doc.revision ? { ...current, writeFence: current.writeFence + 1 } : null, ctx.session)
    if (!locked) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.AGENT_LIBRARY_CHANGED)
    return locked
  }
  async function requireRole(/* 提供用户身份、事务和写入标记的请求上下文。 */ ctx: RequestContext, /* 需要检查成员资格的工作区身份。 */ workspaceId: string, /* 此次读取或写入要求的最低角色。 */ minimum: Role): Promise<WorkspaceDocument> {
    // 检查工作区角色；写请求还会更新授权栅栏，使成员变更和业务写入在同一事务中仲裁。
    const doc = await workspaces.get(workspaceId, ctx.session)
    if (!doc || doc.deletedAt) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', RuntimeMessage.WORKSPACE_NOT_FOUND)
    controlReadRole(ctx, doc, minimum)
    if (!ctx.mutation) return doc
    controlRequireMutation(ctx)
    const touched = await workspaces.change(workspaceId, /* 实际写入前重新读取、检查角色并推进栅栏的工作区记录。 */ current => {
      // 在实际写入时再次验证工作区仍存在及用户角色，随后推进授权栅栏。
      if (current.deletedAt) return null
      controlReadRole(ctx, current, minimum)
      return { ...current, writeFence: current.writeFence + 1 }
    }, ctx.session)
    if (!touched) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_ACCESS_CHANGED)
    return touched
  }
  async function controlReadPreferences(/* 限定个人偏好读取事务和当前用户身份的请求上下文。 */ ctx: RequestContext, /* 需要读取当前用户偏好的工作区身份。 */ workspaceId: string): Promise<Preferences> {
    // 读取当前用户在该工作区的偏好，首次访问返回版本为零的空标签页状态。
    const doc = await preferences.get(`${ctx.actor.userId}:${workspaceId}`, ctx.session)
    return doc ? { workspaceId, revision: doc.revision, openMapIds: doc.openMapIds, currentMapId: doc.currentMapId, nodeSelection: doc.nodeSelection }
      : { workspaceId, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} }
  }
  async function controlReadWorkspace(/* 用于角色、用户名称和图数量查询的请求上下文。 */ ctx: RequestContext, /* 准备投影为公开详情的工作区记录。 */ workspace: WorkspaceDocument): Promise<WorkspaceView> {
    // 组合工作区详情、成员名称、图数量和当前用户偏好，返回界面视图。
    const names = await users.list({ _id: workspace.members.map(/* 当前提取用户身份以批量读取显示名的成员记录。 */ member => /* 收集成员用户身份以批量读取显示名。 */ member.userId) }, ctx.session)
    return {
      id: workspace._id, name: workspace.name, description: workspace.description, revision: workspace.revision,
      role: controlReadRole(ctx, workspace, 'viewer'), updatedAt: workspace.updatedAt,
      mapCount: await graphs.count({ workspaceId: workspace._id, deletedAt: null }, ctx.session),
      agents: workspace.agents,
      members: workspace.members.map(/* 当前补充显示名并投影到公开视图的成员记录。 */ member => /* 为成员附加显示名，账户记录缺失时保留身份作为显示值。 */ ({ ...member, displayName: names.find(/* 当前与成员身份匹配的用户记录。 */ user => /* 在批量读取结果中定位当前成员的用户记录。 */ user._id === member.userId)?.displayName ?? member.userId })),
      preferences: await controlReadPreferences(ctx, workspace._id),
    }
  }
  async function controlValidateTools(/* 必须位于授权事务内的请求上下文。 */ ctx: RequestContext, /* 准备新增或保存、需要核对共享工具目录的 Agent 集合。 */ agents: AgentProfile[]): Promise<void> {
    // 确认所有 Agent 工具属于共享目录，并写入设置栅栏以阻止并发删除所引用工具。
    const current = await controlReadSettings(ctx)
    if (agents.some(/* 当前检查是否引用未知工具的 Agent。 */ agent => /* 检查是否存在引用未注册工具的 Agent。 */ agent.tools.some(/* 当前与共享目录比较的 Agent 工具名称。 */ name => /* 检测当前 Agent 的工具清单中是否有未知名称。 */ !current.tools.some(/* 共享目录中当前与 Agent 工具名称匹配的工具。 */ tool => /* 在共享目录中核对工具是否仍注册。 */ tool.name === name)))) {
      throw new GraphError(422, 'UNKNOWN_TOOL', RuntimeMessage.AGENT_REFERS_TO_A_TOOL_OUTSIDE_THE_SHARED_CAPABILITY_CATALOG)
    }
    // 新增工具引用和删除共享工具声明必须写同一设置记录，避免各自通过读取检查后同时提交。
    const touched = await settings.change('global', /* 准备在版本仍匹配时推进共享设置栅栏的记录。 */ doc => /* 仅在目录版本未变时推进栅栏，把新引用与工具删除纳入事务冲突。 */ doc.revision === current.revision ? { ...doc, writeFence: doc.writeFence + 1 } : null, ctx.session)
    if (!touched) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.TOOL_CATALOG_CHANGED)
  }
  async function controlCommitWorkspace(/* 携带授权写事务的请求上下文。 */ ctx: RequestContext, /* 业务变更所依据的当前工作区记录。 */ workspace: WorkspaceDocument, /* 需要合并到工作区的名称、成员、Agent 或删除状态。 */ changes: Partial<Pick<WorkspaceDocument, 'name' | 'description' | 'members' | 'agents' | 'deletedAt'>>, /* 必须与状态变更一起追加的用户作用域幂等收据。 */ receipt: ControlReceipt): Promise<WorkspaceDocument> {
    // 在授权会话中按原版本更新未删除工作区，一起推进版本并追加请求收据。
    const updated = await workspaces.change(workspace._id, /* 最终写入前重新检查版本和删除状态的工作区记录。 */ doc => /* 只有版本和存在状态仍匹配时才应用变更与收据。 */ doc.revision === workspace.revision && !doc.deletedAt
      ? { ...doc, ...changes, updatedAt: new Date().toISOString(), revision: doc.revision + 1, receipts: [...doc.receipts, receipt] } : null, ctx.session)
    if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.WORKSPACE_CHANGED)
    return updated
  }
  async function createWorkspace(/* 必须属于授权写事务且将成为工作区所有者的请求上下文。 */ ctx: RequestContext, /* 新工作区身份、名称、说明和 Agent 来源。 */ input: WorkspaceCreateInput, /* 导入时显式提供的可选 Agent 配置；省略则按 agentSource 决定。 */ agents?: AgentInput[], /* 需要随工作区创建保存的可选幂等收据。 */ receipt?: ControlReceipt): Promise<WorkspaceView> {
    // 在授权事务中创建工作区及所有者，可使用提供的 Agent 或从锁定版本的全局库复制。
    controlRequireMutation(ctx)
    const id = inputReadId(input.id, 'workspace.id')
    if (typeof input.description !== 'string' || !['empty', 'library'].includes(input.agentSource)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_WORKSPACE_INPUT)
    if (await workspaces.get(id, ctx.session)) throw new GraphError(409, 'WORKSPACE_EXISTS', RuntimeMessage.WORKSPACE_ID_ALREADY_EXISTS)
    const profiles = agents !== undefined ? agents.map(/* 导入方提供、需要转换为持久化配置的 Agent。 */ agent => /* 校验外部提供的 Agent 并建立初始配置版本。 */ controlReadProfile(agent))
      : input.agentSource === 'library' ? (await controlReadCopyLibrary(ctx)).agents.map(/* 从全局库复制、需要新工作区独立身份的 Agent。 */ agent => /* 复制库配置但生成独立工作区 Agent 身份，避免共享可变配置。 */ controlReadProfile({ ...agent, id: randomUUID() })) : []
    controlValidateProfiles(profiles)
    if (profiles.length) await controlValidateTools(ctx, profiles)
    const now = new Date().toISOString()
    const doc: WorkspaceDocument = { _id: id, name: inputReadString(input.name, 'name').trim(), description: input.description,
      revision: 0, members: [{ userId: ctx.actor.userId, role: 'owner' }], agents: profiles, receipts: receipt ? [receipt] : [],
      writeFence: 0, createdAt: now, updatedAt: now, deletedAt: null }
    await workspaces.insert(doc, ctx.session)
    return controlReadWorkspace(ctx, doc)
  }
  async function controlReadAgentScope(/* 限定全局或工作区配置读取权限的请求上下文。 */ ctx: RequestContext, /* 指定 Agent 位于全局库还是某个工作区的作用域。 */ scope: AgentScope, /* true 要求管理员或所有者写权限，false 只要求查看权限。 */ write: boolean): Promise<LibraryDocument | WorkspaceDocument> {
    // 按库或工作区作用域读取 Agent 集合，写库需管理员，写工作区需所有者。
    if (scope.kind === 'workspace') return requireRole(ctx, scope.workspaceId, write ? 'owner' : 'viewer')
    if (write) controlRequireAdmin(ctx)
    return controlReadLibrary(ctx)
  }
  function controlReadAgentList(/* 返回给管理调用方的 Agent 作用域。 */ scope: AgentScope, /* 提供当前版本和 Agent 集合的库或工作区记录。 */ doc: LibraryDocument | WorkspaceDocument): AgentList {
    // 返回作用域、当前集合版本和 Agent 列表供管理界面使用。
    return { scope, revision: doc.revision, items: doc.agents }
  }

  return {
    async initialize(): Promise<void> {
      // 建立成员查询、配置版本及用户工作区偏好唯一性所需索引。
      await workspaces.index(['members.userId', 'updatedAt', '_id'])
      await library.index(['revision'])
      await settings.index(['revision'])
      await preferences.index(['userId', 'workspaceId'], { unique: true })
    },
    async seed(/* 可选显式运行配置；缺少的解析或拆分阶段从部署默认补齐，完全省略时播种 Agent 的模型设为继承。 */ configuration?: GraphRunConfiguration): Promise<void> {
      // 仅在全局库或设置缺失时写入显式种子配置，兼容只提供核查配置的初始化输入。
      const defaults = configurationReadSeed(seedDefaults)
      const config = configuration === undefined ? defaults : configurationRead(configuration)
      const seedProfile = (/* 需要转换为可管理配置的执行期 Agent。 */ agent: GraphAgentProfile, /* 该 Agent 在管理库中的提示词角色。 */ kind: PromptKind, /* 与角色对应、可稳定定位提示词文件的路径。 */ promptPath: string): AgentProfile => /* 把执行配置转换为可管理 Agent，补齐阶段变量与默认优先级。 */ controlReadProfile({
        ...agent, provider: configuration === undefined ? null : agent.provider, model: configuration === undefined ? null : agent.model,
        kind, promptPath, promptVars: agent.promptVars ?? CONTROL_PROMPT_VARIABLES[kind],
        defaultPriority: agent.defaultPriority ?? 'medium', claimCategory: agent.claimCategory ?? null,
      })
      // 默认配置只在显式初始化时用于补齐，运行中的工作区不从文件回退获取缺失配置。
      const fallback = (/* 需要用本次种子模型设置补齐提供者和模型的默认 Agent。 */ profile: GraphAgentProfile): GraphAgentProfile => /* 为补齐的默认阶段沿用本次种子配置的模型提供者和模型。 */ ({ ...profile, provider: config.router.provider, model: config.router.model })
      const parse = config.parse ?? fallback(defaults.parse)
      const split = config.split ?? { router: fallback(defaults.split.router), merger: fallback(defaults.split.merger),
        agents: defaults.split.agents.map(fallback) }
      const agents = [
        seedProfile(parse, 'parseExtract', 'fact-parser/extract'),
        seedProfile(split.router, 'splitRoute', 'fact-extractor/main-agent-route'),
        seedProfile(split.merger, 'splitMerge', 'fact-extractor/main-agent-merge'),
        ...split.agents.map(/* 当前转换为拆分子 Agent 管理配置的执行 Agent。 */ agent => /* 按拆分子 Agent 的身份生成稳定提示词路径并创建种子配置。 */ seedProfile(agent, 'splitSubAgent', `fact-extractor/sub-agents/${agent.id}`)),
        seedProfile(config.router, 'verifyRoute', 'fact-verifier/main-agent-route'),
        seedProfile(config.merger, 'verifyMerge', 'fact-verifier/main-agent-merge'),
        ...config.agents.map(/* 当前转换为核查子 Agent 管理配置的执行 Agent。 */ agent => /* 按核查子 Agent 的身份生成稳定提示词路径并创建种子配置。 */ seedProfile(agent, 'verifySubAgent', `fact-verifier/sub-agents/${agent.id}`)),
      ]
      controlValidateProfiles(agents)
      await database.transaction(async /* 只在缺失时创建全局库和设置的初始化事务。 */ session => {
        // 在同一事务中只创建缺失的库和设置，避免重启覆盖已编辑配置。
        const now = new Date().toISOString()
        if (!await library.get('global', session)) await library.insert({ _id: 'global', revision: 0, agents, receipts: [], writeFence: 0, updatedAt: now }, session)
        if (!await settings.get('global', session)) await settings.insert({ _id: 'global', revision: 0,
          llm: { provider: config.router.provider, model: config.router.model }, tools: config.tools,
          limits: { maxAgentSlots: config.maxSlots }, receipts: [], writeFence: 0, updatedAt: now }, session)
      })
    },
    requireRole,
    createWorkspace,
    async configuration(/* 必须具有工作区编辑权限的请求上下文。 */ ctx: RequestContext, /* 需要解析并冻结运行配置的工作区身份。 */ workspaceId: string): Promise<GraphRunConfiguration> {
      // 要求编辑权限，解析工作区 Agent 与共享默认值，生成经过完整校验的运行配置。
      const workspace = await requireRole(ctx, workspaceId, 'editor')
      const current = await controlReadSettings(ctx)
      const router = workspace.agents.find(/* 当前与固定核查路由角色匹配的工作区 Agent。 */ agent => /* 取得工作区固定核查路由角色。 */ agent.kind === 'verifyRoute')
      const merger = workspace.agents.find(/* 当前与固定核查汇总角色匹配的工作区 Agent。 */ agent => /* 取得工作区固定核查汇总角色。 */ agent.kind === 'verifyMerge')
      const agents = workspace.agents.filter(/* 当前判断是否为核查子 Agent 的工作区配置。 */ agent => /* 收集可供路由选择的核查子 Agent。 */ agent.kind === 'verifySubAgent')
      if (!router || !merger || !agents.length) throw new GraphError(422, 'CONFIGURATION_INCOMPLETE', RuntimeMessage.WORKSPACE_REQUIRES_VERIFICATION_ROUTER_MERGER_AND_AT_LEAST_ONE_WORKER)
      const resolve = (/* 需要用共享模型默认值补齐并投影为执行配置的 Agent。 */ agent: AgentProfile): GraphAgentProfile => /* 投影执行所需配置，未单独指定模型时使用共享默认值，并复制工具和变量列表。 */ ({ id: agent.id, name: agent.name,
        description: agent.description, content: agent.content, tools: [...agent.tools],
        provider: agent.provider ?? current.llm.provider, model: agent.model ?? current.llm.model,
        promptVars: [...agent.promptVars], defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory })
      const parse = workspace.agents.find(/* 当前与可选解析角色匹配的工作区 Agent。 */ agent => /* 取得可选的来源解析角色。 */ agent.kind === 'parseExtract')
      const splitRouter = workspace.agents.find(/* 当前与可选拆分路由角色匹配的工作区 Agent。 */ agent => /* 取得可选拆分阶段的路由角色。 */ agent.kind === 'splitRoute')
      const splitMerger = workspace.agents.find(/* 当前与可选拆分汇总角色匹配的工作区 Agent。 */ agent => /* 取得可选拆分阶段的汇总角色。 */ agent.kind === 'splitMerge')
      const splitAgents = workspace.agents.filter(/* 当前判断是否为拆分子 Agent 的工作区配置。 */ agent => /* 收集拆分子 Agent，供判断拆分能力是否完整。 */ agent.kind === 'splitSubAgent')
      return configurationRead({ router: resolve(router), merger: resolve(merger), agents: agents.map(resolve), tools: current.tools, maxSlots: current.limits.maxAgentSlots,
        ...(parse ? { parse: resolve(parse) } : {}),
        ...(splitRouter && splitMerger && splitAgents.length ? { split: { router: resolve(splitRouter), merger: resolve(splitMerger), agents: splitAgents.map(resolve) } } : {}),
      })
    },
    async read(/* 包含用户身份和可选读取事务的请求上下文。 */ ctx: RequestContext, /* 已经过或即将在边界解析的管理查询。 */ input: ControlQuery): Promise<ControlReadResult> {
      // 解析管理查询并按权限返回启动信息、工作区详情、Agent 列表或用户绑定的工作区分页。
      const query = controlReadQuery(input)
      if (query.method === 'app.bootstrap') return { identity: ctx.actor, settings: await controlReadSettings(ctx),
        metadata: { version: '061-v1', promptKinds: [...CONTROL_PROMPT_KINDS], executableKinds: ['parse', 'split', 'verify'], scores: [0, 0.5, 1],
          variables: structuredClone(CONTROL_PROMPT_VARIABLES), outputs: [
            { kind: 'parseExtract', content: JSON.stringify({ proposal: { kind: 'parse', reason: '整理原稿', news: [{ content: '新闻正文', context: {} }] } }) },
            { kind: 'splitRoute', content: JSON.stringify({ proposal: { kind: 'route', reason: '拆分角度', slots: [
              { id: 'angle-1', agentId: 'agent-id', angle: '数据事实', priority: 'high', hint: '', tools: [] },
            ] } }) },
            { kind: 'splitSubAgent', content: JSON.stringify({ proposal: { kind: 'split-report', reason: '提取依据', claims: [{ content: '可核查事实', category: 'data' }] } }) },
            { kind: 'splitMerge', content: JSON.stringify({ proposal: { kind: 'split-merge', reason: '保留非重复事实', reportIds: ['report-id'], selected: [{ reportId: 'report-id', index: 0 }] } }) },
            { kind: 'verifyRoute', content: JSON.stringify({ proposal: { kind: 'route', reason: '路由理由', slots: [
              { id: 'angle-1', agentId: 'agent-id', angle: '核查角度', priority: 'medium', hint: '', tools: [] },
            ] } }) },
            { kind: 'verifySubAgent', content: JSON.stringify({ proposal: { kind: 'report', score: 0.5, reason: '核查依据' } }) },
            { kind: 'verifyMerge', content: JSON.stringify({ proposal: { kind: 'merge', reportIds: ['report-id'], score: 0.5, reason: '汇总理由' } }) },
          ] } }
      if (query.method === 'workspace.get') return controlReadWorkspace(ctx, await requireRole(ctx, query.params.workspaceId, 'viewer'))
      if (query.method === 'agent.list') {
        const doc = await controlReadAgentScope(ctx, query.params.scope, false)
        return { ...controlReadAgentList(query.params.scope, doc), items: doc.agents.filter(/* 当前按可选提示词类型筛选的 Agent 配置。 */ agent => /* 按可选提示词类型筛选当前作用域 Agent。 */ !query.params.kind || agent.kind === query.params.kind) }
      }
      if (query.method !== 'workspace.list') throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_CONTROL_QUERY)
      let cursor: { userId: string; updatedAt: string; id: string } | null = null
      if (query.params.cursor) {
        try {
          cursor = JSON.parse(Buffer.from(query.params.cursor, 'base64url').toString())
          if (!cursor || cursor.userId !== ctx.actor.userId || typeof cursor.updatedAt !== 'string' || typeof cursor.id !== 'string') throw new Error(RuntimeMessage.CURSOR)
        } catch { throw new GraphError(400, 'INVALID_CURSOR', RuntimeMessage.CURSOR_DOES_NOT_MATCH_THIS_QUERY) }
      }
      const limit = query.params.limit ?? 50
      // ponytail: 当前在内存排序元数据分页；工作区目录规模增大时再将游标范围下推到存储适配器。
      const docs = (await workspaces.list({ deletedAt: null, 'members.userId': ctx.actor.userId }, ctx.session))
        .filter(/* 当前判断是否位于工作区分页游标之后的记录。 */ doc => /* 仅保留排序位置在游标之后的工作区记录。 */ !cursor || doc.updatedAt < cursor.updatedAt || (doc.updatedAt === cursor.updatedAt && doc._id > cursor.id))
        .sort((/* 工作区排序比较中位于左侧的记录。 */ a, /* 工作区排序比较中位于右侧的记录。 */ b) => /* 按更新时间倒序、身份正序固定工作区分页顺序。 */ b.updatedAt.localeCompare(a.updatedAt) || a._id.localeCompare(b._id)).slice(0, limit + 1)
      const items: WorkspaceSummary[] = []
      for (const doc of docs.slice(0, limit)) items.push({ id: doc._id, name: doc.name, description: doc.description,
        revision: doc.revision, role: controlReadRole(ctx, doc, 'viewer'), updatedAt: doc.updatedAt,
        mapCount: await graphs.count({ workspaceId: doc._id, deletedAt: null }, ctx.session) })
      const last = items[items.length - 1]
      return { items, nextCursor: docs.length > limit && last ? Buffer.from(JSON.stringify({ userId: ctx.actor.userId, updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null }
    },
    async dispatch(/* 必须携带已授权写事务的请求上下文。 */ ctx: RequestContext, /* 来自公共边界、需要解析和分派的管理命令。 */ input: ControlCommand): Promise<{ data: ControlWriteResult; replayed: boolean }> {
      // 在授权事务中分派管理写命令，先检查收据重放，再校验角色、版本和各资源不变式。
      controlRequireMutation(ctx)
      const command = controlReadCommand(input)
      const receipt = controlCreateReceipt(ctx, command, 'agentId' in command.params ? command.params.agentId : undefined)
      if (command.method === 'workspace.create') {
        const existing = await workspaces.get(command.params.id, ctx.session)
        if (existing) {
          controlReadRole(ctx, existing, 'owner')
          if (existing.deletedAt) throw new GraphError(410, 'WORKSPACE_GONE', RuntimeMessage.WORKSPACE_WAS_DELETED)
          const authorized = await requireRole(ctx, existing._id, 'owner')
          if (!controlReadReplay(authorized.receipts, receipt)) throw new GraphError(409, 'WORKSPACE_EXISTS', RuntimeMessage.WORKSPACE_ID_ALREADY_EXISTS)
          return { data: await controlReadWorkspace(ctx, authorized), replayed: true }
        }
        return { data: await createWorkspace(ctx, command.params, undefined, receipt), replayed: false }
      }
      if (command.method === 'settings.update') {
        controlRequireAdmin(ctx)
        const doc = await settings.get('global', ctx.session)
        if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.SHARED_SETTINGS_HAVE_NOT_BEEN_SEEDED)
        if (controlReadReplay(doc.receipts, receipt)) return { data: await controlReadSettings(ctx), replayed: true }
        controlRequireRevision(doc.revision, command.params.expectedRevision)
        const allowed = command.params.tools.map(/* 新共享目录中当前提取允许名称的工具。 */ tool => /* 收集新共享工具目录的名称，作为删除检测的允许集合。 */ tool.name)
        const removed = doc.tools.filter(/* 旧共享目录中当前判断是否被移除的工具。 */ tool => /* 找出旧目录中此次更新要删除的工具。 */ !allowed.includes(tool.name)).map(/* 当前提取名称以查询现有 Agent 引用的被移除工具。 */ tool => /* 提取被删除工具的名称以查询现存 Agent 引用。 */ tool.name)
        if (removed.length && ((await library.list({ 'agents.tools': removed }, ctx.session)).length
          || (await workspaces.list({ deletedAt: null, 'agents.tools': removed }, ctx.session)).length)) throw new GraphError(409, 'TOOL_IN_USE', RuntimeMessage.AN_AGENT_STILL_USES_A_REMOVED_TOOL)
        const updated = await settings.change('global', /* 最终保存前重新比较版本的共享设置记录。 */ current => /* 按共享设置原版本保存新配置，并同时推进版本及写入收据。 */ current.revision === doc.revision ? { ...current,
          llm: command.params.llm, tools: command.params.tools, limits: command.params.limits, updatedAt: new Date().toISOString(),
          revision: current.revision + 1, receipts: [...current.receipts, receipt] } : null, ctx.session)
        if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.SETTINGS_CHANGED)
        return { data: { revision: updated.revision, llm: updated.llm, tools: updated.tools, limits: updated.limits }, replayed: false }
      }
      if (command.method === 'agent.create' || command.method === 'agent.update' || command.method === 'agent.delete') {
        const { scope } = command.params
        const doc = await controlReadAgentScope(ctx, scope, true)
        if (controlReadReplay(doc.receipts, receipt)) return { data: controlReadAgentList(scope, doc), replayed: true }
        controlRequireRevision(doc.revision, command.params.expectedRevision)
        let agents = [...doc.agents]
        if (command.method === 'agent.create') {
          if (!controlIsWorker(command.params.agent.kind)) throw new GraphError(422, 'FIXED_ROLE', RuntimeMessage.ONLY_SUBAGENT_PROFILES_MAY_BE_CREATED)
          if (doc.receipts.some(/* 当前检查目标 Agent 身份是否有历史删除收据的记录。 */ item => /* 检查该 Agent 身份是否已有删除记录，阻止删除后复用身份。 */ item.method === 'agent.delete' && item.resourceId === command.params.agent.id)) throw new GraphError(409, 'AGENT_ID_REUSED', RuntimeMessage.DELETED_AGENT_IDS_CANNOT_BE_REUSED)
          agents.push(controlReadProfile(command.params.agent))
        } else {
          const existing = agents.find(/* 当前与编辑或删除目标身份匹配的 Agent。 */ agent => /* 定位本次编辑或删除的现有 Agent。 */ agent.id === command.params.agentId)
          if (!existing) throw new GraphError(404, 'AGENT_NOT_FOUND', RuntimeMessage.AGENT_NOT_FOUND)
          controlRequireRevision(existing.revision, command.params.expectedAgentRevision)
          if (command.method === 'agent.delete') {
            if (!existing.deletable) throw new GraphError(409, 'FIXED_ROLE', RuntimeMessage.FIXED_PROFILES_CANNOT_BE_DELETED)
            agents = agents.filter(/* 当前 Agent 集合中的候选项，仅编号不同于删除目标的项会保留。 */ agent => /* 移除已通过可删除性校验的目标 Agent。 */ agent.id !== existing.id)
          } else {
            const next = command.params.agent
            if (next.id !== existing.id || next.kind !== existing.kind || next.promptPath !== existing.promptPath) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', RuntimeMessage.AGENT_ID_KIND_AND_PROMPTPATH_ARE_IMMUTABLE)
            agents = agents.map(/* 当前替换目标配置并保留其他项的 Agent。 */ agent => /* 仅替换目标 Agent 并推进其版本，保留集合内其余配置。 */ agent.id === existing.id ? controlReadProfile(next, existing.revision + 1) : agent)
          }
        }
        controlValidateProfiles(agents)
        await controlValidateTools(ctx, agents)
        if (scope.kind === 'workspace') {
          const updated = await controlCommitWorkspace(ctx, doc as WorkspaceDocument, { agents }, receipt)
          return { data: controlReadAgentList(scope, updated), replayed: false }
        }
        const updated = await library.change('global', /* 最终保存前重新比较版本的全局库记录。 */ current => /* 在库版本未变时提交新的 Agent 集合和幂等收据。 */ current.revision === doc.revision ? { ...current, agents, updatedAt: new Date().toISOString(),
          revision: current.revision + 1, receipts: [...current.receipts, receipt] } : null, ctx.session)
        if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.AGENT_LIBRARY_CHANGED)
        return { data: controlReadAgentList(scope, updated), replayed: false }
      }
      if (!('workspaceId' in command.params)) throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_CONTROL_COMMAND)
      if (command.method === 'workspace.delete') {
        const tombstone = await workspaces.get(command.params.workspaceId, ctx.session)
        if (tombstone?.deletedAt) {
          controlReadRole(ctx, tombstone, 'owner')
          if (controlReadReplay(tombstone.receipts, receipt)) return { data: { workspaceId: tombstone._id, deleted: true }, replayed: true }
          throw new GraphError(410, 'WORKSPACE_GONE', RuntimeMessage.WORKSPACE_WAS_DELETED)
        }
      }
      const workspace = await requireRole(ctx, command.params.workspaceId, command.method === 'preferences.set' ? 'viewer' : 'owner')
      if (command.method === 'preferences.set') {
        const id = `${ctx.actor.userId}:${workspace._id}`
        const prior = await preferences.get(id, ctx.session)
        if (prior && controlReadReplay(prior.receipts, receipt)) return { data: await controlReadPreferences(ctx, workspace._id), replayed: true }
        controlRequireRevision(prior?.revision ?? 0, command.params.expectedRevision)
        const { openMapIds, currentMapId, nodeSelection } = command.params
        if (currentMapId !== null && !openMapIds.includes(currentMapId)) throw new GraphError(422, 'INVALID_PREFERENCES', RuntimeMessage.CURRENT_MAP_MUST_BE_OPEN)
        const mapIds = [...new Set([...openMapIds, ...Object.keys(nodeSelection)])]
        const maps = await graphs.list({ _id: mapIds, workspaceId: workspace._id, deletedAt: null }, ctx.session)
        if (maps.length !== mapIds.length || maps.some(/* 当前检查偏好节点选择是否仍属于自身图的图记录。 */ map => /* 检测偏好选中的节点是否属于对应图，避免保存跨图或已删除节点。 */ nodeSelection[map._id] && !map.nodes.some(/* 当前与偏好中所选节点身份比较的图节点。 */ node => /* 核对所选节点在这张图中确实存在。 */ node.id === nodeSelection[map._id]))) throw new GraphError(422, 'INVALID_PREFERENCES', RuntimeMessage.PREFERENCES_REFER_TO_ANOTHER_OR_MISSING_MAP_NODE)
        const next: PreferencesDocument = { _id: id, userId: ctx.actor.userId, workspaceId: workspace._id,
          revision: (prior?.revision ?? 0) + 1, openMapIds, currentMapId, nodeSelection, receipts: [...(prior?.receipts ?? []), receipt] }
        if (!prior) await preferences.insert(next, ctx.session)
        else {
          const changed = await preferences.change(id, /* 保存偏好前重新比较版本的当前偏好记录。 */ current => /* 只在偏好版本仍匹配时替换内容，防止并发客户端覆盖。 */ current.revision === prior.revision ? next : null, ctx.session)
          if (!changed) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.PREFERENCES_CHANGED)
        }
        return { data: await controlReadPreferences(ctx, workspace._id), replayed: false }
      }
      if (controlReadReplay(workspace.receipts, receipt)) {
        if (command.method === 'member.set') {
          const member = workspace.members.find(/* 重放成员设置时当前与目标用户匹配的成员记录。 */ member => /* 读取成员设置请求对应的当前成员，作为重放响应。 */ member.userId === command.params.userId)
          const user = member && await users.get(member.userId, ctx.session)
          return { data: { userId: command.params.userId, member: member ? { ...member, displayName: user?.displayName ?? member.userId } : null, workspaceRevision: workspace.revision }, replayed: true }
        }
        return { data: await controlReadWorkspace(ctx, workspace), replayed: true }
      }
      controlRequireRevision(workspace.revision, command.params.expectedRevision)
      if (command.method === 'workspace.update') return { data: await controlReadWorkspace(ctx, await controlCommitWorkspace(ctx, workspace, { name: command.params.name, description: command.params.description }, receipt)), replayed: false }
      if (command.method === 'workspace.delete') {
        if ((await graphs.list({ workspaceId: workspace._id, deletedAt: null, 'run.status': ['accepted', 'running', 'waiting'] }, ctx.session)).length) throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.CANCEL_ACTIVE_RUNS_BEFORE_DELETING_THE_WORKSPACE)
        await controlCommitWorkspace(ctx, workspace, { deletedAt: new Date().toISOString() }, receipt)
        return { data: { workspaceId: workspace._id, deleted: true }, replayed: false }
      }
      if (command.method === 'member.set') {
        const user = await (async () => {
          // 读取目标用户并将已停用账户视为不可新增的成员。
          const user = await users.get(command.params.userId, ctx.session); return user?.disabled ? null : user })()
        if (command.params.role !== null && !user) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.AN_ENABLED_USER_IS_REQUIRED)
        const members = workspace.members.filter(/* 当前判断是否为本次角色设置目标的旧成员记录。 */ member => /* 先移除该用户的旧成员记录，以便统一处理角色替换与移除。 */ member.userId !== command.params.userId)
        if (command.params.role !== null) members.push({ userId: command.params.userId, role: command.params.role })
        const owners = members.filter(/* 当前判断是否仍具有所有者角色的变更后成员。 */ member => /* 收集变更后仍拥有 owner 角色的成员。 */ member.role === 'owner').map(/* 当前提取身份以查询是否仍启用的所有者成员。 */ member => /* 提取所有者身份以确认至少一个账户仍启用。 */ member.userId)
        if (!owners.length || !(await users.list({ _id: owners, disabled: false }, ctx.session)).length) throw new GraphError(409, 'LAST_OWNER', RuntimeMessage.WORKSPACE_MUST_RETAIN_AN_ENABLED_OWNER)
        const updated = await controlCommitWorkspace(ctx, workspace, { members }, receipt)
        return { data: { userId: command.params.userId, member: command.params.role === null ? null : { userId: command.params.userId, displayName: user!.displayName, role: command.params.role }, workspaceRevision: updated.revision }, replayed: false }
      }
      if (command.method === 'agent.copy') {
        const source = await controlReadCopyLibrary(ctx, command.params.libraryRevision)
        const selected = source.agents.filter(/* 当前判断是否被复制命令选中的全局库 Agent。 */ agent => /* 按请求选择全局库中需要复制的 Agent。 */ command.params.agentIds.includes(agent.id))
        if (!selected.length || selected.length !== command.params.agentIds.length) throw new GraphError(404, 'AGENT_NOT_FOUND', RuntimeMessage.SELECT_EXISTING_LIBRARY_AGENTS)
        const copied = selected.map(/* 当前复制到工作区并按提示词路径合并的库 Agent。 */ agent => {
          // 按提示词路径复用工作区身份并推进版本，拒绝复制改变已有固定角色类型。
          const existing = workspace.agents.find(/* 当前与被复制提示词路径匹配的工作区 Agent。 */ item => /* 寻找同提示词路径的工作区配置，保持复制覆盖时的身份稳定。 */ item.promptPath === agent.promptPath)
          if (existing && existing.kind !== agent.kind) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', RuntimeMessage.COPY_CANNOT_CHANGE_THE_KIND_OF_AN_EXISTING_PROMPTPATH)
          return controlReadProfile({ ...agent, id: existing?.id ?? randomUUID() }, existing ? existing.revision + 1 : 0)
        })
        const agents = command.params.mode === 'replace' ? copied : [...workspace.agents.filter(/* 合并模式下当前判断是否应保留的原工作区 Agent。 */ agent => /* 合并模式保留未被本次复制选中路径覆盖的原配置。 */ !selected.some(/* 当前与原配置提示词路径比较的选中库 Agent。 */ item => /* 判断当前配置路径是否将由库中的选择项替换。 */ item.promptPath === agent.promptPath)), ...copied]
        const removed = workspace.agents.filter(/* 当前判断是否在复制后集合中消失的原工作区 Agent。 */ agent => /* 找出复制替换后被移除的旧 Agent。 */ !agents.some(/* 复制后的集合中当前与旧 Agent 身份比较的配置。 */ item => /* 判断旧 Agent 身份是否仍存在于最终集合。 */ item.id === agent.id))
        if (removed.some(/* 当前检查是否为不允许删除的固定角色配置。 */ agent => /* 检查被移除配置中是否包含不允许删除的固定角色。 */ !agent.deletable)) throw new GraphError(409, 'FIXED_ROLE', RuntimeMessage.COPY_CANNOT_REMOVE_FIXED_PROFILES)
        controlValidateProfiles(agents)
        await controlValidateTools(ctx, agents)
        const updated = await controlCommitWorkspace(ctx, workspace, { agents }, receipt)
        return { data: await controlReadWorkspace(ctx, updated), replayed: false }
      }
      throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_CONTROL_COMMAND)
    },
  }
}

export type ControlService = ReturnType<typeof controlCreateService>
