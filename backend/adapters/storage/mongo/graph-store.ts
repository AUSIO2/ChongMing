// 文件职责：以单个 Mongo 图文档维护版本、收据、租约和待发布标记。
import { RuntimeMessage } from '../../../../contracts/messages'
import { GRAPH_COLLECTION, type GraphDocument, type GraphReceipt } from '../../../modules/graph/graph-record'
import type { GraphStore } from '../../../ports/graph-store'
import mongoose, { Schema } from 'mongoose'
import type { ClientSession, Connection } from 'mongoose'
import type { GraphEdge, GraphMapSummary, GraphNode, GraphRun, GraphWork, GraphWorkGrant, GraphWorkProof } from '../../../../contracts/graph'
import { GraphError } from '../../../modules/shared/domain-error'

const nodeSchema = new Schema({
  id: { type: String, required: true },
  revision: { type: Number, required: true },
  data: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  importedFrom: Schema.Types.Mixed,
  validity: { type: String, enum: ['current', 'stale'] },
}, { _id: false, minimize: false })

const edgeSchema = new Schema({
  id: { type: String, required: true },
  revision: { type: Number, required: true },
  kind: { type: String, enum: ['derived-from', 'mentions', 'verifies', 'related-to'], required: true },
  from: { type: String, required: true },
  to: { type: String, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
}, { _id: false })

const receiptSchema = new Schema({
  requestId: { type: String, required: true },
  method: { type: String, required: true },
  inputHash: { type: String, required: true },
  createdNodeIds: { type: [String], default: [] },
  createdEdgeIds: { type: [String], default: [] },
  createdAt: { type: Date, required: true },
}, { _id: false })

const graphSchema = new Schema({
  _id: { type: String, required: true },
  workspaceId: { type: String, required: true, index: true },
  revision: { type: Number, required: true },
  name: { type: String, required: true },
  nodes: { type: [nodeSchema], default: [] },
  edges: { type: [edgeSchema], default: [] },
  run: { type: Schema.Types.Mixed, default: null },
  runHistory: { type: [Schema.Types.Mixed], default: [] },
  leases: { type: Schema.Types.Mixed, default: {} },
  receipts: { type: [receiptSchema], default: [] },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: Date,
  dispatch: { type: new Schema({ version: { type: Number, required: true }, pending: { type: Boolean, required: true } }, { _id: false }), required: true },
}, { minimize: false })
graphSchema.index({ 'dispatch.pending': 1 })
function storeReadIso(/* 存储中的 Date 或日期字符串，转换为业务协议的 ISO 时间。 */ value: unknown): string {
  // 将存储日期规范为 ISO 字符串，拒绝非日期形状。
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new Error(RuntimeMessage.STORED_GRAPH_CONTAINS_AN_INVALID_TIMESTAMP)
  }
  return new Date(value).toISOString()
}
function storeReadDocument(/* 从 Mongo 读取的原始图文档，须转换 BSON 日期并检查旧 Run 结构。 */ raw: Record<string, unknown>): GraphDocument {
  // 将 Mongo 文档投影为业务图结构，并拒绝尚未显式迁移的旧 Run。
  const runs = [raw.run, ...(Array.isArray(raw.runHistory) ? raw.runHistory : [])]
  if (runs.some(/* 原始当前或历史 Run 候选，检查是否含退役的 operation 字段。 */ run => /* 检查当前及历史 Run 是否仍使用退役的单 Operation 字段。 */  run && typeof run === 'object' && 'operation' in run)) {
    throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', RuntimeMessage.STOP_HOSTS_AND_RUN_THE_EXPLICIT_DATA_MIGRATE_NODE_RUNS_COMMAND)
  }
  return {
    id: String(raw._id),
    workspaceId: String(raw.workspaceId),
    revision: Number(raw.revision),
    name: String(raw.name),
    nodes: (raw.nodes as Array<Record<string, unknown>>).map(/* 存储节点记录，时间字段和身份需要规范为业务格式。 */ node => /* 还原节点身份、版本及创建更新时间。 */  ({
      ...node,
      id: String(node.id),
      revision: Number(node.revision),
      data: node.data as GraphNode['data'],
      createdAt: storeReadIso(node.createdAt),
      updatedAt: storeReadIso(node.updatedAt),
    })),
    edges: (raw.edges as Array<Record<string, unknown>>).map(/* 存储关系记录，端点、版本和日期需要规范为业务格式。 */ edge => /* 还原关系身份、端点、版本及时间字段。 */  ({
      ...edge,
      id: String(edge.id),
      kind: edge.kind as GraphEdge['kind'],
      from: String(edge.from),
      to: String(edge.to),
      revision: Number(edge.revision),
      createdAt: storeReadIso(edge.createdAt),
      updatedAt: storeReadIso(edge.updatedAt),
    })),
    run: (raw.run as GraphRun | null) ?? null,
    runHistory: (raw.runHistory as GraphRun[] | undefined) ?? [],
    leases: Object.fromEntries(Object.entries((raw.leases as Record<string, GraphWorkGrant>) ?? {})
      .map((/* 租约索引键及其授权记录，保留键并规范到期时间。 */ [key, lease]) => /* 规范每份工作租约的到期时间并保留其索引键。 */  [key, { ...lease, expiresAt: storeReadIso(lease.expiresAt) }])),
    receipts: (raw.receipts as Array<Record<string, unknown>>).map(/* 持久化的原始幂等收据，恢复请求身份、创建对象及提交时间。 */ receipt => /* 还原幂等收据及其创建对象身份和提交时间。 */  ({
      requestId: String(receipt.requestId),
      method: String(receipt.method),
      inputHash: String(receipt.inputHash),
      createdNodeIds: (receipt.createdNodeIds as string[]) ?? [],
      createdEdgeIds: (receipt.createdEdgeIds as string[]) ?? [],
      createdAt: storeReadIso(receipt.createdAt),
    })),
    createdAt: storeReadIso(raw.createdAt),
    updatedAt: storeReadIso(raw.updatedAt),
    deletedAt: raw.deletedAt ? storeReadIso(raw.deletedAt) : undefined,
  }
}

