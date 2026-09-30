// 管理工作区成员、Agent 库、共享配置与个人偏好，统一角色授权、版本和幂等收据。
import { randomUUID } from 'node:crypto'

import type { DefinitionCatalog, DefinitionPackage, DefinitionRef, ExecutionAgentDefinition, ExecutionCatalog } from '../../../contracts/data-definition'
import type { AgentInput, AgentList, AgentProfile, AgentScope, AppBootstrap, ClusterSettings, ControlCommand, ControlQuery, DefinitionPublishResult, DefinitionView, Page, Preferences, PromptKind, Role, WorkspaceSummary, WorkspaceView } from '../../../contracts/control'
import type { GraphAgentProfile, GraphRunConfiguration } from '../../../contracts/graph'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { Persistence, StorageSession } from '../../ports/persistence'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../graph/graph-record'
import type { RequestContext } from '../identity/identity-service'
import { definitionsDigest, definitionsReadPackage, definitionsReadTransition, definitionsValidateCatalog } from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadString } from '../shared/input-validation'
import { configurationRead, configurationReadSeed, type GraphSeedConfiguration } from './agent-configuration'
import { CONTROL_PROMPT_KINDS, CONTROL_PROMPT_VARIABLES, controlReadAgent, controlReadCommand, controlReadQuery } from './workspace-input'

interface ControlReceipt { userId: string; requestId: string; method: string; hash: string; resourceId?: string }
export interface WorkspaceDocument {
  _id: string; name: string; description: string; revision: number
  members: Array<{ userId: string; role: Role }>; agents: AgentProfile[]; receipts: ControlReceipt[]
  definitionPackages?: DefinitionPackage[]; definitionAgents?: ExecutionAgentDefinition[]
  writeFence: number; createdAt: string; updatedAt: string; deletedAt: string | null
}
interface LibraryDocument {
  _id: string; revision: number; agents: AgentProfile[]; receipts: ControlReceipt[]; writeFence: number; updatedAt: string
  definitionPackages?: DefinitionPackage[]; definitionAgents?: ExecutionAgentDefinition[]
}
interface SettingsDocument extends ClusterSettings { _id: string; receipts: ControlReceipt[]; writeFence: number; updatedAt: string }
interface PreferencesDocument extends Preferences { _id: string; userId: string; receipts: ControlReceipt[] }
interface UserDocument { _id: string; displayName: string; disabled: boolean }
interface GraphRecord { _id: string; workspaceId: string; nodes: Array<{ id: string }>; runs: Array<{ status: string }>
  branchOwnerships?: Record<string, { kind: 'editor' | 'run' | 'control'; expiresAt: string | null }>; deletedAt?: string | Date | null }
type WorkspaceCreateInput = Extract<ControlCommand, { method: 'workspace.create' }>['params']
type ControlReadResult = AppBootstrap | Page<WorkspaceSummary> | WorkspaceView | AgentList | DefinitionView
type ControlWriteResult = WorkspaceView | AgentList | ClusterSettings | Preferences | DefinitionPublishResult
  | { workspaceId: string; deleted: true }
  | { userId: string; member: { userId: string; displayName: string; role: Role } | null; workspaceRevision: number }

const roleRank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 }
/**
 * 区分可增删的拆分/核查子 Agent 与每阶段固定角色。
 *
 * @param kind 需要判断是否属于可增删子 Agent 角色的提示词类型。
 */
function controlIsWorker(kind: PromptKind): boolean {
  return kind === 'splitSubAgent' || kind === 'verifySubAgent' }
/**
 * 要求请求携带已授权写身份且位于活动事务中，阻止单独执行管理写入。
 *
 * @param ctx 必须携带已认证写身份和活动事务的请求上下文。
 */
function controlRequireMutation(ctx: RequestContext): void {
  if (!ctx.mutation || !ctx.session?.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', RuntimeMessage.CONTROL_WRITES_REQUIRE_AN_AUTHORIZED_TRANSACTION)
}
/**
 * 要求当前身份具有宿主管理员权限，保护全局库和共享设置。
 *
 * @param ctx 需要执行全局管理操作的已认证请求上下文。
 */
function controlRequireAdmin(ctx: RequestContext): void {
  if (!ctx.actor.hostAdmin) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.HOST_ADMINISTRATOR_PERMISSION_IS_REQUIRED)
}
/**
 * 比较预期版本与实际版本，冲突时附带当前版本供客户端刷新。
 *
 * @param actual 服务端当前持久化的资源版本。
 * @param expected 客户端据以编辑资源的预期版本。
 */
function controlRequireRevision(actual: number, expected: number): void {
  if (actual !== expected) throw new GraphError(409, 'REVISION_CONFLICT', messageFormat(RuntimeMessage.EXPECTED_REVISION_VALUE_FOUND_VALUE, expected, actual), actual)
}
/**
 * 读取当前用户的成员角色，隐藏不可见工作区并拒绝低于要求的权限。
 *
 * @param ctx 包含当前用户身份和可选事务的请求上下文。
 * @param workspace 需要检查成员资格且未逻辑删除的工作区记录。
 * @param minimum 此次操作要求的最低成员角色。
 */
function controlReadRole(ctx: RequestContext, workspace: WorkspaceDocument, minimum: Role): Role {
  const member = workspace.members.find(member => /* 定位当前身份在目标工作区的成员记录。 */ member.userId === ctx.actor.userId)
  if (!member) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', RuntimeMessage.WORKSPACE_NOT_FOUND)
  if (roleRank[member.role] < roleRank[minimum]) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
  return member.role
}
/**
 * 把用户、请求方法和输入摘要绑定为管理收据，必要时记录被删除等操作的资源身份。
 *
 * @param ctx 提供当前用户身份的授权写请求上下文。
 * @param command 需要生成幂等收据的已解析管理命令。
 * @param resourceId 删除等命令绑定的可选资源身份，用于禁止身份复用。
 */
function controlCreateReceipt(ctx: RequestContext, command: ControlCommand, resourceId?: string): ControlReceipt {
  return { userId: ctx.actor.userId, requestId: command.requestId, method: command.method,
    hash: storeCreateInputHash({ method: command.method, params: command.params }), ...(resourceId ? { resourceId } : {}) }
}
/**
 * 按用户与请求 ID 判断是否重放，存在旧收据但方法或输入不同则报冲突。
 *
 * @param receipts 当前资源已提交的管理收据集合。
 * @param receipt 根据本次用户、请求和输入生成的候选收据。
 */
function controlReadReplay(receipts: ControlReceipt[], receipt: ControlReceipt): boolean {
  const prior = receipts.find(item => /* 将收据限制在当前用户的请求身份内，避免成员之间互相命中。 */ item.userId === receipt.userId && item.requestId === receipt.requestId)
  if (prior && (prior.method !== receipt.method || prior.hash !== receipt.hash)) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_USED_WITH_DIFFERENT_INPUT)
  return !!prior
}
/**
 * 校验 Agent 配置并附加版本、可删除性和更新时间。
 *
 * @param agent 经过边界解析、准备持久化的 Agent 输入。
 * @param revision 该 Agent 的初始或更新后版本；省略时从零开始。
 */
function controlReadProfile(agent: AgentInput, revision = 0): AgentProfile {
  const { id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory, role, bindings } = agent
  return { ...controlReadAgent({ id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory,
    ...(role === undefined ? {} : { role }), ...(bindings === undefined ? {} : { bindings }) }),
    revision, deletable: bindings !== undefined || controlIsWorker(agent.kind), updatedAt: new Date().toISOString() }
}
/**
 * 确保同一作用域内 Agent 身份和提示词路径唯一，固定角色每类至多一个。
 *
 * @param agents 同一库或工作区内需要共同验证唯一性和固定角色的 Agent 配置。
 */
