// 验证资产字节完整性、授权竞争和删除保护；v4 便携包由相邻专项测试验收。
import { sourceReadUrl } from '../../../../backend/adapters/sources/http-source'
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assetsCreateService, type AssetsService, type AssetUploadInput } from '../../../../backend/modules/assets/asset-service'
import { authCreateService, type AuthService } from '../../../../backend/modules/identity/identity-service'
import { controlCreateService, type ControlService } from '../../../../backend/modules/workspace/workspace-service'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { GRAPH_COLLECTION, type GraphDocument } from '../../../../backend/modules/graph/graph-record'
import type { Asset, ControlCommand } from '../../../../contracts/control'
import type { GraphNode, GraphPayload } from '../../../../contracts/graph'
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
function node(/* 需要包装为带身份、版本和时间的节点数据。 */ data: { kind: string; [key: string]: unknown }): GraphNode {
  // 退役用例的 kind 仅作测试工厂输入，真实图仍使用通用类型信封。
  const now = new Date().toISOString()
  const { kind, ...payload } = data
  return { id: randomUUID(), revision: 3, typeId: `factcheck.${kind}`, typeVersion: 1,
    payload: payload as GraphPayload, createdAt: now, updatedAt: now }
}
async function graph(/* 新图归属且附件引用必须匹配的工作区身份。 */ workspaceId: string, /* 写入新图并在事务中验证引用的节点集合。 */ nodes: GraphNode[], /* 创建图使用的用户令牌；默认所有者。 */ token = owner.token, /* 写入图文档的可选关系集合。 */ edges: GraphDocument['edges'] = []) {
  // 在授权事务中校验资产引用并创建含指定节点和关系的图文档。
  const now = new Date().toISOString()
  const document: GraphDocument = { id: randomUUID(), workspaceId, revision: 0, name: 'Portable Map',
    nodes, edges, runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
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
beforeAll(async () => {
  // 初始化独立 Mongo、身份和资产服务，并创建所有者、编辑者及无关管理员。
  mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1 } })
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
