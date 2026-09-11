import { randomUUID } from 'node:crypto'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AgentInput, AgentList, AgentProfile, AppBootstrap, ControlCommand, ControlQuery, Preferences, WorkspaceView } from '../../contracts/control'
import { authCreateService, type AuthService } from '../../backend/auth'
import { controlCreateService, type ControlService, type WorkspaceDocument } from '../../backend/control'
import { controlReadAgent, controlReadCommand } from '../../backend/control-input'
import { GRAPH_COLLECTION, storeCreateConnection, storeDeleteConnection } from '../../backend/store'
import { verificationConfiguration } from './fixtures/verification'

let replica: MongoMemoryReplSet
let connection: Connection
let auth: AuthService
let control: ControlService
const ownerId = randomUUID(), otherId = randomUUID(), viewerId = randomUUID(), adminId = randomUUID()
let ownerToken: string, otherToken: string, viewerToken: string, adminToken: string

async function controlTestCommand(token: string, method: ControlCommand['method'], params: unknown, requestId = randomUUID()) {
  return auth.transact(token, ctx => control.dispatch(ctx, controlReadCommand({ requestId, method, params })))
}
async function controlTestRead(token: string, query: ControlQuery) { return control.read(await auth.read(token), query) }
async function controlTestWorkspace(token = ownerToken, agentSource: 'empty' | 'library' = 'library'): Promise<WorkspaceView> {
  return (await controlTestCommand(token, 'workspace.create', { id: randomUUID(), name: 'Control test', description: '', agentSource })).data as WorkspaceView
}
function controlTestAgent(profile: AgentProfile): AgentInput {
  const { revision: _revision, deletable: _deletable, updatedAt: _updatedAt, ...input } = profile
  return input
}
async function controlTestLibrary(): Promise<AgentList> {
  return await controlTestRead(adminToken, { method: 'agent.list', params: { scope: { kind: 'library' } } }) as AgentList
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  connection = await storeCreateConnection(replica.getUri(`control_${randomUUID().replace(/-/g, '')}`))
  auth = authCreateService(connection)
  control = controlCreateService(connection)
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
  try { if (connection) await storeDeleteConnection(connection) }
  finally { if (replica) await replica.stop({ doCleanup: true, force: true }) }
})

