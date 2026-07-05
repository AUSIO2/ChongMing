import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { getConfig } from '@langchain/langgraph'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { Serialized } from '@langchain/core/load/serializable'
import type { MapSubAgentParams, AgentRuntimeConfig } from './types'

const JSON_CODE_BLOCK_RE = /```(?:json)?\s*([\s\S]*?)```/i

/** 将 LangChain message content 统一转为字符串 */
export function messageContentToString(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') return block
        if (block && typeof block === 'object' && 'text' in block) {
          return String((block as { text: unknown }).text)
        }
        return ''
      })
      .join('')
  }
  if (content == null) return ''
  return String(content)
}

/** 从 LLM 输出中提取 JSON（支持 markdown 代码块包裹） */
export function extractJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(JSON_CODE_BLOCK_RE)
  if (fenced?.[1]) return fenced[1].trim()

  const firstBrace = trimmed.indexOf('{')
  const firstBracket = trimmed.indexOf('[')
  const start = firstBrace === -1
    ? firstBracket
    : firstBracket === -1
      ? firstBrace
      : Math.min(firstBrace, firstBracket)
  if (start === -1) return trimmed

  const opener = trimmed[start]
  const closer = opener === '[' ? ']' : '}'
  const end = trimmed.lastIndexOf(closer)
  if (end <= start) return trimmed.slice(start)

  return trimmed.slice(start, end + 1)
}

/** 解析 LLM 返回的 JSON，失败时返回 null */
export function parseJsonFromLLM<T>(raw: string): T | null {
  try {
    return JSON.parse(extractJsonText(raw)) as T
  } catch {
    return null
  }
}

const VALID_PRIORITIES = new Set(['high', 'medium', 'low'])

/** AI route 输出（尚无 instanceId；由 withInstanceIds 补齐）。 */
export type RouteInstructionDraft = Omit<MapSubAgentParams, 'instanceId'> & {
  instanceId?: string
}

/** 解析并校验 route 节点返回的路由指令 */
export function parseRouteInstructions(
  raw: string,
  availableAgents: AgentRuntimeConfig[],
): RouteInstructionDraft[] {
  const parsed = parseJsonFromLLM<unknown>(raw)
  if (!Array.isArray(parsed)) return []

  const validNames = new Set(availableAgents.map(a => a.name))

  return parsed.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const record = item as Record<string, unknown>
    const agentName = record.agentName
    const priority = record.priority
    if (
      typeof agentName !== 'string'
      || !validNames.has(agentName)
      || typeof priority !== 'string'
      || !VALID_PRIORITIES.has(priority)
    ) {
      return []
    }
    return [{
      agentName,
      priority: priority as MapSubAgentParams['priority'],
      hint: typeof record.hint === 'string' ? record.hint : undefined,
      instanceId: typeof record.instanceId === 'string' ? record.instanceId : undefined,
    }]
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 解析 SubAgent 返回的 claim 数组（支持裸数组或 { claims: [] }） */
export function parseClaimsArray<T extends { content: string }>(raw: string): T[] {
  const parsed = parseJsonFromLLM<unknown>(raw)
  const candidates = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.claims)
      ? parsed.claims
      : []

  return candidates.filter(
    (item): item is T => isRecord(item) && typeof item.content === 'string',
  )
}

/** 解析 SubAgent / merge 返回的 JSON 对象 */
export function parseJsonObjectFromLLM<T extends Record<string, unknown>>(
  raw: string,
  fallback: T,
): T {
  const parsed = parseJsonFromLLM<unknown>(raw)
  return isRecord(parsed) ? { ...fallback, ...parsed } as T : fallback
}

/** 从 tool schema 提取参数说明（JSON Schema；Zod 等无 properties 时跳过） */
function formatToolSchemaParams(schema: unknown): string {
  if (!schema || typeof schema !== 'object') return ''
  const record = schema as {
    properties?: Record<string, { type?: unknown; description?: unknown }>
    required?: unknown
  }
  const properties = record.properties
  if (!properties || typeof properties !== 'object') return ''

  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((item): item is string => typeof item === 'string')
      : [],
  )

  return Object.entries(properties)
    .map(([name, prop]) => {
      const type = typeof prop?.type === 'string' ? prop.type : 'any'
      const req = required.has(name) ? 'required' : 'optional'
      const desc = typeof prop?.description === 'string' && prop.description
        ? ` — ${prop.description}`
        : ''
      return `  - ${name} (${type}, ${req})${desc}`
    })
    .join('\n')
}

