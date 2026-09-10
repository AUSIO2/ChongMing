export const DEVELOPMENT_WORKSPACE_ID = 'workspace:development'

export interface ContextField {
  value: string
  visibleToAI: boolean
}

export type GraphNodeData =
  | { kind: 'news'; content: string; context: Record<string, ContextField> }
  | { kind: 'claim'; content: string; category: string | null }
  | { kind: 'verification'; score: 0 | 0.5 | 1; reason: string; reportIds: string[] }

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
  score: 0 | 0.5 | 1
  reason: string
  createdAt: string
}

export interface GraphReview {
  id: string
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
  reports: GraphReport[]
  review: GraphReview | null
  resultNodeId: string | null
}

export interface GraphRun {
  id: string
  mode: 'auto' | 'human-in-loop'
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
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
      }
    }
  | {
      requestId: string
      method: 'run.cancel'
      params: { mapId: string; expectedRevision: number; runId: string }
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
  reports: GraphReport[]
  review: GraphReview | null
}

export interface GraphReportProposal {
  mapId: string
  operationId: string
  report: { id: string; slotId: string; score: 0 | 0.5 | 1; reason: string }
}

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