function storeValidateDocument(/* 候选图文档，普通写入需检查 BSON 大小软上限。 */ document: GraphDocument, /* 可选本次收据；提供时一起计入大小，并识别允许超软限的收尾命令。 */ receipt?: GraphReceipt): void {
  // 将普通图写入限制在 8 MiB；暂停、取消、删除和失败收尾可使用剩余空间，避免图过大后无法停止。
  if (receipt && ['run.pause', 'run.cancel', 'map.delete', 'work.fail'].includes(receipt.method)) return
  const value = receipt ? { ...document, receipts: [...document.receipts, receipt] } : document
  if (mongoose.mongo.BSON.calculateObjectSize(value) > 8 * 1024 * 1024) {
    throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.GRAPH_EXCEEDS_THE_8_MIB_DOCUMENT_LIMIT)
  }
}
export function storeCreateGraphStore(/* 已连接的 Mongo 实例，模型与图集合绑定到该连接。 */ connection: Connection, /* 可选外部事务会话，默认 null；图存储不负责结束调用方事务。 */ session: ClientSession | null = null): GraphStore {
  // 绑定图模型与可选事务，集中提供版本提交、租约仲裁和分发查询。
  const model = connection.model('GraphV3', graphSchema, GRAPH_COLLECTION)
  function storeReadLeaseFilter(/* 租约所属图身份。 */ mapId: string, /* 调用者提供的工作身份、holder 与 fence，尚需存储时钟及 Run 条件校验。 */ proof: GraphWorkProof) {
    // 生成 holder/fence、当前 Run 和数据库时钟到期条件，供读取、续租和最终提交共同使用。
    const field = `leases.${proof.workId}`
    return {
      _id: mapId,
      [`${field}.holderId`]: proof.holderId,
      [`${field}.fence`]: proof.fence,
      $expr: { $and: [
        { $gt: [`$${field}.expiresAt`, '$$NOW'] },
        { $eq: ['$run.id', `$${field}.runId`] },
      ] },
    }
  }
  return {
    async initialize(): Promise<void> {
      // 等待 Mongoose 模型索引完成初始化。
       await model.init() },
    async create(/* 待创建的完整图文档，存储层补首次分发标记并转换日期。 */ document: GraphDocument): Promise<boolean> {
      // 插入图及首个待发布标记；重复主键返回 false，其余存储错误继续抛出。
      storeValidateDocument(document)
      try {
        await model.create([{
          ...document,
          _id: document.id,
          dispatch: { version: document.revision, pending: true },
          createdAt: new Date(document.createdAt),
          updatedAt: new Date(document.updatedAt),
        }], { session })
        return true
      } catch (error) {
        if (error instanceof mongoose.Error.ValidationError) throw error
        if (typeof error === 'object' && error && 'code' in error && error.code === 11_000) {
          return false
        }
        throw error
      }
    },
    async read(/* 待读取图的持久身份，包括可能已逻辑删除的文档。 */ mapId: string): Promise<GraphDocument | null> {
      // 按图身份读取当前文档，并转换为业务数据结构。
      const raw = await model.findById(mapId).session(session).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },
    async *discover(): AsyncGenerator<GraphDocument> {
      // 遍历运行中且未暂停、未删除的图，用于启动或重连时恢复工作。
      // Startup/reconnect reconciliation only; normal dispatch is driven by change streams.
      const cursor = model.find({ 'run.status': 'running', 'run.paused': false, deletedAt: { $exists: false } })
        .sort({ updatedAt: 1, _id: 1 }).session(session).lean<Record<string, unknown>[]>().cursor()
      try { for await (const raw of cursor) yield storeReadDocument(raw) }
      finally { await cursor.close() }
    },
    async readLeaseDelay(/* 待查询工作租约所属的图身份。 */ mapId: string, /* 需要计算剩余期限的工作身份，用作租约索引键。 */ workId: string): Promise<number> {
      // 用数据库时钟计算指定租约剩余等待时间，缺少租约时返回零。
      const [row] = await model.aggregate<{ delay: number }>([
        { $match: { _id: mapId } },
        { $project: { delay: { $max: [0, { $subtract: [{ $ifNull: [`$leases.${workId}.expiresAt`, '$$NOW'] }, '$$NOW'] }] } } },
      ]).session(session)
      return row ? row.delay : 0
    },
    async *readDispatch(): AsyncGenerator<GraphDocument & { dispatchVersion: number }> {
      // 遍历待发布图并附带分发版本，确保补发后能有条件清除标记。
      const cursor = model.find({ 'dispatch.pending': true }).session(session).lean<Record<string, unknown>[]>().cursor()
      try {
        for await (const raw of cursor) yield { ...storeReadDocument(raw), dispatchVersion: (raw.dispatch as { version: number }).version }
      } finally { await cursor.close() }
    },

    async clearDispatch(/* 已完成通知发布的图身份。 */ mapId: string, /* 发布时读取的分发版本，只有仍匹配时才能清除待发送标记。 */ version: number): Promise<boolean> {
      // 只清除已发布版本的待通知标记；期间发生新提交时保留新版本，避免漏发后续工作和快照通知。
      const result = await model.updateOne({ _id: mapId, 'dispatch.version': version, 'dispatch.pending': true },
        { $set: { 'dispatch.pending': false } })
      return result.matchedCount === 1
    },

    async claim(/* 业务层读取的图快照，使用其版本仲裁领取竞争。 */ document: GraphDocument, /* 从该快照推导的可执行工作，包含 Run、Operation、角色及路由版本。 */ work: GraphWork, /* 申请执行的 Host 身份，用于追踪授权所有者。 */ hostId: string, /* 本次领取尝试的唯一持有者身份，与 Host 身份共同区分执行实例。 */ holderId: string, /* 授予的租约时长，单位毫秒，由服务配置预先校验。 */ leaseMs: number): Promise<GraphWorkGrant | null> {
      // 匹配图版本和可运行状态后，原子领取无租约或租约已到期的工作；递增 fence，并用数据库时钟计算新期限。
      const field = `leases.${work.workId}`
      const raw = await model.findOneAndUpdate({
        _id: document.id, revision: document.revision, 'run.id': work.runId, 'run.status': 'running', 'run.paused': false,
        $expr: { $lte: [{ $ifNull: [`$${field}.expiresAt`, new Date(0)] }, '$$NOW'] },
      }, [{ $set: { [field]: { $mergeObjects: [
        { $literal: { ...work, hostId, holderId, leaseMs } },
        { fence: { $add: [{ $ifNull: [`$${field}.fence`, 0] }, 1] }, expiresAt: { $add: ['$$NOW', leaseMs] } },
      ] } } }], { returnDocument: 'after', updatePipeline: true, session }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw).leases[work.workId] : null
    },
    async readLease(/* 待验证租约所在的图身份。 */ mapId: string, /* 请求方持有的工作凭证，必须同时匹配 holder、fence、当前 Run 和有效期。 */ proof: GraphWorkProof): Promise<GraphDocument | null> {
      // 按授权身份、服务器时钟和运行状态读取有效租约所属图。
      const raw = await model.findOne({ ...storeReadLeaseFilter(mapId, proof),
        'run.status': { $in: ['running', 'waiting', 'completed'] }, 'run.paused': false, deletedAt: { $exists: false },
      }).session(session).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },

    async renew(/* 待续期租约所在的图身份。 */ mapId: string, /* 原授权的工作身份、持有者及 fence，已过期或被接管时拒绝续租。 */ proof: GraphWorkProof): Promise<GraphWorkGrant | null> {
      // 仅续期当前仍有效的 holder/fence，按数据库时钟延长原租约时长，保持授权身份不变。
      const field = `leases.${proof.workId}`
      const raw = await model.findOneAndUpdate({ ...storeReadLeaseFilter(mapId, proof),
        'run.status': { $in: ['running', 'waiting', 'completed'] }, 'run.paused': false, deletedAt: { $exists: false },
      }, [{ $set: { [`${field}.expiresAt`]: { $add: ['$$NOW', `$${field}.leaseMs`] } } }],
      { returnDocument: 'after', updatePipeline: true, session }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw).leases[proof.workId] : null
    },

    async release(/* 待释放工作所在的图身份。 */ mapId: string, /* 需要释放的持有者与 fence，仅允许使自己仍匹配的租约到期。 */ proof: GraphWorkProof): Promise<boolean> {
      // 让匹配 holder/fence 的租约立即到期，保留授权记录；迟到的旧持有者不会释放新租约。
      const field = `leases.${proof.workId}`
      const result = await model.updateOne({ _id: mapId,
        [`${field}.holderId`]: proof.holderId, [`${field}.fence`]: proof.fence,
      }, { $set: { [`${field}.expiresAt`]: new Date(0) } }, { session: session ?? undefined })
      return result.matchedCount === 1
    },
    async list(/* 调用方已经授权的工作区身份，用于限制返回图摘要的范围。 */ workspaceId: string): Promise<GraphMapSummary[]> {
      // 读取工作区内未删除图并按更新时间排序，返回轻量摘要。
      const rows = await model.find({ workspaceId, deletedAt: { $exists: false } })
        .sort({ updatedAt: -1, _id: 1 })
        .session(session)
        .lean<Record<string, unknown>[]>()
      return rows.map(/* Mongo 返回的单个图记录，先转换再计算摘要。 */ raw => {
        // 从单个图计算节点数量、事实数量和列表展示字段。
        const document = storeReadDocument(raw)
        return {
          id: document.id,
          workspaceId: document.workspaceId,
          revision: document.revision,
          name: document.name,
          nodeCount: document.nodes.length,
          claimCount: document.nodes.filter(/* 图中的单个节点，仅 kind 为 claim 时计入事实数量。 */ node => /* 仅统计事实节点，排除来源、新闻和核查结果。 */  node.data.kind === 'claim').length,
          updatedAt: document.updatedAt,
        }
      })
    },

    async commit(
      /* 业务层计算出的待提交图草稿；租约更新保留数据库中的最新值。 */ document: GraphDocument,
      /* 计算草稿时读取的图版本，最终写入必须仍匹配该值。 */ expectedRevision: number,
      /* 与本次状态变化一起持久化的幂等收据。 */ receipt: GraphReceipt,
      /* 可选工作授权；提供时最终写入还要检查有效租约与可运行状态。 */ grant?: GraphWorkGrant,
    ): Promise<boolean> {
      // 以图版本和可选工作租约为写入条件，原子更新状态、收据与待通知标记；条件不匹配返回 false。
      storeValidateDocument(document, receipt)
      if (receipt.method === 'run.pause' && !session?.inTransaction()) throw new Error(RuntimeMessage.RUN_PAUSE_MUST_REVOKE_LEASES_INSIDE_ITS_AUTHORIZATION_TRANSACTION)
      const expiredLeases = receipt.method === 'run.pause'
        ? Object.fromEntries(Object.entries(document.leases).filter((/* 图快照中的租约键值对，此处只取租约以筛选当前 Run。 */ [, lease]) => /* 暂停仅撤销当前 Run 的工作授权。 */ lease.runId === document.run!.id)
          .map((/* 待撤销租约的索引键，用于仅更新其 expiresAt 字段。 */ [id]) => /* 只更新期限字段，保留工作身份和 fence。 */ [`leases.${id}.expiresAt`, new Date(0)])) : {}
      // 不整体替换 leases，防止图快照覆盖并发续租；暂停撤销租约必须包含在调用方的授权事务中。
      // ponytail: 单个图文档保证状态与收据原子更新；接近 8 MiB 时再考虑拆分集合。
      const result = await model.updateOne(
        { _id: document.id, revision: expectedRevision,
          ...(grant ? { ...storeReadLeaseFilter(document.id, grant), 'run.id': grant.runId, 'run.status': 'running', 'run.paused': false } : {}),
        },
        {
          $set: {
            ...expiredLeases,
            dispatch: { version: expectedRevision + 1, pending: true },
            name: document.name,
            nodes: document.nodes,
            edges: document.edges,
            run: document.run,
            runHistory: document.runHistory,
            updatedAt: new Date(document.updatedAt),
            ...(document.deletedAt ? { deletedAt: new Date(document.deletedAt) } : {}),
          },
          $inc: { revision: 1 },
          $push: { receipts: receipt },
        },
        { session: session ?? undefined },
      )
      return result.matchedCount === 1
    },
  }
}
