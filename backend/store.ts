import { createHash } from 'node:crypto'
import mongoose, { Schema } from 'mongoose'
import type { Connection } from 'mongoose'
import type { GraphEdge, GraphMapSummary, GraphNode, GraphRun, GraphWork, GraphWorkGrant, GraphWorkProof } from '../contracts/graph'

export interface GraphReceipt {
  requestId: string
  method: string
  inputHash: string
  createdNodeIds: string[]
  createdEdgeIds: string[]
  createdAt: string
}

export interface GraphDocument {
  id: string
  workspaceId: string
  revision: number
  name: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  run: GraphRun | null
  runHistory: GraphRun[]
  leases: Record<string, GraphWorkGrant>
  receipts: GraphReceipt[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

const nodeSchema = new Schema({
  id: { type: String, required: true },
  revision: { type: Number, required: true },
  data: { type: Schema.Types.Mixed, required: true },
  createdAt: { type: Date, required: true },
  updatedAt: { type: Date, required: true },
}, { _id: false })

const edgeSchema = new Schema({
  id: { type: String, required: true },
  revision: { type: Number, required: true },
  kind: { type: String, enum: ['mentions', 'verifies', 'related-to'], required: true },
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
})

function storeReadIso(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new Error('Stored graph contains an invalid timestamp')
  }
  return new Date(value).toISOString()
}

function storeReadDocument(raw: Record<string, unknown>): GraphDocument {
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

function storeFormatCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(storeFormatCanonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key =>
    `${JSON.stringify(key)}:${storeFormatCanonical(object[key])}`,
  ).join(',')}}`
}

export function storeCreateInputHash(value: unknown): string {
  return createHash('sha256').update(storeFormatCanonical(value)).digest('hex')
}

export function storeCreateGraphStore(connection: Connection) {
  const model = connection.model('GraphV3', graphSchema)
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
    async create(document: GraphDocument): Promise<boolean> {
      try {
        await model.create({
          ...document,
          _id: document.id,
          createdAt: new Date(document.createdAt),
          updatedAt: new Date(document.updatedAt),
        })
        return true
      } catch (error) {
        if (error instanceof mongoose.Error.ValidationError) throw error
        if (typeof error === 'object' && error && 'code' in error && error.code === 11_000) {
          return false
        }
        throw error
      }
    },

    async read(mapId: string): Promise<GraphDocument | null> {
      const raw = await model.findById(mapId).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },

    async *discover(mapId?: string): AsyncGenerator<GraphDocument> {
      // ponytail: scan runnable Maps; add a ready-work index if graph volume requires it.
      const cursor = model.find({ ...(mapId ? { _id: mapId } : {}), 'run.status': 'running', deletedAt: { $exists: false } })
        .sort({ updatedAt: 1, _id: 1 }).lean<Record<string, unknown>[]>().cursor()
      try { for await (const raw of cursor) yield storeReadDocument(raw) }
      finally { await cursor.close() }
    },

    async claim(document: GraphDocument, work: GraphWork, hostId: string, holderId: string, leaseMs: number): Promise<GraphWorkGrant | null> {
      const field = `leases.${work.workId}`
      const raw = await model.findOneAndUpdate({
        _id: document.id, revision: document.revision, 'run.id': work.runId, 'run.status': 'running',
        $expr: { $lte: [{ $ifNull: [`$${field}.expiresAt`, new Date(0)] }, '$$NOW'] },
      }, [{ $set: { [field]: { $mergeObjects: [
        { $literal: { ...work, hostId, holderId, leaseMs } },
        { fence: { $add: [{ $ifNull: [`$${field}.fence`, 0] }, 1] }, expiresAt: { $add: ['$$NOW', leaseMs] } },
      ] } } }], { returnDocument: 'after', updatePipeline: true }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw).leases[work.workId] : null
    },

    async readLease(mapId: string, proof: GraphWorkProof): Promise<GraphDocument | null> {
      const raw = await model.findOne({ ...storeReadLeaseFilter(mapId, proof),
        'run.status': { $in: ['running', 'waiting', 'completed'] }, deletedAt: { $exists: false },
      }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw) : null
    },

    async renew(mapId: string, proof: GraphWorkProof): Promise<GraphWorkGrant | null> {
      const field = `leases.${proof.workId}`
      const raw = await model.findOneAndUpdate({ ...storeReadLeaseFilter(mapId, proof),
        'run.status': { $in: ['running', 'waiting', 'completed'] }, deletedAt: { $exists: false },
      }, [{ $set: { [`${field}.expiresAt`]: { $add: ['$$NOW', `$${field}.leaseMs`] } } }],
      { returnDocument: 'after', updatePipeline: true }).lean<Record<string, unknown>>()
      return raw ? storeReadDocument(raw).leases[proof.workId] : null
    },

    async release(mapId: string, proof: GraphWorkProof): Promise<boolean> {
      const field = `leases.${proof.workId}`
      const result = await model.updateOne({ _id: mapId,
        [`${field}.holderId`]: proof.holderId, [`${field}.fence`]: proof.fence,
      }, { $set: { [`${field}.expiresAt`]: new Date(0) } })
      return result.matchedCount === 1
    },

    async list(workspaceId: string): Promise<GraphMapSummary[]> {
      const rows = await model.find({ workspaceId, deletedAt: { $exists: false } })
        .sort({ updatedAt: -1, _id: 1 })
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

    async commit(
      document: GraphDocument,
      expectedRevision: number,
      receipt: GraphReceipt,
      grant?: GraphWorkGrant,
    ): Promise<boolean> {
      // ponytail: one Map document keeps the first implementation atomic; split collections near 8 MiB.
      const result = await model.updateOne(
        { _id: document.id, revision: expectedRevision,
          ...(grant ? { ...storeReadLeaseFilter(document.id, grant), 'run.id': grant.runId, 'run.status': 'running' } : {}),
        },
        {
          $set: {
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
      )
      return result.matchedCount === 1
    },
  }
}

export type GraphStore = ReturnType<typeof storeCreateGraphStore>

export async function storeCreateConnection(uri: string): Promise<Connection> {
  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5_000,
    readPreference: 'primary',
    writeConcern: { w: 'majority', wtimeoutMS: 5_000 },
  })
  await connection.asPromise()
  return connection
}

export async function storeDeleteConnection(connection: Connection): Promise<void> {
  await connection.close()
}
