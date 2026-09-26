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
// 用途：判断配置与权限是否满足当前条件。
function controlIsWorker(kind: PromptKind): boolean { return kind === 'splitSubAgent' || kind === 'verifySubAgent' }
// 用途：处理配置与权限相关工作，并把结果交给调用方。
function controlRequireMutation(ctx: RequestContext): void {
  if (!ctx.mutation || !ctx.session?.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', RuntimeMessage.CONTROL_WRITES_REQUIRE_AN_AUTHORIZED_TRANSACTION)
}
// 用途：处理配置与权限相关工作，并把结果交给调用方。
function controlRequireAdmin(ctx: RequestContext): void {
  if (!ctx.actor.hostAdmin) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.HOST_ADMINISTRATOR_PERMISSION_IS_REQUIRED)
}
// 用途：处理配置与权限相关工作，并把结果交给调用方。
function controlRequireRevision(actual: number, expected: number): void {
  if (actual !== expected) throw new GraphError(409, 'REVISION_CONFLICT', messageFormat(RuntimeMessage.EXPECTED_REVISION_VALUE_FOUND_VALUE, expected, actual), actual)
}
// 用途：读取权限，并把结构化结果交给调用方。
function controlReadRole(ctx: RequestContext, workspace: WorkspaceDocument, minimum: Role): Role {
  const member = workspace.members.find(member => member.userId === ctx.actor.userId)
  if (!member) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', RuntimeMessage.WORKSPACE_NOT_FOUND)
  if (roleRank[member.role] < roleRank[minimum]) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_PERMISSION_IS_INSUFFICIENT)
  return member.role
}
// 用途：创建收据，供后续流程使用。
function controlCreateReceipt(ctx: RequestContext, command: ControlCommand, resourceId?: string): ControlReceipt {
  return { userId: ctx.actor.userId, requestId: command.requestId, method: command.method,
    hash: storeCreateInputHash({ method: command.method, params: command.params }), ...(resourceId ? { resourceId } : {}) }
}
// 用途：读取配置与权限，并把结构化结果交给调用方。
function controlReadReplay(receipts: ControlReceipt[], receipt: ControlReceipt): boolean {
  const prior = receipts.find(item => item.userId === receipt.userId && item.requestId === receipt.requestId)
  if (prior && (prior.method !== receipt.method || prior.hash !== receipt.hash)) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_WAS_USED_WITH_DIFFERENT_INPUT)
  return !!prior
}
// 用途：读取配置，并把结构化结果交给调用方。
function controlReadProfile(agent: AgentInput, revision = 0): AgentProfile {
  const { id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory } = agent
  return { ...controlReadAgent({ id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory }),
    revision, deletable: controlIsWorker(agent.kind), updatedAt: new Date().toISOString() }
}
// 用途：校验配置输入，发现不符合约束时立即报错。
function controlValidateProfiles(agents: AgentProfile[]): void {
  if (new Set(agents.map(agent => agent.id)).size !== agents.length || new Set(agents.map(agent => agent.promptPath)).size !== agents.length) {
    throw new GraphError(409, 'AGENT_EXISTS', RuntimeMessage.AGENT_ID_AND_PROMPTPATH_MUST_BE_UNIQUE_WITHIN_THEIR_SCOPE)
  }
  const fixed = agents.filter(agent => !controlIsWorker(agent.kind))
  if (new Set(fixed.map(agent => agent.kind)).size !== fixed.length) throw new GraphError(409, 'AGENT_EXISTS', RuntimeMessage.ONLY_ONE_PROFILE_IS_ALLOWED_FOR_EACH_FIXED_ROLE)
}

