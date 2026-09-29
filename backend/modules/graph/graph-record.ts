// 定义图的持久化文档和幂等收据，并为业务输入生成稳定摘要。
import { createHash } from 'node:crypto'
import { RuntimeMessage } from '../../../contracts/messages'
import type { GraphBranchSnapshot, GraphEdge, GraphNode, GraphRun, GraphWorkGrant } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'

export interface GraphReceipt {
  requestId: string
  method: string
  inputHash: string
  createdNodeIds: string[]
  createdEdgeIds: string[]
  branch?: GraphBranchSnapshot
  createdAt: string
}

export interface GraphBranchOwnershipRecord {
  leaseId: string
  kind: 'editor' | 'run'
  rootIds: string[]
  ownerUserId: string
  holderId: string
  fence: number
  expiresAt: string | null
  leaseMs: number | null
  runId?: string
}

export interface GraphRunControlRecord {
  leaseId: string
  kind: 'control'
  runId: string
  ownerUserId: string
  holderId: string
  fence: number
  expiresAt: string
  leaseMs: number
}

export type GraphOwnershipRecord = GraphBranchOwnershipRecord | GraphRunControlRecord

export interface GraphOwnershipReceipt {
  actorUserId: string
  requestId: string
  method: 'branch.claim' | 'branch.renew' | 'branch.release' | 'run.control.claim' | 'run.control.renew' | 'run.control.release'
  inputHash: string
  leaseId: string
  result: unknown
  createdAt: string
}

export interface GraphDocument {
  id: string
  workspaceId: string
  revision: number
  dataFormat?: number
  migration?: {
    kind: string
    migratedAt: string
    legacyReportIds: Record<string, string>
    legacyProducers?: Record<string, unknown>
  }
  name: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  retiredNodeIds?: string[]
  retiredEdgeIds?: string[]
  ownershipRevision?: number
  branchOwnerships?: Record<string, GraphOwnershipRecord>
  ownershipReceipts?: GraphOwnershipReceipt[]
  runs: GraphRun[]
  runHistory: GraphRun[]
  leases: Record<string, GraphWorkGrant>
  receipts: GraphReceipt[]
  createdAt: string
  updatedAt: string
  deletedAt?: string
}

export const GRAPH_COLLECTION = 'graphv3'

function storeIsObject(/* 从持久化层读取、需要按记录字段检查的未知值。 */ value: unknown): value is Record<string, unknown> {
  // 持久化协议中的记录必须是普通 JSON/BSON 对象，数组和 null 不属于记录。
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function storeRejectLegacy(/* 需要区分节点和运行迁移错误的协议错误码。 */ code: 'NODE_SCHEMA_UNSUPPORTED' | 'RUN_SCHEMA_UNSUPPORTED'): never {
  // 旧节点与旧 Run 只能由停机迁移命令改写，读取路径绝不猜测其新类型或执行阶段。
  throw new GraphError(409, code, RuntimeMessage.STOP_HOSTS_AND_RUN_THE_EXPLICIT_DATA_MIGRATE_NODE_RUNS_COMMAND)
}

/** Refuse pre-077 node/run/work records instead of silently interpreting them as generic data. */
export function storeAssertCurrentGraphSchema(/* Mongo BSON 或 SQLite JSON 解码出的完整图记录。 */ value: unknown): void {
  // 浅检查所有决定数据含义和执行授权的字段；更深的业务合同由图服务和冻结定义验证。
  if (!storeIsObject(value) || !Array.isArray(value.nodes)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  for (const node of value.nodes) {
    if (!storeIsObject(node) || 'data' in node || typeof node.typeId !== 'string' || !node.typeId
      || !Number.isSafeInteger(node.typeVersion) || Number(node.typeVersion) < 1
      || !storeIsObject(node.payload)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
    if (node.payloadReferences !== undefined && (!Array.isArray(node.payloadReferences) || node.payloadReferences.some(reference =>
      !storeIsObject(reference) || typeof reference.path !== 'string' || typeof reference.targetId !== 'string'))) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  }
  if (!Array.isArray(value.edges) || value.edges.some(edge => !storeIsObject(edge) || !['successor', 'reference'].includes(String(edge.kind)))) {
    storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  }
  if (value.retiredNodeIds !== undefined && (!Array.isArray(value.retiredNodeIds)
    || value.retiredNodeIds.some(id => typeof id !== 'string') || new Set(value.retiredNodeIds).size !== value.retiredNodeIds.length)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')
  if (value.retiredEdgeIds !== undefined && (!Array.isArray(value.retiredEdgeIds)
    || value.retiredEdgeIds.some(id => typeof id !== 'string') || new Set(value.retiredEdgeIds).size !== value.retiredEdgeIds.length)) storeRejectLegacy('NODE_SCHEMA_UNSUPPORTED')

  if ('run' in value || !Array.isArray(value.runs)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  const runs = [...value.runs, ...(Array.isArray(value.runHistory) ? value.runHistory : [])]
  for (const run of runs) {
    if (!storeIsObject(run) || 'operation' in run || 'configuration' in run || !storeIsObject(run.plan)
      || !storeIsObject(run.definitions) || !Array.isArray(run.agents) || !Array.isArray(run.steps) || !Array.isArray(run.operations)) {
      storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    }
    if ((run.status === 'running' || run.status === 'waiting') && (!storeIsObject(run.branchState)
      || !storeIsObject(run.branchState.scope) || !Array.isArray(run.branchState.scope.rootIds) || typeof run.branchState.version !== 'string')) {
      storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
    }
    for (const operation of run.operations) {
      if (!storeIsObject(operation) || 'kind' in operation || 'targetId' in operation || typeof operation.specHash !== 'string'
        || !operation.specHash || !storeIsObject(operation.transitionRef) || !storeIsObject(operation.executionSpec)
        || !storeIsObject(operation.group) || !Array.isArray(operation.stages) || !Array.isArray(operation.outputRefs)) {
        storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
      }
    }
  }

  if (!storeIsObject(value.leases)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  for (const lease of Object.values(value.leases)) {
    if (!storeIsObject(lease) || !['workId', 'mapId', 'runId', 'operationId', 'stageId', 'slotId', 'specHash']
      .every(key => typeof lease[key] === 'string' && lease[key] !== '')) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  }
  if (value.branchOwnerships !== undefined && !storeIsObject(value.branchOwnerships)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
  if (value.ownershipRevision !== undefined && (!Number.isSafeInteger(value.ownershipRevision) || Number(value.ownershipRevision) < 0)) storeRejectLegacy('RUN_SCHEMA_UNSUPPORTED')
}

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
