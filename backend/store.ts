import { createHash } from 'node:crypto'
import mongoose, { Schema } from 'mongoose'
import type { Connection } from 'mongoose'
import type { GraphEdge, GraphMapSummary, GraphNode } from '../contracts/graph'

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
  kind: { type: String, enum: ['mentions', 'related-to'], required: true },
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
    ): Promise<boolean> {
      // ponytail: one Map document keeps the first implementation atomic; split collections near 8 MiB.
      const result = await model.updateOne(
        { _id: document.id, revision: expectedRevision },
        {
          $set: {
            name: document.name,
            nodes: document.nodes,
            edges: document.edges,
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
  const connection = mongoose.createConnection(uri, { serverSelectionTimeoutMS: 5_000 })
  await connection.asPromise()
  return connection
}

export async function storeDeleteConnection(connection: Connection): Promise<void> {
  await connection.close()
}
