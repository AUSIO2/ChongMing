import type { NewsContext } from './types'
import { NEWS_ROOT_ID } from './map-ids'

/** 单链默认 scope（与 Map 图 news 根节点 id 一致） */
export const MAP_DEFAULT_SCOPE = NEWS_ROOT_ID

export interface MapChainClaims {
  claimId: string
  content: string
  category?: string | null
  sourceAgent?: string | null
  verifyResult?: unknown
}

export interface MapChainScope {
  content: string
  context: unknown
  claims: MapChainClaims[]
  splitMeta?: unknown
}

export interface MapChains {
  [scopeNodeId: string]: MapChainScope
}

export type MapDocLike = {
  chains?: unknown
  get?(key: string): unknown
}

function chainsReadRaw(doc: MapDocLike): MapChains {
  const raw = doc.chains
  if (!raw) return {}
  if (raw instanceof Map) {
    return Object.fromEntries(raw.entries()) as MapChains
  }
  return raw as MapChains
}

export function mapScopeRead(
  doc: MapDocLike,
  scopeNodeId: string,
): MapChainScope | undefined {
  return chainsReadRaw(doc)[scopeNodeId]
}

export function mapScopeRequire(
  doc: MapDocLike,
  scopeNodeId: string,
): MapChainScope {
  const scope = mapScopeRead(doc, scopeNodeId)
  if (!scope) {
    throw new Error(`Map chain scope not found: ${scopeNodeId}`)
  }
  return scope
}

export function mapScopeReadDefault(doc: MapDocLike): MapChainScope {
  return mapScopeRequire(doc, MAP_DEFAULT_SCOPE)
}

export function mapScopeReadContext(scope: MapChainScope): NewsContext {
  const ctx = scope.context
  if (!ctx || typeof ctx !== 'object') return {}
  if (ctx instanceof Map) {
    const out: NewsContext = {}
    for (const [key, field] of ctx.entries()) {
      const f = field as { value?: unknown; visibleToAI?: boolean }
      if (f && typeof f.visibleToAI === 'boolean') {
        out[key] = { value: String(f.value ?? ''), visibleToAI: f.visibleToAI }
      }
    }
    return out
  }
  return ctx as NewsContext
}
