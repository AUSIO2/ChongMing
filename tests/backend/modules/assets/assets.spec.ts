// 验证资产字节完整性、授权竞争和删除保护，以及便携数据包的身份映射与原子导入。
import { sourceReadUrl } from '../../../../backend/adapters/sources/http-source'
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { assetsCreateService, type AssetsService, type AssetUploadInput } from '../../../../backend/modules/assets/asset-service'
import { authCreateService, type AuthService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService, type ControlService } from '../../../../backend/modules/workspace/workspace-service'
import { graphInputReadNodeData } from '../../../../backend/modules/graph/graph-input'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { GRAPH_COLLECTION, type GraphDocument } from '../../../../backend/modules/graph/graph-record'
import type { Asset, ControlCommand, MapBundle, WorkspaceBundle } from '../../../../contracts/control'
import type { GraphNode, GraphNodeData } from '../../../../contracts/graph'
import { DEFAULT_RUN_CONFIGURATION } from '../../../../apps/config/default-prompts'

let mongo: MongoMemoryReplSet
let connection: Connection
let auth: AuthService
let control: ControlService
let assets: AssetsService
let owner: { id: string; token: string }, editor: { id: string; token: string }, outsider: { id: string; token: string }

async function user(/* 新测试用户的显示名称。 */ name: string, /* 是否授予宿主管理员权限；默认普通成员。 */ hostAdmin = false) {
  // 创建指定权限的测试用户并签发令牌，用于资产跨身份访问用例。
  const id = randomUUID()
  await auth.createUser({ id, displayName: name, hostAdmin })
  return { id, token: (await auth.createToken(id)).token }
}
async function workspace(/* 是否从全局库复制默认 Agent 配置。 */ library = false) {
  // 以所有者身份创建独立工作区，可选择复制默认库配置。
  return auth.transact(owner.token, /* 创建测试工作区使用的所有者授权事务上下文。 */ ctx => /* 在真实授权事务中建立测试工作区，沿用选择的 Agent 来源。 */ control.createWorkspace(ctx, {
    id: randomUUID(), name: 'Asset workspace', description: 'portable data', agentSource: library ? 'library' : 'empty',
  }))
}
async function member(/* 要修改成员列表的工作区身份。 */ workspaceId: string, /* 要新增、改权或移除的用户身份。 */ userId: string, /* 目标成员角色；null 表示移除成员。 */ role: 'owner' | 'editor' | 'viewer' | null) {
  // 读取当前工作区版本后设置成员角色，供权限变更和竞争测试使用。
  const current = await control.requireRole(await auth.read(owner.token), workspaceId, 'owner')
  return auth.transact(owner.token, /* 成员变更使用的所有者授权事务上下文。 */ ctx => /* 使用所有者授权及刚读取的版本提交成员变更。 */ control.dispatch(ctx, { requestId: randomUUID(), method: 'member.set',
    params: { workspaceId, expectedRevision: current.revision, userId, role },
  }))
}
function uploadInput(/* 上传资产归属的工作区身份。 */ workspaceId: string, /* 用于计算声明大小和摘要的实际测试字节。 */ bytes: Buffer, /* 覆盖正确上传元数据、构造边界输入的可选字段。 */ changes: Partial<AssetUploadInput> = {}): AssetUploadInput {
  // 根据实际字节生成正确上传元数据，允许用例覆盖字段构造非法输入。
  return { workspaceId, filename: 'evidence.txt', mediaType: 'text/plain', size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(), ...changes }
}
function node(/* 需要包装为带身份、版本和时间的节点数据。 */ data: GraphNodeData): GraphNode {
  // 生成带固定初始版本和当前时间的图节点，供导入保留版本的断言使用。
  const now = new Date().toISOString()
  return { id: randomUUID(), revision: 3, data, createdAt: now, updatedAt: now }
}
async function graph(/* 新图归属且附件引用必须匹配的工作区身份。 */ workspaceId: string, /* 写入新图并在事务中验证引用的节点集合。 */ nodes: GraphNode[], /* 创建图使用的用户令牌；默认所有者。 */ token = owner.token, /* 写入图文档的可选关系集合。 */ edges: GraphDocument['edges'] = []) {
  // 在授权事务中校验资产引用并创建含指定节点和关系的图文档。
  const now = new Date().toISOString()
  const document: GraphDocument = { id: randomUUID(), workspaceId, revision: 0, name: 'Portable Map',
    nodes, edges, run: null, runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
  await auth.transact(token, async /* 引用检查和图创建共用的授权事务上下文。 */ ctx => {
    // 将引用检查和真实图创建放在同一事务，复现与资产删除共享栅栏的写入路径。
    await assets.assertReferences(ctx, workspaceId, nodes)
    expect(await storeCreateGraphStore(connection, ctx.session).create(document)).toBe(true)
  })
  return document
}
function deleteCommand(/* 需要转换为带当前摘要删除命令的公开资产。 */ asset: Asset): Extract<ControlCommand, { method: 'asset.delete' }> {
  // 为资产构造包含当前摘要的稳定删除命令。
  return { requestId: randomUUID(), method: 'asset.delete', params: { assetId: asset.id, expectedSha256: asset.sha256 } }
}
async function importBundle(/* 要序列化并上传到暂存区的单图或工作区包。 */ bundle: WorkspaceBundle | MapBundle, /* 暂存数据包资产所属的工作区身份。 */ staging: string, /* 导入后新工作区的预分配身份。 */ id = randomUUID()) {
  // 先把数据包作为 JSON 附件上传到暂存区，再返回可重复调用的同一导入请求。
  const bytes = Buffer.from(JSON.stringify(bundle))
  const staged = await assets.upload(owner.token, uploadInput(staging, bytes, { filename: 'workspace.json', mediaType: 'application/json' }), Readable.from([bytes]))
  const command: Extract<ControlCommand, { method: 'workspace.import' }> = {
    requestId: randomUUID(), method: 'workspace.import',
    params: { id, bundleAssetId: staged.data.id, stagingWorkspaceId: staging, name: null },
  }
  return { command, run: () => /* 重放同一导入命令，供测试比较首次执行与重复执行的身份结果。 */ assets.importWorkspace(owner.token, command) }
}

beforeAll(async () => {
  // 初始化独立 Mongo、身份和资产服务，并创建所有者、编辑者及无关管理员。
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } })
  connection = await storeCreateConnection(mongo.getUri('assets_test'))
  auth = authCreateService(persistenceCreateMongo(connection)); control = controlCreateService(persistenceCreateMongo(connection), DEFAULT_RUN_CONFIGURATION)
  assets = assetsCreateService(persistenceCreateMongo(connection), auth, control, { readUrl: sourceReadUrl })
  await auth.initialize(); await control.initialize(); await storeCreateGraphStore(connection).initialize(); await assets.initialize()
  await control.seed()
  owner = await user('Owner', true); editor = await user('Editor'); outsider = await user('Unrelated administrator', true)
}, 30000)
afterAll(async () => {
  // 关闭数据库连接和测试副本集，释放本文件拥有的存储资源。
  if (connection) await connection.close(); await mongo?.stop() })

