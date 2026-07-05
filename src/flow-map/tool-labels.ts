import type { MapToolKind } from './types'

const HITL_ACTIVE: Record<MapToolKind, string> = {
  invoke: '调用中',
  validate: '验证中',
  save: '保存中',
}

const HITL_PENDING: Record<MapToolKind, string> = {
  invoke: '待确认',
  validate: '待验证',
  save: '待保存',
}

const SKILL_LABELS: Record<string, string> = {
  web_search: '联网搜索中',
}

const ARGS_SUMMARY_MAX = 40

export function labelFormatHitl(tool: MapToolKind, phase: 'active' | 'pending'): string {
  return phase === 'active' ? HITL_ACTIVE[tool] : HITL_PENDING[tool]
}

export function labelFormatSkill(name: string, argsSummary?: string): string {
  const base = SKILL_LABELS[name] ?? `${name} 调用中`
  if (!argsSummary?.trim()) return base
  const summary = argsSummary.length > ARGS_SUMMARY_MAX
    ? `${argsSummary.slice(0, ARGS_SUMMARY_MAX)}…`
    : argsSummary
  return `${base}：${summary}`
}

export function labelFormatSkillTitle(name: string, argsSummary?: string): string | undefined {
  if (!argsSummary?.trim()) return undefined
  const base = SKILL_LABELS[name] ?? name
  return `${base}：${argsSummary}`
}
