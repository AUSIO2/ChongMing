import { MAP_TRANSITION_COLUMN } from '../columns'
import { docCollectSubtree } from '../graph-doc'
import { mapIdCreateNews, mapIdReadChain } from '../ids'
import { layoutReadSnapshot } from '../layout'
import type { MapTimeline, StateIndex, TransitionKey } from '../timeline'
import { timelineProjectLines, type TimelineLine } from '../timeline-project'
import { scheduleReadPending } from './registry'
import {
  scheduleReadScopeClaims,
  scheduleScopeNeedsSplit,
} from './scope'
import type { ScheduleTransitionKey, TimelineScheduleContext, TimelineWorkItem } from './types'

export function scheduleReadLines(ctx: TimelineScheduleContext): TimelineLine[] {
  return timelineProjectLines(ctx.snapshot)
    .slice()
    .sort((a, b) => a.layoutY - b.layoutY)
}

export function scheduleFindLine(
  ctx: TimelineScheduleContext,
  nodeId: string,
): TimelineLine | null {
  for (const line of scheduleReadLines(ctx)) {
    if (line.rootId === nodeId) return line
    if (docCollectSubtree(ctx.snapshot, line.rootId).has(nodeId)) return line
  }
  return null
}

export function scheduleReadLineNews(
  ctx: TimelineScheduleContext,
  line: TimelineLine,
): string | null {
  for (const id of docCollectSubtree(ctx.snapshot, line.rootId)) {
    const node = ctx.snapshot.nodes.find(n => n.id === id)
    if (node?.kind === 'news') return node.id
  }
  return null
}

function scheduleLineNeedsParse(ctx: TimelineScheduleContext, line: TimelineLine): boolean {
  const root = ctx.snapshot.nodes.find(n => n.id === line.rootId)
  if (root?.kind !== 'source') return false
  const chainId = mapIdReadChain(root.id)
  if (!chainId) return false
  const newsId = mapIdCreateNews(chainId)
  const news = ctx.snapshot.nodes.find(n => n.id === newsId && n.kind === 'news')
  return !news || !news.params.content.trim()
}

export function scheduleReadLinePending(
  ctx: TimelineScheduleContext,
  line: TimelineLine,
  endX: StateIndex,
): StateIndex | null {
  if (scheduleLineNeedsParse(ctx, line)) return 0

  const newsId = scheduleReadLineNews(ctx, line)
  if (!newsId) return null

  const news = ctx.snapshot.nodes.find(n => n.id === newsId)
  if (!news?.params.content.trim()) return 0

  if (scheduleScopeNeedsSplit(ctx.snapshot, newsId, ctx.claims)) {
    return endX <= 1 ? null : 1
  }

  const scoped = scheduleReadScopeClaims(ctx.claims, newsId)
  if (scoped.some(c => !c.verifyResult)) {
    return endX <= 2 ? null : 2
  }

  return null
}

export function scheduleDeriveStateIndex(
  ctx: TimelineScheduleContext,
  timeline: MapTimeline,
): StateIndex {
  for (const line of scheduleReadLines(ctx)) {
    if (scheduleLineNeedsParse(ctx, line)) return 0
  }

  const anyNews = ctx.snapshot.nodes.some(
    n => n.kind === 'news' && n.params.content.trim(),
  )
  if (!anyNews) return 0

  for (const line of scheduleReadLines(ctx)) {
    const pending = scheduleReadLinePending(ctx, line, timeline.endX)
    if (pending !== null) return pending
  }
  return timeline.endX
}

export function scheduleReadActiveLine(
  ctx: TimelineScheduleContext,
  timeline: MapTimeline,
): TimelineLine | null {
  for (const line of scheduleReadLines(ctx)) {
    if (scheduleLineNeedsParse(ctx, line)) return line
  }
  for (const line of scheduleReadLines(ctx)) {
    if (scheduleReadLinePending(ctx, line, timeline.endX) !== null) return line
  }
  return null
}

