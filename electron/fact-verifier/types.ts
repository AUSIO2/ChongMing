// ==========================================
// 事实核查模块 — 专有类型
// ==========================================

import type { Confidence, Priority } from '../shared/types'

// 从 shared 重导出（方便模块内部 import）
export type {
  Confidence, Priority, ExecutionMode,
  AgentRuntimeConfig, MapSubAgentParams, GraphConfig,
  ContextField, NewsContext, VisibleContext, PromptConfig,
} from '../shared/types'

// ==========================================
// 核查专有类型
// ==========================================

/** SubAgent 核查意见 */
export interface GraphOpinion {
  agentName: string
  /** 与 routeInstructions 槽位对应，同名多槽时区分父节点 */
  instanceId: string
  priority: Priority
  score: Confidence
  reason: string
  rawResponse: string
}

/** 核查结果（写回 claim 子文档） */
export interface PersistVerifyResult {
  score: Confidence
  reason: string
  opinions: GraphOpinion[]
  rawMergeResponse: string
  verifiedAt: Date
}

