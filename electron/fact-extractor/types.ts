// ==========================================
// 事实拆分模块 — 专有类型
// ==========================================

import type { Priority } from '../shared/types'

// 从 shared 重导出（方便模块内部 import）
export type {
  ContextField, NewsContext, VisibleContext,
  Priority, Confidence, ExecutionMode,
  PromptConfig, AgentRuntimeConfig, MapSubAgentParams, GraphConfig,
} from '../shared/types'

// ==========================================
// 拆分专有类型
// ==========================================

/** SubAgent 解析出的原始条目（未分配 ID） */
export interface GraphClaim {
  content: string
  category?: string
  sourceAgent?: string
  /** 是否保留待落库；默认 true；仅 merge 可改为 false */
  shouldSave?: boolean
}

/** 拆分出的单条可核查事实（嵌入子文档） */
export interface PersistClaim {
  claimId: string
  content: string
  category?: string
  sourceAgent: string
}

/** 单个 SubAgent 的拆分记录（带权重） */
export interface GraphSplitRecord {
  agentName: string
  priority: Priority
  instanceId: string
  claims: GraphClaim[]
  rawResponse: string
}

/** 拆分过程元数据 */
export interface PersistSplitMeta {
  model: string
  routeInstructions?: import('../shared/types').MapSubAgentParams[]
  subAgentResults: GraphSplitRecord[]
  rawMergeResponse: string
  splitAt: Date
}

/** 顶层文档 — 一条新闻 + 拆分结果 */
export interface PersistNews {
  _id: string
  content: string
  context: import('../shared/types').NewsContext
  claims: PersistClaim[]
  splitMeta?: PersistSplitMeta
  confidence?: number
  confidenceUpdatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