// 用途：创建服务，供后续流程使用。
export function controlCreateService(database: Persistence, seedDefaults: GraphSeedConfiguration) {
  const workspaces = database.records<WorkspaceDocument>('control_workspaces')
  const library = database.records<LibraryDocument>('control_library')
  const settings = database.records<SettingsDocument>('control_settings')
  const preferences = database.records<PreferencesDocument>('control_preferences')
  const users = database.records<UserDocument>('control_users')
  const graphs = database.records<GraphRecord>(GRAPH_COLLECTION)


  // 用途：读取设置，并把结构化结果交给调用方。
  async function controlReadSettings(ctx: RequestContext): Promise<ClusterSettings> {
    const doc = await settings.get('global', ctx.session)
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.AN_ADMINISTRATOR_MUST_SEED_SHARED_SETTINGS)
    return { revision: doc.revision, llm: doc.llm, tools: doc.tools, limits: doc.limits }
  }
  // 用途：读取库，并把结构化结果交给调用方。
  async function controlReadLibrary(ctx: RequestContext): Promise<LibraryDocument> {
    const doc = await library.get('global', ctx.session)
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', RuntimeMessage.AN_ADMINISTRATOR_MUST_SEED_THE_AGENT_LIBRARY)
    return doc
  }
  // 用途：读取库，并把结构化结果交给调用方。
  async function controlReadCopyLibrary(ctx: RequestContext, expectedRevision?: number): Promise<LibraryDocument> {
    const doc = await controlReadLibrary(ctx)
    if (expectedRevision !== undefined) controlRequireRevision(doc.revision, expectedRevision)
    const locked = await library.change('global', current => current.revision === doc.revision ? { ...current, writeFence: current.writeFence + 1 } : null, ctx.session)
    if (!locked) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.AGENT_LIBRARY_CHANGED)
    return locked
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  async function requireRole(ctx: RequestContext, workspaceId: string, minimum: Role): Promise<WorkspaceDocument> {
    const doc = await workspaces.get(workspaceId, ctx.session)
    if (!doc || doc.deletedAt) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', RuntimeMessage.WORKSPACE_NOT_FOUND)
    controlReadRole(ctx, doc, minimum)
    if (!ctx.mutation) return doc
    controlRequireMutation(ctx)
    const touched = await workspaces.change(workspaceId, current => {
      if (current.deletedAt) return null
      controlReadRole(ctx, current, minimum)
      return { ...current, writeFence: current.writeFence + 1 }
    }, ctx.session)
    if (!touched) throw new GraphError(403, 'FORBIDDEN', RuntimeMessage.WORKSPACE_ACCESS_CHANGED)
    return touched
  }
  // 用途：读取偏好，并把结构化结果交给调用方。
  async function controlReadPreferences(ctx: RequestContext, workspaceId: string): Promise<Preferences> {
    const doc = await preferences.get(`${ctx.actor.userId}:${workspaceId}`, ctx.session)
    return doc ? { workspaceId, revision: doc.revision, openMapIds: doc.openMapIds, currentMapId: doc.currentMapId, nodeSelection: doc.nodeSelection }
      : { workspaceId, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} }
  }
  // 用途：读取工作区，并把结构化结果交给调用方。
  async function controlReadWorkspace(ctx: RequestContext, workspace: WorkspaceDocument): Promise<WorkspaceView> {
    const names = await users.list({ _id: workspace.members.map(member => member.userId) }, ctx.session)
    return {
      id: workspace._id, name: workspace.name, description: workspace.description, revision: workspace.revision,
      role: controlReadRole(ctx, workspace, 'viewer'), updatedAt: workspace.updatedAt,
      mapCount: await graphs.count({ workspaceId: workspace._id, deletedAt: null }, ctx.session),
      agents: workspace.agents,
      members: workspace.members.map(member => ({ ...member, displayName: names.find(user => user._id === member.userId)?.displayName ?? member.userId })),
      preferences: await controlReadPreferences(ctx, workspace._id),
    }
  }
  // 用途：校验配置与权限输入，发现不符合约束时立即报错。
  async function controlValidateTools(ctx: RequestContext, agents: AgentProfile[]): Promise<void> {
    const current = await controlReadSettings(ctx)
    if (agents.some(agent => agent.tools.some(name => !current.tools.some(tool => tool.name === name)))) {
      throw new GraphError(422, 'UNKNOWN_TOOL', RuntimeMessage.AGENT_REFERS_TO_A_TOOL_OUTSIDE_THE_SHARED_CAPABILITY_CATALOG)
    }
    // Serialize new references with removal of a shared tool declaration.
    const touched = await settings.change('global', doc => doc.revision === current.revision ? { ...doc, writeFence: doc.writeFence + 1 } : null, ctx.session)
    if (!touched) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.TOOL_CATALOG_CHANGED)
  }
  // 用途：提交工作区，并保持相关状态一致。
  async function controlCommitWorkspace(ctx: RequestContext, workspace: WorkspaceDocument, changes: Partial<Pick<WorkspaceDocument, 'name' | 'description' | 'members' | 'agents' | 'deletedAt'>>, receipt: ControlReceipt): Promise<WorkspaceDocument> {
    const updated = await workspaces.change(workspace._id, doc => doc.revision === workspace.revision && !doc.deletedAt
      ? { ...doc, ...changes, updatedAt: new Date().toISOString(), revision: doc.revision + 1, receipts: [...doc.receipts, receipt] } : null, ctx.session)
    if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.WORKSPACE_CHANGED)
    return updated
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  async function createWorkspace(ctx: RequestContext, input: WorkspaceCreateInput, agents?: AgentInput[], receipt?: ControlReceipt): Promise<WorkspaceView> {
    controlRequireMutation(ctx)
    const id = inputReadId(input.id, 'workspace.id')
    if (typeof input.description !== 'string' || !['empty', 'library'].includes(input.agentSource)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_WORKSPACE_INPUT)
    if (await workspaces.get(id, ctx.session)) throw new GraphError(409, 'WORKSPACE_EXISTS', RuntimeMessage.WORKSPACE_ID_ALREADY_EXISTS)
    const profiles = agents !== undefined ? agents.map(agent => controlReadProfile(agent))
      : input.agentSource === 'library' ? (await controlReadCopyLibrary(ctx)).agents.map(agent => controlReadProfile({ ...agent, id: randomUUID() })) : []
    controlValidateProfiles(profiles)
    if (profiles.length) await controlValidateTools(ctx, profiles)
    const now = new Date().toISOString()
    const doc: WorkspaceDocument = { _id: id, name: inputReadString(input.name, 'name').trim(), description: input.description,
      revision: 0, members: [{ userId: ctx.actor.userId, role: 'owner' }], agents: profiles, receipts: receipt ? [receipt] : [],
      writeFence: 0, createdAt: now, updatedAt: now, deletedAt: null }
    await workspaces.insert(doc, ctx.session)
    return controlReadWorkspace(ctx, doc)
  }
  // 用途：读取Agent范围，并把结构化结果交给调用方。
  async function controlReadAgentScope(ctx: RequestContext, scope: AgentScope, write: boolean): Promise<LibraryDocument | WorkspaceDocument> {
    if (scope.kind === 'workspace') return requireRole(ctx, scope.workspaceId, write ? 'owner' : 'viewer')
    if (write) controlRequireAdmin(ctx)
    return controlReadLibrary(ctx)
  }
  // 用途：读取Agent列表，并把结构化结果交给调用方。
  function controlReadAgentList(scope: AgentScope, doc: LibraryDocument | WorkspaceDocument): AgentList {
    return { scope, revision: doc.revision, items: doc.agents }
  }

  return {
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize(): Promise<void> {
      await workspaces.index(['members.userId', 'updatedAt', '_id'])
      await library.index(['revision'])
      await settings.index(['revision'])
      await preferences.index(['userId', 'workspaceId'], { unique: true })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async seed(configuration?: GraphRunConfiguration): Promise<void> {
      const defaults = configurationReadSeed(seedDefaults)
      const config = configuration === undefined ? defaults : configurationRead(configuration)
      const seedProfile = (agent: GraphAgentProfile, kind: PromptKind, promptPath: string): AgentProfile => controlReadProfile({
        ...agent, provider: configuration === undefined ? null : agent.provider, model: configuration === undefined ? null : agent.model,
        kind, promptPath, promptVars: agent.promptVars ?? CONTROL_PROMPT_VARIABLES[kind],
        defaultPriority: agent.defaultPriority ?? 'medium', claimCategory: agent.claimCategory ?? null,
      })
      // Files are read only at this explicit seed boundary, never as a running Workspace fallback.
      const fallback = (profile: GraphAgentProfile): GraphAgentProfile => ({ ...profile, provider: config.router.provider, model: config.router.model })
      const parse = config.parse ?? fallback(defaults.parse)
      const split = config.split ?? { router: fallback(defaults.split.router), merger: fallback(defaults.split.merger),
        agents: defaults.split.agents.map(fallback) }
      const agents = [
        seedProfile(parse, 'parseExtract', 'fact-parser/extract'),
        seedProfile(split.router, 'splitRoute', 'fact-extractor/main-agent-route'),
        seedProfile(split.merger, 'splitMerge', 'fact-extractor/main-agent-merge'),
        ...split.agents.map(agent => seedProfile(agent, 'splitSubAgent', `fact-extractor/sub-agents/${agent.id}`)),
        seedProfile(config.router, 'verifyRoute', 'fact-verifier/main-agent-route'),
        seedProfile(config.merger, 'verifyMerge', 'fact-verifier/main-agent-merge'),
        ...config.agents.map(agent => seedProfile(agent, 'verifySubAgent', `fact-verifier/sub-agents/${agent.id}`)),
      ]
      controlValidateProfiles(agents)
      await database.transaction(async session => {
        const now = new Date().toISOString()
        if (!await library.get('global', session)) await library.insert({ _id: 'global', revision: 0, agents, receipts: [], writeFence: 0, updatedAt: now }, session)
        if (!await settings.get('global', session)) await settings.insert({ _id: 'global', revision: 0,
          llm: { provider: config.router.provider, model: config.router.model }, tools: config.tools,
          limits: { maxAgentSlots: config.maxSlots }, receipts: [], writeFence: 0, updatedAt: now }, session)
      })
    },
    requireRole,
    createWorkspace,
    // 用途：处理配置相关工作，并把结果交给调用方。
    async configuration(ctx: RequestContext, workspaceId: string): Promise<GraphRunConfiguration> {
      const workspace = await requireRole(ctx, workspaceId, 'editor')
      const current = await controlReadSettings(ctx)
      const router = workspace.agents.find(agent => agent.kind === 'verifyRoute')
      const merger = workspace.agents.find(agent => agent.kind === 'verifyMerge')
      const agents = workspace.agents.filter(agent => agent.kind === 'verifySubAgent')
      if (!router || !merger || !agents.length) throw new GraphError(422, 'CONFIGURATION_INCOMPLETE', RuntimeMessage.WORKSPACE_REQUIRES_VERIFICATION_ROUTER_MERGER_AND_AT_LEAST_ONE_WORKER)
      const resolve = (agent: AgentProfile): GraphAgentProfile => ({ id: agent.id, name: agent.name,
        description: agent.description, content: agent.content, tools: [...agent.tools],
        provider: agent.provider ?? current.llm.provider, model: agent.model ?? current.llm.model,
        promptVars: [...agent.promptVars], defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory })
      const parse = workspace.agents.find(agent => agent.kind === 'parseExtract')
      const splitRouter = workspace.agents.find(agent => agent.kind === 'splitRoute')
      const splitMerger = workspace.agents.find(agent => agent.kind === 'splitMerge')
      const splitAgents = workspace.agents.filter(agent => agent.kind === 'splitSubAgent')
      return configurationRead({ router: resolve(router), merger: resolve(merger), agents: agents.map(resolve), tools: current.tools, maxSlots: current.limits.maxAgentSlots,
        ...(parse ? { parse: resolve(parse) } : {}),
        ...(splitRouter && splitMerger && splitAgents.length ? { split: { router: resolve(splitRouter), merger: resolve(splitMerger), agents: splitAgents.map(resolve) } } : {}),
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read(ctx: RequestContext, input: ControlQuery): Promise<ControlReadResult> {
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
        return { ...controlReadAgentList(query.params.scope, doc), items: doc.agents.filter(agent => !query.params.kind || agent.kind === query.params.kind) }
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
      // ponytail: sort metadata pages here; push cursor ranges into adapters for large workspace catalogs.
      const docs = (await workspaces.list({ deletedAt: null, 'members.userId': ctx.actor.userId }, ctx.session))
        .filter(doc => !cursor || doc.updatedAt < cursor.updatedAt || (doc.updatedAt === cursor.updatedAt && doc._id > cursor.id))
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a._id.localeCompare(b._id)).slice(0, limit + 1)
      const items: WorkspaceSummary[] = []
      for (const doc of docs.slice(0, limit)) items.push({ id: doc._id, name: doc.name, description: doc.description,
        revision: doc.revision, role: controlReadRole(ctx, doc, 'viewer'), updatedAt: doc.updatedAt,
        mapCount: await graphs.count({ workspaceId: doc._id, deletedAt: null }, ctx.session) })
      const last = items[items.length - 1]
      return { items, nextCursor: docs.length > limit && last ? Buffer.from(JSON.stringify({ userId: ctx.actor.userId, updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
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
        const allowed = command.params.tools.map(tool => tool.name)
        const removed = doc.tools.filter(tool => !allowed.includes(tool.name)).map(tool => tool.name)
        if (removed.length && ((await library.list({ 'agents.tools': removed }, ctx.session)).length
          || (await workspaces.list({ deletedAt: null, 'agents.tools': removed }, ctx.session)).length)) throw new GraphError(409, 'TOOL_IN_USE', RuntimeMessage.AN_AGENT_STILL_USES_A_REMOVED_TOOL)
        const updated = await settings.change('global', current => current.revision === doc.revision ? { ...current,
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
          if (doc.receipts.some(item => item.method === 'agent.delete' && item.resourceId === command.params.agent.id)) throw new GraphError(409, 'AGENT_ID_REUSED', RuntimeMessage.DELETED_AGENT_IDS_CANNOT_BE_REUSED)
          agents.push(controlReadProfile(command.params.agent))
        } else {
          const existing = agents.find(agent => agent.id === command.params.agentId)
          if (!existing) throw new GraphError(404, 'AGENT_NOT_FOUND', RuntimeMessage.AGENT_NOT_FOUND)
          controlRequireRevision(existing.revision, command.params.expectedAgentRevision)
          if (command.method === 'agent.delete') {
            if (!existing.deletable) throw new GraphError(409, 'FIXED_ROLE', RuntimeMessage.FIXED_PROFILES_CANNOT_BE_DELETED)
            agents = agents.filter(agent => agent.id !== existing.id)
          } else {
            const next = command.params.agent
            if (next.id !== existing.id || next.kind !== existing.kind || next.promptPath !== existing.promptPath) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', RuntimeMessage.AGENT_ID_KIND_AND_PROMPTPATH_ARE_IMMUTABLE)
            agents = agents.map(agent => agent.id === existing.id ? controlReadProfile(next, existing.revision + 1) : agent)
          }
        }
        controlValidateProfiles(agents)
        await controlValidateTools(ctx, agents)
        if (scope.kind === 'workspace') {
          const updated = await controlCommitWorkspace(ctx, doc as WorkspaceDocument, { agents }, receipt)
          return { data: controlReadAgentList(scope, updated), replayed: false }
        }
        const updated = await library.change('global', current => current.revision === doc.revision ? { ...current, agents, updatedAt: new Date().toISOString(),
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
        if (maps.length !== mapIds.length || maps.some(map => nodeSelection[map._id] && !map.nodes.some(node => node.id === nodeSelection[map._id]))) throw new GraphError(422, 'INVALID_PREFERENCES', RuntimeMessage.PREFERENCES_REFER_TO_ANOTHER_OR_MISSING_MAP_NODE)
        const next: PreferencesDocument = { _id: id, userId: ctx.actor.userId, workspaceId: workspace._id,
          revision: (prior?.revision ?? 0) + 1, openMapIds, currentMapId, nodeSelection, receipts: [...(prior?.receipts ?? []), receipt] }
        if (!prior) await preferences.insert(next, ctx.session)
        else {
          const changed = await preferences.change(id, current => current.revision === prior.revision ? next : null, ctx.session)
          if (!changed) throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.PREFERENCES_CHANGED)
        }
        return { data: await controlReadPreferences(ctx, workspace._id), replayed: false }
      }
      if (controlReadReplay(workspace.receipts, receipt)) {
        if (command.method === 'member.set') {
          const member = workspace.members.find(member => member.userId === command.params.userId)
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
        const user = await (async () => { const user = await users.get(command.params.userId, ctx.session); return user?.disabled ? null : user })()
        if (command.params.role !== null && !user) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.AN_ENABLED_USER_IS_REQUIRED)
        const members = workspace.members.filter(member => member.userId !== command.params.userId)
        if (command.params.role !== null) members.push({ userId: command.params.userId, role: command.params.role })
        const owners = members.filter(member => member.role === 'owner').map(member => member.userId)
        if (!owners.length || !(await users.list({ _id: owners, disabled: false }, ctx.session)).length) throw new GraphError(409, 'LAST_OWNER', RuntimeMessage.WORKSPACE_MUST_RETAIN_AN_ENABLED_OWNER)
        const updated = await controlCommitWorkspace(ctx, workspace, { members }, receipt)
        return { data: { userId: command.params.userId, member: command.params.role === null ? null : { userId: command.params.userId, displayName: user!.displayName, role: command.params.role }, workspaceRevision: updated.revision }, replayed: false }
      }
      if (command.method === 'agent.copy') {
        const source = await controlReadCopyLibrary(ctx, command.params.libraryRevision)
        const selected = source.agents.filter(agent => command.params.agentIds.includes(agent.id))
        if (!selected.length || selected.length !== command.params.agentIds.length) throw new GraphError(404, 'AGENT_NOT_FOUND', RuntimeMessage.SELECT_EXISTING_LIBRARY_AGENTS)
        const copied = selected.map(agent => {
          const existing = workspace.agents.find(item => item.promptPath === agent.promptPath)
          if (existing && existing.kind !== agent.kind) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', RuntimeMessage.COPY_CANNOT_CHANGE_THE_KIND_OF_AN_EXISTING_PROMPTPATH)
          return controlReadProfile({ ...agent, id: existing?.id ?? randomUUID() }, existing ? existing.revision + 1 : 0)
        })
        const agents = command.params.mode === 'replace' ? copied : [...workspace.agents.filter(agent => !selected.some(item => item.promptPath === agent.promptPath)), ...copied]
        const removed = workspace.agents.filter(agent => !agents.some(item => item.id === agent.id))
        if (removed.some(agent => !agent.deletable)) throw new GraphError(409, 'FIXED_ROLE', RuntimeMessage.COPY_CANNOT_REMOVE_FIXED_PROFILES)
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
