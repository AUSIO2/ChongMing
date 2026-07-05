import {
  MAP_DEFAULT_NEWS_ID,
  mapIdCreateClaim,
  mapIdCreateDraftClaim,
  mapIdCreateRoute,
  mapIdClaimBelongsToNews,
  mapIdReadSubAgentClaim,
} from '../ids'
import { mergeUpdateDraftFlags } from '../../../electron/shared/merge-flags'
import { apiCanWriteRoute } from '../../../electron/api/types'
import type { GraphSplitState, GraphStatePatch } from '../../../electron/api/types'
import {
  docDeleteNodes,
  docReadClaims,
  docReadRoutes,
  docUpdateClaim,
  docUpdateMap,
} from '../graph-mutators'
import type { MapGraphDoc } from '../graph-doc'
import type { MapNode, MapSubAgentParams } from '../types'
import { projUpdateRouteSlots, type ProjUpdateContext } from './hitl-column'
import type { ProjSpec } from './types'

export function projReadSplitClaimParent(
  nodes: MapNode[],
  source: { instanceId?: string; agentName?: string },
  splitRoutes: MapSubAgentParams[],
  newsParentId: string = MAP_DEFAULT_NEWS_ID,
): string {
  if (source.instanceId) {
    const route = splitRoutes.find(r => r.instanceId === source.instanceId)
    if (route) {
      const id = mapIdCreateRoute(route, newsParentId)
      if (nodes.some(n => n.id === id)) return id
    }
    const byId = nodes.find(
      n => n.kind === 'subAgent'
        && n.params.instanceId === source.instanceId
        && n.parentId === newsParentId,
    )
    if (byId) return byId.id
  }
  if (source.agentName) {
    const byName = splitRoutes.filter(r => r.agentName === source.agentName)
    if (byName.length === 1) {
      const id = mapIdCreateRoute(byName[0], newsParentId)
      if (nodes.some(n => n.id === id)) return id
    }
    const nodeByName = nodes.find(
      n => n.kind === 'subAgent'
        && n.params.agentName === source.agentName
        && n.parentId === newsParentId,
    )
    if (nodeByName) return nodeByName.id
  }
  return newsParentId
}

function projUpdateSplitClaim(
  doc: MapGraphDoc,
  state: GraphSplitState,
  ctx?: ProjUpdateContext,
): void {
  const parentId = state.parentNodeId
  const routes = state.routeInstructions ?? []

  const useNumbered =
    ctx?.upcomingGate === 'save'
    || ctx?.completedNode === 'validate'
    || ctx?.completedNode === 'save'
    || (state.saveIndex > 0 && !!state.mergedClaims?.length)

  if (useNumbered && state.mergedClaims?.length) {
    const draftIds = docReadClaims(doc, 'draft', parentId).map(n => n.id)
    docDeleteNodes(doc, new Set(draftIds))
    state.mergedClaims.forEach((c, index) => {
      const id = mapIdCreateClaim(index, parentId)
      const persisted = index < state.saveIndex
      const claimParent = projReadSplitClaimParent(
        doc.nodes,
        { agentName: c.sourceAgent },
        routes,
        parentId,
      )
      docUpdateClaim(doc, {
        id,
        parentId: claimParent,
        content: c.content,
        category: c.category,
        sourceAgent: c.sourceAgent,
        dataPhase: persisted ? 'persisted' : 'workerOut',
        shouldSave: true,
      })
    })
    return
  }

  if (
    state.mergedClaims?.length
    || ctx?.upcomingGate === 'validate'
    || ctx?.completedNode === 'merge'
  ) {
    const rows = mapIdReadSubAgentClaim(state.subAgentResults ?? [])
    rows.forEach((row, index) => {
      const claimParent = projReadSplitClaimParent(
        doc.nodes,
        { instanceId: row.instanceId, agentName: row.agentName },
        routes,
        parentId,
      )
      docUpdateClaim(doc, {
        id: mapIdCreateDraftClaim(index, parentId),
        parentId: claimParent,
        content: row.content,
        category: row.category,
        sourceAgent: row.sourceAgent,
        dataPhase: 'workerOut',
        shouldSave: true,
      })
    })
    const drafts = docReadClaims(doc, 'draft', parentId)
    mergeUpdateDraftFlags(drafts, state.mergedClaims ?? [])
    return
  }

  if (state.subAgentResults?.length) {
    const rows = mapIdReadSubAgentClaim(state.subAgentResults ?? [])
    rows.forEach((row, index) => {
      const claimParent = projReadSplitClaimParent(
        doc.nodes,
        { instanceId: row.instanceId, agentName: row.agentName },
        routes,
        parentId,
      )
      docUpdateClaim(doc, {
        id: mapIdCreateDraftClaim(index, parentId),
        parentId: claimParent,
        content: row.content,
        category: row.category,
        sourceAgent: row.sourceAgent,
        dataPhase: 'workerOut',
        shouldSave: true,
      })
    })
  }
}

function projUpdateSplitGraph(
  doc: MapGraphDoc,
  state: GraphSplitState,
  ctx?: ProjUpdateContext,
): void {
  docUpdateMap(doc, state.content, state.parentNodeId)
  projUpdateRouteSlots(doc, state.parentNodeId, state.routeInstructions ?? [], ctx ?? {})
  projUpdateSplitClaim(doc, state, ctx)
}

function projUpdateSplitDraft(doc: MapGraphDoc): void {
  const draft = doc.draft
  if (!draft || !('routeInstructions' in draft)) return
  const parentId = draft.parentNodeId
  doc.draft = {
    ...draft,
    routeInstructions: docReadRoutes(doc, parentId),
  }

  if ('mergedClaims' in draft) {
    const source = docReadClaims(doc, 'numbered', parentId).length > 0
      ? docReadClaims(doc, 'numbered', parentId)
      : docReadClaims(doc, 'draft', parentId).filter(n => n.shouldSave)

    const claims = source.map(n => ({
      content: n.params.content,
      category: n.params.category,
      sourceAgent: n.params.sourceAgent,
      shouldSave: true as boolean,
    }))
    if (claims.length > 0) {
      doc.draft = { ...doc.draft, mergedClaims: claims }
    }
  }
}

function projReadSplitResume(doc: MapGraphDoc): GraphStatePatch | null {
  const state = doc.draft
  if (!state) return null

  if (apiCanWriteRoute(doc.pendingTool) && 'routeInstructions' in state) {
    return { routeInstructions: state.routeInstructions }
  }

  if (
    (doc.pendingTool === 'validate' || doc.pendingTool === 'save')
    && 'mergedClaims' in state
    && state.mergedClaims.length > 0
  ) {
    return { mergedClaims: state.mergedClaims }
  }

  return null
}

export const splitProjSpec: ProjSpec = {
  key: '1-2',
  readAnchorId: state => state.parentNodeId,
  pruneKinds: ['subAgent', 'claim', 'opinion'],
  resetDefaultNews: true,
  updateGraph(doc, state, ctx) {
    projUpdateSplitGraph(doc, state as GraphSplitState, ctx)
  },
  updateDraft: projUpdateSplitDraft,
  readResume: projReadSplitResume,
}
