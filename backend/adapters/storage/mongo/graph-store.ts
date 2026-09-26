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

// 用途：读取存储，并把结构化结果交给调用方。
function storeReadIso(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new Error(RuntimeMessage.STORED_GRAPH_CONTAINS_AN_INVALID_TIMESTAMP)
  }
  return new Date(value).toISOString()
}

// 用途：读取文档，并把结构化结果交给调用方。
function storeReadDocument(raw: Record<string, unknown>): GraphDocument {
  const runs = [raw.run, ...(Array.isArray(raw.runHistory) ? raw.runHistory : [])]
  if (runs.some(run => run && typeof run === 'object' && 'operation' in run)) {
    throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', RuntimeMessage.STOP_HOSTS_AND_RUN_THE_EXPLICIT_DATA_MIGRATE_NODE_RUNS_COMMAND)
  }
  return {
    id: String(raw._id),
    workspaceId: String(raw.workspaceId),
    revision: Number(raw.revision),
    name: String(raw.name),
    nodes: (raw.nodes as Array<Record<string, unknown>>).map(node => ({
      ...node,
      id: String(node.id),
      revision: Number(node.revision),
      data: node.data as GraphNode['data'],
      createdAt: storeReadIso(node.createdAt),
      updatedAt: storeReadIso(node.updatedAt),
    })),
    edges: (raw.edges as Array<Record<string, unknown>>).map(edge => ({
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
      .map(([key, lease]) => [key, { ...lease, expiresAt: storeReadIso(lease.expiresAt) }])),
    receipts: (raw.receipts as Array<Record<string, unknown>>).map(receipt => ({
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

// 用途：校验文档输入，发现不符合约束时立即报错。
function storeValidateDocument(document: GraphDocument, receipt?: GraphReceipt): void {
  // Reserve Mongo's remaining headroom for cancellation/deletion when the graph reaches its soft limit.
  if (receipt && ['run.pause', 'run.cancel', 'map.delete', 'work.fail'].includes(receipt.method)) return
  const value = receipt ? { ...document, receipts: [...document.receipts, receipt] } : document
  if (mongoose.mongo.BSON.calculateObjectSize(value) > 8 * 1024 * 1024) {
    throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.GRAPH_EXCEEDS_THE_8_MIB_DOCUMENT_LIMIT)
  }
}

// 用途：创建图，供后续流程使用。
export function storeCreateGraphStore(connection: Connection, session: ClientSession | null = null): GraphStore {
  const model = connection.model('GraphV3', graphSchema, GRAPH_COLLECTION)
  // 用途：读取租约，并把结构化结果交给调用方。
  function storeReadLeaseFilter(mapId: string, proof: GraphWorkProof) {
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
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize(): Promise<void> { await model.init() },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
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

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read(mapId: string): Promise<GraphDocument | null> {
      const raw = await model.findById(mapId).session(session).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async *discover(): AsyncGenerator<GraphDocument> {
      // Startup/reconnect reconciliation only; normal dispatch is driven by change streams.
      const cursor = model.find({ 'run.status': 'running', 'run.paused': false, deletedAt: { $exists: false } })
        .sort({ updatedAt: 1, _id: 1 }).session(session).lean<Record<string, unknown>[]>().cursor()
      try { for await (const raw of cursor) yield storeReadDocument(raw) }
      finally { await cursor.close() }
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readLeaseDelay(mapId: string, workId: string): Promise<number> {
      const [row] = await model.aggregate<{ delay: number }>([
        { $match: { _id: mapId } },
        { $project: { delay: { $max: [0, { $subtract: [{ $ifNull: [`$leases.${workId}.expiresAt`, '$$NOW'] }, '$$NOW'] }] } } },
      ]).session(session)
      return row ? row.delay : 0
    },

    // 用途：分发当前模块命令到对应处理路径。
    async *readDispatch(): AsyncGenerator<GraphDocument & { dispatchVersion: number }> {
      const cursor = model.find({ 'dispatch.pending': true }).session(session).lean<Record<string, unknown>[]>().cursor()
      try {
        for await (const raw of cursor) yield { ...storeReadDocument(raw), dispatchVersion: (raw.dispatch as { version: number }).version }
      } finally { await cursor.close() }
    },

    // 用途：分发当前模块命令到对应处理路径。
    async clearDispatch(mapId: string, version: number): Promise<boolean> {
      const result = await model.updateOne({ _id: mapId, 'dispatch.version': version, 'dispatch.pending': true },
        { $set: { 'dispatch.pending': false } })
      return result.matchedCount === 1
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async claim(document: GraphDocument, work: GraphWork, hostId: string, holderId: string, leaseMs: number): Promise<GraphWorkGrant | null> {
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

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readLease(mapId: string, proof: GraphWorkProof): Promise<GraphDocument | null> {
      const raw = await model.findOne({ ...storeReadLeaseFilter(mapId, proof),
        'run.status': { $in: ['running', 'waiting', 'completed'] }, 'run.paused': false, deletedAt: { $exists: false },
      }).session(session).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async renew(mapId: string, proof: GraphWorkProof): Promise<GraphWorkGrant | null> {
      const field = `leases.${proof.workId}`
      const raw = await model.findOneAndUpdate({ ...storeReadLeaseFilter(mapId, proof),
        'run.status': { $in: ['running', 'waiting', 'completed'] }, 'run.paused': false, deletedAt: { $exists: false },
      }, [{ $set: { [`${field}.expiresAt`]: { $add: ['$$NOW', `$${field}.leaseMs`] } } }],
      { returnDocument: 'after', updatePipeline: true, session }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw).leases[proof.workId] : null
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async release(mapId: string, proof: GraphWorkProof): Promise<boolean> {
      const field = `leases.${proof.workId}`
      const result = await model.updateOne({ _id: mapId,
        [`${field}.holderId`]: proof.holderId, [`${field}.fence`]: proof.fence,
      }, { $set: { [`${field}.expiresAt`]: new Date(0) } }, { session: session ?? undefined })
      return result.matchedCount === 1
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async list(workspaceId: string): Promise<GraphMapSummary[]> {
      const rows = await model.find({ workspaceId, deletedAt: { $exists: false } })
        .sort({ updatedAt: -1, _id: 1 })
        .session(session)
        .lean<Record<string, unknown>[]>()
      return rows.map(raw => {
        const document = storeReadDocument(raw)
        return {
          id: document.id,
          workspaceId: document.workspaceId,
          revision: document.revision,
          name: document.name,
          nodeCount: document.nodes.length,
          claimCount: document.nodes.filter(node => node.data.kind === 'claim').length,
          updatedAt: document.updatedAt,
        }
      })
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async commit(
      document: GraphDocument,
      expectedRevision: number,
      receipt: GraphReceipt,
      grant?: GraphWorkGrant,
    ): Promise<boolean> {
      storeValidateDocument(document, receipt)
      if (receipt.method === 'run.pause' && !session?.inTransaction()) throw new Error(RuntimeMessage.RUN_PAUSE_MUST_REVOKE_LEASES_INSIDE_ITS_AUTHORIZATION_TRANSACTION)
      const expiredLeases = receipt.method === 'run.pause'
        ? Object.fromEntries(Object.entries(document.leases).filter(([, lease]) => lease.runId === document.run!.id)
          .map(([id]) => [`leases.${id}.expiresAt`, new Date(0)])) : {}
      // ponytail: one Map document keeps the first implementation atomic; split collections near 8 MiB.
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
