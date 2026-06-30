// ==========================================
// 事实拆分模块 — 专有类型
// ==========================================

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Priority, SubAgentConfig, ExecutionMode } from '../shared/types'

// 从 shared 重导出（方便模块内部 import）
export type {
  ContextField, NewsContext, VisibleContext,
  Priority, Confidence, ExecutionMode,
  PromptConfig, SubAgentConfig, RouteInstruction,
} from '../shared/types'

// ==========================================
// 拆分专有类型
// ==========================================

/** SubAgent 解析出的原始条目（未分配 ID） */
export interface RawClaim {
  content: string
  category?: string
  sourceAgent?: string
}

/** 拆分出的单条可核查事实（嵌入子文档） */
export interface SplitClaim {
  claimId: string
  content: string
  category?: string
  sourceAgent: string
}

/** 单个 SubAgent 的拆分记录（带权重） */
export interface SubAgentSplitRecord {
  agentName: string
  priority: Priority
  claims: RawClaim[]
  rawResponse: string
}

/** 拆分过程元数据 */
export interface SplitMeta {
  model: string
  subAgentResults: SubAgentSplitRecord[]
  rawMergeResponse: string
  splitAt: Date
}

/** 顶层文档 — 一条新闻 + 拆分结果 */
export interface NewsDocument {
  _id: string
  content: string
  context: import('../shared/types').NewsContext
  claims: SplitClaim[]
  splitMeta?: SplitMeta
  confidence?: number
  confidenceUpdatedAt?: Date
  createdAt: Date
  updatedAt: Date
}

/** 拆分图构建配置 */
export interface SplitGraphConfig {
  defaultModel: BaseChatModel
  availableAgents: SubAgentConfig[]
  routePromptPath: string
  mergePromptPath: string
  mode?: ExecutionMode
  maxConcurrency?: number
}
