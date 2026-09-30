// 文件职责：以单个 Mongo 图文档维护版本、收据、租约和待发布标记。
import { RuntimeMessage } from '../../../../contracts/messages'
import { GRAPH_COLLECTION, storeAssertCurrentGraphSchema, type GraphDocument, type GraphOwnershipReceipt, type GraphOwnershipRecord, type GraphReceipt } from '../../../modules/graph/graph-record'
import type { GraphCommitGuard, GraphStore } from '../../../ports/graph-store'
import mongoose, { Schema } from 'mongoose'
import type { ClientSession, Connection } from 'mongoose'
import type { GraphEdge, GraphMapSummary, GraphNode, GraphRun, GraphWork, GraphWorkGrant, GraphWorkProof } from '../../../../contracts/graph'
import { GraphError } from '../../../modules/shared/domain-error'

const nodeSchema = new Schema({
  id: { type: String, required: true },
  revision: { type: Number, required: true },
  typeId: { type: String, required: true },
  typeVersion: { type: Number, required: true },
  payload: { type: Schema.Types.Mixed, required: true },
  payloadReferences: { type: [Schema.Types.Mixed], default: [] },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  importedFrom: Schema.Types.Mixed,
  validity: { type: String, enum: ['current', 'stale'] },
  producer: Schema.Types.Mixed,
}, { _id: false, minimize: false })

const edgeSchema = new Schema({
  id: { type: String, required: true },
  revision: { type: Number, required: true },
  kind: { type: String, enum: ['successor', 'reference'], required: true },
  from: { type: String, required: true },
  to: { type: String, required: true },
  label: String,
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
}, { _id: false })

const receiptSchema = new Schema({
  requestId: { type: String, required: true },
  method: { type: String, required: true },
  inputHash: { type: String, required: true },
  createdNodeIds: { type: [String], default: [] },
  createdEdgeIds: { type: [String], default: [] },
  branch: Schema.Types.Mixed,
  createdAt: { type: Date, required: true },
}, { _id: false })

const graphSchema = new Schema({
  _id: { type: String, required: true },
  workspaceId: { type: String, required: true, index: true },
  revision: { type: Number, required: true },
  dataFormat: Number,
  migration: Schema.Types.Mixed,
  name: { type: String, required: true },
  nodes: { type: [nodeSchema], default: [] },
  edges: { type: [edgeSchema], default: [] },
  retiredNodeIds: { type: [String], default: [] },
  retiredEdgeIds: { type: [String], default: [] },
  ownershipRevision: { type: Number, default: 0 },
  branchOwnerships: { type: Schema.Types.Mixed, default: {} },
  ownershipReceipts: { type: [Schema.Types.Mixed], default: [] },
  runs: { type: [Schema.Types.Mixed], default: [] },
  runHistory: { type: [Schema.Types.Mixed], default: [] },
  leases: { type: Schema.Types.Mixed, default: {} },
  receipts: { type: [receiptSchema], default: [] },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
  deletedAt: Date,
  dispatch: { type: new Schema({ version: { type: Number, required: true }, pending: { type: Boolean, required: true } }, { _id: false }), required: true },
}, { minimize: false })
graphSchema.index({ 'dispatch.pending': 1 })
/**
 * 将存储日期规范为 ISO 字符串，拒绝非日期形状。
 *
 * @param value 存储中的 Date 或日期字符串，转换为业务协议的 ISO 时间。
 */
function storeReadIso(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new Error(RuntimeMessage.STORED_GRAPH_CONTAINS_AN_INVALID_TIMESTAMP)
  }
  return new Date(value).toISOString()
}
/**
 * 将 Mongo 文档投影为业务图结构，并拒绝尚未显式迁移的旧节点、Run 或工作授权。
 *
 * @param raw 从 Mongo 读取的原始图文档，须转换 BSON 日期并检查旧 Run 结构。
 */
