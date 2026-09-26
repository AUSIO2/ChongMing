import { randomUUID } from 'node:crypto'
import { effectScope, reactive } from 'vue'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { clientCreateGateway } from '../../client/graph-client'
import { ClientError, type ClientGateway } from '../../contracts/client'
import type { AgentInput, AgentProfile, Asset, ImportResult, PromptKind, WorkspaceView } from '../../contracts/control'
import { useManagementTask } from '../../apps/ui/features/management/use-management'
import { fixtureCreateEnvironment, type UiFixture } from './ui-fixture'

let fixture: UiFixture, gateway: ClientGateway
const connections: ClientGateway[] = [], scopes: ReturnType<typeof effectScope>[] = []
beforeAll(async () => {
  fixture = await fixtureCreateEnvironment()
  gateway = await connect(fixture.token)
}, 30_000)
afterEach(() => { for (const scope of scopes.splice(0)) scope.stop() })
afterAll(async () => {
  await Promise.all(connections.map(connection => connection.disconnect()))
  await fixture?.close()
}, 30_000)
async function connect(token: string) {
  const connection = clientCreateGateway({ baseUrl: fixture.baseUrl, timeoutMs: 5000 })
  await connection.connect({ baseUrl: fixture.baseUrl, token, remember: false }); connections.push(connection)
  return connection
}
function management(connection = gateway, onUnauthorized = () => {}) {
  const scope = effectScope(); scopes.push(scope)
  return scope.run(() => useManagementTask({ gateway: connection, onUnauthorized }))!
}
async function workspace() {
  return (await gateway.dispatch(randomUUID(), 'workspace.create', { id: randomUUID(), name: '管理验收工作区', description: '', agentSource: 'library' })).data
}
async function createMap(value: WorkspaceView) {
  const current = await gateway.read('workspace.get', { workspaceId: value.id })
  return (await gateway.dispatch(randomUUID(), 'map.create', { workspaceId: value.id, expectedRevision: current.revision, id: randomUUID(), name: '文件流转图' })).data.snapshot
}
function input(profile: AgentProfile): AgentInput {
  return { id: profile.id, kind: profile.kind, promptPath: profile.promptPath, name: profile.name, description: profile.description,
    content: profile.content, provider: profile.provider, model: profile.model, tools: [...profile.tools], promptVars: [...profile.promptVars],
    defaultPriority: profile.defaultPriority, claimCategory: profile.claimCategory }
}
const lostReply = () => new ClientError({ code: 'NETWORK_ERROR', message: 'Fixture lost the committed response', status: 0, retryable: true })

