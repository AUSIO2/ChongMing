import { MAP_DEFAULT_NEWS_ID } from '../ids'
import {
  docDeleteNodes,
  docUpdateSubAgent,
  type GraphDocSlice,
} from '../graph-mutators'
import type { MapNewsNode, MapNodeKind } from '../types'
import { mapIdCreateRoute } from '../ids'
import { projCanPruneRoutes, type ProjUpdateContext } from './gate-policy'
import type { MapSubAgentParams } from '../types'

export type { ProjUpdateContext } from './gate-policy'

export function projDeleteSubtree(
  doc: GraphDocSlice,
  anchorId: string,
  kinds: MapNodeKind[],
): void {
  const kindSet = new Set(kinds)
  const remove = new Set<string>()
  const collect = (parentId: string) => {
    for (const n of doc.nodes) {
      if (
        n.parentId === parentId
        && kindSet.has(n.kind)
        && !remove.has(n.id)
      ) {
        remove.add(n.id)
        collect(n.id)
      }
    }
  }
  collect(anchorId)
  if (remove.size > 0) docDeleteNodes(doc, remove)
}

export function projResetDefaultNews(doc: GraphDocSlice): void {
  const newsNode = doc.nodes.find(
    (n): n is MapNewsNode => n.id === MAP_DEFAULT_NEWS_ID && n.kind === 'news',
  )
  doc.nodes = newsNode ? [newsNode] : []
  doc.edges = []
}

export function projUpdateRouteSlots(
  doc: GraphDocSlice,
  parentId: string,
  routes: MapSubAgentParams[],
  ctx: ProjUpdateContext,
): void {
  if (projCanPruneRoutes(ctx)) {
    const routeNodeIds = new Set(routes.map(r => mapIdCreateRoute(r, parentId)))
    const staleIds = new Set(
      doc.nodes
        .filter(n => n.kind === 'subAgent' && n.parentId === parentId && !routeNodeIds.has(n.id))
        .map(n => n.id),
    )
    for (const n of doc.nodes) {
      if (n.parentId && staleIds.has(n.parentId)) staleIds.add(n.id)
    }
    docDeleteNodes(doc, staleIds)
  }
  for (const route of routes) {
    docUpdateSubAgent(doc, parentId, route)
  }
}
