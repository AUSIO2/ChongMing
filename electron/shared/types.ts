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

/** 提示词配置（对应 subagentconfig/ 下的 JSON 文件；SubAgent 可含额外 catalog 字段） */
export interface PromptConfig {
  description?: string
  content: string
  /** 启用的运行时注入块 id，顺序即拼装顺序 */
  promptVars?: string[]
  /** Split SubAgent 返回 JSON 的 category 字段 */
  claimCategory?: 'data' | 'quote' | 'causal'
  model?: string
  baseUrl?: string
}

/** Agent 类型 — local_agents / Workspace.agents 共用 */
export type AgentType = 'split' | 'verify' | 'parse' | 'coordinator'

/**
 * 持久化 Agent 文档形状（本地池与工作区私有 Agent 共用）。
 * promptPath 为逻辑唯一键。
 */
export interface AgentDoc {
  promptPath: string
  agentType: AgentType
  agentName?: string
  displayLabel: string
  description?: string
  content: string
  promptVars: string[]
  defaultPriority?: Priority
  claimCategory?: 'data' | 'quote' | 'causal'
  tools?: string[]
  model?: string
  baseUrl?: string
  updatedAt?: Date | string
}

export const WORKSPACE_DEFAULT_ID = 'workspace:default'

// ==========================================
// Agent 配置类型
// ==========================================

/** Agent 运行时配置（per-agent model/tools/并发） */
export interface AgentRuntimeConfig {
  name: string
  promptPath: string
  model?: BaseChatModel
  tools?: StructuredToolInterface[]
  maxConcurrency?: number
}

/** 拆分 / 核查图共用构建配置（mode 仅 split 使用）。 */
export interface GraphConfig {
  defaultModel: BaseChatModel
  availableAgents: AgentRuntimeConfig[]
  routePromptPath: string
  mergePromptPath: string
  maxConcurrency?: number
  mode?: ExecutionMode
}

/**
 * Map SubAgent 槽位参数 — 前后端唯一来源。
 * 图状态 routeInstructions 与 Map 节点 params 同形。
 * instanceId 由 mapIdUpdateInstance 在写路径补齐（AI route / addSubAgent）。
 */
export interface MapSubAgentParams {
  agentName: string
  priority: Priority
  hint?: string
  /** 稳定实例 id（Map 节点 id = mapIdCreateSubAgent(instanceId)） */
  instanceId: string
}

/** AI route 解析输出（尚无 instanceId；由 mapIdUpdateInstance 补齐）。 */
export type RouteInstructionDraft = Omit<MapSubAgentParams, 'instanceId'> & {
  instanceId?: string
}