describe('Shared Control transactions', () => {
  it('strictly validates Agent metadata and rejects undeclared credential and endpoint fields', async () => {
    const profile = (await controlTestLibrary()).items.find(agent => agent.kind === 'verifySubAgent')!
    const input = controlTestAgent(profile)
    expect(controlReadAgent(input)).toEqual(input)
    expect(() => controlReadAgent({ ...input, apiKey: 'must-not-enter-shared-documents' })).toThrow()
    expect(() => controlReadAgent({ ...input, baseUrl: 'https://unregistered.invalid' })).toThrow()
    expect(() => controlReadAgent({ ...input, tools: ['data_propose'] })).toThrow()
    expect(() => controlReadAgent({ ...input, promptVars: ['unknown-variable'] })).toThrow()
    expect(() => controlReadCommand({ requestId: randomUUID(), method: 'settings.update', params: {
      expectedRevision: 0, llm: { provider: 'openai', model: 'fixture', apiKey: 'secret' }, tools: [], limits: { maxAgentSlots: 2 },
    } })).toThrow()
    const bootstrap = await controlTestRead(ownerToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    expect(bootstrap.metadata.variables.verifySubAgent).toEqual(['hint', 'context', 'claimContent', 'originalContent'])
    expect(bootstrap.metadata.outputs.map(output => output.kind)).toEqual(['verifyRoute', 'verifySubAgent', 'verifyMerge'])
    for (const output of bootstrap.metadata.outputs) {
      const example = JSON.parse(output.content)
      expect(Object.keys(example)).toEqual(['proposal'])
      expect(example.proposal).not.toHaveProperty('mapId')
      expect(example.proposal).not.toHaveProperty('fence')
    }
  })

  it('scopes Workspace access, replays before revision checks, and protects deletion with a tombstone', async () => {
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
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    await expect(controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: ownerId, role: 'viewer' }))
      .rejects.toMatchObject({ code: 'LAST_OWNER' })
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: otherId, role: 'owner' })
    const results = await Promise.allSettled([
      controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 1, userId: ownerId, role: 'viewer' }),
      controlTestCommand(otherToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 1, userId: otherId, role: 'viewer' }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const doc = await connection.db!.collection<WorkspaceDocument>('control_workspaces').findOne({ _id: workspace.id })
    expect(doc!.members.filter(member => member.role === 'owner')).toHaveLength(1)
    expect(doc!.revision).toBe(2)
  })

  it('touches the authorization fence without changing public revision and isolates validated preferences', async () => {
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    await controlTestCommand(ownerToken, 'member.set', { workspaceId: workspace.id, expectedRevision: 0, userId: viewerId, role: 'viewer' })
    const collection = connection.db!.collection<WorkspaceDocument>('control_workspaces')
    const before = (await collection.findOne({ _id: workspace.id }))!
    await auth.transact(viewerToken, ctx => control.requireRole(ctx, workspace.id, 'viewer'))
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
    const workspace = await controlTestWorkspace()
    const source = await controlTestLibrary()
    const sourceAgent = source.items.find(agent => agent.kind === 'verifySubAgent')!
    const copy = workspace.agents.find(agent => agent.promptPath === sourceAgent.promptPath)!
    expect(copy.id).not.toBe(sourceAgent.id)
    const frozen = await control.configuration(await auth.read(ownerToken), workspace.id)
    expect(frozen.agents.find(agent => agent.id === copy.id)).toMatchObject({
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
    expect(copied.agents.find(agent => agent.promptPath === sourceAgent.promptPath)).toMatchObject({ id: copy.id, revision: copy.revision + 1, content: update.agent.content })
    expect(frozen.agents.find(agent => agent.id === copy.id)!.content).toBe(copy.content)
    expect((await control.configuration(await auth.read(ownerToken), workspace.id)).agents.find(agent => agent.id === copy.id)!.content).toBe(update.agent.content)
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
    const workspace = await controlTestWorkspace()
    const original = workspace.agents.find(agent => agent.kind === 'verifySubAgent')!
    const scope = { kind: 'workspace' as const, workspaceId: workspace.id }
    const agent: AgentInput = { ...controlTestAgent(original), id: randomUUID(), promptPath: 'custom/verification', provider: null, model: null, tools: [] }
    const created = (await controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: 0, agent })).data as AgentList
    const item = created.items.find(item => item.id === agent.id)!
    await expect(controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision, agentId: item.id,
      expectedAgentRevision: item.revision, agent: { ...agent, promptPath: 'another/path' } })).rejects.toMatchObject({ code: 'AGENT_IDENTITY_CHANGED' })
    const updated = (await controlTestCommand(ownerToken, 'agent.update', { scope, expectedRevision: created.revision, agentId: item.id,
      expectedAgentRevision: item.revision, agent: { ...agent, name: 'Human-readable custom angle' } })).data as AgentList
    const changed = updated.items.find(profile => profile.id === item.id)!
    expect(changed).toMatchObject({ revision: 1, name: 'Human-readable custom angle' })
    const fixed = updated.items.find(profile => profile.kind === 'verifyRoute')!
    await expect(controlTestCommand(ownerToken, 'agent.delete', { scope, expectedRevision: updated.revision,
      agentId: fixed.id, expectedAgentRevision: fixed.revision })).rejects.toMatchObject({ code: 'FIXED_ROLE' })
    const bootstrap = await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    const settingParams = { expectedRevision: bootstrap.settings.revision, llm: { provider: 'other-provider', model: 'new-default' },
      tools: bootstrap.settings.tools, limits: bootstrap.settings.limits }
    const requestId = randomUUID()
    await expect(controlTestCommand(ownerToken, 'settings.update', settingParams)).rejects.toMatchObject({ status: 403 })
    await controlTestCommand(adminToken, 'settings.update', settingParams, requestId)
    expect(await controlTestCommand(adminToken, 'settings.update', settingParams, requestId)).toMatchObject({ replayed: true })
    expect((await control.configuration(await auth.read(ownerToken), workspace.id)).agents.find(profile => profile.id === item.id))
      .toMatchObject(settingParams.llm)
    const deleted = (await controlTestCommand(ownerToken, 'agent.delete', { scope, expectedRevision: updated.revision,
      agentId: item.id, expectedAgentRevision: changed.revision })).data as AgentList
    expect(deleted.items.some(profile => profile.id === item.id)).toBe(false)
    await expect(controlTestCommand(ownerToken, 'agent.create', { scope, expectedRevision: deleted.revision, agent }))
      .rejects.toMatchObject({ code: 'AGENT_ID_REUSED' })
  })

  it('blocks removal of used tools, keeps seed idempotent, and leaves empty Workspaces explicitly unconfigured', async () => {
    const bootstrap = await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} }) as AppBootstrap
    await expect(controlTestCommand(adminToken, 'settings.update', { expectedRevision: bootstrap.settings.revision,
      llm: bootstrap.settings.llm, tools: [], limits: bootstrap.settings.limits })).rejects.toMatchObject({ code: 'TOOL_IN_USE' })
    await control.seed()
    expect(await controlTestRead(adminToken, { method: 'app.bootstrap', params: {} })).toEqual(bootstrap)
    const workspace = await controlTestWorkspace(ownerToken, 'empty')
    await expect(control.configuration(await auth.read(ownerToken), workspace.id)).rejects.toMatchObject({ code: 'CONFIGURATION_INCOMPLETE' })
    const library = await controlTestLibrary()
    expect(library.items.filter(agent => !agent.deletable).map(agent => agent.kind).sort())
      .toEqual(['parseExtract', 'splitMerge', 'splitRoute', 'verifyMerge', 'verifyRoute'])
  })

  it('makes default seeded profiles inherit later settings while explicit seeds retain overrides', async () => {
    const explicitLibrary = await controlTestLibrary()
    const explicitConfiguration = verificationConfiguration()
    const explicitRouter = explicitLibrary.items.find(agent => agent.kind === 'verifyRoute')!
    expect(explicitRouter).toMatchObject({ provider: explicitConfiguration.router.provider, model: explicitConfiguration.router.model })

    const freshConnection = await storeCreateConnection(replica.getUri(`control_default_${randomUUID().replace(/-/g, '')}`))
    try {
      const freshAuth = authCreateService(freshConnection)
      const freshControl = controlCreateService(freshConnection)
      await freshAuth.initialize()
      await freshControl.initialize()
      await freshControl.seed()
      const userId = randomUUID()
      await freshAuth.createUser({ id: userId, displayName: 'Default configuration owner', hostAdmin: true })
      const token = (await freshAuth.createToken(userId)).token
      const ctx = await freshAuth.read(token)
      const seeded = await freshControl.read(ctx, { method: 'agent.list', params: { scope: { kind: 'library' } } }) as AgentList
      expect(seeded.items.length).toBeGreaterThan(0)
      expect(seeded.items.every(agent => agent.provider === null && agent.model === null)).toBe(true)
      const workspace = await freshAuth.transact(token, context => freshControl.createWorkspace(context, {
        id: randomUUID(), name: 'Uses shared defaults', description: '', agentSource: 'library',
      }))
      const frozen = await freshControl.configuration(ctx, workspace.id)
      const bootstrap = await freshControl.read(ctx, { method: 'app.bootstrap', params: {} }) as AppBootstrap
      const llm = { provider: 'new-shared-provider', model: 'new-shared-model' }
      await freshAuth.transact(token, context => freshControl.dispatch(context, {
        requestId: randomUUID(), method: 'settings.update', params: {
          expectedRevision: bootstrap.settings.revision, llm, tools: bootstrap.settings.tools, limits: bootstrap.settings.limits,
        },
      }))
      const next = await freshControl.configuration(ctx, workspace.id)
      expect([next.router, next.merger, ...next.agents].every(agent => agent.provider === llm.provider && agent.model === llm.model)).toBe(true)
      expect(frozen.router).toMatchObject(bootstrap.settings.llm)
      expect(frozen.router.model).not.toBe(next.router.model)
    } finally { await storeDeleteConnection(freshConnection) }
  })
})