function storeReadDocument(raw: Record<string, unknown>): GraphDocument {
  storeAssertCurrentGraphSchema(raw)
  return {
    id: String(raw._id),
    workspaceId: String(raw.workspaceId),
    revision: Number(raw.revision),
    ...(raw.dataFormat === undefined ? {} : { dataFormat: Number(raw.dataFormat) }),
    ...(raw.migration === undefined ? {} : { migration: raw.migration as GraphDocument['migration'] }),
    name: String(raw.name),
    nodes: (raw.nodes as Array<Record<string, unknown>>).map(node => /* 还原节点身份、版本及创建更新时间。 */  ({
      ...node,
      id: String(node.id),
      revision: Number(node.revision),
      typeId: String(node.typeId),
      typeVersion: Number(node.typeVersion),
      payload: node.payload as GraphNode['payload'],
      createdAt: storeReadIso(node.createdAt),
      updatedAt: storeReadIso(node.updatedAt),
    })),
    edges: (raw.edges as Array<Record<string, unknown>>).map(edge => /* 还原关系身份、端点、版本及时间字段。 */  ({
      ...edge,
      id: String(edge.id),
      kind: edge.kind as GraphEdge['kind'],
      from: String(edge.from),
      to: String(edge.to),
      revision: Number(edge.revision),
      createdAt: storeReadIso(edge.createdAt),
      updatedAt: storeReadIso(edge.updatedAt),
    })),
    retiredNodeIds: Array.isArray(raw.retiredNodeIds) ? raw.retiredNodeIds.map(String) : [],
    retiredEdgeIds: Array.isArray(raw.retiredEdgeIds) ? raw.retiredEdgeIds.map(String) : [],
    ownershipRevision: Number(raw.ownershipRevision ?? 0),
    branchOwnerships: Object.fromEntries(Object.entries((raw.branchOwnerships as Record<string, GraphOwnershipRecord>) ?? {}).map(([id, ownership]) =>
      [id, ownership.kind === 'control' ? { ...ownership, expiresAt: storeReadIso(ownership.expiresAt) }
        : { ...ownership, expiresAt: ownership.expiresAt === null ? null : storeReadIso(ownership.expiresAt) }])),
    ownershipReceipts: ((raw.ownershipReceipts as Array<GraphOwnershipReceipt & { createdAt: unknown }>) ?? []).map(receipt =>
      ({ ...receipt, createdAt: storeReadIso(receipt.createdAt) })),
    runs: (raw.runs as GraphRun[] | undefined) ?? [],
    runHistory: (raw.runHistory as GraphRun[] | undefined) ?? [],
    leases: Object.fromEntries(Object.entries((raw.leases as Record<string, GraphWorkGrant>) ?? {})
      .map(([key, lease]) => /* 规范每份工作租约的到期时间并保留其索引键。 */  [key, { ...lease, expiresAt: storeReadIso(lease.expiresAt) }])),
    receipts: (raw.receipts as Array<Record<string, unknown>>).map(receipt => /* 还原幂等收据及其创建对象身份和提交时间。 */  ({
      requestId: String(receipt.requestId),
      method: String(receipt.method),
      inputHash: String(receipt.inputHash),
      createdNodeIds: (receipt.createdNodeIds as string[]) ?? [],
      createdEdgeIds: (receipt.createdEdgeIds as string[]) ?? [],
      ...(receipt.branch === undefined ? {} : { branch: receipt.branch as GraphReceipt['branch'] }),
      createdAt: storeReadIso(receipt.createdAt),
    })),
    createdAt: storeReadIso(raw.createdAt),
    updatedAt: storeReadIso(raw.updatedAt),
    deletedAt: raw.deletedAt ? storeReadIso(raw.deletedAt) : undefined,
  }
}

/**
 * 将普通图写入限制在 8 MiB；暂停、取消、删除和失败收尾可使用剩余空间，避免图过大后无法停止。
 *
 * @param document 候选图文档，普通写入需检查 BSON 大小软上限。
 * @param receipt 可选本次收据；提供时一起计入大小，并识别允许超软限的收尾命令。
 */
