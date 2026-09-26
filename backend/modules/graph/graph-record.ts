import { createHash } from 'node:crypto'
import type { GraphEdge, GraphNode, GraphRun, GraphWorkGrant } from '../../../contracts/graph'

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

export const GRAPH_COLLECTION = 'graphv3'

// 用途：把存储转换成调用方需要的格式。
function storeFormatCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(storeFormatCanonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(key =>
    `${JSON.stringify(key)}:${storeFormatCanonical(object[key])}`,
  ).join(',')}}`
}

// 用途：创建输入摘要，供后续流程使用。
export function storeCreateInputHash(value: unknown): string {
  return createHash('sha256').update(storeFormatCanonical(value)).digest('hex')
}
