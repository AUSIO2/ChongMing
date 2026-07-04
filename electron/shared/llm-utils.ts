import { createReactAgent } from '@langchain/langgraph/prebuilt'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
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

/** 解析并校验 route 节点返回的路由指令 */
export function parseRouteInstructions(
  raw: string,
  availableAgents: AgentRuntimeConfig[],
): MapSubAgentParams[] {
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

/** 有 tools 时走 ReAct，否则直接 invoke */
export async function invokeWithOptionalTools(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  prompt: string,
): Promise<string> {
  if (tools.length > 0) {
    const agent = createReactAgent({ llm: model, tools })
    const result = await agent.invoke({
      messages: [{ role: 'user', content: prompt }],
    })
    return messageContentToString(result.messages.at(-1)?.content)
  }

  const response = await model.invoke(prompt)
  return messageContentToString(response.content)
}
