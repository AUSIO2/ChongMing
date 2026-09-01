import type { Confidence } from '../shared/types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readJsonText(raw: string): string {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const objectStart = trimmed.indexOf('{')
  const arrayStart = trimmed.indexOf('[')
  const start = objectStart < 0
    ? arrayStart
    : arrayStart < 0 ? objectStart : Math.min(objectStart, arrayStart)
  if (start < 0) return trimmed
  const closer = trimmed[start] === '[' ? ']' : '}'
  const end = trimmed.lastIndexOf(closer)
  return end > start ? trimmed.slice(start, end + 1) : trimmed.slice(start)
}

export function readJson(raw: string): unknown {
  try {
    return JSON.parse(readJsonText(raw)) as unknown
  } catch {
    return null
  }
}

export function readRouteOutput(
  raw: string,
  agentNames: Set<string>,
): Array<{ agentName: string; priority: 'high' | 'medium' | 'low'; hint?: string }> {
  const parsed = readJson(raw)
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap(item => {
    if (!isRecord(item)) return []
    const agentName = item.agentName
    const priority = item.priority
    if (
      typeof agentName !== 'string'
      || !agentNames.has(agentName)
      || (priority !== 'high' && priority !== 'medium' && priority !== 'low')
    ) return []
    return [{
      agentName,
      priority,
      hint: typeof item.hint === 'string' ? item.hint : undefined,
    }]
  })
}

export function readClaimsOutput(raw: string): Array<{
  content: string
  category?: string
}> {
  const parsed = readJson(raw)
  const rows = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.claims) ? parsed.claims : []
  return rows.flatMap(item => isRecord(item) && typeof item.content === 'string'
    ? [{
        content: item.content,
        category: typeof item.category === 'string' ? item.category : undefined,
      }]
    : [])
}

export function readVerifyOutput(raw: string): {
  score: Confidence
  reason: string
} {
  const parsed = readJson(raw)
  if (!isRecord(parsed)) return { score: 0.5, reason: '' }
  const score = parsed.score === 1 || parsed.score === 0.5 || parsed.score === 0
    ? parsed.score
    : 0.5
  return {
    score,
    reason: typeof parsed.reason === 'string' ? parsed.reason : '',
  }
}

export function readMergeFlags(raw: string): Map<number, boolean> {
  const parsed = readJson(raw)
  const flags = new Map<number, boolean>()
  if (!Array.isArray(parsed)) return flags
  parsed.forEach((item, index) => {
    if (!isRecord(item)) return
    const draftIndex = typeof item.draftIndex === 'number'
      ? item.draftIndex
      : index
    flags.set(draftIndex, item.shouldSave !== false)
  })
  return flags
}
