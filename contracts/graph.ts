export const DEVELOPMENT_WORKSPACE_ID = 'workspace:development'

export interface ContextField {
  value: string
  visibleToAI: boolean
}

export type GraphNodeData =
  | { kind: 'news'; content: string; context: Record<string, ContextField> }
  | { kind: 'claim'; content: string; category: string | null }

export interface GraphNode {
  id: string
  revision: number
  data: GraphNodeData
  createdAt: string
  updatedAt: string
}

export type GraphEdgeKind = 'mentions' | 'related-to'

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
