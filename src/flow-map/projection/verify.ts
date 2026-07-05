import {
  MAP_DEFAULT_NEWS_ID,
  mapIdCreateOpinion,
  mapIdCreateRoute,
} from '../ids'
import { apiCanWriteRoute } from '../../../electron/api/types'
import type { GraphStatePatch, GraphVerifyState } from '../../../electron/api/types'
import {
  docDeleteNodes,
  docReadRoutes,
  docUpdateClaim,
  docUpdateOpinion,
  docUpdateSubAgent,
} from '../graph-mutators'
import type { MapGraphDoc } from '../graph-doc'
import type { MapClaimNode, MapOpinionNode, MapSubAgentParams, Priority } from '../types'
import { projUpdateRouteSlots, type ProjUpdateContext } from './hitl-column'
import type { ProjSpec } from './types'

type VerifyOpinionLike = {
  agentName: string
  instanceId: string
  priority: Priority
  reason: string
  score: MapOpinionNode['params']['confidence']
}

function projReadVerifyOpinionRoute(
  routes: MapSubAgentParams[],
  op: { agentName: string; instanceId: string; priority: Priority },
  used: Set<string>,
): MapSubAgentParams {
  const byId = routes.find(r => r.instanceId === op.instanceId && !used.has(r.instanceId))
  if (byId) return byId
  return {
    agentName: op.agentName,
    priority: op.priority,
    instanceId: op.instanceId,
  }
}

export function projUpdateVerifyOpinion(
  doc: MapGraphDoc,
  claimId: string,
  routes: MapSubAgentParams[],
  opinions: VerifyOpinionLike[],
  opinionSaveIndex: number,
): void {
  const usedParents = new Set<string>()
  opinions.forEach((op, index) => {
    const route = routes.length > 0
      ? projReadVerifyOpinionRoute(routes, op, usedParents)
      : { agentName: op.agentName, priority: op.priority, instanceId: op.instanceId }
    const parentId = docUpdateSubAgent(doc, claimId, route)
    usedParents.add(route.instanceId)
    const persisted = index < opinionSaveIndex
    docUpdateOpinion(doc, {
      id: mapIdCreateOpinion(claimId, index),
      parentId,
      content: op.reason,
      confidence: op.score,
      priority: op.priority,
      dataPhase: persisted ? 'persisted' : 'workerOut',
    })
  })
}

function projUpdateClaimPersist(doc: MapGraphDoc): void {
  for (const n of doc.nodes) {
    if (n.kind === 'claim' || n.kind === 'opinion') {
      n.dataPhase = 'persisted'
    }
    if (n.kind === 'claim') {
      n.shouldSave = true
    }
  }
}

function projUpdateVerifyGraph(
  doc: MapGraphDoc,
  state: GraphVerifyState,
  ctx?: ProjUpdateContext,
): void {
  const claimId = state.parentNodeId
  const existingClaim = doc.nodes.find((n): n is MapClaimNode => n.id === claimId)
  if (existingClaim) {
    existingClaim.params = {
      ...existingClaim.params,
      content: state.claimContent || existingClaim.params.content,
    }
    existingClaim.dataPhase = 'persisted'
    existingClaim.shouldSave = true
  } else {
    docUpdateClaim(doc, {
      id: claimId,
      parentId: MAP_DEFAULT_NEWS_ID,
      content: state.claimContent,
      dataPhase: 'persisted',
      shouldSave: true,
    })
  }

  const routes = state.routeInstructions ?? []

  const workerOutOpinionIds = new Set(
    doc.nodes
      .filter(
        n => n.kind === 'opinion'
          && n.dataPhase === 'workerOut'
          && n.id.startsWith(`opinion:${claimId}:`),
      )
      .map(n => n.id),
  )
  docDeleteNodes(doc, workerOutOpinionIds)

  projUpdateRouteSlots(doc, claimId, routes, ctx ?? {})
  projUpdateVerifyOpinion(
    doc,
    claimId,
    routes,
    state.subAgentOpinions,
    state.opinionSaveIndex,
  )
}

function projUpdateVerifyDraft(doc: MapGraphDoc): void {
  const draft = doc.draft
  if (!draft || !('scopeNodeId' in draft)) return
  doc.draft = {
    ...draft,
    routeInstructions: docReadRoutes(doc, draft.parentNodeId),
  }
}

function projReadVerifyResume(doc: MapGraphDoc): GraphStatePatch | null {
  const state = doc.draft
  if (!state) return null
  if (apiCanWriteRoute(doc.pendingTool) && 'routeInstructions' in state) {
    return { routeInstructions: state.routeInstructions }
  }
  return null
}

export const verifyProjSpec: ProjSpec = {
  key: '2-3',
  readAnchorId: state => state.parentNodeId,
  pruneKinds: ['subAgent', 'opinion'],
  updateGraph(doc, state, ctx) {
    projUpdateClaimPersist(doc)
    projUpdateVerifyGraph(doc, state as GraphVerifyState, ctx)
  },
  updateDraft: projUpdateVerifyDraft,
  readResume: projReadVerifyResume,
}
