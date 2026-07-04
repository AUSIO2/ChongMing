import type { ContextField, NewsContext } from './types'

/** 将 visibleContext 格式化为文本 */
export function formatContext(ctx: Record<string, string>): string {
  return Object.entries(ctx)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')
}

/** 从 NewsContext 中提取 visibleToAI: true 的字段 */
export function extractVisibleContext(context: NewsContext): Record<string, string> {
  const visible: Record<string, string> = {}
  for (const [key, field] of Object.entries(context)) {
    if (field?.visibleToAI) {
      visible[key] = String(field.value)
    }
  }
  return visible
}

function isContextField(value: unknown): value is { value: unknown; visibleToAI: boolean } {
  return (
    value !== null
    && typeof value === 'object'
    && 'value' in value
    && 'visibleToAI' in value
  )
}

/**
 * 将 Mongoose Map / 普通对象统一转为 NewsContext
 * 避免 doc.context 在 Map 与 Record 之间行为不一致
 */
export function toNewsContext(raw: unknown): NewsContext {
  if (!raw || typeof raw !== 'object') return {}

  const entries: Iterable<[unknown, unknown]> = raw instanceof Map
    ? raw.entries()
    : Object.entries(raw as Record<string, unknown>)

  const context: NewsContext = {}
  for (const [key, value] of entries) {
    if (isContextField(value)) {
      context[String(key)] = {
        value: value.value as ContextField['value'],
        visibleToAI: Boolean(value.visibleToAI),
      }
    }
  }
  return context
}

/** 从 Mongoose 文档读取并规范化 context */
export function readNewsContext(doc: { context?: unknown }): NewsContext {
  return toNewsContext(doc.context)
}
