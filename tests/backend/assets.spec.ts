import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assetsCreateService, type AssetsService, type AssetUploadInput } from '../../backend/assets'
import { authCreateService, type AuthService } from '../../backend/auth'
import { controlCreateService, type ControlService } from '../../backend/control'
import { graphInputReadNodeData } from '../../backend/graph-input'
import { storeCreateConnection, storeCreateGraphStore, GRAPH_COLLECTION, type GraphDocument } from '../../backend/store'
import type { Asset, ControlCommand, MapBundle, WorkspaceBundle } from '../../contracts/control'
import type { GraphNode, GraphNodeData } from '../../contracts/graph'

let mongo: MongoMemoryReplSet
let connection: Connection
let auth: AuthService
let control: ControlService
let assets: AssetsService
let owner: { id: string; token: string }, editor: { id: string; token: string }, outsider: { id: string; token: string }

async function user(name: string, hostAdmin = false) {
  const id = randomUUID()
  await auth.createUser({ id, displayName: name, hostAdmin })
  return { id, token: (await auth.createToken(id)).token }
}
async function workspace(library = false) {
  return auth.transact(owner.token, ctx => control.createWorkspace(ctx, {
    id: randomUUID(), name: 'Asset workspace', description: 'portable data', agentSource: library ? 'library' : 'empty',
  }))
}
async function member(workspaceId: string, userId: string, role: 'owner' | 'editor' | 'viewer' | null) {
  const current = await control.requireRole(await auth.read(owner.token), workspaceId, 'owner')
  return auth.transact(owner.token, ctx => control.dispatch(ctx, { requestId: randomUUID(), method: 'member.set',
    params: { workspaceId, expectedRevision: current.revision, userId, role },
  }))
}
function uploadInput(workspaceId: string, bytes: Buffer, changes: Partial<AssetUploadInput> = {}): AssetUploadInput {
  return { workspaceId, filename: 'evidence.txt', mediaType: 'text/plain', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(), ...changes }
}
function node(data: GraphNodeData): GraphNode {
  const now = new Date().toISOString()
  return { id: randomUUID(), revision: 3, data, createdAt: now, updatedAt: now }
}
async function graph(workspaceId: string, nodes: GraphNode[], token = owner.token, edges: GraphDocument['edges'] = []) {
  const now = new Date().toISOString()
  const document: GraphDocument = { id: randomUUID(), workspaceId, revision: 0, name: 'Portable Map',
    nodes, edges, run: null, runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
  await auth.transact(token, async ctx => {
    await assets.assertReferences(ctx, workspaceId, nodes)
    expect(await storeCreateGraphStore(connection, ctx.session).create(document)).toBe(true)
  })
  return document
}
function deleteCommand(asset: Asset): Extract<ControlCommand, { method: 'asset.delete' }> {
  return { requestId: randomUUID(), method: 'asset.delete', params: { assetId: asset.id, expectedSha256: asset.sha256 } }
}
async function importBundle(bundle: WorkspaceBundle | MapBundle, staging: string, id = randomUUID()) {
  const bytes = Buffer.from(JSON.stringify(bundle))
  const staged = await assets.upload(owner.token, uploadInput(staging, bytes, { filename: 'workspace.json', mediaType: 'application/json' }), Readable.from([bytes]))
  const command: Extract<ControlCommand, { method: 'workspace.import' }> = {
    requestId: randomUUID(), method: 'workspace.import',
    params: { id, bundleAssetId: staged.data.id, stagingWorkspaceId: staging, name: null },
  }
  return { command, run: () => assets.importWorkspace(owner.token, command) }
}

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  connection = await storeCreateConnection(mongo.getUri('assets_test'))
  auth = authCreateService(connection); control = controlCreateService(connection)
  assets = assetsCreateService(connection, auth, control)
  await auth.initialize(); await control.initialize(); await storeCreateGraphStore(connection).initialize(); await assets.initialize()
  await control.seed()
  owner = await user('Owner', true); editor = await user('Editor'); outsider = await user('Unrelated administrator', true)
}, 30000)
afterAll(async () => { if (connection) await connection.close(); await mongo?.stop() })

