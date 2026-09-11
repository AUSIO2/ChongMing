export const DEVELOPMENT_WORKSPACE_ID = 'workspace:development'

export interface ContextField {
  value: string
  visibleToAI: boolean
}

export type GraphNodeData =
  | { kind: 'news'; content: string; context: Record<string, ContextField> }
  | { kind: 'claim'; content: string; category: string | null }
  | { kind: 'verification'; score: 0 | 0.5 | 1; reason: string; reportIds: string[]; opinions: GraphReport[] }

export interface GraphAgentProfile {
  id: string
  name: string
  description: string
  content: string
  tools: string[]
  provider: string
  model: string
}

export interface GraphRunConfiguration {
  router: GraphAgentProfile
  merger: GraphAgentProfile
  agents: GraphAgentProfile[]
  tools: Array<{ name: string; description: string }>
  maxSlots: number
}

export interface GraphRouteSlot {
  id: string
  agentId: string
  angle: string
  priority: 'high' | 'medium' | 'low'
  hint: string
  tools: string[]
}

export interface GraphRoute {
  revision: number
  reason: string
  slots: GraphRouteSlot[]
  approved: boolean
}

export interface GraphMergeDraft {
  id: string
  routeRevision: number
  reportIds: string[]
  score: 0 | 0.5 | 1
  reason: string
}

/** Trusted bridge identity, supplied in authenticated headers, never model arguments. */
export type GraphDataActor = { role: 'router' | 'merge' } | { role: 'worker'; slotId: string }

export interface GraphNode {
  id: string
  revision: number
  data: GraphNodeData
  createdAt: string
  updatedAt: string
}

export type GraphEdgeKind = 'mentions' | 'verifies' | 'related-to'

export interface GraphEdgeInput {
  id: string
  kind: GraphEdgeKind
  from: string
  to: string
}

export interface GraphEdge extends GraphEdgeInput {
  revision: number
  createdAt: string
  updatedAt: string
}

export interface GraphChanges {
  name?: string
  nodes?: {
    put?: Array<{ id: string; data: GraphNodeData }>
    remove?: string[]
  }
  edges?: {
    put?: GraphEdgeInput[]
    remove?: string[]
  }
}

export interface GraphSnapshot {
  mapId: string
  workspaceId: string
  revision: number
  name: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  run: GraphRun | null
  updatedAt: string
}

export interface GraphReport {
  id: string
  slotId: string
  agentId: string
  agentName: string
  angle: string
  tools: string[]
  routeRevision: number
  score: 0 | 0.5 | 1
  reason: string
  createdAt: string
}

export interface GraphReview {
  id: string
  kind: 'route' | 'result'
  revision: number
  state: 'pending' | 'answered'
  decision: 'approve' | 'reject' | null
  createdAt: string
  answeredAt: string | null
}

export interface GraphOperation {
  id: string
  kind: 'verify'
  targetId: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  inputRefs: Array<{ id: string; revision: number }>
  route: GraphRoute | null
  draft: GraphMergeDraft | null
  reports: GraphReport[]
  review: GraphReview | null
  resultNodeId: string | null
}

export interface GraphRun {
  id: string
  mode: 'auto' | 'human-in-loop'
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  configuration: GraphRunConfiguration
  operation: GraphOperation
  createdAt: string
  updatedAt: string
}

export interface GraphMapSummary {
  id: string
  workspaceId: string
  revision: number
  name: string
  nodeCount: number
  claimCount: number
  updatedAt: string
}

export interface GraphWriteResult {
  snapshot: GraphSnapshot
  createdNodeIds: string[]
  createdEdgeIds: string[]
}

export type GraphQuery =
  | { method: 'map.list'; params: { workspaceId: string } }
  | { method: 'map.get'; params: { mapId: string } }

export type GraphCommand =
  | {
      requestId: string
      method: 'map.create'
      params: { workspaceId: string; expectedRevision: 0; id: string; name: string }
    }
  | {
      requestId: string
      method: 'map.delete'
      params: { mapId: string; expectedRevision: number }
    }
  | {
      requestId: string
      method: 'graph.apply'
      params: { mapId: string; expectedRevision: number; changes: GraphChanges }
    }
  | {
      requestId: string
      method: 'run.start'
      params: {
        mapId: string
        expectedRevision: number
        id: string
        targetId: string
        mode: 'auto' | 'human-in-loop'
        configuration?: GraphRunConfiguration
      }
    }
  | {
      requestId: string
      method: 'run.cancel'
      params: { mapId: string; expectedRevision: number; runId: string }
    }
  | {
      requestId: string
      method: 'review.update'
      params: {
        mapId: string; expectedRevision: number; runId: string
        reviewId: string; expectedReviewRevision: number
        reason: string; slots: GraphRouteSlot[]
      }
    }
  | {
      requestId: string
      method: 'review.answer'
      params: {
        mapId: string
        expectedRevision: number
        runId: string
        reviewId: string
        expectedReviewRevision: number
        decision: 'approve' | 'reject'
      }
    }

export interface GraphDataRead {
  mapId: string
  runId: string
  operationId: string
  claim: GraphNode & { data: Extract<GraphNodeData, { kind: 'claim' }> }
  context: Array<{ id: string; content: string; context: Record<string, ContextField> }>
  configuration: GraphRunConfiguration
  route: GraphRoute | null
  reports: GraphReport[]
  draft: GraphMergeDraft | null
  review: GraphReview | null
  phase: 'route' | 'workers' | 'merge' | 'waiting' | 'done'
  proposalId: string
}

export type GraphDataProposal = { mapId: string; operationId: string; id: string } & (
  | { kind: 'route'; reason: string; slots: GraphRouteSlot[] }
  | { kind: 'report'; routeRevision: number; slotId: string; score: 0 | 0.5 | 1; reason: string }
  | { kind: 'merge'; routeRevision: number; reportIds: string[]; score: 0 | 0.5 | 1; reason: string }
)

export interface GraphSuccess<T> {
  ok: true
  requestId: string
  replayed: boolean
  data: T
}

export interface GraphFailure {
  ok: false
  requestId: string
  error: { code: string; message: string; retryable: boolean; currentRevision?: number }
}
