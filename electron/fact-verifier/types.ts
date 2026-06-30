// ==========================================
// 事实核查模块 — 专有类型
// ==========================================

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { Confidence, Priority, SubAgentConfig } from '../shared/types'

// 从 shared 重导出（方便模块内部 import）
export type {
  Confidence, Priority, ExecutionMode,
  SubAgentConfig, RouteInstruction,
  ContextField, NewsContext, VisibleContext, PromptConfig,
} from '../shared/types'

// ==========================================
// 核查专有类型
// ==========================================

/** SubAgent 核查意见 */
export interface SubAgentOpinion {
  agentName: string
  priority: Priority
  score: Confidence
  reason: string
  rawResponse: string
}

/** 核查结果（写回 claim 子文档） */
export interface VerifyResult {
  score: Confidence
  reason: string
  opinions: SubAgentOpinion[]
  rawMergeResponse: string
  verifiedAt: Date
}

/** 核查图构建配置 */
export interface VerifyGraphConfig {
  defaultModel: BaseChatModel
  availableAgents: SubAgentConfig[]
  routePromptPath: string
  mergePromptPath: string
  maxConcurrency?: number
}
