// ==========================================
// 事实拆分模块 — 类型与接口定义
// ==========================================

import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'

// ==========================================
// 基础数据类型
// ==========================================

/** 上下文字段 — 包装值和 AI 可见性 */
export interface ContextField<T = string> {
  value: T
  visibleToAI: boolean
}

/** 新闻环境上下文 — 每个字段都是 ContextField */
export interface NewsContext {
  [key: string]: ContextField | undefined
}

/** 权重枚举 — 不信任 AI 给数值 */
export type Priority = 'high' | 'medium' | 'low'

/** Strategy / SubAgent 解析出的原始条目（未分配 ID） */
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
  context: NewsContext
  claims: SplitClaim[]
  splitMeta?: SplitMeta
  createdAt: Date
  updatedAt: Date
}

/** 从 context 中提取 AI 可见字段后的扁平结构 */
export type VisibleContext = Record<string, string>

/** 提示词配置（对应 prompts/ 下的 JSON 文件） */
export interface PromptConfig {
  description: string
  content: string
}

// ==========================================
// Agent 配置类型
// ==========================================

/** SubAgent 注册配置（per-agent model/tools/并发） */
export interface SubAgentConfig {
  name: string
  promptPath: string
  model?: BaseChatModel
  tools?: StructuredToolInterface[]
  maxConcurrency?: number
}

/** MainAgent route 返回的结构化路由指令 */
export interface RouteInstruction {
  agentName: string
  priority: Priority
  hint?: string
}

/** 执行模式 */
export type ExecutionMode = 'auto' | 'human-in-loop'

/** 拆分图构建配置 */
export interface SplitGraphConfig {
  defaultModel: BaseChatModel
  availableAgents: SubAgentConfig[]
  routePromptPath: string
  mergePromptPath: string
  mode?: ExecutionMode
  maxConcurrency?: number
}
