import {
  mapIdCreateParse,
  mapIdCreateSource,
  mapIdReadChain,
} from '../ids'
import { docUpdateEdge } from '../graph-mutators'
import type { MapGraphDoc } from '../graph-doc'
import type { GraphParseState, GraphStatePatch } from '../../electron/api/types'
import type { MapNewsNode, MapParseAgentNode } from '../types'
import type { ProjSpec } from './types'

function projUpdateParseGraph(doc: MapGraphDoc, state: GraphParseState): void {
  const chainId = mapIdReadChain(state.newsNodeId) ?? mapIdReadChain(state.parentNodeId)
  if (!chainId) return

  const sourceId = mapIdCreateSource(chainId)
  const parseId = mapIdCreateParse(chainId)

  for (const route of state.routeInstructions ?? []) {
    if (!doc.nodes.some(n => n.id === parseId)) {
      const parseNode: MapParseAgentNode = {
        id: parseId,
        kind: 'parseAgent',
        parentId: sourceId,
        params: { agentName: route.agentName },
      }
      doc.nodes.push(parseNode)
      docUpdateEdge(doc, sourceId, parseId)
    }
  }

  if (!state.parsedContent.trim()) return

  const existing = doc.nodes.find(
    (n): n is MapNewsNode => n.id === state.newsNodeId && n.kind === 'news',
  )
  if (existing) {
    existing.params.content = state.parsedContent
    return
  }

  doc.nodes.push({
    id: state.newsNodeId,
    kind: 'news',
    parentId: parseId,
    params: { content: state.parsedContent },
  })
  docUpdateEdge(doc, parseId, state.newsNodeId)
}

function projUpdateParseDraft(doc: MapGraphDoc): void {
  const draft = doc.draft
  if (!draft || !('parsedContent' in draft) || !('newsNodeId' in draft)) return
  const newsNode = doc.nodes.find(
    (n): n is MapNewsNode => n.id === draft.newsNodeId && n.kind === 'news',
  )
  if (newsNode) {
    doc.draft = { ...draft, parsedContent: newsNode.params.content }
  }
}

function projReadParseResume(doc: MapGraphDoc): GraphStatePatch | null {
  if (doc.pendingTool !== 'save') return null
  const state = doc.draft
  if (!state || !('parsedContent' in state)) return null
  return { parsedContent: state.parsedContent }
}

export const parseProjSpec: ProjSpec = {
  key: '0-1',
  readAnchorId: state => state.parentNodeId,
  pruneKinds: [],
  updateGraph(doc, state, _ctx) {
    projUpdateParseGraph(doc, state as GraphParseState)
  },
  updateDraft: projUpdateParseDraft,
  readResume: projReadParseResume,
}
