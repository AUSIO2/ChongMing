/**
 * Map 图低层 mutator — graph-doc 与 projection 共用，避免循环依赖。
 */
import {
  MAP_DEFAULT_NEWS_ID,
  mapIdReadDraftIndex,
  mapIdReadClaimSaveIndex,
  mapIdClaimBelongsToNews,
  mapIdCreateEdge,
  mapIdIsDraftClaim,
  mapIdCreateRoute,
} from './ids'
import type {
  MapClaimNode,
  MapEdge,
  MapNewsNode,
  MapNode,
  MapOpinionNode,
  MapSubAgentNode,
  MapSubAgentParams,
  Priority,
} from './types'

export interface GraphDocSlice {
  nodes: MapNode[]
  edges: MapEdge[]
}

export function docDeleteNodes(doc: GraphDocSlice, ids: Set<string>): void {
  if (ids.size === 0) return
  doc.nodes = doc.nodes.filter(n => !ids.has(n.id))
  doc.edges = doc.edges.filter(e => !ids.has(e.from) && !ids.has(e.to))
}

export function docReadClaims(
  doc: GraphDocSlice,
  phase: 'draft' | 'numbered',
  newsParentId?: string,
): MapClaimNode[] {
  const belongs = (id: string) =>
    newsParentId === undefined || mapIdClaimBelongsToNews(id, newsParentId)

  if (phase === 'draft') {
    return doc.nodes
      .filter((n): n is MapClaimNode =>
        n.kind === 'claim' && mapIdIsDraftClaim(n.id) && belongs(n.id))
      .sort((a, b) => (mapIdReadDraftIndex(a.id) ?? 0) - (mapIdReadDraftIndex(b.id) ?? 0))
  }
  return doc.nodes
    .filter((n): n is MapClaimNode =>
      n.kind === 'claim' && !mapIdIsDraftClaim(n.id) && belongs(n.id))
    .sort((a, b) =>
      (mapIdReadClaimSaveIndex(a.id) ?? 0) - (mapIdReadClaimSaveIndex(b.id) ?? 0))
}

export function docReadRoutes(doc: GraphDocSlice, parentId: string): MapSubAgentParams[] {
  return doc.nodes
    .filter((n): n is MapSubAgentNode => n.kind === 'subAgent' && n.parentId === parentId)
    .map(n => ({ ...n.params }))
}

export function docUpdateEdge(doc: GraphDocSlice, from: string, to: string): void {
  const id = mapIdCreateEdge(from, to)
  if (doc.edges.some(e => e.id === id)) return
  doc.edges.push({ id, from, to })
}

export function docUpdateMap(
  doc: GraphDocSlice,
  content: string,
  newsId: string = MAP_DEFAULT_NEWS_ID,
): void {
  const existing = doc.nodes.find(
    (n): n is MapNewsNode => n.id === newsId && n.kind === 'news',
  )
  if (existing) {
    existing.params = { content }
    return
  }
  if (newsId === MAP_DEFAULT_NEWS_ID) {
    doc.nodes.push({
      id: MAP_DEFAULT_NEWS_ID,
      kind: 'news',
      params: { content },
    })
  }
}

export function docUpdateSubAgent(
  doc: GraphDocSlice,
  parentId: string,
  route: MapSubAgentParams,
): string {
  const id = mapIdCreateRoute(route, parentId)
  const existing = doc.nodes.find((n): n is MapSubAgentNode => n.id === id)
  if (existing) {
    const prevParent = existing.parentId
    existing.params = route
    existing.parentId = parentId
    if (prevParent && prevParent !== parentId) {
      doc.edges = doc.edges.filter(e => !(e.to === id && e.from === prevParent))
    }
    docUpdateEdge(doc, parentId, id)
    return id
  }
  const node: MapSubAgentNode = {
    id,
    kind: 'subAgent',
    parentId,
    params: route,
  }
  doc.nodes.push(node)
  docUpdateEdge(doc, parentId, id)
  return id
}

export function docUpdateClaim(
  doc: GraphDocSlice,
  opts: {
    id: string
    parentId: string
    content: string
    category?: string
    sourceAgent?: string
    dataPhase: MapClaimNode['dataPhase']
    shouldSave?: boolean
  },
): void {
  const shouldSave = opts.shouldSave ?? true
  const existing = doc.nodes.find((n): n is MapClaimNode => n.id === opts.id)
  if (existing) {
    existing.parentId = opts.parentId
    existing.params = {
      content: opts.content,
      category: opts.category,
      sourceAgent: opts.sourceAgent,
    }
    existing.dataPhase = opts.dataPhase
    existing.shouldSave = shouldSave
    docUpdateEdge(doc, opts.parentId, opts.id)
    return
  }
  doc.nodes.push({
    id: opts.id,
    kind: 'claim',
    parentId: opts.parentId,
    params: {
      content: opts.content,
      category: opts.category,
      sourceAgent: opts.sourceAgent,
    },
    dataPhase: opts.dataPhase,
    shouldSave,
  })
  docUpdateEdge(doc, opts.parentId, opts.id)
}

export function docUpdateOpinion(
  doc: GraphDocSlice,
  opts: {
    id: string
    parentId: string
    content: string
    confidence: MapOpinionNode['params']['confidence']
    priority: Priority
    dataPhase: MapOpinionNode['dataPhase']
  },
): void {
  const existing = doc.nodes.find((n): n is MapOpinionNode => n.id === opts.id)
  if (existing) {
    existing.parentId = opts.parentId
    existing.params = {
      content: opts.content,
      confidence: opts.confidence,
      priority: opts.priority,
    }
    existing.dataPhase = opts.dataPhase
    docUpdateEdge(doc, opts.parentId, opts.id)
    return
  }
  doc.nodes.push({
    id: opts.id,
    kind: 'opinion',
    parentId: opts.parentId,
    params: {
      content: opts.content,
      confidence: opts.confidence,
      priority: opts.priority,
    },
    dataPhase: opts.dataPhase,
  })
  docUpdateEdge(doc, opts.parentId, opts.id)
}
