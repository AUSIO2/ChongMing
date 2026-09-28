// 定义图的持久化文档和幂等收据，并为业务输入生成稳定摘要。
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

function storeFormatCanonical(/* 需要生成稳定序列化表示的任意业务输入。 */ value: unknown): string {
  // 递归排序对象键并保留数组顺序，生成不受对象字段插入顺序影响的摘要原文。
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(storeFormatCanonical).join(',')}]`
  const object = value as Record<string, unknown>
  return `{${Object.keys(object).sort().map(/* 规范化对象中当前按字典序处理的字段名。 */ key => /* 将排序后的键与其规范化值拼成稳定的对象成员表示。 */
    `${JSON.stringify(key)}:${storeFormatCanonical(object[key])}`,
  ).join(',')}}`
}

export function storeCreateInputHash(/* 需要绑定到收据或配置比较的业务输入。 */ value: unknown): string {
  // 对规范化输入计算 SHA-256，用于比较请求内容和执行配置是否相同。
  return createHash('sha256').update(storeFormatCanonical(value)).digest('hex')
}