describe('Management tasks against authenticated API and file endpoints', () => {
  it('saves all seven profile kinds without losing ordered fields and leaves an existing Run frozen', async () => {
    const ws = await workspace(), task = management()
    const scope = { kind: 'workspace' as const, workspaceId: ws.id }
    let list = await gateway.read('agent.list', { scope })
    const bootstrap = await gateway.read('app.bootstrap', {})
    const kinds: PromptKind[] = ['parseExtract', 'splitRoute', 'splitSubAgent', 'splitMerge', 'verifyRoute', 'verifySubAgent', 'verifyMerge']
    for (const kind of kinds) {
      const profile = list.items.find(agent => agent.kind === kind)!
      const agent = reactive({ ...input(profile), content: profile.content + '\n管理页自定义配置', provider: null, model: null,
        promptVars: [...bootstrap.metadata.variables[kind]].reverse(), defaultPriority: 'low' as const, claimCategory: kind === 'splitSubAgent' ? 'data' as const : null })
      const saved = await task.command('agent.update', { scope, expectedRevision: list.revision, agentId: profile.id, expectedAgentRevision: profile.revision, agent })
      expect(saved, task.error.value?.message).not.toBeNull()
      list = saved!.data
      expect(list.items.find(item => item.id === profile.id)).toMatchObject(agent)
    }
    const map = await createMap(ws), claimId = randomUUID()
    const edited = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId, expectedRevision: map.revision,
      changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: '管理配置冻结验收', category: null } }] } } })
    const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, expectedRevision: edited.data.snapshot.revision,
      id: randomUUID(), scope: { nodeIds: [claimId] }, until: 'verified', mode: 'human-in-loop' })
    const frozen = started.data.snapshot.run!.configuration
    const currentList = await gateway.read('agent.list', { scope })
    const original = currentList.items.find(agent => agent.kind === 'verifySubAgent')!
    await task.command('agent.update', { scope, expectedRevision: currentList.revision, agentId: original.id,
      expectedAgentRevision: original.revision, agent: { ...input(original), content: '以后运行使用的新提示词' } })
    expect((await gateway.read('map.get', { mapId: map.mapId })).run!.configuration).toEqual(frozen)
    const fixed = currentList.items.find(agent => !agent.deletable)!
    const latest = await gateway.read('agent.list', { scope })
    await expect(gateway.dispatch(randomUUID(), 'agent.delete', { scope, expectedRevision: latest.revision,
      agentId: fixed.id, expectedAgentRevision: fixed.revision })).rejects.toMatchObject({ code: 'FIXED_ROLE' })
  }, 20_000)

  it('restricts shared-library edits to HostAdmin and copies merge/replace into the explicit Workspace', async () => {
    const ws = await workspace()
    const admin = await fixture.application.auth.createUser({ id: randomUUID(), displayName: '隔离管理员', hostAdmin: true })
    const token = await fixture.application.auth.createToken(admin.userId)
    const adminGateway = await connect(token.token), libraryScope = { kind: 'library' as const }
    const library = await adminGateway.read('agent.list', { scope: libraryScope })
    const fixed = library.items.find(agent => agent.kind === 'parseExtract')!
    const update = { scope: libraryScope, expectedRevision: library.revision, agentId: fixed.id,
      expectedAgentRevision: fixed.revision, agent: { ...input(fixed), content: fixed.content + '\n库中明确更新' } }
    await expect(gateway.dispatch(randomUUID(), 'agent.update', update)).rejects.toMatchObject({ status: 403 })
    const changedLibrary = (await adminGateway.dispatch(randomUUID(), 'agent.update', update)).data
    const scope = { kind: 'workspace' as const, workspaceId: ws.id }
    const list = await gateway.read('agent.list', { scope })
    const source = list.items.find(agent => agent.kind === 'verifySubAgent')!
    const customId = randomUUID()
    const custom = await gateway.dispatch(randomUUID(), 'agent.create', { scope, expectedRevision: list.revision,
      agent: { ...input(source), id: customId, promptPath: 'custom/' + customId, name: '仅当前工作区' } })
    const oldFixed = list.items.find(agent => agent.kind === 'parseExtract')!
    const task = management()
    const merged = await task.command('agent.copy', { workspaceId: ws.id, expectedRevision: custom.data.revision,
      libraryRevision: changedLibrary.revision, agentIds: changedLibrary.items.map(agent => agent.id), mode: 'merge' })
    expect(merged!.data.agents.some(agent => agent.id === customId)).toBe(true)
    expect(merged!.data.agents.find(agent => agent.promptPath === oldFixed.promptPath)).toMatchObject({ id: oldFixed.id, content: update.agent.content })
    const replaced = await task.command('agent.copy', { workspaceId: ws.id, expectedRevision: merged!.data.revision,
      libraryRevision: changedLibrary.revision, agentIds: changedLibrary.items.map(agent => agent.id), mode: 'replace' })
    expect(replaced!.data.id).toBe(ws.id)
    expect(replaced!.data.agents.some(agent => agent.id === customId)).toBe(false)
    expect(replaced!.data.agents.filter(agent => !agent.deletable)).toHaveLength(5)
  })

  it('retains the uploaded Asset across lost replies and failed Source creation, then lists and exports it', async () => {
    const ws = await workspace(), map = await createMap(ws), task = management()
    const original = new TextEncoder().encode('共享原稿：数据与来源必须保持一致。')
    const draft = reactive({ workspaceId: ws.id, filename: 'source.txt', mediaType: 'text/plain', bytes: original.slice() })
    const uploadIds: string[] = []
    let first = true, asset: Asset | null = null
    const pending = task.run(draft, async (payload, requestId, signal) => {
      uploadIds.push(requestId)
      const result = await gateway.upload(requestId, payload, signal)
      if (first) { first = false; throw lostReply() }
      return result
    }, result => { asset = result.data })
    draft.filename = 'changed-after-submission.txt'; draft.bytes.fill(0)
    expect(await pending).toBeNull()
    expect(task.canRetry.value).toBe(true)
    expect(await task.retry()).toBe(true)
    expect(new Set(uploadIds).size).toBe(1)
    const saved = asset as unknown as Asset
    expect(saved.filename).toBe('source.txt')
    expect((await gateway.download({ kind: 'asset', id: saved.id })).bytes).toEqual(original)
    const altered = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId, expectedRevision: map.revision,
      changes: { nodes: { put: [{ id: randomUUID(), data: { kind: 'news', content: '先发生的并发修改', context: {} } }] } } })
    const source = { id: randomUUID(), data: { kind: 'source' as const, locator: { kind: 'asset' as const, assetId: saved.id, mediaType: saved.mediaType }, label: saved.filename } }
    expect(await task.command('graph.apply', { mapId: map.mapId, expectedRevision: map.revision, changes: { nodes: { put: [source] } } })).toBeNull()
    expect(task.error.value?.code).toBe('REVISION_CONFLICT')
    expect((await gateway.read('asset.get', { assetId: saved.id })).id).toBe(saved.id)
    task.clearError()
    expect(await task.command('graph.apply', { mapId: map.mapId, expectedRevision: altered.data.snapshot.revision, changes: { nodes: { put: [source] } } })).not.toBeNull()
    expect(uploadIds).toHaveLength(2)
    for (const filename of ['second.txt', 'third.txt']) await gateway.upload(randomUUID(), { workspaceId: ws.id, filename, mediaType: 'text/plain', bytes: original })
    const page = await gateway.read('asset.list', { workspaceId: ws.id, limit: 2 })
    expect(page.items).toHaveLength(2); expect(page.nextCursor).not.toBeNull()
    const next = await gateway.read('asset.list', { workspaceId: ws.id, limit: 2, cursor: page.nextCursor! })
    expect(new Set([...page.items, ...next.items].map(item => item.id)).size).toBe(3)
    const file = await gateway.download({ kind: 'map', id: map.mapId })
    const bundle = JSON.parse(new TextDecoder().decode(file.bytes))
    expect(bundle).toMatchObject({ format: 'chongming-map', version: 3 })
    expect(bundle.map).not.toHaveProperty('run'); expect(bundle.map).not.toHaveProperty('leases')
    expect(bundle.assets.map((item: Asset) => item.id)).toContain(saved.id)
    expect(JSON.parse(new TextDecoder().decode((await gateway.download({ kind: 'workspace', id: ws.id })).bytes)).format).toBe('chongming-workspace')
  })

  it('imports an exported map through two stable stages and confirms a single Workspace after a lost response', async () => {
    const ws = await workspace(), map = await createMap(ws)
    const file = await gateway.download({ kind: 'map', id: map.mapId })
    const task = management()
    const staged = await task.run({ workspaceId: ws.id, filename: 'map-package.json', mediaType: 'application/json', bytes: file.bytes },
      (payload, requestId, signal) => gateway.upload(requestId, payload, signal))
    expect(staged).not.toBeNull()
    let lost = false, imported: ImportResult | null = null, importedName = ''
    const ids: string[] = [], bodies: string[] = []
    const dropReply: ClientGateway = { ...gateway, async dispatch(requestId, method, params, signal) {
      ids.push(requestId); bodies.push(JSON.stringify(params))
      const result = await gateway.dispatch(requestId, method, params, signal)
      if (!lost) { lost = true; throw lostReply() }
      return result
    } }
    const importing = management(dropReply)
    const params = reactive({ id: randomUUID(), bundleAssetId: staged!.data.id, stagingWorkspaceId: ws.id, name: '仅创建一次的新工作区' })
    const targetId = params.id
    const pending = importing.run(params, async (payload, requestId, signal) => {
      const result = await dropReply.dispatch(requestId, 'workspace.import', payload, signal)
      const workspace = await dropReply.read('workspace.get', { workspaceId: result.data.workspaceId }, signal)
      return { imported: result.data, name: workspace.name }
    }, result => { imported = result.imported; importedName = result.name })
    params.id = randomUUID(); params.name = '不应采用的新草稿'
    expect(await pending).toBeNull(); expect(importing.canRetry.value).toBe(true)
    expect(await importing.retry()).toBe(true)
    const result = imported as unknown as ImportResult
    expect(result.workspaceId).toBe(targetId)
    expect(importedName).toBe('仅创建一次的新工作区')
    expect(new Set(ids).size).toBe(1); expect(new Set(bodies).size).toBe(1)
    expect((await gateway.read('workspace.get', { workspaceId: targetId })).name).toBe('仅创建一次的新工作区')
    expect((await gateway.read('workspace.list', {})).items.filter(item => item.id === targetId)).toHaveLength(1)
    expect((await gateway.read('map.list', { workspaceId: targetId }))).toHaveLength(1)
    expect((await gateway.read('asset.get', { assetId: staged!.data.id })).id).toBe(staged!.data.id)
  })

  it('enforces Viewer/Editor file permissions and reports real token revocation without accepting late UI state', async () => {
    const ws = await workspace(), map = await createMap(ws)
    const editor = await fixture.application.auth.createUser({ id: randomUUID(), displayName: '隔离编辑者', hostAdmin: false })
    const viewer = await fixture.application.auth.createUser({ id: randomUUID(), displayName: '隔离只读成员', hostAdmin: false })
    for (const [userId, role] of [[editor.userId, 'editor'], [viewer.userId, 'viewer']] as const) {
      const current = await gateway.read('workspace.get', { workspaceId: ws.id })
      await gateway.dispatch(randomUUID(), 'member.set', { workspaceId: ws.id, expectedRevision: current.revision, userId, role })
    }
    const editorToken = await fixture.application.auth.createToken(editor.userId), viewerToken = await fixture.application.auth.createToken(viewer.userId)
    const editorGateway = await connect(editorToken.token), viewerGateway = await connect(viewerToken.token)
    const upload = { workspaceId: ws.id, filename: 'permissions.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('权限验收') }
    await expect(viewerGateway.upload(randomUUID(), upload)).rejects.toMatchObject({ status: 403 })
    const asset = (await editorGateway.upload(randomUUID(), upload)).data
    expect((await viewerGateway.read('asset.list', { workspaceId: ws.id })).items.some(item => item.id === asset.id)).toBe(true)
    expect((await viewerGateway.download({ kind: 'asset', id: asset.id })).bytes).toEqual(upload.bytes)
    expect((await viewerGateway.download({ kind: 'map', id: map.mapId })).bytes.length).toBeGreaterThan(0)
    await expect(viewerGateway.download({ kind: 'workspace', id: ws.id })).rejects.toMatchObject({ status: 403 })
    await expect(editorGateway.dispatch(randomUUID(), 'asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 })).rejects.toMatchObject({ status: 403 })
    await editorGateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId, expectedRevision: map.revision, changes: { nodes: { put: [{ id: randomUUID(),
      data: { kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: '编辑者来源' } }] } } })
    await expect(gateway.dispatch(randomUUID(), 'asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 })).rejects.toMatchObject({ status: 409 })
    let unauthorized = 0, accepted = false
    const task = management(viewerGateway, () => { unauthorized++ })
    await fixture.application.auth.revokeToken(viewerToken.tokenId)
    expect(await task.read('asset.list', { workspaceId: ws.id }, () => { accepted = true })).toBeNull()
    expect(unauthorized).toBe(1); expect(accepted).toBe(false); expect(task.canRetry.value).toBe(false)
  })
})
