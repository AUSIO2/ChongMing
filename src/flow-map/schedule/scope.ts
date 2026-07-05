import type { DisplayClaim } from '../../../electron/api/types'
import {
  MAP_DEFAULT_NEWS_ID,
  mapIdClaimBelongsToNews,
  mapIdReadClaimNewsScope,
} from '../ids'
import type { MapSnapshot } from '../types'

export function scheduleReadScopeClaims(claims: DisplayClaim[], scope: string): DisplayClaim[] {
  return claims.filter(c =>
    mapIdClaimBelongsToNews(c.claimId, scope)
    || mapIdReadClaimNewsScope(c.claimId) === scope,
  )
}

export function scheduleScopeHasPersistedClaims(snapshot: MapSnapshot, scope: string): boolean {
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

export function scheduleScopeNeedsSplit(
  snapshot: MapSnapshot,
  scope: string,
  claims: DisplayClaim[],
): boolean {
  const news = snapshot.nodes.find(
    n => n.id === scope && n.kind === 'news' && n.params.content.trim(),
  )
  if (!news) return false
  if (scheduleScopeHasPersistedClaims(snapshot, scope)) return false
  if (scheduleReadScopeClaims(claims, scope).length > 0) return false
  return true
}

export function scheduleReadClaimScope(claimId: string): string | undefined {
  return mapIdReadClaimNewsScope(claimId)
}
