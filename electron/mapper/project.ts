import {
  mapIdCreateOpinion,
  mapIdCreateNews,
  mapIdCreateParse,
  mapIdCreateRoute,
  mapIdReadChain,
} from '../shared/map-ids'
import type {
  ClaimRecord,
  MapperDocument,
  MapperNode,
  MapperSnapshot,
  OpinionRecord,
  RouteRecord,
} from './types'

function readRouteParent(
  routes: RouteRecord[],
  parentId: string,
  source: { agentName?: string; instanceId?: string },
): string {
  const route = source.instanceId
    ? routes.find(r => r.parentId === parentId && r.instanceId === source.instanceId)
    : routes.find(r => r.parentId === parentId && r.agentName === source.agentName)
  return route ? mapIdCreateRoute(route, parentId) : parentId
}

function projectOpinion(
  claim: ClaimRecord,
  opinion: OpinionRecord,
  index: number,
  routes: RouteRecord[],
  dataPhase: 'workerOut' | 'persisted',
): MapperNode {
  return {
    id: mapIdCreateOpinion(claim.id, index),
    kind: 'opinion',
    parentId: readRouteParent(routes, claim.id, opinion),
    params: {
      content: opinion.reason,
      confidence: opinion.score,
      priority: opinion.priority,
    },
    dataPhase,
  }
}

export function projectSnapshot(document: MapperDocument): MapperSnapshot {
  const draftRoutes = document.run?.draft.routes ?? []
  const draftParents = new Set(draftRoutes.map(route => route.parentId))
  const routes = [
    ...document.routes.filter(route => !draftParents.has(route.parentId)),
    ...draftRoutes,
  ]
  const draftClaims = document.run?.stage === 'split'
    ? document.run.draft.claims
    : undefined
  let claims = draftClaims
    ? [
        ...document.claims.filter(claim => claim.newsId !== document.run?.targetId),
        ...draftClaims,
      ]
    : document.claims
  if (document.run?.stage === 'verify' && document.run.draft.verify) {
    claims = claims.map(claim => claim.id === document.run?.targetId
      ? { ...claim, verify: document.run!.draft.verify }
      : claim)
  }
  const nodes: MapperNode[] = [
    ...document.sources.map(source => ({
      id: source.id,
      kind: 'source' as const,
      params: {
        uri: source.uri,
        kind: source.kind,
        label: source.label,
      },
    })),
    ...document.news.map(news => ({
      id: news.id,
      kind: 'news' as const,
      parentId: news.sourceId
        ? mapIdCreateParse(mapIdReadChain(news.sourceId) ?? '')
        : undefined,
      params: { content: news.content },
    })),
    ...routes.map(route => ({
      id: mapIdCreateRoute(route, route.parentId),
      kind: 'subAgent' as const,
      parentId: route.parentId,
      params: {
        agentName: route.agentName,
        priority: route.priority,
        hint: route.hint,
        instanceId: route.instanceId,
      },
    })),
  ]

  for (const source of document.sources) {
    const chainId = mapIdReadChain(source.id)
    if (!chainId) continue
    const hasNews = document.news.some(news => news.sourceId === source.id)
    const isRunning = document.run?.stage === 'parse'
      && document.run.targetId === source.id
    if (!hasNews && !isRunning) continue
    nodes.push({
      id: mapIdCreateParse(chainId),
      kind: 'parseAgent',
      parentId: source.id,
      params: { agentName: 'parse' },
    })
  }

  for (const claim of claims) {
    const parentId = claim.newsId
      ? readRouteParent(routes, claim.newsId, {
          agentName: claim.sourceAgent,
          instanceId: claim.sourceInstanceId,
        })
      : undefined
    nodes.push({
      id: claim.id,
      kind: 'claim',
      parentId,
      params: {
        content: claim.content,
        category: claim.category,
        sourceAgent: claim.sourceAgent,
        confidence: claim.verify?.score,
        verifyReason: claim.verify?.reason,
      },
      dataPhase: draftClaims?.some(item => item.id === claim.id)
        ? 'workerOut'
        : 'persisted',
      shouldSave: true,
    })
    claim.verify?.opinions.forEach((opinion, index) => {
      const isDraft = document.run?.stage === 'verify'
        && document.run.targetId === claim.id
        && document.run.draft.verify !== undefined
      nodes.push(projectOpinion(
        claim,
        opinion,
        index,
        routes,
        isDraft ? 'workerOut' : 'persisted',
      ))
    })
  }

  const edges = nodes.flatMap(node => node.parentId
    ? [{ id: `${node.parentId}->${node.id}`, from: node.parentId, to: node.id }]
    : [])
  const pendingAction = document.run?.step === 'confirm-route'
    || document.run?.step === 'validate'
    || document.run?.step === 'save'
    ? document.run.step
    : undefined
  const pendingTool = pendingAction === 'confirm-route'
    ? 'invoke'
    : pendingAction
  const activeNodeId = document.run?.targetId
  if (activeNodeId && pendingTool) {
    const active = nodes.find(node => node.id === activeNodeId)
    if (active) active.runtime = { pendingTool }
  }

  const stateIndex = document.sources.some(source => {
    const chainId = mapIdReadChain(source.id)
    return chainId && !document.news.some(news => news.id === mapIdCreateNews(chainId))
  })
    ? 0
    : document.news.some(news => !document.claims.some(claim => claim.newsId === news.id))
      ? 1
      : document.claims.some(claim => !claim.verify) ? 2 : 3
  const timeline = { ...document.timeline, stateIndex: stateIndex as 0 | 1 | 2 | 3 }
  const activeNews = document.news.find(news => news.id === timeline.activeScope)
    ?? document.news[0]

  return {
    mapId: document.id,
    name: document.name,
    nodes,
    edges,
    runPhase: document.run?.status === 'cancelled'
      ? 'error'
      : document.run?.status ?? 'idle',
    mode: document.run?.mode ?? 'human-in-loop',
    activeNodeId,
    pendingAction,
    pendingTool,
    error: document.run?.error,
    timeline,
    activeNews: activeNews ? { ...activeNews, context: { ...activeNews.context } } : undefined,
  }
}