function storeValidateDocument(document: GraphDocument, receipt?: GraphReceipt): void {
  storeAssertCurrentGraphSchema(document)
  if (receipt && ['run.pause', 'run.cancel', 'map.delete', 'work.fail'].includes(receipt.method)) return
  const value = receipt ? { ...document, receipts: [...document.receipts, receipt] } : document
  if (mongoose.mongo.BSON.calculateObjectSize(value) > 8 * 1024 * 1024) {
    throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.GRAPH_EXCEEDS_THE_8_MIB_DOCUMENT_LIMIT)
  }
}
/**
 * 绑定图模型与可选事务，集中提供版本提交、租约仲裁和分发查询。
 *
 * @param connection 已连接的 Mongo 实例，模型与图集合绑定到该连接。
 * @param session 可选外部事务会话，默认 null；图存储不负责结束调用方事务。
 */
export function storeCreateGraphStore(connection: Connection, session: ClientSession | null = null): GraphStore {
  const model = connection.model('GraphV3', graphSchema, GRAPH_COLLECTION)
  /**
   * 生成 holder/fence、当前 Run 和数据库时钟到期条件，供读取、续租和最终提交共同使用。
   *
   * @param mapId 租约所属图身份。
   * @param proof 调用者提供的工作身份、holder 与 fence，尚需存储时钟及 Run 条件校验。
   */
  function storeReadLeaseFilter(mapId: string, proof: GraphWorkProof) {
    const field = `leases.${proof.workId}`
    return {
      _id: mapId,
      [`${field}.holderId`]: proof.holderId,
      [`${field}.fence`]: proof.fence,
      $expr: { $and: [
        { $gt: [`$${field}.expiresAt`, '$$NOW'] },
        { $gt: [{ $size: { $filter: { input: '$runs', as: 'run', cond: { $and: [
          { $eq: ['$$run.id', `$${field}.runId`] }, { $in: ['$$run.status', ['running', 'waiting', 'completed']] },
          { $eq: ['$$run.paused', false] },
        ] } } } }, 0] },
      ] },
    }
  }
  /**
   * 将阶段、槽位和冻结规格加入最终 CAS，阻止同一 workId 下被篡改或过时的授权提交。
   *
   * @param grant 最终提交携带的完整授权，必须与存储租约和当前 Operation 完全一致。
   */
  function storeReadGrantFilter(grant: GraphWorkGrant) {
    const field = `leases.${grant.workId}`
    return {
      ...storeReadLeaseFilter(grant.mapId, grant),
      [`${field}.mapId`]: grant.mapId,
      [`${field}.runId`]: grant.runId,
      [`${field}.operationId`]: grant.operationId,
      [`${field}.stageId`]: grant.stageId,
      [`${field}.slotId`]: grant.slotId,
      [`${field}.specHash`]: grant.specHash,
      runs: { $elemMatch: { id: grant.runId, status: 'running', paused: false, operations: { $elemMatch: {
          id: grant.operationId, status: 'running', specHash: grant.specHash,
          stages: { $elemMatch: { stageId: grant.stageId, expectedWorkIds: grant.workId,
            planSlots: { $elemMatch: { id: grant.slotId, stageId: grant.stageId } } } },
        } } } },
    }
  }
  /**
   * @param ownerships 领域层 ISO 时间占有记录，转换为可由 $$NOW 比较的 BSON Date。
   */
  function storeWriteOwnerships(ownerships: Record<string, GraphOwnershipRecord>) {
    return Object.fromEntries(Object.entries(ownerships).map(([id, ownership]) => [id, {
      ...ownership, expiresAt: ownership.expiresAt === null ? null : new Date(ownership.expiresAt),
    }]))
  }
  /**
   * @param guard 内容提交必须匹配的占有代次。
   */
  function storeReadCommitGuardFilter(guard?: GraphCommitGuard): Record<string, unknown> {
    if (!guard) return {}
    const result: Record<string, unknown> = { ownershipRevision: guard.ownershipRevision === 0 ? { $in: [0, null] } : guard.ownershipRevision }
    if (guard.editor) {
      const field = `branchOwnerships.${guard.editor.leaseId}`
      Object.assign(result, { [`${field}.kind`]: 'editor', [`${field}.ownerUserId`]: guard.editor.ownerUserId,
        [`${field}.holderId`]: guard.editor.holderId, [`${field}.fence`]: guard.editor.fence,
        $expr: { $gt: [`$${field}.expiresAt`, '$$NOW'] } })
    }
    if (guard.runId) Object.assign(result, { [`branchOwnerships.${guard.runId}.kind`]: 'run',
      [`branchOwnerships.${guard.runId}.runId`]: guard.runId })
    if (guard.control) {
      const field = `branchOwnerships.${guard.control.leaseId}`
      Object.assign(result, { [`${field}.kind`]: 'control', [`${field}.runId`]: guard.control.runId,
        [`${field}.ownerUserId`]: guard.control.ownerUserId, [`${field}.holderId`]: guard.control.holderId,
        [`${field}.fence`]: guard.control.fence, $expr: { $gt: [`$${field}.expiresAt`, '$$NOW'] } })
    }
    return result
  }
  return {
    async initialize(): Promise<void> {
      // 等待 Mongoose 模型索引完成初始化。
       await model.init() },
    /**
     * 插入图及首个待发布标记；重复主键返回 false，其余存储错误继续抛出。
     *
     * @param document 待创建的完整图文档，存储层补首次分发标记并转换日期。
     */
    async create(document: GraphDocument): Promise<boolean> {
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
    /**
     * 按图身份读取当前文档，并转换为业务数据结构。
     *
     * @param mapId 待读取图的持久身份，包括可能已逻辑删除的文档。
     */
    async read(mapId: string): Promise<GraphDocument | null> {
      const raw = await model.findById(mapId).session(session).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },
    async *discover(): AsyncGenerator<GraphDocument> {
      // 遍历运行中且未暂停、未删除的图，用于启动或重连时恢复工作。
      // Startup/reconnect reconciliation only; normal dispatch is driven by change streams.
      const cursor = model.find({ runs: { $elemMatch: { status: 'running', paused: false } }, deletedAt: { $exists: false } })
        .sort({ updatedAt: 1, _id: 1 }).session(session).lean<Record<string, unknown>[]>().cursor()
      try { for await (const raw of cursor) yield storeReadDocument(raw) }
      finally { await cursor.close() }
    },
    /**
     * 用数据库时钟计算指定租约剩余等待时间，缺少租约时返回零。
     *
     * @param mapId 待查询工作租约所属的图身份。
     * @param workId 需要计算剩余期限的工作身份，用作租约索引键。
     */
    async readLeaseDelay(mapId: string, workId: string): Promise<number> {
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

    /**
     * 只清除已发布版本的待通知标记；期间发生新提交时保留新版本，避免漏发后续工作和快照通知。
     *
     * @param mapId 已完成通知发布的图身份。
     * @param version 发布时读取的分发版本，只有仍匹配时才能清除待发送标记。
     */
    async clearDispatch(mapId: string, version: number): Promise<boolean> {
      const result = await model.updateOne({ _id: mapId, 'dispatch.version': version, 'dispatch.pending': true },
        { $set: { 'dispatch.pending': false } })
      return result.matchedCount === 1
    },

    /**
     * 匹配图版本和可运行状态后，原子领取无租约或租约已到期的工作；递增 fence，并用数据库时钟计算新期限。
     *
     * @param document 业务层读取的图快照，使用其版本仲裁领取竞争。
     * @param work 从该快照推导的可执行工作，包含 Run、Operation、角色及路由版本。
     * @param hostId 申请执行的 Host 身份，用于追踪授权所有者。
     * @param holderId 本次领取尝试的唯一持有者身份，与 Host 身份共同区分执行实例。
     * @param leaseMs 授予的租约时长，单位毫秒，由服务配置预先校验。
     */
    async claim(document: GraphDocument, work: GraphWork, hostId: string, holderId: string, leaseMs: number): Promise<GraphWorkGrant | null> {
      const field = `leases.${work.workId}`
      const raw = await model.findOneAndUpdate({
        _id: document.id, revision: document.revision, runs: { $elemMatch: { id: work.runId, status: 'running', paused: false } },
        $expr: { $lte: [{ $ifNull: [`$${field}.expiresAt`, new Date(0)] }, '$$NOW'] },
      }, [{ $set: { [field]: { $mergeObjects: [
        { $literal: { ...work, hostId, holderId, leaseMs } },
        { fence: { $add: [{ $ifNull: [`$${field}.fence`, 0] }, 1] }, expiresAt: { $add: ['$$NOW', leaseMs] } },
      ] } } }], { returnDocument: 'after', updatePipeline: true, session }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw).leases[work.workId] : null
    },
    /**
     * 按授权身份、服务器时钟和运行状态读取有效租约所属图。
     *
     * @param mapId 待验证租约所在的图身份。
     * @param proof 请求方持有的工作凭证，必须同时匹配 holder、fence、当前 Run 和有效期。
     */
    async readLease(mapId: string, proof: GraphWorkProof): Promise<GraphDocument | null> {
      const raw = await model.findOne({ ...storeReadLeaseFilter(mapId, proof), deletedAt: { $exists: false } })
        .session(session).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },

    /**
     * 仅续期当前仍有效的 holder/fence，按数据库时钟延长原租约时长，保持授权身份不变。
     *
     * @param mapId 待续期租约所在的图身份。
     * @param proof 原授权的工作身份、持有者及 fence，已过期或被接管时拒绝续租。
     */
    async renew(mapId: string, proof: GraphWorkProof): Promise<GraphWorkGrant | null> {
      const field = `leases.${proof.workId}`
      const raw = await model.findOneAndUpdate({ ...storeReadLeaseFilter(mapId, proof), deletedAt: { $exists: false } },
      [{ $set: { [`${field}.expiresAt`]: { $add: ['$$NOW', `$${field}.leaseMs`] } } }],
      { returnDocument: 'after', updatePipeline: true, session }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw).leases[proof.workId] : null
    },

    /**
     * 让匹配 holder/fence 的租约立即到期，保留授权记录；迟到的旧持有者不会释放新租约。
     *
     * @param mapId 待释放工作所在的图身份。
     * @param proof 需要释放的持有者与 fence，仅允许使自己仍匹配的租约到期。
     */
    async release(mapId: string, proof: GraphWorkProof): Promise<boolean> {
      const field = `leases.${proof.workId}`
      const result = await model.updateOne({ _id: mapId,
        [`${field}.holderId`]: proof.holderId, [`${field}.fence`]: proof.fence,
      }, { $set: { [`${field}.expiresAt`]: new Date(0) } }, { session: session ?? undefined })
      return result.matchedCount === 1
    },
    /**
     * 读取工作区内未删除图并按更新时间排序，返回轻量摘要。
     *
     * @param workspaceId 调用方已经授权的工作区身份，用于限制返回图摘要的范围。
     */
    async list(workspaceId: string): Promise<GraphMapSummary[]> {
      const rows = await model.find({ workspaceId, deletedAt: { $exists: false } })
        .sort({ updatedAt: -1, _id: 1 })
        .session(session)
        .lean<Record<string, unknown>[]>()
      return rows.map(raw => {
        // 从单个图计算节点总量及注册类型分布，不假设固定事实类型。
        const document = storeReadDocument(raw)
        return {
          id: document.id,
          workspaceId: document.workspaceId,
          revision: document.revision,
          name: document.name,
          nodeCount: document.nodes.length,
          typeCounts: Object.fromEntries([...document.nodes.reduce((counts, node) => {
            // 用户可见种类按 typeId 汇总，定义版本仍由具体节点保留。
            counts.set(node.typeId, (counts.get(node.typeId) ?? 0) + 1)
            return counts
          }, new Map<string, number>())]),
          updatedAt: document.updatedAt,
        }
      })
    },

    /**
     * 只推进协调和独立分发版本，不改变业务内容 revision。
     *
     * @param mapId 图身份。
     * @param expectedRevision 内容版本。
     * @param expectedOwnershipRevision 协调版本。
     * @param ownerships 新占有字典。
     * @param receipt 幂等收据。
     */
    async commitOwnership(mapId, expectedRevision, expectedOwnershipRevision,
      ownerships, receipt) {
      const result = await model.updateOne({ _id: mapId, revision: expectedRevision,
        ownershipRevision: expectedOwnershipRevision === 0 ? { $in: [0, null] } : expectedOwnershipRevision }, {
        $set: { branchOwnerships: storeWriteOwnerships(ownerships), 'dispatch.pending': true },
        $inc: { ownershipRevision: 1, 'dispatch.version': 1 }, $push: { ownershipReceipts: receipt },
      }, { session: session ?? undefined })
      return result.matchedCount === 1
    },

    /**
     * 只接受从 expectedRevision 同一快照派生的草稿，再以持久化图版本和可选租约为条件原子提交。
     *
     * @param document 业务层计算出的待提交图草稿；租约更新保留数据库中的最新值。
     * @param expectedRevision 计算草稿时读取的图版本，最终写入必须仍匹配该值。
     * @param receipt 与本次状态变化一起持久化的幂等收据。
     * @param grant 可选工作授权；提供时最终写入还要检查有效租约与可运行状态。
     * @param guard 分支占有最终写条件。
     */
    async commit(
      document: GraphDocument,
      expectedRevision: number,
      receipt: GraphReceipt,
      grant?: GraphWorkGrant,
      guard?: GraphCommitGuard,
    ): Promise<boolean> {
      // 该本地检查阻止调用方在 CAS 失败后仅抬高 expectedRevision 并盲写旧草稿；分支重放必须先读取并保留其他分支的最新状态。
      storeValidateDocument(document, receipt)
      if (document.revision !== expectedRevision) return false
      if (grant && grant.mapId !== document.id) return false
      if (receipt.method === 'run.pause' && !session?.inTransaction()) throw new Error(RuntimeMessage.RUN_PAUSE_MUST_REVOKE_LEASES_INSIDE_ITS_AUTHORIZATION_TRANSACTION)
      const expiredLeases = receipt.method === 'run.pause'
        ? Object.fromEntries(Object.entries(document.leases).filter(([, lease]) => /* 暂停仅撤销当前 Run 的工作授权。 */ lease.runId === guard?.runId)
          .map(([id]) => /* 只更新期限字段，保留工作身份和 fence。 */ [`leases.${id}.expiresAt`, new Date(0)])) : {}
      // 不整体替换 leases，防止图快照覆盖并发续租；暂停撤销租约必须包含在调用方的授权事务中。
      // ponytail: 单个图文档保证状态与收据原子更新；接近 8 MiB 时再考虑拆分集合。
      const grantFilter: Record<string, unknown> = grant ? storeReadGrantFilter(grant) : {}
      const guardFilter = storeReadCommitGuardFilter(guard)
      const expressions = [grantFilter.$expr, guardFilter.$expr].filter(Boolean)
      delete grantFilter.$expr; delete guardFilter.$expr
      const result = await model.updateOne(
        { _id: document.id, revision: expectedRevision, ...grantFilter, ...guardFilter,
          ...(expressions.length ? { $expr: expressions.length === 1 ? expressions[0] : { $and: expressions } } : {}),
        },
        {
          $set: {
            ...expiredLeases,
            'dispatch.pending': true,
            name: document.name,
            ...(document.dataFormat === undefined ? {} : { dataFormat: document.dataFormat }),
            ...(document.migration === undefined ? {} : { migration: document.migration }),
            nodes: document.nodes,
            edges: document.edges,
            retiredNodeIds: document.retiredNodeIds ?? [],
            retiredEdgeIds: document.retiredEdgeIds ?? [],
            ownershipRevision: document.ownershipRevision ?? 0,
            branchOwnerships: storeWriteOwnerships(document.branchOwnerships ?? {}),
            ownershipReceipts: document.ownershipReceipts ?? [],
            runs: document.runs,
            runHistory: document.runHistory,
            updatedAt: new Date(document.updatedAt),
            ...(document.deletedAt ? { deletedAt: new Date(document.deletedAt) } : {}),
          },
          $inc: { revision: 1, 'dispatch.version': 1 },
          $push: { receipts: receipt },
        },
        { session: session ?? undefined },
      )
      return result.matchedCount === 1
    },
  }
}
