import { randomUUID } from 'node:crypto'
import type { Connection } from 'mongoose'
import type { AgentInput, AgentList, AgentProfile, AgentScope, AppBootstrap, ClusterSettings, ControlCommand, ControlQuery, Page, Preferences, PromptKind, Role, WorkspaceSummary, WorkspaceView } from '../contracts/control'
import type { GraphAgentProfile, GraphRunConfiguration } from '../contracts/graph'
import type { RequestContext } from './auth'
import { configurationRead, DEFAULT_VERIFY_CONFIGURATION } from './configuration'
import { CONTROL_PROMPT_KINDS, CONTROL_PROMPT_VARIABLES, controlReadAgent, controlReadCommand, controlReadQuery } from './control-input'
import { GraphError } from './graph-error'
import { inputReadId, inputReadString } from './input'
import { GRAPH_COLLECTION, storeCreateInputHash } from './store'
import parseSeed from '../subagentconfig/fact-parser/extract.json'
import splitRouteSeed from '../subagentconfig/fact-extractor/main-agent-route.json'
import splitMergeSeed from '../subagentconfig/fact-extractor/main-agent-merge.json'

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
function controlIsWorker(kind: PromptKind): boolean { return kind === 'splitSubAgent' || kind === 'verifySubAgent' }
function controlRequireMutation(ctx: RequestContext): void {
  if (!ctx.mutation || !ctx.session?.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', 'Control writes require an authorized transaction')
}
function controlRequireAdmin(ctx: RequestContext): void {
  if (!ctx.actor.hostAdmin) throw new GraphError(403, 'FORBIDDEN', 'Host administrator permission is required')
}
function controlRequireRevision(actual: number, expected: number): void {
  if (actual !== expected) throw new GraphError(409, 'REVISION_CONFLICT', `Expected revision ${expected}, found ${actual}`, actual)
}
function controlReadRole(ctx: RequestContext, workspace: WorkspaceDocument, minimum: Role): Role {
  const member = workspace.members.find(member => member.userId === ctx.actor.userId)
  if (!member) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found')
  if (roleRank[member.role] < roleRank[minimum]) throw new GraphError(403, 'FORBIDDEN', 'Workspace permission is insufficient')
  return member.role
}
function controlCreateReceipt(ctx: RequestContext, command: ControlCommand, resourceId?: string): ControlReceipt {
  return { userId: ctx.actor.userId, requestId: command.requestId, method: command.method,
    hash: storeCreateInputHash({ method: command.method, params: command.params }), ...(resourceId ? { resourceId } : {}) }
}
function controlReadReplay(receipts: ControlReceipt[], receipt: ControlReceipt): boolean {
  const prior = receipts.find(item => item.userId === receipt.userId && item.requestId === receipt.requestId)
  if (prior && (prior.method !== receipt.method || prior.hash !== receipt.hash)) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', 'requestId was used with different input')
  return !!prior
}
function controlReadProfile(agent: AgentInput, revision = 0): AgentProfile {
  const { id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory } = agent
  return { ...controlReadAgent({ id, name, description, content, tools, provider, model, promptPath, kind, promptVars, defaultPriority, claimCategory }),
    revision, deletable: controlIsWorker(agent.kind), updatedAt: new Date().toISOString() }
}
function controlValidateProfiles(agents: AgentProfile[]): void {
  if (new Set(agents.map(agent => agent.id)).size !== agents.length || new Set(agents.map(agent => agent.promptPath)).size !== agents.length) {
    throw new GraphError(409, 'AGENT_EXISTS', 'Agent id and promptPath must be unique within their scope')
  }
  const fixed = agents.filter(agent => !controlIsWorker(agent.kind))
  if (new Set(fixed.map(agent => agent.kind)).size !== fixed.length) throw new GraphError(409, 'AGENT_EXISTS', 'Only one profile is allowed for each fixed role')
}

export function controlCreateService(connection: Connection) {
  if (!connection.db) throw new Error('Mongo connection is not ready')
  const db = connection.db
  const workspaces = db.collection<WorkspaceDocument>('control_workspaces')
  const library = db.collection<LibraryDocument>('control_library')
  const settings = db.collection<SettingsDocument>('control_settings')
  const preferences = db.collection<PreferencesDocument>('control_preferences')
  const users = db.collection<UserDocument>('control_users')
  const graphs = db.collection<GraphRecord>(GRAPH_COLLECTION)
  const options = (ctx: RequestContext) => ({ session: ctx.session ?? undefined })

  async function controlReadSettings(ctx: RequestContext): Promise<ClusterSettings> {
    const doc = await settings.findOne({ _id: 'global' }, options(ctx))
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', 'An administrator must seed shared settings')
    return { revision: doc.revision, llm: doc.llm, tools: doc.tools, limits: doc.limits }
  }
  async function controlReadLibrary(ctx: RequestContext): Promise<LibraryDocument> {
    const doc = await library.findOne({ _id: 'global' }, options(ctx))
    if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', 'An administrator must seed the Agent library')
    return doc
  }
  async function controlReadCopyLibrary(ctx: RequestContext, expectedRevision?: number): Promise<LibraryDocument> {
    const doc = await controlReadLibrary(ctx)
    if (expectedRevision !== undefined) controlRequireRevision(doc.revision, expectedRevision)
    const locked = await library.findOneAndUpdate({ _id: 'global', revision: doc.revision },
      { $inc: { writeFence: 1 } }, { ...options(ctx), returnDocument: 'after' })
    if (!locked) throw new GraphError(409, 'REVISION_CONFLICT', 'Agent library changed')
    return locked
  }
  async function requireRole(ctx: RequestContext, workspaceId: string, minimum: Role): Promise<WorkspaceDocument> {
    const doc = await workspaces.findOne({ _id: workspaceId, deletedAt: null }, options(ctx))
    if (!doc) throw new GraphError(404, 'WORKSPACE_NOT_FOUND', 'Workspace not found')
    controlReadRole(ctx, doc, minimum)
    if (!ctx.mutation) return doc
    controlRequireMutation(ctx)
    const allowed = (Object.keys(roleRank) as Role[]).filter(role => roleRank[role] >= roleRank[minimum])
    const touched = await workspaces.findOneAndUpdate({ _id: workspaceId, deletedAt: null,
      members: { $elemMatch: { userId: ctx.actor.userId, role: { $in: allowed } } },
    }, { $inc: { writeFence: 1 } }, { ...options(ctx), returnDocument: 'after' })
    if (!touched) throw new GraphError(403, 'FORBIDDEN', 'Workspace access changed')
    return touched
  }
  async function controlReadPreferences(ctx: RequestContext, workspaceId: string): Promise<Preferences> {
    const doc = await preferences.findOne({ _id: `${ctx.actor.userId}:${workspaceId}` }, options(ctx))
    return doc ? { workspaceId, revision: doc.revision, openMapIds: doc.openMapIds, currentMapId: doc.currentMapId, nodeSelection: doc.nodeSelection }
      : { workspaceId, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} }
  }
  async function controlReadWorkspace(ctx: RequestContext, workspace: WorkspaceDocument): Promise<WorkspaceView> {
    const names = await users.find({ _id: { $in: workspace.members.map(member => member.userId) } }, options(ctx)).toArray()
    return {
      id: workspace._id, name: workspace.name, description: workspace.description, revision: workspace.revision,
      role: controlReadRole(ctx, workspace, 'viewer'), updatedAt: workspace.updatedAt,
      mapCount: await graphs.countDocuments({ workspaceId: workspace._id, deletedAt: null }, options(ctx)),
      agents: workspace.agents,
      members: workspace.members.map(member => ({ ...member, displayName: names.find(user => user._id === member.userId)?.displayName ?? member.userId })),
      preferences: await controlReadPreferences(ctx, workspace._id),
    }
  }
  async function controlValidateTools(ctx: RequestContext, agents: AgentProfile[]): Promise<void> {
    const current = await controlReadSettings(ctx)
    if (agents.some(agent => agent.tools.some(name => !current.tools.some(tool => tool.name === name)))) {
      throw new GraphError(422, 'UNKNOWN_TOOL', 'Agent refers to a tool outside the shared capability catalog')
    }
    // Serialize new references with removal of a shared tool declaration.
    const touched = await settings.updateOne({ _id: 'global', revision: current.revision }, { $inc: { writeFence: 1 } }, options(ctx))
    if (!touched.matchedCount) throw new GraphError(409, 'REVISION_CONFLICT', 'Tool catalog changed')
  }
  async function controlCommitWorkspace(ctx: RequestContext, workspace: WorkspaceDocument, changes: Partial<Pick<WorkspaceDocument, 'name' | 'description' | 'members' | 'agents' | 'deletedAt'>>, receipt: ControlReceipt): Promise<WorkspaceDocument> {
    const updated = await workspaces.findOneAndUpdate({ _id: workspace._id, revision: workspace.revision, deletedAt: null },
      { $set: { ...changes, updatedAt: new Date().toISOString() }, $inc: { revision: 1 }, $push: { receipts: receipt } },
      { ...options(ctx), returnDocument: 'after' })
    if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', 'Workspace changed')
    return updated
  }
  async function controlRequireProfileDeletion(ctx: RequestContext, workspaceId: string, ids: string[]): Promise<void> {
    if (!ids.length) return
    const referenced = await graphs.findOne({ workspaceId, deletedAt: null, $or: [
      { 'policies.routing.slots.agentId': { $in: ids } }, { 'policies.routing.preferences.agentId': { $in: ids } },
    ] }, options(ctx))
    if (referenced) throw new GraphError(409, 'PROFILE_IN_USE', 'A graph policy still references the Agent')
  }
  async function createWorkspace(ctx: RequestContext, input: WorkspaceCreateInput, agents?: AgentInput[], receipt?: ControlReceipt): Promise<WorkspaceView> {
    controlRequireMutation(ctx)
    const id = inputReadId(input.id, 'workspace.id')
    if (typeof input.description !== 'string' || !['empty', 'library'].includes(input.agentSource)) throw new GraphError(400, 'INVALID_ARGUMENT', 'Invalid Workspace input')
    if (await workspaces.findOne({ _id: id }, options(ctx))) throw new GraphError(409, 'WORKSPACE_EXISTS', 'Workspace id already exists')
    const profiles = agents !== undefined ? agents.map(agent => controlReadProfile(agent))
      : input.agentSource === 'library' ? (await controlReadCopyLibrary(ctx)).agents.map(agent => controlReadProfile({ ...agent, id: randomUUID() })) : []
    controlValidateProfiles(profiles)
    if (profiles.length) await controlValidateTools(ctx, profiles)
    const now = new Date().toISOString()
    const doc: WorkspaceDocument = { _id: id, name: inputReadString(input.name, 'name').trim(), description: input.description,
      revision: 0, members: [{ userId: ctx.actor.userId, role: 'owner' }], agents: profiles, receipts: receipt ? [receipt] : [],
      writeFence: 0, createdAt: now, updatedAt: now, deletedAt: null }
    await workspaces.insertOne(doc, options(ctx))
    return controlReadWorkspace(ctx, doc)
  }
  async function controlReadAgentScope(ctx: RequestContext, scope: AgentScope, write: boolean): Promise<LibraryDocument | WorkspaceDocument> {
    if (scope.kind === 'workspace') return requireRole(ctx, scope.workspaceId, write ? 'owner' : 'viewer')
    if (write) controlRequireAdmin(ctx)
    return controlReadLibrary(ctx)
  }
  function controlReadAgentList(scope: AgentScope, doc: LibraryDocument | WorkspaceDocument): AgentList {
    return { scope, revision: doc.revision, items: doc.agents }
  }

  return {
    async initialize(): Promise<void> {
      await workspaces.createIndex({ 'members.userId': 1, updatedAt: -1, _id: 1 })
      await library.createIndex({ revision: 1 })
      await settings.createIndex({ revision: 1 })
      await preferences.createIndex({ userId: 1, workspaceId: 1 }, { unique: true })
    },
    async seed(configuration?: GraphRunConfiguration): Promise<void> {
      const config = configurationRead(configuration ?? DEFAULT_VERIFY_CONFIGURATION)
      const seedProfile = (agent: GraphAgentProfile, kind: PromptKind, promptPath: string): AgentProfile => controlReadProfile({
        ...agent, provider: configuration === undefined ? null : agent.provider, model: configuration === undefined ? null : agent.model,
        kind, promptPath, promptVars: CONTROL_PROMPT_VARIABLES[kind], defaultPriority: 'medium', claimCategory: null,
      })
      // Files are read only at this explicit seed boundary, never as a running Workspace fallback.
      const fixedSeeds = [
        { kind: 'parseExtract' as const, promptPath: 'fact-parser/extract', seed: parseSeed },
        { kind: 'splitRoute' as const, promptPath: 'fact-extractor/main-agent-route', seed: splitRouteSeed },
        { kind: 'splitMerge' as const, promptPath: 'fact-extractor/main-agent-merge', seed: splitMergeSeed },
      ].map(item => seedProfile({ id: randomUUID(), name: item.seed.description, description: item.seed.description,
        content: item.seed.content, tools: [], provider: config.router.provider, model: config.router.model }, item.kind, item.promptPath))
      const agents = [...fixedSeeds,
        seedProfile(config.router, 'verifyRoute', 'fact-verifier/main-agent-route'),
        seedProfile(config.merger, 'verifyMerge', 'fact-verifier/main-agent-merge'),
        ...config.agents.map(agent => seedProfile(agent, 'verifySubAgent', `fact-verifier/sub-agents/${agent.id}`)),
      ]
      controlValidateProfiles(agents)
      const session = await connection.startSession()
      try {
        await session.withTransaction(async () => {
          const now = new Date().toISOString()
          await library.updateOne({ _id: 'global' }, { $setOnInsert: { _id: 'global', revision: 0, agents, receipts: [], writeFence: 0, updatedAt: now } }, { session, upsert: true })
          await settings.updateOne({ _id: 'global' }, { $setOnInsert: { _id: 'global', revision: 0,
            llm: { provider: config.router.provider, model: config.router.model }, tools: config.tools,
            limits: { maxAgentSlots: config.maxSlots }, receipts: [], writeFence: 0, updatedAt: now } }, { session, upsert: true })
        })
      } finally { await session.endSession() }
    },
    requireRole,
    createWorkspace,
    async configuration(ctx: RequestContext, workspaceId: string): Promise<GraphRunConfiguration> {
      const workspace = await requireRole(ctx, workspaceId, 'editor')
      const current = await controlReadSettings(ctx)
      const router = workspace.agents.find(agent => agent.kind === 'verifyRoute')
      const merger = workspace.agents.find(agent => agent.kind === 'verifyMerge')
      const agents = workspace.agents.filter(agent => agent.kind === 'verifySubAgent')
      if (!router || !merger || !agents.length) throw new GraphError(422, 'CONFIGURATION_INCOMPLETE', 'Workspace requires verification router, merger and at least one worker')
      const resolve = (agent: AgentProfile): GraphAgentProfile => ({ id: agent.id, name: agent.name,
        description: agent.description, content: agent.content, tools: [...agent.tools],
        provider: agent.provider ?? current.llm.provider, model: agent.model ?? current.llm.model,
        promptVars: [...agent.promptVars], defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory })
      return configurationRead({ router: resolve(router), merger: resolve(merger), agents: agents.map(resolve), tools: current.tools, maxSlots: current.limits.maxAgentSlots })
    },
    async read(ctx: RequestContext, input: ControlQuery): Promise<ControlReadResult> {
      const query = controlReadQuery(input)
      if (query.method === 'app.bootstrap') return { identity: ctx.actor, settings: await controlReadSettings(ctx),
        metadata: { version: '055-v1', promptKinds: [...CONTROL_PROMPT_KINDS], executableKinds: ['verify'], scores: [0, 0.5, 1],
          variables: structuredClone(CONTROL_PROMPT_VARIABLES), outputs: [
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
      if (query.method !== 'workspace.list') throw new GraphError(400, 'UNKNOWN_METHOD', 'Unknown Control query')
      let cursor: { userId: string; updatedAt: string; id: string } | null = null
      if (query.params.cursor) {
        try {
          cursor = JSON.parse(Buffer.from(query.params.cursor, 'base64url').toString())
          if (!cursor || cursor.userId !== ctx.actor.userId || typeof cursor.updatedAt !== 'string' || typeof cursor.id !== 'string') throw new Error('cursor')
        } catch { throw new GraphError(400, 'INVALID_CURSOR', 'Cursor does not match this query') }
      }
      const limit = query.params.limit ?? 50
      const docs = await workspaces.find({ deletedAt: null, 'members.userId': ctx.actor.userId,
        ...(cursor ? { $or: [{ updatedAt: { $lt: cursor.updatedAt } }, { updatedAt: cursor.updatedAt, _id: { $gt: cursor.id } }] } : {}),
      }, options(ctx)).sort({ updatedAt: -1, _id: 1 }).limit(limit + 1).toArray()
      const items: WorkspaceSummary[] = []
      for (const doc of docs.slice(0, limit)) items.push({ id: doc._id, name: doc.name, description: doc.description,
        revision: doc.revision, role: controlReadRole(ctx, doc, 'viewer'), updatedAt: doc.updatedAt,
        mapCount: await graphs.countDocuments({ workspaceId: doc._id, deletedAt: null }, options(ctx)) })
      const last = items[items.length - 1]
      return { items, nextCursor: docs.length > limit && last ? Buffer.from(JSON.stringify({ userId: ctx.actor.userId, updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null }
    },
    async dispatch(ctx: RequestContext, input: ControlCommand): Promise<{ data: ControlWriteResult; replayed: boolean }> {
      controlRequireMutation(ctx)
      const command = controlReadCommand(input)
      const receipt = controlCreateReceipt(ctx, command, 'agentId' in command.params ? command.params.agentId : undefined)
      if (command.method === 'workspace.create') {
        const existing = await workspaces.findOne({ _id: command.params.id }, options(ctx))
        if (existing) {
          controlReadRole(ctx, existing, 'owner')
          if (existing.deletedAt) throw new GraphError(410, 'WORKSPACE_GONE', 'Workspace was deleted')
          const authorized = await requireRole(ctx, existing._id, 'owner')
          if (!controlReadReplay(authorized.receipts, receipt)) throw new GraphError(409, 'WORKSPACE_EXISTS', 'Workspace id already exists')
          return { data: await controlReadWorkspace(ctx, authorized), replayed: true }
        }
        return { data: await createWorkspace(ctx, command.params, undefined, receipt), replayed: false }
      }
      if (command.method === 'settings.update') {
        controlRequireAdmin(ctx)
        const doc = await settings.findOne({ _id: 'global' }, options(ctx))
        if (!doc) throw new GraphError(503, 'CONFIGURATION_NOT_INITIALIZED', 'Shared settings have not been seeded')
        if (controlReadReplay(doc.receipts, receipt)) return { data: await controlReadSettings(ctx), replayed: true }
        controlRequireRevision(doc.revision, command.params.expectedRevision)
        const allowed = command.params.tools.map(tool => tool.name)
        const removed = doc.tools.filter(tool => !allowed.includes(tool.name)).map(tool => tool.name)
        if (removed.length && ((await library.findOne({ 'agents.tools': { $in: removed } }, options(ctx)))
          || (await workspaces.findOne({ deletedAt: null, 'agents.tools': { $in: removed } }, options(ctx))))) throw new GraphError(409, 'TOOL_IN_USE', 'An Agent still uses a removed tool')
        const updated = await settings.findOneAndUpdate({ _id: 'global', revision: doc.revision }, { $set: {
          llm: command.params.llm, tools: command.params.tools, limits: command.params.limits, updatedAt: new Date().toISOString(),
        }, $inc: { revision: 1 }, $push: { receipts: receipt } }, { ...options(ctx), returnDocument: 'after' })
        if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', 'Settings changed')
        return { data: { revision: updated.revision, llm: updated.llm, tools: updated.tools, limits: updated.limits }, replayed: false }
      }
      if (command.method === 'agent.create' || command.method === 'agent.update' || command.method === 'agent.delete') {
        const { scope } = command.params
        const doc = await controlReadAgentScope(ctx, scope, true)
        if (controlReadReplay(doc.receipts, receipt)) return { data: controlReadAgentList(scope, doc), replayed: true }
        controlRequireRevision(doc.revision, command.params.expectedRevision)
        let agents = [...doc.agents]
        if (command.method === 'agent.create') {
          if (!controlIsWorker(command.params.agent.kind)) throw new GraphError(422, 'FIXED_ROLE', 'Only SubAgent profiles may be created')
          if (doc.receipts.some(item => item.method === 'agent.delete' && item.resourceId === command.params.agent.id)) throw new GraphError(409, 'AGENT_ID_REUSED', 'Deleted Agent ids cannot be reused')
          agents.push(controlReadProfile(command.params.agent))
        } else {
          const existing = agents.find(agent => agent.id === command.params.agentId)
          if (!existing) throw new GraphError(404, 'AGENT_NOT_FOUND', 'Agent not found')
          controlRequireRevision(existing.revision, command.params.expectedAgentRevision)
          if (command.method === 'agent.delete') {
            if (!existing.deletable) throw new GraphError(409, 'FIXED_ROLE', 'Fixed profiles cannot be deleted')
            if (scope.kind === 'workspace') await controlRequireProfileDeletion(ctx, scope.workspaceId, [existing.id])
            agents = agents.filter(agent => agent.id !== existing.id)
          } else {
            const next = command.params.agent
            if (next.id !== existing.id || next.kind !== existing.kind || next.promptPath !== existing.promptPath) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', 'Agent id, kind and promptPath are immutable')
            agents = agents.map(agent => agent.id === existing.id ? controlReadProfile(next, existing.revision + 1) : agent)
          }
        }
        controlValidateProfiles(agents)
        await controlValidateTools(ctx, agents)
        if (scope.kind === 'workspace') {
          const updated = await controlCommitWorkspace(ctx, doc as WorkspaceDocument, { agents }, receipt)
          return { data: controlReadAgentList(scope, updated), replayed: false }
        }
        const updated = await library.findOneAndUpdate({ _id: 'global', revision: doc.revision },
          { $set: { agents, updatedAt: new Date().toISOString() }, $inc: { revision: 1 }, $push: { receipts: receipt } },
          { ...options(ctx), returnDocument: 'after' })
        if (!updated) throw new GraphError(409, 'REVISION_CONFLICT', 'Agent library changed')
        return { data: controlReadAgentList(scope, updated), replayed: false }
      }
      if (!('workspaceId' in command.params)) throw new GraphError(400, 'UNKNOWN_METHOD', 'Unknown Control command')
      if (command.method === 'workspace.delete') {
        const tombstone = await workspaces.findOne({ _id: command.params.workspaceId }, options(ctx))
        if (tombstone?.deletedAt) {
          controlReadRole(ctx, tombstone, 'owner')
          if (controlReadReplay(tombstone.receipts, receipt)) return { data: { workspaceId: tombstone._id, deleted: true }, replayed: true }
          throw new GraphError(410, 'WORKSPACE_GONE', 'Workspace was deleted')
        }
      }
      const workspace = await requireRole(ctx, command.params.workspaceId, command.method === 'preferences.set' ? 'viewer' : 'owner')
      if (command.method === 'preferences.set') {
        const id = `${ctx.actor.userId}:${workspace._id}`
        const prior = await preferences.findOne({ _id: id }, options(ctx))
        if (prior && controlReadReplay(prior.receipts, receipt)) return { data: await controlReadPreferences(ctx, workspace._id), replayed: true }
        controlRequireRevision(prior?.revision ?? 0, command.params.expectedRevision)
        const { openMapIds, currentMapId, nodeSelection } = command.params
        if (currentMapId !== null && !openMapIds.includes(currentMapId)) throw new GraphError(422, 'INVALID_PREFERENCES', 'Current Map must be open')
        const mapIds = [...new Set([...openMapIds, ...Object.keys(nodeSelection)])]
        const maps = await graphs.find({ _id: { $in: mapIds }, workspaceId: workspace._id, deletedAt: null }, options(ctx)).toArray()
        if (maps.length !== mapIds.length || maps.some(map => nodeSelection[map._id] && !map.nodes.some(node => node.id === nodeSelection[map._id]))) throw new GraphError(422, 'INVALID_PREFERENCES', 'Preferences refer to another or missing Map/Node')
        const next: PreferencesDocument = { _id: id, userId: ctx.actor.userId, workspaceId: workspace._id,
          revision: (prior?.revision ?? 0) + 1, openMapIds, currentMapId, nodeSelection, receipts: [...(prior?.receipts ?? []), receipt] }
        if (!prior) await preferences.insertOne(next, options(ctx))
        else {
          const changed = await preferences.replaceOne({ _id: id, revision: prior.revision }, next, options(ctx))
          if (!changed.matchedCount) throw new GraphError(409, 'REVISION_CONFLICT', 'Preferences changed')
        }
        return { data: await controlReadPreferences(ctx, workspace._id), replayed: false }
      }
      if (controlReadReplay(workspace.receipts, receipt)) {
        if (command.method === 'member.set') {
          const member = workspace.members.find(member => member.userId === command.params.userId)
          const user = member && await users.findOne({ _id: member.userId }, options(ctx))
          return { data: { userId: command.params.userId, member: member ? { ...member, displayName: user?.displayName ?? member.userId } : null, workspaceRevision: workspace.revision }, replayed: true }
        }
        return { data: await controlReadWorkspace(ctx, workspace), replayed: true }
      }
      controlRequireRevision(workspace.revision, command.params.expectedRevision)
      if (command.method === 'workspace.update') return { data: await controlReadWorkspace(ctx, await controlCommitWorkspace(ctx, workspace, { name: command.params.name, description: command.params.description }, receipt)), replayed: false }
      if (command.method === 'workspace.delete') {
        if (await graphs.findOne({ workspaceId: workspace._id, deletedAt: null, 'run.status': { $in: ['accepted', 'running', 'waiting'] } }, options(ctx))) throw new GraphError(409, 'RUN_ACTIVE', 'Cancel active Runs before deleting the Workspace')
        await controlCommitWorkspace(ctx, workspace, { deletedAt: new Date().toISOString() }, receipt)
        return { data: { workspaceId: workspace._id, deleted: true }, replayed: false }
      }
      if (command.method === 'member.set') {
        const user = await users.findOne({ _id: command.params.userId, disabled: false }, options(ctx))
        if (command.params.role !== null && !user) throw new GraphError(404, 'USER_NOT_FOUND', 'An enabled user is required')
        const members = workspace.members.filter(member => member.userId !== command.params.userId)
        if (command.params.role !== null) members.push({ userId: command.params.userId, role: command.params.role })
        const owners = members.filter(member => member.role === 'owner').map(member => member.userId)
        if (!owners.length || !await users.findOne({ _id: { $in: owners }, disabled: false }, options(ctx))) throw new GraphError(409, 'LAST_OWNER', 'Workspace must retain an enabled Owner')
        const updated = await controlCommitWorkspace(ctx, workspace, { members }, receipt)
        return { data: { userId: command.params.userId, member: command.params.role === null ? null : { userId: command.params.userId, displayName: user!.displayName, role: command.params.role }, workspaceRevision: updated.revision }, replayed: false }
      }
      if (command.method === 'agent.copy') {
        const source = await controlReadCopyLibrary(ctx, command.params.libraryRevision)
        const selected = source.agents.filter(agent => command.params.agentIds.includes(agent.id))
        if (!selected.length || selected.length !== command.params.agentIds.length) throw new GraphError(404, 'AGENT_NOT_FOUND', 'Select existing library Agents')
        const copied = selected.map(agent => {
          const existing = workspace.agents.find(item => item.promptPath === agent.promptPath)
          if (existing && existing.kind !== agent.kind) throw new GraphError(422, 'AGENT_IDENTITY_CHANGED', 'Copy cannot change the kind of an existing promptPath')
          return controlReadProfile({ ...agent, id: existing?.id ?? randomUUID() }, existing ? existing.revision + 1 : 0)
        })
        const agents = command.params.mode === 'replace' ? copied : [...workspace.agents.filter(agent => !selected.some(item => item.promptPath === agent.promptPath)), ...copied]
        const removed = workspace.agents.filter(agent => !agents.some(item => item.id === agent.id))
        if (removed.some(agent => !agent.deletable)) throw new GraphError(409, 'FIXED_ROLE', 'Copy cannot remove fixed profiles')
        await controlRequireProfileDeletion(ctx, workspace._id, removed.map(agent => agent.id))
        controlValidateProfiles(agents)
        await controlValidateTools(ctx, agents)
        const updated = await controlCommitWorkspace(ctx, workspace, { agents }, receipt)
        return { data: await controlReadWorkspace(ctx, updated), replayed: false }
      }
      throw new GraphError(400, 'UNKNOWN_METHOD', 'Unknown Control command')
    },
  }
}

export type ControlService = ReturnType<typeof controlCreateService>
