import { createReactAgent } from '@langchain/langgraph/prebuilt'
import { BaseCallbackHandler } from '@langchain/core/callbacks/base'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import type { Serialized } from '@langchain/core/load/serializable'

/** 将 LangChain message content 统一转为字符串 */
export function llmReadMessage(content: unknown): string {
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
export function llmFormatTools(tools: StructuredToolInterface[]): string {
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
export function llmReadToolInput(input: unknown): string | undefined {
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

export type DeltaActivityChannel = 'thinking' | 'text'

export interface DeltaActivityEvent {
  channel: DeltaActivityChannel
  text: string
}

export type DeltaActivityCallback = (event: DeltaActivityEvent) => void

const DELTA_THROTTLE_MS = 60

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
        argsSummary: llmReadToolInput(parsed),
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

/** 从 AIMessageChunk 拆 thinking / text。 */
function llmReadDelta(chunk: unknown): { thinking: string; text: string } {
  if (!chunk || typeof chunk !== 'object') return { thinking: '', text: '' }
  const record = chunk as {
    content?: unknown
    additional_kwargs?: { reasoning_content?: unknown }
  }
  const text = llmReadMessage(record.content)
  const raw = record.additional_kwargs?.reasoning_content
  const thinking = typeof raw === 'string'
    ? raw
    : raw == null
      ? ''
      : String(raw)
  return { thinking, text }
}

function llmCreateDeltaThrottle(onDelta?: DeltaActivityCallback): {
  push: (event: DeltaActivityEvent) => void
  flush: () => void
} {
  if (!onDelta) return { push: () => {}, flush: () => {} }

  let thinkingBuf = ''
  let textBuf = ''
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    if (thinkingBuf) {
      const text = thinkingBuf
      thinkingBuf = ''
      onDelta({ channel: 'thinking', text })
    }
    if (textBuf) {
      const text = textBuf
      textBuf = ''
      onDelta({ channel: 'text', text })
    }
  }

  return {
    push(event) {
      if (!event.text) return
      if (event.channel === 'thinking') thinkingBuf += event.text
      else textBuf += event.text
      if (timer !== undefined) return
      timer = setTimeout(flush, DELTA_THROTTLE_MS)
    },
    flush,
  }
}

function llmPushDelta(
  throttle: { push: (event: DeltaActivityEvent) => void },
  chunk: unknown,
): void {
  const { thinking, text } = llmReadDelta(chunk)
  if (thinking) throttle.push({ channel: 'thinking', text: thinking })
  if (text) throttle.push({ channel: 'text', text })
}

export interface InvokeWithOptionalToolsOptions {
  signal?: AbortSignal
  onSkillActivity?: SkillActivityCallback
  onDeltaActivity?: DeltaActivityCallback
}

function llmReadChainMessages(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined
  const record = output as Record<string, unknown>
  if (Array.isArray(record.messages) && record.messages.length > 0) {
    const last = record.messages[record.messages.length - 1] as { content?: unknown }
    const text = llmReadMessage(last?.content)
    if (text) return text
  }
  if ('content' in record) {
    const text = llmReadMessage(record.content)
    if (text) return text
  }
  return undefined
}

/** 有 tools 时走 ReAct streamEvents，否则 model.stream；支持思考/正文增量回调 */
export async function llmRunInvoke(
  model: BaseChatModel,
  tools: StructuredToolInterface[],
  prompt: string,
  options?: InvokeWithOptionalToolsOptions,
): Promise<string> {
  options?.signal?.throwIfAborted()
  const throttle = llmCreateDeltaThrottle(options?.onDeltaActivity)

  if (tools.length > 0) {
    const agent = createReactAgent({
      llm: model,
      tools,
      prompt: llmFormatTools(tools),
    })
    const skillHandler = createSkillActivityHandler(options?.onSkillActivity)

    let result = ''
    const stream = agent.streamEvents(
      { messages: [{ role: 'user', content: prompt }] },
      {
        version: 'v2',
        signal: options?.signal,
        callbacks: [skillHandler],
      },
    )

    for await (const event of stream) {
      if (event.event === 'on_chat_model_stream') {
        llmPushDelta(throttle, event.data?.chunk)
        continue
      }
      if (event.event === 'on_chat_model_end') {
        const fromEnd = llmReadChainMessages(event.data?.output)
        if (fromEnd) result = fromEnd
        continue
      }
      if (event.event === 'on_chain_end') {
        const fromMessages = llmReadChainMessages(event.data?.output)
        if (fromMessages) result = fromMessages
      }
    }

    throttle.flush()
    return result
  }

  let result = ''
  const stream = await model.stream(prompt, { signal: options?.signal })
  for await (const chunk of stream) {
    llmPushDelta(throttle, chunk)
    const { text } = llmReadDelta(chunk)
    if (text) result += text
  }
  throttle.flush()
  return result
}
