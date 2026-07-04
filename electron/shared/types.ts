// ==========================================
// 共享类型 — 拆分 & 核查模块通用
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

/** 从 context 中提取 AI 可见字段后的扁平结构 */
export type VisibleContext = Record<string, string>

/** 权重枚举 — 不信任 AI 给数值 */
export type Priority = 'high' | 'medium' | 'low'

/** 置信度枚举 — 0=false, 0.5=uncertain, 1=true */
export type Confidence = 1 | 0.5 | 0

/** 执行模式 */
export type ExecutionMode = 'auto' | 'human-in-loop'

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
  /** 稳定实例 id（Map 节点 id 对齐）；缺省由 route / Adapter 补齐 */
  instanceId?: string
}