function controlValidateProfiles(agents: AgentProfile[]): void {
  if (new Set(agents.map(agent => /* 提取 Agent 身份以检查重复配置。 */ agent.id)).size !== agents.length || new Set(agents.map(agent => /* 提取提示词路径以检查路径占用冲突。 */ agent.promptPath)).size !== agents.length) {
    throw new GraphError(409, 'AGENT_EXISTS', RuntimeMessage.AGENT_ID_AND_PROMPTPATH_MUST_BE_UNIQUE_WITHIN_THEIR_SCOPE)
  }
  const fixed = agents.filter(agent => /* 注册绑定 Agent 的唯一性由转换阶段检查，旧配置仍按 kind 限制。 */ !agent.bindings && !controlIsWorker(agent.kind))
  if (new Set(fixed.map(agent => /* 提取固定角色类型以检测同阶段重复定义。 */ agent.kind)).size !== fixed.length) throw new GraphError(409, 'AGENT_EXISTS', RuntimeMessage.ONLY_ONE_PROFILE_IS_ALLOWED_FOR_EACH_FIXED_ROLE)
}

/**
 * 把可继承模型的管理配置解析为精确 Agent 版本和独立执行快照。
 *
 * @param agent 需要冻结为执行内容的已保存 Agent。
 * @param settings 发布时生效的共享模型和工具设置。
 */
function controlResolveExecutionAgent(agent: AgentProfile, settings: ClusterSettings): ExecutionAgentDefinition {
  return { ref: { id: agent.id, version: agent.revision }, profile: {
    id: agent.id, name: agent.name, description: agent.description, content: agent.content, tools: [...agent.tools],
    provider: agent.provider ?? settings.llm.provider, model: agent.model ?? settings.llm.model,
    promptVars: [...agent.promptVars], defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
  } }
}

/**
 * 重写默认包或工作区副本中的 Agent 引用，并重建精确依赖列表。
 *
 * @param source 需要绑定到另一组 Agent 身份的定义包。
 * @param references 原 Agent 精确引用到目标引用的映射。
 * @param candidateGroups 可选路由候选组，用完整目标组替换模板候选。
 */
function controlRemapDefinitionPackage(source: DefinitionPackage, references: ReadonlyMap<string, DefinitionRef>, candidateGroups: ReadonlyArray<{ sourceIds: ReadonlySet<string>; targets: DefinitionRef[] }> = []): DefinitionPackage {
  const packageCopy = structuredClone(source)
  /**
   * 读取预先建立的精确引用映射，缺失表示装配配置与默认包不一致。
   *
   * @param ref 定义包中准备改写的旧 Agent 引用。
   */
  const readTarget = (ref: DefinitionRef): DefinitionRef => {
    const target = references.get(`${ref.id}\u0000${ref.version}`)
    if (!target) throw new GraphError(500, 'DEFAULT_CONFIGURATION_INVALID', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `Agent mapping is missing for ${ref.id}@${ref.version}`))
    return structuredClone(target)
  }
  const dependencies = new Map<string, DefinitionRef>()
  for (const transition of packageCopy.transitions) for (const stage of transition.execution.stages) {
    stage.agentRef = readTarget(stage.agentRef)
    dependencies.set(`${stage.agentRef.id}\u0000${stage.agentRef.version}`, stage.agentRef)
    if (stage.plan) {
      const original = stage.plan.agentRefs
      const group = candidateGroups.find(candidate => /* 用原身份集合判断该计划属于哪个可扩展 Agent 组。 */ original.length > 0 && original.every(ref => /* 要求候选组包含计划引用身份。 */ candidate.sourceIds.has(ref.id)))
      stage.plan.agentRefs = group ? structuredClone(group.targets) : original.map(readTarget)
      for (const ref of stage.plan.agentRefs) dependencies.set(`${ref.id}\u0000${ref.version}`, ref)
    }
  }
  packageCopy.dependencies.agents = [...dependencies.values()]
  return packageCopy
}

/**
 * 合并历史精确快照与当前 Agent 版本，同一引用只保留原先冻结的内容。
 *
 * @param archived 当前工作区已归档的定义 Agent 快照。
 * @param agents 当前可管理 Agent 配置。
 * @param settings 用于解析当前 Agent 共享模型默认值的设置。
 */
function controlReadDefinitionAgents(archived: readonly ExecutionAgentDefinition[], agents: readonly AgentProfile[], settings: ClusterSettings): ExecutionAgentDefinition[] {
  const result = new Map<string, ExecutionAgentDefinition>()
  for (const agent of archived) result.set(`${agent.ref.id}\u0000${agent.ref.version}`, structuredClone(agent))
  for (const agent of agents) {
    const current = controlResolveExecutionAgent(agent, settings)
    const key = `${current.ref.id}\u0000${current.ref.version}`
    if (!result.has(key)) result.set(key, current)
  }
  return [...result.values()]
}

/**
 * 核对通用 Agent 的转换阶段、结果职责和提示词变量，不按事实核查 kind 推断能力。
 *
 * @param catalog 已通过完整发布校验的工作区定义目录。
 * @param agents 准备保存到同一作用域的 Agent 集合。
 */
function controlValidateAgentBindings(catalog: DefinitionCatalog, agents: readonly AgentProfile[]): void {
  for (const agent of agents) for (const binding of agent.bindings ?? []) {
    const transition = definitionsReadTransition(catalog, binding.transition)
    const stage = transition.execution.stages.find(item => /* 定位 Agent 声明参与的阶段。 */ item.id === binding.stageId)
    if (!stage) throw new GraphError(422, 'DEFINITION_INVALID', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `Agent ${agent.id} binds unknown stage ${binding.stageId}`))
    const role = stage.resultMode === 'plan' ? 'planner' : stage.resultMode === 'selection' ? 'selector' : 'producer'
    if (agent.role !== role) throw new GraphError(422, 'DEFINITION_INVALID', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `Agent ${agent.id} role does not match stage ${binding.stageId}`))
    const variables = new Set(Object.keys(stage.promptBindings ?? {}))
    if (agent.promptVars.some(name => /* 拒绝读取阶段未授予的提示词变量。 */ !variables.has(name))) throw new GraphError(422, 'DEFINITION_INVALID', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `Agent ${agent.id} uses an undeclared prompt variable`))
  }
}

/**
 * 组装工作区、配置库、共享设置和偏好服务，并集中管理角色授权与版本提交。
 *
 * @param database 提供所有管理记录、事务和图摘要的持久化入口。
 * @param seedDefaults 部署默认的完整解析、拆分和核查配置，仅用于显式初始化。
 * @param clientLeases 本机无需客户端租约；协作默认要求。
 */