/** 将可用 tool 列表格式化为系统提示词 */
export function formatToolsSystemPrompt(tools: StructuredToolInterface[]): string {
  const entries = tools.map((t) => {
    const header = `- ${t.name}: ${t.description}`
    const params = formatToolSchemaParams(t.schema)
    return params ? `${header}\n  参数:\n${params}` : header
  })

  return [
    '你可以使用以下工具。需要时通过 tool calling 调用；不需要时直接回答。',
    '调用工具后根据返回结果继续推理，最终给出完整答复。',
    '',
    '可用工具：',
    ...entries,
  ].join('\n')
}

const TOOL_INPUT_SUMMARY_MAX = 200

/** 将 tool 输入压缩为 Map 层可展示的摘要。 */
export function summarizeToolInput(input: unknown): string | undefined {
  let value = input
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    try {
      value = JSON.parse(trimmed) as unknown
    } catch {
      return trimmed.length > TOOL_INPUT_SUMMARY_MAX
        ? `${trimmed.slice(0, TOOL_INPUT_SUMMARY_MAX)}…`
        : trimmed
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (typeof record.query === 'string' && record.query.trim()) {
      const q = record.query.trim()
      return q.length > TOOL_INPUT_SUMMARY_MAX
        ? `${q.slice(0, TOOL_INPUT_SUMMARY_MAX)}…`
        : q
    }
  }

  try {
    const text = JSON.stringify(value)
    if (!text || text === '{}') return undefined
    return text.length > TOOL_INPUT_SUMMARY_MAX
      ? `${text.slice(0, TOOL_INPUT_SUMMARY_MAX)}…`
      : text
  } catch {
    return undefined
  }
}

export type SkillActivityPhase = 'start' | 'end'

export interface SkillActivityEvent {
  phase: SkillActivityPhase
  toolName: string
  argsSummary?: string
}

export type SkillActivityCallback = (event: SkillActivityEvent) => void

function serializedToolName(tool: Serialized): string {
  if (typeof tool.name === 'string' && tool.name) return tool.name
  const id = tool.id
  if (Array.isArray(id) && id.length > 0) {
    const last = id[id.length - 1]
    if (typeof last === 'string' && last) return last
  }
  return 'unknown'
}

function createSkillActivityHandler(onSkillActivity?: SkillActivityCallback): BaseCallbackHandler {
  let activeToolName: string | undefined

  return BaseCallbackHandler.fromMethods({
    handleToolStart(tool, input) {
      const toolName = serializedToolName(tool)
      activeToolName = toolName
      const parsed = typeof input === 'string'
        ? (() => {
          try { return JSON.parse(input) as unknown } catch { return input }
        })()
        : input
      onSkillActivity?.({
        phase: 'start',
        toolName,
        argsSummary: summarizeToolInput(parsed),
      })
    },
    handleToolEnd() {
      if (!activeToolName) return
      onSkillActivity?.({ phase: 'end', toolName: activeToolName })
      activeToolName = undefined
    },
    handleToolError() {
      if (!activeToolName) return
      onSkillActivity?.({ phase: 'end', toolName: activeToolName })
      activeToolName = undefined
    },
  })
}

export interface InvokeWithOptionalToolsOptions {
  onSkillActivity?: SkillActivityCallback
}

/** 有 tools 时走 ReAct，否则直接 invoke */
export async function invokeWithOptionalTools(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  prompt: string,
  options?: InvokeWithOptionalToolsOptions,
): Promise<string> {
  if (tools.length > 0) {
    const agent = createReactAgent({
      llm: model,
      tools,
      prompt: formatToolsSystemPrompt(tools),
    })
    const parentConfig = getConfig()
    const skillHandler = createSkillActivityHandler(options?.onSkillActivity)
    const parentCallbacks = Array.isArray(parentConfig?.callbacks)
      ? parentConfig.callbacks
      : parentConfig?.callbacks
        ? [parentConfig.callbacks]
        : []

    const result = await agent.invoke(
      { messages: [{ role: 'user', content: prompt }] },
      {
        ...parentConfig,
        callbacks: [...parentCallbacks, skillHandler],
      },
    )
    return messageContentToString(result.messages.at(-1)?.content)
  }

  const response = await model.invoke(prompt)
  return messageContentToString(response.content)
}