function scheduleReadWorkRank(
  ctx: TimelineScheduleContext,
  item: TimelineWorkItem,
  key: ScheduleTransitionKey,
): [number, number, number, string] {
  const line = scheduleFindLine(ctx, item.parentNodeId)
  const layout = layoutReadSnapshot(ctx.snapshot)
  const ln = layout.nodes.find(n => n.node.id === item.parentNodeId)
  const transCol = MAP_TRANSITION_COLUMN[key] ?? 0
  return [line?.layoutY ?? 0, transCol, ln?.y ?? 0, item.parentNodeId]
}

function scheduleCompareWorkRank(
  ctx: TimelineScheduleContext,
  a: TimelineWorkItem,
  b: TimelineWorkItem,
  key: ScheduleTransitionKey,
): number {
  const ra = scheduleReadWorkRank(ctx, a, key)
  const rb = scheduleReadWorkRank(ctx, b, key)
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] < rb[i]) return -1
    if (ra[i] > rb[i]) return 1
  }
  return 0
}

export function schedulePickWork(
  ctx: TimelineScheduleContext,
  key: ScheduleTransitionKey,
  items: TimelineWorkItem[],
  timeline: MapTimeline,
  selectedNewsId?: string | null,
): TimelineWorkItem | null {
  if (items.length === 0) return null

  const activeLine = scheduleReadActiveLine(ctx, timeline)
  let pool = items
  if (activeLine) {
    pool = pool.filter(w => {
      const anchor = w.scopeNodeId ?? w.parentNodeId
      const line = scheduleFindLine(ctx, anchor)
      return line?.rootId === activeLine.rootId
    })
  }
  if (pool.length === 0) return null

  if (selectedNewsId) {
    const hit = pool.find(w => w.scopeNodeId === selectedNewsId)
    if (hit) return hit
  }
  if (timeline.activeScope) {
    const hit = pool.find(w => w.scopeNodeId === timeline.activeScope)
    if (hit) return hit
  }

  return pool.slice().sort((a, b) => scheduleCompareWorkRank(ctx, a, b, key))[0] ?? null
}

export function schedulePickWorks(
  ctx: TimelineScheduleContext,
  key: ScheduleTransitionKey,
  items: TimelineWorkItem[],
  timeline: MapTimeline,
  limit: number,
  selectedNewsId?: string | null,
): TimelineWorkItem[] {
  if (items.length === 0 || limit < 1) return []
  if (limit === 1) {
    const one = schedulePickWork(ctx, key, items, timeline, selectedNewsId)
    return one ? [one] : []
  }

  const pool = items.slice()
  if (selectedNewsId) {
    const hit = pool.find(w => w.scopeNodeId === selectedNewsId)
    if (hit) {
      const seen = new Set([hit.parentNodeId])
      const rest = pool
        .filter(w => !seen.has(w.parentNodeId))
        .sort((a, b) => scheduleCompareWorkRank(ctx, a, b, key))
        .filter((w) => {
          if (seen.has(w.parentNodeId)) return false
          seen.add(w.parentNodeId)
          return true
        })
        .slice(0, limit - 1)
      return [hit, ...rest]
    }
  }

  const seen = new Set<string>()
  const ranked = pool
    .slice()
    .sort((a, b) => scheduleCompareWorkRank(ctx, a, b, key))
    .filter((w) => {
      if (seen.has(w.parentNodeId)) return false
      seen.add(w.parentNodeId)
      return true
    })

  return ranked.slice(0, limit)
}

export function scheduleReadTransitionKey(derived: StateIndex): TransitionKey | null {
  if (derived >= 3) return null
  return `${derived}-${derived + 1}` as TransitionKey
}

export function scheduleLinePendingEmpty(
  ctx: TimelineScheduleContext,
  timeline: MapTimeline,
  key: ScheduleTransitionKey,
): boolean {
  const stage = key === '0-1' ? 0 : key === '1-2' ? 1 : 2
  for (const line of scheduleReadLines(ctx)) {
    const pending = scheduleReadLinePending(ctx, line, timeline.endX)
    if (pending === stage) return false
    if (key === '0-1' && scheduleLineNeedsParse(ctx, line)) return false
  }
  return scheduleReadPending(ctx, key).length === 0
}