describe('GridFS assets', () => {
  // 组织流式上传、授权重查、引用保护和逻辑删除清理的测试场景。
  it('streams bytes, verifies integrity and replays concurrent uploads as one immutable Asset', async () => {
    // 并发上传相同请求，验证只发布一个不可变资产，字节完整且伪造摘要重放被拒绝。
    const ws = await workspace(), bytes = Buffer.from('证据\nstreamed bytes')
    const input = uploadInput(ws.id, bytes)
    const results = await Promise.all([
      assets.upload(owner.token, input, Readable.from([bytes.subarray(0, 3), bytes.subarray(3)])),
      assets.upload(owner.token, input, Readable.from([bytes])),
    ])
    expect(results.map(/* 并发上传响应中当前提取资产身份的结果。 */ result => /* 提取并发上传返回的资产身份，验证两次响应指向同一对象。 */ result.data.id)).toEqual([results[0].data.id, results[0].data.id])
    expect(results.map(/* 并发上传响应中当前提取重放标记的结果。 */ result => /* 提取重放标记，验证只有一次请求实际发布资产。 */ result.replayed).sort()).toEqual([false, true])
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
    // 验证长度不符、超限、摘要错误和上传流中断均不会发布资产元数据。
    const ws = await workspace(), bytes = Buffer.from('data')
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes, { size: bytes.length + 1 }), Readable.from([bytes]))).rejects.toMatchObject({ code: 'ASSET_INTEGRITY' })
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes, { sha256: '0'.repeat(64) }), Readable.from([bytes]))).rejects.toMatchObject({ code: 'ASSET_INTEGRITY' })
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes, { size: 64 * 1024 * 1024 + 1 }), Readable.from([bytes]))).rejects.toMatchObject({ code: 'ASSET_LIMIT' })
    async function* interrupted() {
      // 先产出部分字节再抛错，模拟客户端连接中断。
      yield bytes.subarray(0, 2); throw new Error('incoming connection closed') }
    await expect(assets.upload(owner.token, uploadInput(ws.id, bytes), interrupted())).rejects.toThrow('incoming connection closed')
    expect(await connection.collection('control_assets').countDocuments({ workspaceId: ws.id })).toBe(0)
  })

  it('reauthorizes after streaming and never lets a removed member use an old upload receipt', async () => {
    // 在上传字节流期间移除成员，验证发布前重新鉴权并清理未发布字节，旧收据也不能恢复访问。
    const ws = await workspace(), bytes = Buffer.from('stream with permission change')
    await member(ws.id, editor.id, 'editor')
    const input = uploadInput(ws.id, bytes)
    const prior = await assets.upload(editor.token, input, Readable.from([bytes]))
    const filesBefore = await connection.collection('asset_blobs.files').countDocuments()
    let started!: () => void, resume!: () => void
    const entered = new Promise<void>(/* 上传流到达权限竞争点时完成 entered Promise 的回调。 */ resolve => {
      // 保存上传进入暂停点的通知回调，用于精确安排成员移除。
      started = resolve })
    const released = new Promise<void>(/* 撤权完成后恢复上传流的回调。 */ resolve => {
      // 保存恢复上传的回调，使撤权先于元数据发布完成。
      resume = resolve })
    async function* paused() {
      // 分段产出上传字节，并在中间等待测试撤销工作区权限。
      yield bytes.subarray(0, 2); started(); await released; yield bytes.subarray(2) }
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
    // 验证被图引用的资产不能删除，跨工作区引用和无关管理员读取被拒绝，而 Viewer 只能读取。
    const ws = await workspace(), other = await workspace(), bytes = Buffer.from('reference')
    const asset = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const source = node({ kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: null })
    await graph(ws.id, [source])
    await expect(auth.transact(owner.token, /* 尝试删除被引用资产的所有者事务上下文。 */ ctx => /* 尝试在合法所有者事务中删除仍被图引用的资产。 */ assets.delete(ctx, deleteCommand(asset)))).rejects.toMatchObject({ code: 'ASSET_IN_USE' })
    await expect(auth.transact(owner.token, /* 尝试跨工作区引用资产的所有者事务上下文。 */ ctx => /* 尝试将另一个工作区的资产作为新节点引用，触发范围校验。 */ assets.assertReferences(ctx, other.id, [source]))).rejects.toMatchObject({ code: 'ASSET_REFERENCE' })
    await expect(assets.read(await auth.read(outsider.token), asset.id)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
    await member(ws.id, editor.id, 'viewer')
    await expect(assets.read(await auth.read(editor.token), asset.id)).resolves.toMatchObject({ id: asset.id })
    await expect(auth.transact(editor.token, /* 尝试以 Viewer 删除资产的事务上下文。 */ ctx => /* 以 Viewer 的真实身份事务尝试删除资产，验证所有者权限要求。 */ assets.delete(ctx, deleteCommand(asset)))).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('serializes deletion against a new reference using the same Workspace fence', async () => {
    // 让资产删除与编辑者新增引用同时执行，验证共享工作区栅栏确保只提交一个结果。
    const ws = await workspace(), bytes = Buffer.from('race')
    await member(ws.id, editor.id, 'editor')
    const asset = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const source = node({ kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: null })
    const deletion = deleteCommand(asset)
    const results = await Promise.allSettled([
      auth.transact(owner.token, /* 与新图引用竞争提交资产删除的所有者事务上下文。 */ ctx => /* 与新引用创建竞争提交所有者的资产删除请求。 */ assets.delete(ctx, deletion)),
      graph(ws.id, [source], editor.token),
    ])
    expect(results.filter(/* 并发删除与新增引用结果中当前判断是否成功的项。 */ result => /* 统计成功提交的竞争操作，确认没有同时删除资产又保留新引用。 */ result.status === 'fulfilled')).toHaveLength(1)
    const stored = await connection.collection('control_assets').findOne({ _id: asset.id })
    if (stored!.state === 'deleted') {
      expect(await connection.collection(GRAPH_COLLECTION).countDocuments({ workspaceId: ws.id })).toBe(0)
      await expect(assets.read(await auth.read(owner.token), asset.id)).rejects.toMatchObject({ code: 'ASSET_NOT_FOUND' })
      expect((await auth.transact(owner.token, /* 重放已成功删除命令的所有者事务上下文。 */ ctx => /* 重新执行原删除请求，验证获胜删除结果能以收据重放。 */ assets.delete(ctx, deletion))).replayed).toBe(true)
    } else expect(await connection.collection(GRAPH_COLLECTION).countDocuments({ workspaceId: ws.id })).toBe(1)
  })

  it('cleans only logically deleted GridFS objects and keeps ready assets readable', async () => {
    // 验证维护清理只移除逻辑删除附件，重复清理无新增删除且可用资产字节仍完整。
    const ws = await workspace(), bytes = Buffer.from('cleanup')
    const removed = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const retained = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const document = await connection.collection('control_assets').findOne({ _id: removed.id })
    await auth.transact(owner.token, /* 逻辑删除待维护清理资产的所有者事务上下文。 */ ctx => /* 先通过授权删除把目标资产标记为可维护清理状态。 */ assets.delete(ctx, deleteCommand(removed)))
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
  // 组织 v3 数据包的可携带字段、身份映射、非法内容和原子导入回归场景。
  async function portableWorkspace() {
    // 构造多图共享附件、私有上下文及当前/退休 Agent 历史意见，并注入不得导出的运行字段。
    const ws = await workspace(true), bytes = Buffer.from('original source asset')
    const asset = (await assets.upload(owner.token, uploadInput(ws.id, bytes), Readable.from([bytes]))).data
    const original = node({ kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: 'source' })
    const evidence = node({ kind: 'evidence', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, content: 'cited passage', capturedAt: new Date().toISOString() })
    const news = node({ kind: 'news', content: 'News content', context: { private: { value: 'human-only', visibleToAI: false } } })
    const claim = node({ kind: 'claim', content: 'Checkable claim', category: 'custom category' })
    const profile = ws.agents.find(/* 当前与核查子角色匹配的工作区 Agent。 */ agent => /* 找到当前工作区核查子 Agent，为历史意见建立真实配置引用。 */ agent.kind === 'verifySubAgent')!
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
    // 验证导出排除执行内部状态，导入原子重映射图、节点、关系和附件身份，并保留历史溯源。
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
    expect(target.agents.some(/* 导入后 Agent 列表中当前与原身份比较的配置。 */ agent => /* 确认新工作区没有沿用原 Agent 身份。 */ agent.id === fixture.profile.id)).toBe(false)
    const maps = await Promise.all(imported.data.mapIds.map(/* 准备读取导入后持久化图的图身份。 */ id => /* 读取每张导入后的真实图，核对持久化而非仅响应内容。 */ storeCreateGraphStore(connection).read(id)))
    for (const [index, map] of maps.entries()) {
      expect(map).toMatchObject({ revision: 0, run: null, runHistory: [], leases: {} })
      expect(map!.edges.map(/* 当前提取版本的导入关系。 */ edge => /* 提取导入关系版本，以核对版本保留。 */ edge.revision)).toEqual(bundle.maps[index].edges.map(/* 包内对应图中当前提取版本的原关系。 */ edge => /* 提取包内原关系版本，作为导入关系的预期值。 */ edge.revision))
      for (const edge of map!.edges) expect(map!.nodes.map(/* 当前提取身份以核对关系端点存在的导入节点。 */ node => /* 收集导入节点身份，验证每条关系两端均已重映射到本图节点。 */ node.id)).toEqual(expect.arrayContaining([edge.from, edge.to]))
      for (const node of map!.nodes) {
        expect(node.importedFrom?.bundleId).toBe(bundle.id)
        const original = bundle.maps[index].nodes.find(/* 包内当前与 importedFrom.nodeId 匹配的原节点。 */ item => /* 根据导入来源查找原节点，以验证版本和溯源保留。 */ item.id === node.importedFrom?.nodeId)!
        expect(node.revision).toBe(original.revision)
        expect(node.importedFrom?.revision).toBe(original.revision)
        if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') expect(node.data.locator.assetId).toBe(imported.data.assetIds[0])
      }
    }
    const conclusion = maps.flatMap(/* 当前展开节点集合的导入图。 */ map => /* 合并所有导入图的节点，查找历史核查结论。 */ map!.nodes).find(/* 当前判断是否为历史核查结论的导入节点。 */ node => /* 定位核查结论节点以验证过时标记和意见身份映射。 */ node.data.kind === 'verification')!
    expect(conclusion.validity).toBe('stale')
    if (conclusion.data.kind !== 'verification') throw new Error('missing verification')
    expect(conclusion.data.reportIds).toEqual(['old-report', 'retired-report'])
    expect(conclusion.data.opinions.map(/* 历史核查结论中当前提取标识的意见。 */ opinion => /* 提取历史意见标识，确认仍对应原报告标签。 */ opinion.id)).toEqual(conclusion.data.reportIds)
    expect(conclusion.data.opinions[0].slotId).not.toBe('old-slot')
    expect(target.agents.map(/* 新工作区中当前提取身份的 Agent。 */ agent => /* 收集导入 Agent 身份，验证随包历史意见已指向新配置。 */ agent.id)).toContain(conclusion.data.opinions[0].agentId)
    expect(conclusion.data.opinions[1].agentId).toBe('retired-agent-from-archive')
    expect(target.agents.some(/* 当前检查退休历史 Agent 是否被错误恢复为执行配置的 Agent。 */ agent => /* 确认退休 Agent 只保留为历史标签，没有被创建为可执行配置。 */ agent.id === 'retired-agent-from-archive')).toBe(false)
    const content = await assets.content(ctx, imported.data.assetIds[0])
    const chunks: Buffer[] = []
    for await (const chunk of content.stream) chunks.push(Buffer.from(chunk))
    expect(Buffer.concat(chunks)).toEqual(fixture.bytes)
    expect(await staged.run()).toEqual({ data: imported.data, replayed: true })
  })

  it('rejects incomplete references, invalid asset bytes and executable/secret fields before publication', async () => {
    // 逐类注入悬空引用、坏附件、秘密字段或空正文，验证任何非法包都不会发布工作区或资产。
    const fixture = await portableWorkspace()
    const bundle = await assets.exportWorkspace(await auth.read(owner.token), fixture.ws.id)
    for (const mutate of [
      (/* 需要把关系端点改为缺失身份的包副本。 */ value: WorkspaceBundle) => {
        // 把真实关系端点改为不存在的身份，构造悬空引用。
        value.maps.find(/* 当前查找至少含一条关系、可注入悬空端点的图。 */ map => /* 选择至少有一条关系的图以施加端点破坏。 */ map.edges.length)!.edges[0].to = randomUUID() },
      (/* 需要把附件内容改为非法 Base64 的包副本。 */ value: WorkspaceBundle) => {
        // 将附件内容改为非法 Base64，验证内容校验先于发布。
        value.assets[0].contentBase64 = '@@@@' },
      (/* 需要注入不允许根字段的包副本。 */ value: WorkspaceBundle) => {
        // 向包根对象注入不允许携带的令牌字段，验证字段白名单。
        Object.assign(value, { token: 'not-a-portable-field' }) },
      ...(['claim', 'news', 'evidence', 'verification', 'opinion'] as const).map(/* 当前生成相应节点或意见非法内容变更器的类型。 */ kind => /* 为每一种节点或意见正文创建对应的非法内容变更函数。 */ (/* 需要按当前类型破坏正文或理由的包副本。 */ value: WorkspaceBundle) => {
        // 把指定类型的正文或理由改为空白，验证各类内容都必须有效。
        const target = value.maps.flatMap(/* 当前展开节点以定位待破坏类型的便携图。 */ map => /* 收集包内全部图节点，以定位需要破坏的类型。 */ map.nodes).find(/* 当前与待破坏节点或意见类型匹配的节点。 */ node => /* 匹配目标节点种类；意见理由需要在核查结论节点内修改。 */ node.data.kind === (kind === 'opinion' ? 'verification' : kind))!
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
    // 验证没有关系和有多个核查目标的历史结论均能合法往返，导入不额外限制边数量。
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
    const mappedIsolated = imported.nodes.find(/* 当前与孤立结论溯源身份匹配的导入节点。 */ node => /* 通过溯源找到导入后的孤立结论。 */ node.importedFrom?.nodeId === isolated.id)!
    const mappedLinked = imported.nodes.find(/* 当前与多目标结论溯源身份匹配的导入节点。 */ node => /* 通过溯源找到导入后的多目标结论。 */ node.importedFrom?.nodeId === linked.id)!
    expect(imported.edges.filter(/* 当前判断是否从孤立结论出发的导入关系。 */ edge => /* 统计孤立结论的出边，确认导入没有凭空补边。 */ edge.from === mappedIsolated.id)).toHaveLength(0)
    expect(imported.edges.filter(/* 当前判断是否从多目标结论出发的导入关系。 */ edge => /* 统计多目标结论的出边，确认全部关系均被保留。 */ edge.from === mappedLinked.id)).toHaveLength(2)
    expect(imported.edges.map(/* 当前提取版本以检查历史关系保留的导入边。 */ edge => /* 提取关系版本，检查不同历史版本原样保留。 */ edge.revision)).toEqual([1, 9])
    expect(mappedIsolated.revision).toBe(isolated.revision)
    expect(mappedLinked.revision).toBe(linked.revision)
  })

  it('preserves independent historical report labels and repeated opinion tool names accepted by the Graph API', async () => {
    // 验证重复历史报告标签和意见工具名仍可携带，导入保留历史文字且不恢复执行状态。
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
    expect(bundle.map.nodes.find(/* 当前与历史标签节点身份匹配的包内节点。 */ node => /* 找到只包含历史报告标签的导出节点，核对内容无损。 */ node.id === labels.id)!.data).toEqual(labels.data)
    expect(bundle.map.nodes.find(/* 当前与历史详情节点身份匹配的包内节点。 */ node => /* 找到含退休专家意见的导出节点，核对详情无损。 */ node.id === details.id)!.data).toEqual(details.data)
    const staged = await importBundle(bundle, ws.id)
    const result = await staged.run()
    const imported = (await storeCreateGraphStore(connection).read(result.data.mapIds[0]))!
    const importedLabels = imported.nodes.find(/* 当前与标签节点溯源身份匹配的导入节点。 */ node => /* 根据溯源找到导入的历史标签节点。 */ node.importedFrom?.nodeId === labels.id)!
    const importedDetails = imported.nodes.find(/* 当前与详情节点溯源身份匹配的导入节点。 */ node => /* 根据溯源找到导入的历史意见节点。 */ node.importedFrom?.nodeId === details.id)!
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
    // 在第二张图发布时注入失败，验证工作区、所有图和已准备的资产元数据整体回滚。
    const fixture = await portableWorkspace()
    const bundle = await assets.exportWorkspace(await auth.read(owner.token), fixture.ws.id)
    const staged = await importBundle(bundle, fixture.ws.id)
    const collection = connection.collection(GRAPH_COLLECTION)
    const original = collection.insertOne
    let count = 0
    const spy = vi.spyOn(collection, 'insertOne').mockImplementation((/* Mongo insertOne 的原始调用参数，用于有条件注入第二张图发布失败。 */ ...args: unknown[]) => {
      // 只在目标导入工作区的第二次图插入时拒绝，其余调用仍执行真实 Mongo 插入。
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
