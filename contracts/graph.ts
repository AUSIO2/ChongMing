// 定义通用数据图的节点、边、payload 和人工变更输入。
import type { DefinitionRef, JsonValue } from './data-definition'
import type { EvidenceUseRef } from './evidence-library'

export type GraphPayload = { [key: string]: JsonValue }

// 一份通用数据实例。类型规则来自不可变 typeId/typeVersion，payload 不携带业务 kind。
export interface GraphNode {
  id: string
  revision: number
  typeId: string
  typeVersion: number
  payload: GraphPayload
  // 显式引用固定库内容的理由；省略不表示删除旧引用。
  libraryClaimRefs?: EvidenceUseRef[]
  // 服务端从类型声明派生的节点引用索引；不接受客户端直接写入，也不扩大 successor 范围。
  payloadReferences?: Array<{ path: string; targetId: string }>
  createdAt: string
  updatedAt: string
  importedFrom?: { bundleId: string; nodeId: string; revision: number }
  // 仅服务端记录人工新建时的认证用户；编辑不改创建来源，缺省表示历史来源未知。
  manualOrigin?: { userId: string }
  validity?: 'current' | 'stale'
  producer?: {
    operationId: string
    transitionRef: DefinitionRef
    stageId: string
    workId: string
    agentRef: DefinitionRef
    agentName: string
  }
}

// successor 参与结构分支遍历；reference 只表达引用，不扩大结构范围。
type GraphEdgeKind = 'successor' | 'reference'

// 来源定位绑定 from 节点的精确内容版本；行号按原文硬换行计算，闭区间从 1 开始。
export interface GraphSourceAnchor {
  path: string
  sourceRevision: number
  startLine: number
  endLine: number
  quote: string
}

interface GraphEdgeInput {
  id: string
  kind: GraphEdgeKind
  from: string
  to: string
  label?: string
  sourceAnchors?: GraphSourceAnchor[]
}

export interface GraphEdge extends GraphEdgeInput {
  revision: number
  createdAt: string
  updatedAt: string
}

export interface GraphNodeInput {
  id: string
  typeId: string
  typeVersion: number
  payload: GraphPayload
  libraryClaimRefs?: EvidenceUseRef[]
}

export interface GraphChanges {
  name?: string
  nodes?: { put?: GraphNodeInput[]; remove?: string[] }
  edges?: { put?: GraphEdgeInput[]; remove?: string[] }
}
