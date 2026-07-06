import type { DisplayClaim } from '../../electron/api/types'
import { AppError, ErrorCode } from '../../electron/shared/errors'
import {
  MAP_DEFAULT_NEWS_ID,
  mapIdIsScopedNews,
} from './ids'
import {
  scheduleDeriveStateIndex,
  schedulePickWork,
  schedulePickWorks,
  scheduleReadInterruptStale,
  scheduleReadPending,
  scheduleReadScopePatch,
  type TimelineScheduleContext,
  type TimelineWorkItem,
} from './schedule'
import type { MapNode, MapSnapshot } from './types'

export const STATE_CHAIN = ['source', 'news', 'fact', 'conclusion'] as const
export type StateKind = typeof STATE_CHAIN[number]
export type StateIndex = 0 | 1 | 2 | 3
export type TransitionKey = '0-1' | '1-2' | '2-3'

export const STATE_CHAIN_LABEL: Record<StateIndex, string> = {
  0: '源',
  1: '新闻',
  2: '事实',
  3: '结论',
}

export const STATE_TRANSITION_LABEL: Record<TransitionKey, string> = {
  '0-1': '解析',
  '1-2': '拆分',
  '2-3': '核查',
}

export interface MapTimeline {
  startX: StateIndex
  endX: StateIndex
  stateIndex?: StateIndex
  activeScope: string
}

export const TIMELINE_DEFAULT: MapTimeline = {
  startX: 0,
  endX: 3,
  activeScope: '',
}

export function timelineCreateDefault(activeScope = ''): MapTimeline {
  return { ...TIMELINE_DEFAULT, activeScope }
}

export function timelineValidate(timeline: MapTimeline): void {
  if (timeline.startX > timeline.endX) {
    throw new Error(`timeline startX ${timeline.startX} > endX ${timeline.endX}`)
  }
}

export function timelineReadScheduleContext(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
): TimelineScheduleContext {
  return { snapshot, claims }
}

export function timelineReadScope(
  snapshot: MapSnapshot,
  timeline: MapTimeline,
  selectedNewsId?: string | null,
): string {
  if (selectedNewsId && snapshot.nodes.some(n => n.id === selectedNewsId && n.kind === 'news')) {
    return selectedNewsId
  }
  if (timeline.activeScope && snapshot.nodes.some(n => n.id === timeline.activeScope)) {
    return timeline.activeScope
  }
  const scoped = snapshot.nodes.find(
    n => n.kind === 'news' && mapIdIsScopedNews(n.id) && n.params.content.trim(),
  )
  if (scoped) return scoped.id
  const root = snapshot.nodes.find(n => n.id === MAP_DEFAULT_NEWS_ID && n.kind === 'news')
  if (root) return MAP_DEFAULT_NEWS_ID
  return timeline.activeScope || MAP_DEFAULT_NEWS_ID
}

export function timelineReadRootsAt(snapshot: MapSnapshot, x: StateIndex): MapNode[] {
  if (x === 0) {
    return snapshot.nodes.filter(n => n.kind === 'source' && !n.parentId)
  }
  if (x === 1) {
    return snapshot.nodes.filter(n => n.kind === 'news' && !n.parentId)
  }
  if (x === 2) {
    return snapshot.nodes.filter(
      n => n.kind === 'claim' && n.dataPhase === 'persisted',
    )
  }
  return []
}

export function timelineReadPending(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  key: TransitionKey,
): ReturnType<typeof scheduleReadPending> {
  return scheduleReadPending(timelineReadScheduleContext(snapshot, claims), key)
}

/** 中断会话是否已完成（parent 对应阶段产物已落库），应清 session 重新调度。 */
export function timelineReadInterruptStale(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  transitionKey: TransitionKey,
  parentId: string,
): boolean {
  return scheduleReadInterruptStale(
    timelineReadScheduleContext(snapshot, claims),
    transitionKey,
    parentId,
  )
}

export function timelineReadScopePatch(
  transitionKey: TransitionKey,
  parentId: string,
): { activeScope?: string } | undefined {
  return scheduleReadScopePatch(transitionKey, parentId)
}

export function timelineDeriveStateIndex(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  timeline: MapTimeline = timelineCreateDefault(),
): StateIndex {
  return scheduleDeriveStateIndex(
    timelineReadScheduleContext(snapshot, claims),
    timeline,
  )
}

export function timelineReadEffectiveIndex(
  timeline: MapTimeline,
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  _scope?: string,
): StateIndex {
  const derived = timelineDeriveStateIndex(snapshot, claims, timeline)
  if (timeline.stateIndex === undefined) return derived
  return Math.max(timeline.stateIndex, derived) as StateIndex
}

export function timelineResolveKeys(
  timeline: MapTimeline,
  effectiveX: StateIndex,
): TransitionKey[] {
  timelineValidate(timeline)
  const from = Math.max(timeline.startX, effectiveX) as StateIndex
  const keys: TransitionKey[] = []
  for (let x = from; x < timeline.endX; x++) {
    const key = `${x}-${x + 1}` as TransitionKey
    keys.push(key)
  }
  return keys
}

export function timelineReadParents(
  snapshot: MapSnapshot,
  key: TransitionKey,
  scope: string,
  claims: DisplayClaim[],
): string[] {
  return timelineReadPending(snapshot, claims, key)
    .filter(w => !scope || !w.scopeNodeId || w.scopeNodeId === scope)
    .map(w => w.parentNodeId)
}

/** 源链 news 节点 id（parse 后用于默认 activeScope）。 */
export function timelineReadScopeAfterParse(sourceId: string): string | undefined {
  return scheduleReadScopePatch('0-1', sourceId)?.activeScope
}

export function timelineReadNextStateIndex(key: TransitionKey): StateIndex {
  if (key === '0-1') return 1
  if (key === '1-2') return 2
  return 3
}

export function timelinePickWork(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  key: TransitionKey,
  items: TimelineWorkItem[],
  timeline: MapTimeline,
  selectedNewsId?: string | null,
): TimelineWorkItem | null {
  return schedulePickWork(
    timelineReadScheduleContext(snapshot, claims),
    key,
    items,
    timeline,
    selectedNewsId,
  )
}

export function timelinePickWorks(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  key: TransitionKey,
  items: TimelineWorkItem[],
  timeline: MapTimeline,
  limit: number,
  selectedNewsId?: string | null,
): TimelineWorkItem[] {
  return schedulePickWorks(
    timelineReadScheduleContext(snapshot, claims),
    key,
    items,
    timeline,
    limit,
    selectedNewsId,
  )
}

/** runTransition 启动时解析 parentNodeId；无合法 parent 抛 MAP_SCOPE_NOT_FOUND。 */
export function timelineReadRunParent(
  snapshot: MapSnapshot,
  timeline: MapTimeline,
  transitionKey: TransitionKey,
  selectedNewsId?: string | null,
  claims: DisplayClaim[] = [],
): string {
  const work = timelinePickWork(
    snapshot,
    claims,
    transitionKey,
    timelineReadPending(snapshot, claims, transitionKey),
    timeline,
    selectedNewsId,
  )
  if (!work) {
    throw new AppError(
      ErrorCode.MAP_SCOPE_NOT_FOUND,
      `no parent for transition ${transitionKey}`,
    )
  }
  return work.parentNodeId
}

export {
  scheduleLinePendingEmpty,
  scheduleReadTransitionKey,
} from './schedule'