export function controlCreateService(database: Persistence, seedDefaults: GraphSeedConfiguration,
  clientLeases: 'required' | 'none' = 'required') {
  const deploymentDefaults = configurationReadSeed(seedDefaults)
  const workspaces = database.records<WorkspaceDocument>('control_workspaces')
  const library = database.records<LibraryDocument>('control_library')
  const settings = database.records<SettingsDocument>('control_settings')
  const preferences = database.records<PreferencesDocument>('control_preferences')
  const users = database.records<UserDocument>('control_users')
  const graphs = database.records<GraphRecord>(GRAPH_COLLECTION)

  /**
   * 将部署默认包绑定到工作区现有的旧角色 Agent，并移除缺少完整 Agent 依赖的转换。
   *
   * @param profiles 新工作区已经保存身份和版本的 Agent 配置。
   */
  function controlCreateDefaultDefinitions(profiles: readonly AgentProfile[]): DefinitionPackage {
    const references = new Map<string, DefinitionRef>()
    /**
     * 在工作区存在相应角色时建立模板到精确配置版本的引用。
     *
     * @param source 默认配置中声明的模板 Agent。
     * @param target 工作区中承担同一兼容角色的 Agent。
     */
    const bind = (source: GraphAgentProfile, target: AgentProfile | undefined): void => {
      if (target) references.set(`${source.id}\u0000${0}`, { id: target.id, version: target.revision })
    }
    const splitAgents = profiles.filter(agent => /* 收集可供默认拆分计划使用的 Agent。 */ agent.kind === 'splitSubAgent')
    const verifyAgents = profiles.filter(agent => /* 收集可供默认核查计划使用的 Agent。 */ agent.kind === 'verifySubAgent')
    bind(deploymentDefaults.parse, profiles.find(agent => /* 按旧兼容 kind 查找解析 Agent。 */ agent.kind === 'parseExtract'))
    bind(deploymentDefaults.split.router, profiles.find(agent => /* 按旧兼容 kind 查找拆分路由。 */ agent.kind === 'splitRoute'))
    bind(deploymentDefaults.split.merger, profiles.find(agent => /* 按旧兼容 kind 查找拆分汇总。 */ agent.kind === 'splitMerge'))
    for (const [index, source] of deploymentDefaults.split.agents.entries()) bind(source, splitAgents[index % splitAgents.length])
    bind(deploymentDefaults.router, profiles.find(agent => /* 按旧兼容 kind 查找核查路由。 */ agent.kind === 'verifyRoute'))
    bind(deploymentDefaults.merger, profiles.find(agent => /* 按旧兼容 kind 查找核查汇总。 */ agent.kind === 'verifyMerge'))
    for (const [index, source] of deploymentDefaults.agents.entries()) bind(source, verifyAgents[index % verifyAgents.length])
    const candidateGroups = [
      { sourceIds: new Set(deploymentDefaults.split.agents.map(agent => /* 提取模板身份以识别计划组。 */ agent.id)),
        targets: splitAgents.map(agent => /* 转换为精确配置引用。 */ ({ id: agent.id, version: agent.revision })) },
      { sourceIds: new Set(deploymentDefaults.agents.map(agent => /* 提取模板身份以识别计划组。 */ agent.id)),
        targets: verifyAgents.map(agent => /* 转换为精确配置引用。 */ ({ id: agent.id, version: agent.revision })) },
    ]
    const source = structuredClone(deploymentDefaults.definitionPackage)
    source.transitions = source.transitions.filter(transition => /* 只保留当前工作区可以完整绑定的转换。 */ transition.execution.stages.every(stage => {
      // 固定 Agent 必须可映射；计划阶段还需要至少一个完整候选组。
      if (!references.has(`${stage.agentRef.id}\u0000${stage.agentRef.version}`)) return false
      const plan = stage.plan
      if (!plan) return true
      const group = candidateGroups.find(candidate => /* 识别计划使用的候选组。 */ plan.agentRefs.every(ref => /* 要求组包含该模板身份。 */ candidate.sourceIds.has(ref.id)))
      return group ? group.targets.length > 0 : plan.agentRefs.every(ref => /* 确认精确模板引用可映射。 */ references.has(`${ref.id}\u0000${ref.version}`))
    }))
    return controlRemapDefinitionPackage(source, references, candidateGroups)
  }


  /**
   * 读取已初始化的共享设置，投影模型、工具与执行限制。
   *
   * @param ctx 限定共享设置读取事务和用户身份的请求上下文。
   */
  async function controlReadSettings(ctx: RequestContext): Promise<ClusterSettings> {
    const doc = await settings.get('global', ctx.session)
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.AN_ADMINISTRATOR_MUST_SEED_SHARED_SETTINGS)
    return { revision: doc.revision, llm: doc.llm, tools: doc.tools, limits: doc.limits }
  }
  /**
   * 读取已初始化的全局 Agent 库；缺失时要求显式初始化。
   *
   * @param ctx 限定全局 Agent 库读取事务和用户身份的请求上下文。
   */
  async function controlReadLibrary(ctx: RequestContext): Promise<LibraryDocument> {
    const doc = await library.get('global', ctx.session)
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.AN_ADMINISTRATOR_MUST_SEED_THE_AGENT_LIBRARY)
    return doc
  }
  /**
   * 校验准备复制的库版本并更新写栅栏，使复制与并发库更新发生事务冲突。
   *
   * @param ctx 用于锁定全局 Agent 库版本的请求上下文。
   * @param expectedRevision 复制命令声明的可选库版本；省略时锁定刚读取版本。
   */
  async function controlReadCopyLibrary(ctx: RequestContext, expectedRevision?: number): Promise<LibraryDocument> {
    const doc = await controlReadLibrary(ctx)
    if (expectedRevision !== undefined) controlRequireRevision(doc.revision, expectedRevision)
    const locked = await library.change('global', current => /* 仅对刚读取的库版本推进栅栏，不接受中途变化后的配置。 */ current.revision === doc.revision ? { ...current, writeFence: current.writeFence + 1 } : null, ctx.session)
    if (!locked) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.AGENT_LIBRARY_CHANGED)
    return locked
  }
  /**
   * 检查工作区角色；写请求还会更新授权栅栏，使成员变更和业务写入在同一事务中仲裁。
   *
   * @param ctx 提供用户身份、事务和写入标记的请求上下文。
   * @param workspaceId 需要检查成员资格的工作区身份。
   * @param minimum 此次读取或写入要求的最低角色。
   */
  async function requireRole(ctx: RequestContext, workspaceId: string, minimum: Role): Promise<WorkspaceDocument> {
    const doc = await workspaces.get(workspaceId, ctx.session)
    if (!doc || doc.deletedAt) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', RuntimeMessage.WORKSPACE_NOT_FOUND)
    controlReadRole(ctx, doc, minimum)
    if (!ctx.mutation) return doc
    controlRequireMutation(ctx)
    const touched = await workspaces.change(workspaceId, current => {
      // 在实际写入时再次验证工作区仍存在及用户角色，随后推进授权栅栏。
      if (current.deletedAt) return null
      controlReadRole(ctx, current, minimum)
      return { ...current, writeFence: current.writeFence + 1 }
    }, ctx.session)
    if (!touched) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_ACCESS_CHANGED)
    return touched
  }
  /**
   * 读取当前用户在该工作区的偏好，首次访问返回版本为零的空标签页状态。
   *
   * @param ctx 限定个人偏好读取事务和当前用户身份的请求上下文。
   * @param workspaceId 需要读取当前用户偏好的工作区身份。
   */
  async function controlReadPreferences(ctx: RequestContext, workspaceId: string): Promise<Preferences> {
    const doc = await preferences.get(`${ctx.actor.userId}:${workspaceId}`, ctx.session)
    return doc ? { workspaceId, revision: doc.revision, openMapIds: doc.openMapIds, currentMapId: doc.currentMapId, nodeSelection: doc.nodeSelection }
      : { workspaceId, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} }
  }
  /**
   * 组合工作区详情、成员名称、图数量和当前用户偏好，返回界面视图。
   *
   * @param ctx 用于角色、用户名称和图数量查询的请求上下文。
   * @param workspace 准备投影为公开详情的工作区记录。
   */
  async function controlReadWorkspace(ctx: RequestContext, workspace: WorkspaceDocument): Promise<WorkspaceView> {
    const names = await users.list({ _id: workspace.members.map(member => /* 收集成员用户身份以批量读取显示名。 */ member.userId) }, ctx.session)
    return {
      id: workspace._id, name: workspace.name, description: workspace.description, revision: workspace.revision,
      role: controlReadRole(ctx, workspace, 'viewer'), updatedAt: workspace.updatedAt,
      mapCount: await graphs.count({ workspaceId: workspace._id, deletedAt: null }, ctx.session),
      agents: workspace.agents,
      members: workspace.members.map(member => /* 为成员附加显示名，账户记录缺失时保留身份作为显示值。 */ ({ ...member, displayName: names.find(user => /* 在批量读取结果中定位当前成员的用户记录。 */ user._id === member.userId)?.displayName ?? member.userId })),
      preferences: await controlReadPreferences(ctx, workspace._id),
    }
  }
  /**
   * 确认所有 Agent 工具属于共享目录，并写入设置栅栏以阻止并发删除所引用工具。
   *
   * @param ctx 必须位于授权事务内的请求上下文。
   * @param agents 准备新增或保存、需要核对共享工具目录的 Agent 集合。
   */
  async function controlValidateTools(ctx: RequestContext, agents: AgentProfile[]): Promise<void> {
    const current = await controlReadSettings(ctx)
    if (agents.some(agent => /* 检查是否存在引用未注册工具的 Agent。 */ agent.tools.some(name => /* 检测当前 Agent 的工具清单中是否有未知名称。 */ !current.tools.some(tool => /* 在共享目录中核对工具是否仍注册。 */ tool.name === name)))) {
      throw new GraphError(422, 'UNKNOWN_TOOL', RuntimeMessage.AGENT_REFERS_TO_A_TOOL_OUTSIDE_THE_SHARED_CAPABILITY_CATALOG)
    }
    // 新增工具引用和删除共享工具声明必须写同一设置记录，避免各自通过读取检查后同时提交。
    const touched = await settings.change('global', doc => /* 仅在目录版本未变时推进栅栏，把新引用与工具删除纳入事务冲突。 */ doc.revision === current.revision ? { ...doc, writeFence: doc.writeFence + 1 } : null, ctx.session)
    if (!touched) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.TOOL_CATALOG_CHANGED)
  }
  /**
   * 在授权会话中按原版本更新未删除工作区，一起推进版本并追加请求收据。
   *
   * @param ctx 携带授权写事务的请求上下文。
   * @param workspace 业务变更所依据的当前工作区记录。
   * @param changes 需要合并到工作区的名称、成员、Agent、定义或删除状态。
   * @param receipt 必须与状态变更一起追加的用户作用域幂等收据。
   */
  async function controlCommitWorkspace(ctx: RequestContext, workspace: WorkspaceDocument, changes: Partial<Pick<WorkspaceDocument, 'name' | 'description' | 'members' | 'agents' | 'definitionPackages' | 'definitionAgents' | 'deletedAt'>>, receipt: ControlReceipt): Promise<WorkspaceDocument> {
    const updated = await workspaces.change(workspace._id, doc => /* 只有版本和存在状态仍匹配时才应用变更与收据。 */ doc.revision === workspace.revision && !doc.deletedAt
      ? { ...doc, ...changes, updatedAt: new Date().toISOString(), revision: doc.revision + 1, receipts: [...doc.receipts, receipt] } : null, ctx.session)
    if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.WORKSPACE_CHANGED)
    return updated
  }
  /**
   * 在授权事务中创建工作区及所有者，可使用提供的 Agent 或从锁定版本的全局库复制。
   *
   * @param ctx 必须属于授权写事务且将成为工作区所有者的请求上下文。
   * @param input 新工作区身份、名称、说明和 Agent 来源。
   * @param agents 导入时显式提供的可选 Agent 配置；省略则按 agentSource 决定。
   * @param receipt 需要随工作区创建保存的可选幂等收据。
   * @param definitions v4 导入提供的精确定义闭包及历史 Agent 快照；省略时使用复制或默认目录。
   */
  async function createWorkspace(ctx: RequestContext, input: WorkspaceCreateInput, agents?: AgentInput[], receipt?: ControlReceipt,
    definitions?: { packages: DefinitionPackage[]; agents?: ExecutionAgentDefinition[] }): Promise<WorkspaceView> {
    controlRequireMutation(ctx)
    const id = inputReadId(input.id, 'workspace.id')
    if (typeof input.description !== 'string' || !['empty', 'library'].includes(input.agentSource)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_WORKSPACE_INPUT)
    if (await workspaces.get(id, ctx.session)) throw new GraphError(409, 'WORKSPACE_EXISTS', RuntimeMessage.WORKSPACE_ID_ALREADY_EXISTS)
    let profiles: AgentProfile[] = [], definitionPackages: DefinitionPackage[] = []
    if (agents !== undefined) profiles = agents.map(agent => /* 校验外部提供的 Agent 并建立初始配置版本。 */ controlReadProfile(agent))
    else if (input.agentSource === 'library') {
      const source = await controlReadCopyLibrary(ctx)
      const references = new Map<string, DefinitionRef>()
      const targetBySourceId = new Map<string, DefinitionRef>()
      profiles = source.agents.map(agent => {
        // 为工作区生成独立 Agent 身份，并记录定义包引用的精确重映射。
        const profile = controlReadProfile({ ...agent, id: randomUUID() })
        const target = { id: profile.id, version: profile.revision }
        references.set(`${agent.id}\u0000${agent.revision}`, target)
        targetBySourceId.set(agent.id, target)
        return profile
      })
      for (const archived of source.definitionAgents ?? []) {
        const target = targetBySourceId.get(archived.ref.id)
        if (target) references.set(`${archived.ref.id}\u0000${archived.ref.version}`, target)
      }
      definitionPackages = (source.definitionPackages ?? []).map(packageItem => /* 将包绑定到工作区的独立 Agent 身份。 */ controlRemapDefinitionPackage(packageItem, references))
    }
    if (definitions) definitionPackages = structuredClone(definitions.packages)
    if (!definitions && !definitionPackages.length) definitionPackages = [controlCreateDefaultDefinitions(profiles)]
    controlValidateProfiles(profiles)
    if (profiles.length) await controlValidateTools(ctx, profiles)
    const currentSettings = await controlReadSettings(ctx)
    const definitionAgents = controlReadDefinitionAgents(definitions?.agents ?? [], profiles, currentSettings)
    if (definitionPackages.length) definitionsValidateCatalog(definitionPackages, definitionAgents, 0)
    const now = new Date().toISOString()
    const doc: WorkspaceDocument = { _id: id, name: inputReadString(input.name, 'name').trim(), description: input.description,
      revision: 0, members: [{ userId: ctx.actor.userId, role: 'owner' }], agents: profiles, receipts: receipt ? [receipt] : [],
      definitionPackages, definitionAgents,
      writeFence: 0, createdAt: now, updatedAt: now, deletedAt: null }
    await workspaces.insert(doc, ctx.session)
    return controlReadWorkspace(ctx, doc)
  }
  /**
   * 按库或工作区作用域读取 Agent 集合，写库需管理员，写工作区需所有者。
   *
   * @param ctx 限定全局或工作区配置读取权限的请求上下文。
   * @param scope 指定 Agent 位于全局库还是某个工作区的作用域。
   * @param write true 要求管理员或所有者写权限，false 只要求查看权限。
   */
  async function controlReadAgentScope(ctx: RequestContext, scope: AgentScope, write: boolean): Promise<LibraryDocument | WorkspaceDocument> {
    if (scope.kind === 'workspace') return requireRole(ctx, scope.workspaceId, write ? 'owner' : 'viewer')
    if (write) controlRequireAdmin(ctx)
    return controlReadLibrary(ctx)
  }
  /**
   * 返回作用域、当前集合版本和 Agent 列表供管理界面使用。
   *
   * @param scope 返回给管理调用方的 Agent 作用域。
   * @param doc 提供当前版本和 Agent 集合的库或工作区记录。
   */
  function controlReadAgentList(scope: AgentScope, doc: LibraryDocument | WorkspaceDocument): AgentList {
    return { scope, revision: doc.revision, items: doc.agents }
  }
  /**
   * 用已归档 Agent 快照和当前精确版本校验工作区全部定义，返回与工作区版本绑定的目录。
   *
   * @param ctx 提供共享设置读取事务的请求上下文。
   * @param workspace 已通过角色检查的工作区记录。
   */
  async function controlBuildDefinitionCatalog(ctx: RequestContext, workspace: WorkspaceDocument): Promise<DefinitionCatalog> {
    const current = await controlReadSettings(ctx)
    const agents = controlReadDefinitionAgents(workspace.definitionAgents ?? [], workspace.agents, current)
    return definitionsValidateCatalog(workspace.definitionPackages ?? [], agents, workspace.revision)
  }
  /**
   * 组合精确定义、冻结 Agent 快照、共享工具目录和槽位预算，供 Run 一次性冻结执行规格。
   *
   * @param ctx 提供共享设置读取事务的请求上下文。
   * @param workspace 已通过角色检查的工作区记录。
   */
  async function controlBuildExecutionCatalog(ctx: RequestContext, workspace: WorkspaceDocument): Promise<ExecutionCatalog> {
    const current = await controlReadSettings(ctx)
    const agents = controlReadDefinitionAgents(workspace.definitionAgents ?? [], workspace.agents, current)
    return { definitions: definitionsValidateCatalog(workspace.definitionPackages ?? [], agents, workspace.revision), agents,
      tools: structuredClone(current.tools), maxSlots: current.limits.maxAgentSlots }
  }
  /**
   * 检查工作区查看权限，返回目录和可选精确包，不向未授权用户泄露定义内容。
   *
   * @param ctx 提供用户身份和读取事务的请求上下文。
   * @param workspaceId 需要读取定义目录的工作区身份。
   * @param packageRef 可选需要返回完整内容的精确包引用。
   */
  async function controlReadDefinitions(ctx: RequestContext, workspaceId: string, packageRef?: DefinitionRef): Promise<DefinitionView> {
    const workspace = await requireRole(ctx, workspaceId, 'viewer')
    const catalog = await controlBuildDefinitionCatalog(ctx, workspace)
    if (!packageRef) return { workspaceId, catalog }
    const packageItem = (workspace.definitionPackages ?? []).find(item => /* 同时匹配包身份和版本，不回落到其他版本。 */ item.id === packageRef.id && item.version === packageRef.version)
    if (!packageItem) throw new GraphError(404, 'DEFINITION_NOT_FOUND', messageFormat(RuntimeMessage.DEFINITION_NOT_FOUND_VALUE, packageRef.id, packageRef.version))
    return { workspaceId, catalog, package: structuredClone(packageItem) }
  }
  /**
   * 从已提交工作区读取精确包并返回摘要和新工作区版本。
   *
   * @param workspace 已提交定义包的工作区。
   * @param packageRef 需要投影发布摘要的精确包引用。
   */
  function controlReadDefinitionPublishResult(workspace: WorkspaceDocument, packageRef: DefinitionRef): DefinitionPublishResult {
    const packageItem = (workspace.definitionPackages ?? []).find(item => /* 定位本次发布的精确包。 */ item.id === packageRef.id && item.version === packageRef.version)
    if (!packageItem) throw new GraphError(500, 'DEFINITION_NOT_FOUND', messageFormat(RuntimeMessage.DEFINITION_NOT_FOUND_VALUE, packageRef.id, packageRef.version))
    return { workspaceId: workspace._id, workspaceRevision: workspace.revision,
      package: { ref: { id: packageItem.id, version: packageItem.version }, digest: definitionsDigest(packageItem) } }
  }

  return {
    async initialize(): Promise<void> {
      // 建立成员查询、配置版本及用户工作区偏好唯一性所需索引。
      await workspaces.index(['members.userId', 'updatedAt', '_id'])
      await library.index(['revision'])
      await settings.index(['revision'])
      await preferences.index(['userId', 'workspaceId'], { unique: true })
    },
    /**
     * 仅在全局库或设置缺失时写入显式种子配置，兼容只提供核查配置的初始化输入。
     *
     * @param configuration 可选显式运行配置；缺少的解析或拆分阶段从部署默认补齐，完全省略时播种 Agent 的模型设为继承。
     */
    async seed(configuration?: GraphRunConfiguration): Promise<void> {
      const defaults = deploymentDefaults
      const config = configuration === undefined ? defaults : configurationRead({
        parse: configuration.parse, split: configuration.split, router: configuration.router, merger: configuration.merger,
        agents: configuration.agents, tools: configuration.tools, maxSlots: configuration.maxSlots,
      })
      /**
       * @param agent 需要转换为可管理配置的执行期 Agent。
       * @param kind 该 Agent 在管理库中的提示词角色。
       * @param promptPath 与角色对应、可稳定定位提示词文件的路径。
       */
      const seedProfile = (agent: GraphAgentProfile, kind: PromptKind, promptPath: string): AgentProfile => /* 把执行配置转换为可管理 Agent，补齐阶段变量与默认优先级。 */ controlReadProfile({
        ...agent, provider: configuration === undefined ? null : agent.provider, model: configuration === undefined ? null : agent.model,
        kind, promptPath, promptVars: agent.promptVars ?? CONTROL_PROMPT_VARIABLES[kind],
        defaultPriority: agent.defaultPriority ?? 'medium', claimCategory: agent.claimCategory ?? null,
      })
      /**
       * 默认配置只在显式初始化时用于补齐，运行中的工作区不从文件回退获取缺失配置。
       *
       * @param profile 需要用本次种子模型设置补齐提供者和模型的默认 Agent。
       */
      const fallback = (profile: GraphAgentProfile): GraphAgentProfile => /* 为补齐的默认阶段沿用本次种子配置的模型提供者和模型。 */ ({ ...profile, provider: config.router.provider, model: config.router.model })
      const parse = config.parse ?? fallback(defaults.parse)
      const split = config.split ?? { router: fallback(defaults.split.router), merger: fallback(defaults.split.merger),
        agents: defaults.split.agents.map(fallback) }
      const agents = [
        seedProfile(parse, 'parseExtract', 'fact-parser/extract'),
        seedProfile(split.router, 'splitRoute', 'fact-extractor/main-agent-route'),
        seedProfile(split.merger, 'splitMerge', 'fact-extractor/main-agent-merge'),
        ...split.agents.map(agent => /* 按拆分子 Agent 的身份生成稳定提示词路径并创建种子配置。 */ seedProfile(agent, 'splitSubAgent', `fact-extractor/sub-agents/${agent.id}`)),
        seedProfile(config.router, 'verifyRoute', 'fact-verifier/main-agent-route'),
        seedProfile(config.merger, 'verifyMerge', 'fact-verifier/main-agent-merge'),
        ...config.agents.map(agent => /* 按核查子 Agent 的身份生成稳定提示词路径并创建种子配置。 */ seedProfile(agent, 'verifySubAgent', `fact-verifier/sub-agents/${agent.id}`)),
      ]
      controlValidateProfiles(agents)
      const targetById = new Map(agents.map(agent => /* 将 Agent 原始执行身份映射到保存后的配置。 */ [agent.id, agent]))
      const references = new Map<string, DefinitionRef>()
      /**
       * 把默认提示词身份绑定到实际种子 Agent 的初始配置版本。
       *
       * @param source 默认包中使用的模板 Agent。
       * @param target 本次种子配置中取代模板的 Agent。
       */
      const bind = (source: GraphAgentProfile, target: GraphAgentProfile): void => {
        const profile = targetById.get(target.id)
        if (!profile) throw new GraphError(500, 'DEFAULT_CONFIGURATION_INVALID', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `Seed Agent is missing: ${target.id}`))
        references.set(`${source.id}\u0000${0}`, { id: profile.id, version: profile.revision })
      }
      bind(defaults.parse, parse); bind(defaults.split.router, split.router); bind(defaults.split.merger, split.merger)
      for (const [index, source] of defaults.split.agents.entries()) bind(source, split.agents[index % split.agents.length])
      bind(defaults.router, config.router); bind(defaults.merger, config.merger)
      for (const [index, source] of defaults.agents.entries()) bind(source, config.agents[index % config.agents.length])
      /**
       * 把本次种子配置的 Agent 身份转换为初始版本引用。
       *
       * @param items 需要转换为精确已保存引用的执行 Agent 集合。
       */
      const readRefs = (items: readonly GraphAgentProfile[]): DefinitionRef[] => {
        return items.map(item => {
          // 定位该执行 Agent 对应的管理配置并返回精确引用。
          const profile = targetById.get(item.id)
          if (!profile) throw new GraphError(500, 'DEFAULT_CONFIGURATION_INVALID', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `Seed Agent is missing: ${item.id}`))
          return { id: profile.id, version: profile.revision }
        })
      }
      const definitionPackage = controlRemapDefinitionPackage(defaults.definitionPackage, references, [
        { sourceIds: new Set(defaults.split.agents.map(agent => /* 提取候选身份以识别计划组。 */ agent.id)), targets: readRefs(split.agents) },
        { sourceIds: new Set(defaults.agents.map(agent => /* 提取候选身份以识别计划组。 */ agent.id)), targets: readRefs(config.agents) },
      ])
      const seedSettings: ClusterSettings = { revision: 0, llm: { provider: config.router.provider, model: config.router.model },
        tools: config.tools, limits: { maxAgentSlots: config.maxSlots } }
      const definitionAgents = controlReadDefinitionAgents([], agents, seedSettings)
      definitionsValidateCatalog([definitionPackage], definitionAgents, 0)
      await database.transaction(async session => {
        // 在同一事务中只创建缺失的库和设置，避免重启覆盖已编辑配置。
        const now = new Date().toISOString()
        if (!await library.get('global', session)) await library.insert({ _id: 'global', revision: 0, agents, receipts: [], writeFence: 0, updatedAt: now,
          definitionPackages: [definitionPackage], definitionAgents }, session)
        if (!await settings.get('global', session)) await settings.insert({ _id: 'global', revision: 0,
          llm: { provider: config.router.provider, model: config.router.model }, tools: config.tools,
          limits: { maxAgentSlots: config.maxSlots }, receipts: [], writeFence: 0, updatedAt: now }, session)
      })
    },
    requireRole,
    createWorkspace,
    /**
     * 与用户写权限检查共用 writeFence，防止 Agent 新增资产引用和并发资产删除形成写偏差。
     *
     * @param session 内部 Work 结果提交使用的共享事务会话。
     * @param workspaceId Work 所属工作区。
     */
    async fenceExecutionWrite(session: StorageSession, workspaceId: string): Promise<void> {
      const current = await workspaces.get(workspaceId, session)
      if (!current || current.deletedAt) throw new GraphError(409, 'WORKSPACE_GONE', RuntimeMessage.WORKSPACE_WAS_DELETED)
      const touched = await workspaces.change(workspaceId, doc => !doc.deletedAt && doc.writeFence === current.writeFence
        ? { ...doc, writeFence: doc.writeFence + 1 } : null, session)
      if (!touched) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.WORKSPACE_CHANGED)
    },
    /**
     * 校验工作区查看权限并返回经过完整引用检查的定义目录，供 Run 启动冻结规格。
     *
     * @param ctx 需要读取执行定义的授权请求上下文。
     * @param workspaceId 定义目录所属工作区身份。
     */
    async definitions(ctx: RequestContext, workspaceId: string): Promise<DefinitionCatalog> {
      return (await controlReadDefinitions(ctx, workspaceId)).catalog
    },
    /**
     * Viewer 已能导出工作区 Agent 内容；这里返回当前及历史精确快照，供数据包验证不可变定义依赖。
     *
     * @param ctx 需要导出精确定义依赖的授权请求上下文。
     * @param workspaceId 定义及历史 Agent 快照所属工作区。
     */
    async definitionAgents(ctx: RequestContext, workspaceId: string): Promise<ExecutionAgentDefinition[]> {
      const workspace = await requireRole(ctx, workspaceId, 'viewer')
      const current = await controlReadSettings(ctx)
      return structuredClone(controlReadDefinitionAgents(workspace.definitionAgents ?? [], workspace.agents, current))
    },
    /**
     * 检查工作区编辑权限并返回定义、Agent、工具和预算的同一读取快照。
     *
     * @param ctx 需要启动 Run 的授权请求上下文。
     * @param workspaceId 执行目录所属工作区身份。
     */
    async executionCatalog(ctx: RequestContext, workspaceId: string): Promise<ExecutionCatalog> {
      return controlBuildExecutionCatalog(ctx, await requireRole(ctx, workspaceId, 'editor'))
    },
    /**
     * 要求编辑权限，解析工作区 Agent 与共享默认值，生成经过完整校验的运行配置。
     *
     * @param ctx 必须具有工作区编辑权限的请求上下文。
     * @param workspaceId 需要解析并冻结运行配置的工作区身份。
     */
    async configuration(ctx: RequestContext, workspaceId: string): Promise<GraphRunConfiguration> {
      const workspace = await requireRole(ctx, workspaceId, 'editor')
      const current = await controlReadSettings(ctx)
      const router = workspace.agents.find(agent => /* 取得工作区固定核查路由角色。 */ agent.kind === 'verifyRoute')
      const merger = workspace.agents.find(agent => /* 取得工作区固定核查汇总角色。 */ agent.kind === 'verifyMerge')
      const agents = workspace.agents.filter(agent => /* 收集可供路由选择的核查子 Agent。 */ agent.kind === 'verifySubAgent')
      if (!router || !merger || !agents.length) throw new GraphError(422, 'CONFIGURATION_INCOMPLETE', RuntimeMessage.WORKSPACE_REQUIRES_VERIFICATION_ROUTER_MERGER_AND_AT_LEAST_ONE_WORKER)
      /**
       * @param agent 需要用共享模型默认值补齐并投影为执行配置的 Agent。
       */
      const resolve = (agent: AgentProfile): GraphAgentProfile => /* 投影执行所需配置，未单独指定模型时使用共享默认值，并复制工具和变量列表。 */ ({ id: agent.id, name: agent.name,
        description: agent.description, content: agent.content, tools: [...agent.tools],
        provider: agent.provider ?? current.llm.provider, model: agent.model ?? current.llm.model,
        promptVars: [...agent.promptVars], defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory })
      const parse = workspace.agents.find(agent => /* 取得可选的来源解析角色。 */ agent.kind === 'parseExtract')
      const splitRouter = workspace.agents.find(agent => /* 取得可选拆分阶段的路由角色。 */ agent.kind === 'splitRoute')
      const splitMerger = workspace.agents.find(agent => /* 取得可选拆分阶段的汇总角色。 */ agent.kind === 'splitMerge')
      const splitAgents = workspace.agents.filter(agent => /* 收集拆分子 Agent，供判断拆分能力是否完整。 */ agent.kind === 'splitSubAgent')
      return configurationRead({ router: resolve(router), merger: resolve(merger), agents: agents.map(resolve), tools: current.tools, maxSlots: current.limits.maxAgentSlots,
        ...(parse ? { parse: resolve(parse) } : {}),
        ...(splitRouter && splitMerger && splitAgents.length ? { split: { router: resolve(splitRouter), merger: resolve(splitMerger), agents: splitAgents.map(resolve) } } : {}),
      })
    },
    /**
     * 解析管理查询并按权限返回启动信息、工作区详情、Agent 列表或用户绑定的工作区分页。
     *
     * @param ctx 包含用户身份和可选读取事务的请求上下文。
     * @param input 已经过或即将在边界解析的管理查询。
     */
    async read(ctx: RequestContext, input: ControlQuery): Promise<ControlReadResult> {
      const query = controlReadQuery(input)
      if (query.method === 'app.bootstrap') return { identity: ctx.actor, settings: await controlReadSettings(ctx),
        metadata: { clientLeases, version: '061-v1', promptKinds: [...CONTROL_PROMPT_KINDS], executableKinds: ['parse', 'split', 'verify'], scores: [0, 0.5, 1],
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
          ], definitions: { queryMethod: 'definition.get', publishMethod: 'definition.publish' } } }
      if (query.method === 'workspace.get') return controlReadWorkspace(ctx, await requireRole(ctx, query.params.workspaceId, 'viewer'))
      if (query.method === 'definition.get') return controlReadDefinitions(ctx, query.params.workspaceId,
        query.params.packageId === undefined || query.params.packageVersion === undefined ? undefined : { id: query.params.packageId, version: query.params.packageVersion })
      if (query.method === 'agent.list') {
        const doc = await controlReadAgentScope(ctx, query.params.scope, false)
        return { ...controlReadAgentList(query.params.scope, doc), items: doc.agents.filter(agent => /* 按可选提示词类型筛选当前作用域 Agent。 */ !query.params.kind || agent.kind === query.params.kind) }
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
        .filter(doc => /* 仅保留排序位置在游标之后的工作区记录。 */ !cursor || doc.updatedAt < cursor.updatedAt || (doc.updatedAt === cursor.updatedAt && doc._id > cursor.id))
        .sort((a, b) => /* 按更新时间倒序、身份正序固定工作区分页顺序。 */ b.updatedAt.localeCompare(a.updatedAt) || a._id.localeCompare(b._id)).slice(0, limit + 1)
      const items: WorkspaceSummary[] = []
      for (const doc of docs.slice(0, limit)) items.push({ id: doc._id, name: doc.name, description: doc.description,
        revision: doc.revision, role: controlReadRole(ctx, doc, 'viewer'), updatedAt: doc.updatedAt,
        mapCount: await graphs.count({ workspaceId: doc._id, deletedAt: null }, ctx.session) })
      const last = items[items.length - 1]
      return { items, nextCursor: docs.length > limit && last ? Buffer.from(JSON.stringify({ userId: ctx.actor.userId, updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null }
    },
    /**
     * 在授权事务中分派管理写命令，先检查收据重放，再校验角色、版本和各资源不变式。
     *
     * @param ctx 必须携带已授权写事务的请求上下文。
     * @param input 来自公共边界、需要解析和分派的管理命令。
     */
    async dispatch(ctx: RequestContext, input: ControlCommand): Promise<{ data: ControlWriteResult; replayed: boolean }> {
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
        const allowed = command.params.tools.map(tool => /* 收集新共享工具目录的名称，作为删除检测的允许集合。 */ tool.name)
        const removed = doc.tools.filter(tool => /* 找出旧目录中此次更新要删除的工具。 */ !allowed.includes(tool.name)).map(tool => /* 提取被删除工具的名称以查询现存 Agent 引用。 */ tool.name)
        if (removed.length && ((await library.list({ 'agents.tools': removed }, ctx.session)).length
          || (await library.list({ 'definitionAgents.profile.tools': removed }, ctx.session)).length
          || (await workspaces.list({ deletedAt: null, 'agents.tools': removed }, ctx.session)).length
          || (await workspaces.list({ deletedAt: null, 'definitionAgents.profile.tools': removed }, ctx.session)).length)) throw new GraphError(409, 'TOOL_IN_USE', RuntimeMessage.AN_AGENT_STILL_USES_A_REMOVED_TOOL)
        const updated = await settings.change('global', current => /* 按共享设置原版本保存新配置，并同时推进版本及写入收据。 */ current.revision === doc.revision ? { ...current,
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
          if (!command.params.agent.bindings && !controlIsWorker(command.params.agent.kind)) throw new GraphError(422, 'FIXED_ROLE', RuntimeMessage.ONLY_SUBAGENT_PROFILES_MAY_BE_CREATED)
          if (doc.receipts.some(item => /* 检查该 Agent 身份是否已有删除记录，阻止删除后复用身份。 */ item.method === 'agent.delete' && item.resourceId === command.params.agent.id)) throw new GraphError(409, 'AGENT_ID_REUSED', RuntimeMessage.DELETED_AGENT_IDS_CANNOT_BE_REUSED)
          agents.push(controlReadProfile(command.params.agent))
        } else {
          const existing = agents.find(agent => /* 定位本次编辑或删除的现有 Agent。 */ agent.id === command.params.agentId)
          if (!existing) throw new GraphError(404, 'AGENT_NOT_FOUND', RuntimeMessage.AGENT_NOT_FOUND)
          controlRequireRevision(existing.revision, command.params.expectedAgentRevision)
          if (command.method === 'agent.delete') {
            if (!existing.deletable) throw new GraphError(409, 'FIXED_ROLE', RuntimeMessage.FIXED_PROFILES_CANNOT_BE_DELETED)
            agents = agents.filter(agent => /* 移除已通过可删除性校验的目标 Agent。 */ agent.id !== existing.id)
          } else {
            const next = command.params.agent
            if (next.id !== existing.id || next.kind !== existing.kind || next.promptPath !== existing.promptPath) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', RuntimeMessage.AGENT_ID_KIND_AND_PROMPTPATH_ARE_IMMUTABLE)
            agents = agents.map(agent => /* 仅替换目标 Agent 并推进其版本，保留集合内其余配置。 */ agent.id === existing.id ? controlReadProfile(next, existing.revision + 1) : agent)
          }
        }
        controlValidateProfiles(agents)
        await controlValidateTools(ctx, agents)
        if (agents.some(agent => /* 仅在存在通用绑定时构建并校验定义目录。 */ !!agent.bindings?.length)) {
          const current = await controlReadSettings(ctx)
          const definitionAgents = controlReadDefinitionAgents(doc.definitionAgents ?? [], agents, current)
          const catalog = definitionsValidateCatalog(doc.definitionPackages ?? [], definitionAgents, doc.revision)
          controlValidateAgentBindings(catalog, agents)
        }
        if (scope.kind === 'workspace') {
          const updated = await controlCommitWorkspace(ctx, doc as WorkspaceDocument, { agents }, receipt)
          return { data: controlReadAgentList(scope, updated), replayed: false }
        }
        const updated = await library.change('global', current => /* 在库版本未变时提交新的 Agent 集合和幂等收据。 */ current.revision === doc.revision ? { ...current, agents, updatedAt: new Date().toISOString(),
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
        if (maps.length !== mapIds.length || maps.some(map => /* 检测偏好选中的节点是否属于对应图，避免保存跨图或已删除节点。 */ nodeSelection[map._id] && !map.nodes.some(node => /* 核对所选节点在这张图中确实存在。 */ node.id === nodeSelection[map._id]))) throw new GraphError(422, 'INVALID_PREFERENCES', RuntimeMessage.PREFERENCES_REFER_TO_ANOTHER_OR_MISSING_MAP_NODE)
        const next: PreferencesDocument = { _id: id, userId: ctx.actor.userId, workspaceId: workspace._id,
          revision: (prior?.revision ?? 0) + 1, openMapIds, currentMapId, nodeSelection, receipts: [...(prior?.receipts ?? []), receipt] }
        if (!prior) await preferences.insert(next, ctx.session)
        else {
          const changed = await preferences.change(id, current => /* 只在偏好版本仍匹配时替换内容，防止并发客户端覆盖。 */ current.revision === prior.revision ? next : null, ctx.session)
          if (!changed) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.PREFERENCES_CHANGED)
        }
        return { data: await controlReadPreferences(ctx, workspace._id), replayed: false }
      }
      if (controlReadReplay(workspace.receipts, receipt)) {
        if (command.method === 'definition.publish') return { data: controlReadDefinitionPublishResult(workspace, command.params.package), replayed: true }
        if (command.method === 'member.set') {
          const member = workspace.members.find(member => /* 读取成员设置请求对应的当前成员，作为重放响应。 */ member.userId === command.params.userId)
          const user = member && await users.get(member.userId, ctx.session)
          return { data: { userId: command.params.userId, member: member ? { ...member, displayName: user?.displayName ?? member.userId } : null, workspaceRevision: workspace.revision }, replayed: true }
        }
        return { data: await controlReadWorkspace(ctx, workspace), replayed: true }
      }
      controlRequireRevision(workspace.revision, command.params.expectedRevision)
      if (command.method === 'definition.publish') {
        const packageItem = definitionsReadPackage(command.params.package)
        const packages = [...(workspace.definitionPackages ?? [])]
        const existing = packages.find(item => /* 定位同一 package id/version 以检查不可变内容。 */ item.id === packageItem.id && item.version === packageItem.version)
        if (!existing) packages.push(packageItem)
        else if (definitionsDigest(existing) !== definitionsDigest(packageItem)) throw new GraphError(409, 'DEFINITION_VERSION_CONFLICT', messageFormat(RuntimeMessage.DEFINITION_VERSION_CONFLICT_VALUE, packageItem.id, packageItem.version))
        const current = await controlReadSettings(ctx)
        const definitionAgents = controlReadDefinitionAgents(workspace.definitionAgents ?? [], workspace.agents, current)
        definitionsValidateCatalog(packages, definitionAgents, workspace.revision + 1)
        const updated = await controlCommitWorkspace(ctx, workspace, { definitionPackages: packages, definitionAgents }, receipt)
        return { data: controlReadDefinitionPublishResult(updated, packageItem), replayed: false }
      }
      if (command.method === 'workspace.update') return { data: await controlReadWorkspace(ctx, await controlCommitWorkspace(ctx, workspace, { name: command.params.name, description: command.params.description }, receipt)), replayed: false }
      if (command.method === 'workspace.delete') {
        const now = await database.now(), graphRows = await graphs.list({ workspaceId: workspace._id, deletedAt: null }, ctx.session)
        if (graphRows.some(graph => graph.runs.some(run => ['accepted', 'running', 'waiting'].includes(run.status))
          || Object.values(graph.branchOwnerships ?? {}).some(ownership => ownership.kind === 'run'
            || clientLeases === 'required' && ownership.expiresAt !== null && Date.parse(ownership.expiresAt) > now))) {
          throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.CANCEL_ACTIVE_RUNS_BEFORE_DELETING_THE_WORKSPACE)
        }
        await controlCommitWorkspace(ctx, workspace, { deletedAt: new Date().toISOString() }, receipt)
        return { data: { workspaceId: workspace._id, deleted: true }, replayed: false }
      }
      if (command.method === 'member.set') {
        const user = await (async () => {
          // 读取目标用户并将已停用账户视为不可新增的成员。
          const user = await users.get(command.params.userId, ctx.session); return user?.disabled ? null : user })()
        if (command.params.role !== null && !user) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.AN_ENABLED_USER_IS_REQUIRED)
        const members = workspace.members.filter(member => /* 先移除该用户的旧成员记录，以便统一处理角色替换与移除。 */ member.userId !== command.params.userId)
        if (command.params.role !== null) members.push({ userId: command.params.userId, role: command.params.role })
        const owners = members.filter(member => /* 收集变更后仍拥有 owner 角色的成员。 */ member.role === 'owner').map(member => /* 提取所有者身份以确认至少一个账户仍启用。 */ member.userId)
        if (!owners.length || !(await users.list({ _id: owners, disabled: false }, ctx.session)).length) throw new GraphError(409, 'LAST_OWNER', RuntimeMessage.WORKSPACE_MUST_RETAIN_AN_ENABLED_OWNER)
        const updated = await controlCommitWorkspace(ctx, workspace, { members }, receipt)
        return { data: { userId: command.params.userId, member: command.params.role === null ? null : { userId: command.params.userId, displayName: user!.displayName, role: command.params.role }, workspaceRevision: updated.revision }, replayed: false }
      }
      if (command.method === 'agent.copy') {
        const source = await controlReadCopyLibrary(ctx, command.params.libraryRevision)
        const selected = source.agents.filter(agent => /* 按请求选择全局库中需要复制的 Agent。 */ command.params.agentIds.includes(agent.id))
        if (!selected.length || selected.length !== command.params.agentIds.length) throw new GraphError(404, 'AGENT_NOT_FOUND', RuntimeMessage.SELECT_EXISTING_LIBRARY_AGENTS)
        const copied = selected.map(agent => {
          // 按提示词路径复用工作区身份并推进版本，拒绝复制改变已有固定角色类型。
          const existing = workspace.agents.find(item => /* 寻找同提示词路径的工作区配置，保持复制覆盖时的身份稳定。 */ item.promptPath === agent.promptPath)
          if (existing && existing.kind !== agent.kind) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', RuntimeMessage.COPY_CANNOT_CHANGE_THE_KIND_OF_AN_EXISTING_PROMPTPATH)
          return controlReadProfile({ ...agent, id: existing?.id ?? randomUUID() }, existing ? existing.revision + 1 : 0)
        })
        const agents = command.params.mode === 'replace' ? copied : [...workspace.agents.filter(agent => /* 合并模式保留未被本次复制选中路径覆盖的原配置。 */ !selected.some(item => /* 判断当前配置路径是否将由库中的选择项替换。 */ item.promptPath === agent.promptPath)), ...copied]
        const removed = workspace.agents.filter(agent => /* 找出复制替换后被移除的旧 Agent。 */ !agents.some(item => /* 判断旧 Agent 身份是否仍存在于最终集合。 */ item.id === agent.id))
        if (removed.some(agent => /* 检查被移除配置中是否包含不允许删除的固定角色。 */ !agent.deletable)) throw new GraphError(409, 'FIXED_ROLE', RuntimeMessage.COPY_CANNOT_REMOVE_FIXED_PROFILES)
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
