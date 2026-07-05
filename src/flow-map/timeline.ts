import type { DisplayClaim } from '../../electron/api/types'
import {
  MAP_DEFAULT_NEWS_ID,
  mapIdCreateNews,
  mapIdIsScopedNews,
  mapIdReadChain,
} from './ids'
import { docReadPendingParseSource } from './graph-doc'
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

function scopeHasPersistedClaims(snapshot: MapSnapshot, scope: string): boolean {
  if (scope === MAP_DEFAULT_NEWS_ID) {
    return snapshot.nodes.some(
      n => n.kind === 'claim' && n.dataPhase === 'persisted' && n.parentId !== undefined,
    )
  }
  const subIds = new Set(
    snapshot.nodes
      .filter(n => n.kind === 'subAgent' && n.parentId === scope)
      .map(n => n.id),
  )
  return snapshot.nodes.some(
    n => n.kind === 'claim' && n.dataPhase === 'persisted' && subIds.has(n.parentId ?? ''),
  )
}

function scopeClaimsNeedVerify(snapshot: MapSnapshot, claims: DisplayClaim[]): boolean {
  if (claims.length > 0) {
    return claims.some(c => !c.verifyResult)
  }
  return snapshot.nodes.some(
    n => n.kind === 'claim' && n.dataPhase === 'persisted',
  )
}

function scopeAtConclusion(claims: DisplayClaim[]): boolean {
  return claims.length > 0 && claims.every(c => !!c.verifyResult)
}

export function timelineDeriveStateIndex(
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  scope: string,
): StateIndex {
  if (docReadPendingParseSource({ nodes: snapshot.nodes })) return 0

  const scopedNews = snapshot.nodes.find(
    n => n.id === scope && n.kind === 'news' && n.params.content.trim(),
  )
  const anyNews = snapshot.nodes.some(
    n => n.kind === 'news' && n.params.content.trim(),
  )

  if (!anyNews) return 0

  if (!scopeHasPersistedClaims(snapshot, scope)) {
    return scopedNews || scope === MAP_DEFAULT_NEWS_ID ? 1 : 1
  }

  if (scopeAtConclusion(claims)) return 3
  if (scopeClaimsNeedVerify(snapshot, claims)) return 2
  return 2
}

export function timelineReadEffectiveIndex(
  timeline: MapTimeline,
  snapshot: MapSnapshot,
  claims: DisplayClaim[],
  scope: string,
): StateIndex {
  const derived = timelineDeriveStateIndex(snapshot, claims, scope)
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
  if (key === '0-1') {
    const pending = docReadPendingParseSource({ nodes: snapshot.nodes })
    if (pending) return [pending]
    return snapshot.nodes
      .filter(n => n.kind === 'source' && !n.parentId)
      .map(n => n.id)
  }

  if (key === '1-2') {
    const news = snapshot.nodes.find(
      n => n.id === scope && n.kind === 'news' && n.params.content.trim(),
    )
    if (news) return [news.id]
    const root = snapshot.nodes.find(
      n => n.kind === 'news' && !n.parentId && n.params.content.trim(),
    )
    return root ? [root.id] : []
  }

  if (key === '2-3') {
    const fromDb = claims.filter(c => !c.verifyResult).map(c => c.claimId)
    if (fromDb.length > 0) return fromDb
    return snapshot.nodes
      .filter(n => n.kind === 'claim' && n.dataPhase === 'persisted')
      .map(n => n.id)
  }

  return []
}

/** 源链 news 节点 id（parse 后用于默认 activeScope）。 */
export function timelineReadScopeAfterParse(sourceId: string): string | undefined {
  const chainId = mapIdReadChain(sourceId)
  return chainId ? mapIdCreateNews(chainId) : undefined
}

export function timelineReadNextStateIndex(key: TransitionKey): StateIndex {
  if (key === '0-1') return 1
  if (key === '1-2') return 2
  return 3
}
