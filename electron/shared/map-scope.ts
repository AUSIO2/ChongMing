import type { NewsContext } from './types'
import { MAP_DEFAULT_CHAIN_ID, MAP_DEFAULT_NEWS_ID } from './map-ids'

/** chains 持久化默认 scope（无冒号，避免 Mongoose Map path 歧义） */
export const MAP_DEFAULT_SCOPE = MAP_DEFAULT_CHAIN_ID

const LEGACY_NEWS_ROOT_ID = '__news_root__'

/** 图节点 id / timeline.activeScope → chains 键 */
export function mapScopeReadKey(scopeNodeId: string): string {
  if (
    scopeNodeId === MAP_DEFAULT_NEWS_ID
    || scopeNodeId === LEGACY_NEWS_ROOT_ID
    || scopeNodeId === MAP_DEFAULT_CHAIN_ID
  ) {
    return MAP_DEFAULT_CHAIN_ID
  }
  return scopeNodeId
}

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
  return chainsReadRaw(doc)[mapScopeReadKey(scopeNodeId)]
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

/** 汇总所有 scope 的 claims（用于 mapGraph 与 chains 对账）。 */
export function mapScopeReadAllClaims(doc: MapDocLike): MapChainClaims[] {
  const chains = chainsReadRaw(doc)
  return Object.values(chains).flatMap(scope => scope.claims ?? [])
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