describe('GridFS assets', () => {
  it('streams bytes, verifies integrity and replays concurrent uploads as one immutable Asset', async () => {
    const ws = await workspace(), bytes = Buffer.from('证据\nstreamed bytes')
    const input = uploadInput(ws.id, bytes)
    const results = await Promise.all([
      assets.upload(owner.token, input, Readable.from([bytes.subarray(0, 3), bytes.subarray(3)])),
      assets.upload(owner.token, input, Readable.from([bytes])),
    ])
    expect(results.map(result => result.data.id)).toEqual([results[0].data.id, results[0].data.id])
    expect(results.map(result => result.replayed).sort()).toEqual([false, true])
    const downloaded = await assets.content(await auth.read(owner.token), results[0].data.id)
    const chunks: Buffer[] = []
    for await (const chunk of downloaded.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(bytes)
    expect(Object.keys(results[0].data).sort()).toEqual(['createdAt', 'filename', 'id', 'mediaType', 'sha256', 'size', 'workspaceId'])
    await expect(assets.upload(owner.token, { ...input, filename: 'different.txt' }, Readable.from([bytes]))).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    await expect(assets.upload(owner.token, input, Readable.from([Buffer.alloc(bytes.length)]))).rejects.toMatchObject({ code: 'ASSET_INTEGRITY' })
    expect(await connection.collection('control_assets').countDocuments({ workspaceId: ws.id })).toBe(1)
  })

  it('never publishes short, oversized, checksum-invalid or interrupted uploads', async () => {
    const ws = await workspace(), bytes = Buffer.from('data')
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes, { size: bytes.length + 1 }), Readable.from([bytes]))).rejects.toMatchObject({ code: 'ASSET_INTEGRITY' })
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes, { sha256: '0'.repeat(64) }), Readable.from([bytes]))).rejects.toMatchObject({ code: 'ASSET_INTEGRITY' })
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes, { size: 64 * 1024 * 1024 + 1 }), Readable.from([bytes]))).rejects.toMatchObject({ code: 'ASSET_LIMIT' })
    async function* interrupted() { yield bytes.subarray(0, 2); throw new Error('incoming connection closed') }
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes), interrupted())).rejects.toThrow('incoming connection closed')
    expect(await connection.collection('control_assets').countDocuments({ workspaceId: ws.id })).toBe(0)
  })

  it('reauthorizes after streaming and never lets a removed member use an old upload receipt', async () => {
    const ws = await workspace(), bytes = Buffer.from('stream with permission change')
    await member(ws.id, editor.id, 'editor')
    const input = uploadInput(ws.id, bytes)
    const prior = await assets.upload(editor.token, input, Readable.from([bytes]))
    const filesBefore = await connection.collection('asset_blobs.files').countDocuments()
    let started!: () => void, resume!: () => void
    const entered = new Promise<void>(resolve => { started = resolve })
    const released = new Promise<void>(resolve => { resume = resolve })
    async function* paused() { yield bytes.subarray(0, 2); started(); await released; yield bytes.subarray(2) }
    const active = assets.upload(editor.token, uploadInput(ws.id, bytes), paused())
    await entered
    await member(ws.id, editor.id, null)
    resume()
    await expect(active).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    expect(await connection.collection('asset_blobs.files').countDocuments()).toBe(filesBefore)
    await expect(assets.upload(editor.token, input, Readable.from([bytes]))).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    await expect(assets.read(await auth.read(editor.token), prior.data.id)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    expect(await connection.collection('control_assets').countDocuments({ workspaceId: ws.id, state: 'ready' })).toBe(1)
  })

  it('protects referenced assets and cross-Workspace reads, including unrelated HostAdmin', async () => {
    const ws = await workspace(), other = await workspace(), bytes = Buffer.from('reference')
    const asset = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const source = node({ kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: null })
    await graph(ws.id, [source])
    await expect(auth.transact(owner.token, ctx => assets.delete(ctx, deleteCommand(asset)))).rejects.toMatchObject({ code: 'ASSET_IN_USE' })
    await expect(auth.transact(owner.token, ctx => assets.assertReferences(ctx, other.id, [source]))).rejects.toMatchObject({ code: 'ASSET_REFERENCE' })
    await expect(assets.read(await auth.read(outsider.token), asset.id)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    await member(ws.id, editor.id, 'viewer')
    await expect(assets.read(await auth.read(editor.token), asset.id)).resolves.toMatchObject({ id: asset.id })
    await expect(auth.transact(editor.token, ctx => assets.delete(ctx, deleteCommand(asset)))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('serializes deletion against a new reference using the same Workspace fence', async () => {
    const ws = await workspace(), bytes = Buffer.from('race')
    await member(ws.id, editor.id, 'editor')
    const asset = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const source = node({ kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: null })
    const deletion = deleteCommand(asset)
    const results = await Promise.allSettled([
      auth.transact(owner.token, ctx => assets.delete(ctx, deletion)),
      graph(ws.id, [source], editor.token),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const stored = await connection.collection('control_assets').findOne({ _id: asset.id })
    if (stored!.state === 'deleted') {
      expect(await connection.collection(GRAPH_COLLECTION).countDocuments({ workspaceId: ws.id })).toBe(0)
      await expect(assets.read(await auth.read(owner.token), asset.id)).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })
      expect((await auth.transact(owner.token, ctx => assets.delete(ctx, deletion))).replayed).toBe(true)
    } else expect(await connection.collection(GRAPH_COLLECTION).countDocuments({ workspaceId: ws.id })).toBe(1)
  })

  it('cleans only logically deleted GridFS objects and keeps ready assets readable', async () => {
    const ws = await workspace(), bytes = Buffer.from('cleanup')
    const removed = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const retained = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const document = await connection.collection('control_assets').findOne({ _id: removed.id })
    await auth.transact(owner.token, ctx => assets.delete(ctx, deleteCommand(removed)))
    expect(await assets.cleanupDeleted()).toBeGreaterThanOrEqual(1)
    expect(await connection.collection('asset_blobs.files').findOne({ _id: document!.blobId })).toBeNull()
    expect(await assets.cleanupDeleted()).toBe(0)
    const result = await assets.content(await auth.read(owner.token), retained.id)
    const chunks: Buffer[] = []
    for await (const chunk of result.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(bytes)
  })
})

describe('Portable v3 bundles', () => {
  async function portableWorkspace() {
    const ws = await workspace(true), bytes = Buffer.from('original source asset')
    const asset = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const original = node({ kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: 'source' })
    const evidence = node({ kind: 'evidence', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, content: 'cited passage', capturedAt: new Date().toISOString() })
    const news = node({ kind: 'news', content: 'News content', context: { private: { value: 'human-only', visibleToAI: false } } })
    const claim = node({ kind: 'claim', content: 'Checkable claim', category: 'custom category' })
    const profile = ws.agents.find(agent => agent.kind === 'verifySubAgent')!
    const verification = node({ kind: 'verification', score: 1, reason: 'historic conclusion', reportIds: ['old-report', 'retired-report'],
      opinions: [{ id: 'old-report', slotId: 'old-slot', agentId: profile.id, agentName: profile.name, angle: 'source',
        tools: profile.tools, routeRevision: 2, score: 1, reason: 'historic evidence', createdAt: new Date().toISOString() },
      { id: 'retired-report', slotId: 'retired-slot', agentId: 'retired-agent-from-archive', agentName: 'Historical expert', angle: 'archive',
        tools: [], routeRevision: 1, score: 0.5, reason: 'An older observation', createdAt: new Date().toISOString() }] })
    const now = new Date().toISOString()
    const map = await graph(ws.id, [original, evidence, news, claim, verification], owner.token, [
      { id: randomUUID(), revision: 4, kind: 'mentions', from: news.id, to: claim.id, createdAt: now, updatedAt: now },
      { id: randomUUID(), revision: 7, kind: 'verifies', from: verification.id, to: claim.id, createdAt: now, updatedAt: now },
    ])
    await graph(ws.id, [node({ kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: null })])
    await connection.collection(GRAPH_COLLECTION).updateOne({ _id: map.id }, { $set: { run: { status: 'completed', token: 'NEVER_EXPORT_THIS' }, runHistory: [{ secret: 'NEVER_EXPORT_THIS' }] } })
    return { ws, map, asset, bytes, verification, profile }
  }

  it('exports only portable state and imports the complete graph/assets/profile/history ID mapping atomically', async () => {
    const fixture = await portableWorkspace()
    const ctx = await auth.read(owner.token)
    const single = await assets.exportMap(ctx, fixture.map.id)
    expect(single.format).toBe('chongming-map')
    expect(single.assets).toHaveLength(1)
    const singleImport = await importBundle(single, fixture.ws.id)
    expect((await singleImport.run()).data.mapIds).toHaveLength(1)
    const bundle = await assets.exportWorkspace(ctx, fixture.ws.id)
    expect(bundle.maps).toHaveLength(2)
    expect(bundle.assets).toHaveLength(1)
    expect(JSON.stringify(bundle)).not.toContain('NEVER_EXPORT_THIS')
    expect(bundle.maps[0]).not.toHaveProperty('run')
    expect(bundle.maps[0]).not.toHaveProperty('leases')
    expect(bundle.workspace.agents[0]).not.toHaveProperty('revision')
    const staged = await importBundle(bundle, fixture.ws.id)
    const imported = await staged.run()
    expect(imported.replayed).toBe(false)
    expect(imported.data.mapIds).toHaveLength(2)
    expect(imported.data.assetIds).toHaveLength(1)
    expect(imported.data.workspaceId).not.toBe(fixture.ws.id)
    const target = await control.requireRole(ctx, imported.data.workspaceId, 'owner')
    expect(target.agents).toHaveLength(fixture.ws.agents.length)
    expect(target.agents.some(agent => agent.id === fixture.profile.id)).toBe(false)
    const maps = await Promise.all(imported.data.mapIds.map(id => storeCreateGraphStore(connection).read(id)))
    for (const [index, map] of maps.entries()) {
      expect(map).toMatchObject({ revision: 0, run: null, runHistory: [], leases: {} })
      expect(map!.edges.map(edge => edge.revision)).toEqual(bundle.maps[index].edges.map(edge => edge.revision))
      for (const edge of map!.edges) expect(map!.nodes.map(node => node.id)).toEqual(expect.arrayContaining([edge.from, edge.to]))
      for (const node of map!.nodes) {
        expect(node.importedFrom?.bundleId).toBe(bundle.id)
        const original = bundle.maps[index].nodes.find(item => item.id === node.importedFrom?.nodeId)!
        expect(node.revision).toBe(original.revision)
        expect(node.importedFrom?.revision).toBe(original.revision)
        if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') expect(node.data.locator.assetId).toBe(imported.data.assetIds[0])
      }
    }
    const conclusion = maps.flatMap(map => map!.nodes).find(node => node.data.kind === 'verification')!
    expect(conclusion.validity).toBe('stale')
    if (conclusion.data.kind !== 'verification') throw new Error('missing verification')
    expect(conclusion.data.reportIds).toEqual(['old-report', 'retired-report'])
    expect(conclusion.data.opinions.map(opinion => opinion.id)).toEqual(conclusion.data.reportIds)
    expect(conclusion.data.opinions[0].slotId).not.toBe('old-slot')
    expect(target.agents.map(agent => agent.id)).toContain(conclusion.data.opinions[0].agentId)
    expect(conclusion.data.opinions[1].agentId).toBe('retired-agent-from-archive')
    expect(target.agents.some(agent => agent.id === 'retired-agent-from-archive')).toBe(false)
    const content = await assets.content(ctx, imported.data.assetIds[0])
    const chunks: Buffer[] = []
    for await (const chunk of content.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(fixture.bytes)
    expect(await staged.run()).toEqual({ data: imported.data, replayed: true })
  })

  it('rejects incomplete references, invalid asset bytes and executable/secret fields before publication', async () => {
    const fixture = await portableWorkspace()
    const bundle = await assets.exportWorkspace(await auth.read(owner.token), fixture.ws.id)
    for (const mutate of [
      (value: WorkspaceBundle) => { value.maps.find(map => map.edges.length)!.edges[0].to = randomUUID() },
      (value: WorkspaceBundle) => { value.assets[0].contentBase64 = '@@@@' },
      (value: WorkspaceBundle) => { Object.assign(value, { token: 'not-a-portable-field' }) },
      ...(['claim', 'news', 'evidence', 'verification', 'opinion'] as const).map(kind => (value: WorkspaceBundle) => {
        const target = value.maps.flatMap(map => map.nodes).find(node => node.data.kind === (kind === 'opinion' ? 'verification' : kind))!
        if (target.data.kind === 'verification') {
          if (kind === 'opinion') target.data.opinions[0].reason = ' '
          else target.data.reason = ''
        } else if ('content' in target.data) target.data.content = ' '
      }),
    ]) {
      const invalid = structuredClone(bundle)
      mutate(invalid)
      const staged = await importBundle(invalid, fixture.ws.id)
      await expect(staged.run()).rejects.toMatchObject({ name: 'GraphError' })
      expect(await connection.collection('control_workspaces').countDocuments({ _id: staged.command.params.id })).toBe(0)
      expect(await connection.collection('control_assets').countDocuments({ workspaceId: staged.command.params.id })).toBe(0)
    }
  })

  it('roundtrips legal isolated and multi-target Verification nodes without inventing an edge-count constraint', async () => {
    const ws = await workspace()
    const isolated = node({ kind: 'verification', score: 0.5, reason: 'Unlinked historical conclusion', reportIds: [], opinions: [] })
    const linked = node({ kind: 'verification', score: 1, reason: 'Shared historical conclusion', reportIds: [], opinions: [] })
    const first = node({ kind: 'claim', content: 'First claim', category: null })
    const second = node({ kind: 'claim', content: 'Second claim', category: null })
    const now = new Date().toISOString()
    const original = await graph(ws.id, [isolated, linked, first, second], owner.token, [
      { id: randomUUID(), revision: 1, kind: 'verifies', from: linked.id, to: first.id, createdAt: now, updatedAt: now },
      { id: randomUUID(), revision: 9, kind: 'verifies', from: linked.id, to: second.id, createdAt: now, updatedAt: now },
    ])
    const bundle = await assets.exportMap(await auth.read(owner.token), original.id)
    const staged = await importBundle(bundle, ws.id)
    const result = await staged.run()
    const imported = (await storeCreateGraphStore(connection).read(result.data.mapIds[0]))!
    const mappedIsolated = imported.nodes.find(node => node.importedFrom?.nodeId === isolated.id)!
    const mappedLinked = imported.nodes.find(node => node.importedFrom?.nodeId === linked.id)!
    expect(imported.edges.filter(edge => edge.from === mappedIsolated.id)).toHaveLength(0)
    expect(imported.edges.filter(edge => edge.from === mappedLinked.id)).toHaveLength(2)
    expect(imported.edges.map(edge => edge.revision)).toEqual([1, 9])
    expect(mappedIsolated.revision).toBe(isolated.revision)
    expect(mappedLinked.revision).toBe(linked.revision)
  })

  it('preserves independent historical report labels and repeated opinion tool names accepted by the Graph API', async () => {
    const ws = await workspace()
    const labels = node(graphInputReadNodeData({
      kind: 'verification', score: 0.5, reason: 'Historical labels without retained detail',
      reportIds: ['old-report', 'old-report', 'unavailable-history'], opinions: [],
    }, 'history.labels'))
    const details = node(graphInputReadNodeData({
      kind: 'verification', score: 1, reason: 'Manual historical conclusion',
      reportIds: ['independent-label', 'independent-label'],
      opinions: [{
        id: 'detail-only-label', slotId: 'archived-slot', agentId: 'retired-expert', agentName: 'Retired expert',
        angle: 'archive', tools: ['archive_lookup', 'archive_lookup'], routeRevision: 4,
        score: 1, reason: 'Retained historical opinion', createdAt: new Date().toISOString(),
      }],
    }, 'history.details'))
    const original = await graph(ws.id, [labels, details])
    const bundle = await assets.exportMap(await auth.read(owner.token), original.id)
    expect(bundle.map.nodes.find(node => node.id === labels.id)!.data).toEqual(labels.data)
    expect(bundle.map.nodes.find(node => node.id === details.id)!.data).toEqual(details.data)
    const staged = await importBundle(bundle, ws.id)
    const result = await staged.run()
    const imported = (await storeCreateGraphStore(connection).read(result.data.mapIds[0]))!
    const importedLabels = imported.nodes.find(node => node.importedFrom?.nodeId === labels.id)!
    const importedDetails = imported.nodes.find(node => node.importedFrom?.nodeId === details.id)!
    expect(importedLabels.data).toEqual(labels.data)
    if (importedDetails.data.kind !== 'verification') throw new Error('Missing historical verification')
    expect(importedDetails.data.reportIds).toEqual(['independent-label', 'independent-label'])
    expect(importedDetails.data.opinions).toHaveLength(1)
    expect(importedDetails.data.opinions[0]).toMatchObject({
      id: 'detail-only-label', agentId: 'retired-expert', tools: ['archive_lookup', 'archive_lookup'],
      reason: 'Retained historical opinion', routeRevision: 4,
    })
    expect(importedDetails.data.opinions[0].slotId).not.toBe('archived-slot')
    expect(imported.run).toBeNull()
    expect(imported.leases).toEqual({})
  })

  it('rolls back the entire Workspace and imported ready assets when a later Map publication fails', async () => {
    const fixture = await portableWorkspace()
    const bundle = await assets.exportWorkspace(await auth.read(owner.token), fixture.ws.id)
    const staged = await importBundle(bundle, fixture.ws.id)
    const collection = connection.collection(GRAPH_COLLECTION)
    const original = collection.insertOne
    let count = 0
    const spy = vi.spyOn(collection, 'insertOne').mockImplementation((...args: unknown[]) => {
      const document = args[0] as { workspaceId: string }
      if (document.workspaceId === staged.command.params.id && ++count === 2) return Promise.reject(new Error('injected Map publish failure'))
      return Reflect.apply(original, collection, args)
    })
    try { await expect(staged.run()).rejects.toThrow('injected Map publish failure') }
    finally { spy.mockRestore() }
    expect(count).toBe(2)
    expect(await connection.collection('control_workspaces').countDocuments({ _id: staged.command.params.id })).toBe(0)
    expect(await connection.collection(GRAPH_COLLECTION).countDocuments({ workspaceId: staged.command.params.id })).toBe(0)
    expect(await connection.collection('control_assets').countDocuments({ workspaceId: staged.command.params.id })).toBe(0)
  })
})
