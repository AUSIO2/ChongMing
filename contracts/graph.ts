export interface ContextField {
  value: string
  visibleToAI: boolean
}

export type GraphNodeData =
  | { kind: 'source'; locator: GraphLocator; label: string | null }
  | { kind: 'evidence'; content: string; locator: GraphLocator; capturedAt: string }
  | { kind: 'news'; content: string; context: Record<string, ContextField> }
  | { kind: 'claim'; content: string; category: string | null }
  | { kind: 'verification'; score: 0 | 0.5 | 1; reason: string; reportIds: string[]; opinions: GraphReport[] }

export type GraphLocator = { kind: 'asset'; assetId: string; mediaType: string } | { kind: 'url'; url: string }

export interface GraphAgentProfile {
  id: string
  name: string
  description: string
  content: string
  tools: string[]
  provider: string
  model: string
  promptVars?: string[]
  defaultPriority?: 'high' | 'medium' | 'low'
  claimCategory?: 'data' | 'quote' | 'causal' | null
}

export interface GraphRunConfiguration {
  parse?: GraphAgentProfile
  split?: { router: GraphAgentProfile; merger: GraphAgentProfile; agents: GraphAgentProfile[] }
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
export type GraphDataActor = { role: 'parse' | 'router' | 'merge' } | { role: 'worker'; slotId: string }

export interface GraphWorkProof {
  workId: string
  holderId: string
  fence: number
}

export interface GraphWork {
  workId: string
  mapId: string
  runId: string
  operationId: string
  actor: GraphDataActor
  routeRevision: number
}

export interface GraphWorkGrant extends GraphWork, GraphWorkProof {
  hostId: string
  expiresAt: string
  leaseMs: number
}

export type GraphWorkCommand =
  | { method: 'claim'; params: { hostId: string; holderId: string; mapId: string; workId: string; deploymentId: string } }
  | { method: 'read'; params: GraphWorkProof & { mapId: string } }
  | { method: 'renew'; params: GraphWorkProof & { mapId: string } }
  | { method: 'release'; params: GraphWorkProof & { mapId: string } }
  | { method: 'fail'; params: GraphWorkProof & { mapId: string; message: string } }

export interface GraphNode {
  id: string
  revision: number
  data: GraphNodeData
  createdAt: string
  updatedAt: string
  importedFrom?: { bundleId: string; nodeId: string; revision: number }
  validity?: 'current' | 'stale'
  /** Read-only provenance projected from accepted operation history; never an execution node. */
  producer?: { operationId: string; kind: 'parse' | 'split'; inputId: string; agentId: string; agentName: string; slotId?: string; angle?: string }
}

export type GraphEdgeKind = 'derived-from' | 'mentions' | 'verifies' | 'related-to'

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
  kind: 'parse' | 'split' | 'verify'
  targetId: string
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  inputRefs: Array<{ id: string; revision: number }>
  configurationHash: string
  outputRefs: Array<{ id: string; revision: number; reportId?: string; index?: number }>
  rawContent?: string
  route: GraphRoute | null
  draft: GraphMergeDraft | null
  reports: GraphReport[]
  splitReports: GraphSplitReport[]
  contentDraft: GraphContentDraft | null
  review: GraphReview | null
  resultNodeId: string | null
}

export interface GraphRun {
  id: string
  scope: { nodeIds: string[] }
  until: 'news' | 'claims' | 'verified'
  paused: boolean
  regenerate: boolean
  mode: 'auto' | 'human-in-loop'
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  configuration: GraphRunConfiguration
  error?: { code: string; message: string; workId: string }
  operations: GraphOperation[]
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
  | { method: 'run.get'; params: { mapId: string; runId: string } }

export type GraphCommand =
  | {
      requestId: string
      method: 'map.create'
      params: { workspaceId: string; expectedRevision: number; id: string; name: string }
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
        scope: { nodeIds: string[] }
        until: GraphRun['until']
        regenerate?: boolean
        mode: 'auto' | 'human-in-loop'
      }
    }
  | {
      requestId: string
      method: 'run.cancel'
      params: { mapId: string; expectedRevision: number; runId: string }
    }
  | { requestId: string; method: 'run.pause'; params: { mapId: string; expectedRevision: number; runId: string } }
  | { requestId: string; method: 'run.resume'; params: { mapId: string; expectedRevision: number; runId: string } }
  | {
      requestId: string
      method: 'review.update'
      params: {
        mapId: string; expectedRevision: number; runId: string; operationId: string
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
        operationId: string
        reviewId: string
        expectedReviewRevision: number
        decision: 'approve' | 'reject'
      }
    }

export interface GraphDataRead {
  mapId: string
  runId: string
  operationId: string
  operationKind: GraphOperation['kind']
  target: GraphNode & { data: Extract<GraphNodeData, { kind: 'source' | 'news' | 'claim' }> }
  rawContent?: string
  context: Array<{ id: string; content: string; context: Record<string, ContextField> }>
  configuration: GraphRunConfiguration
  route: GraphRoute | null
  reports: GraphReport[]
  splitReports: GraphSplitReport[]
  contentDraft: GraphContentDraft | null
  draft: GraphMergeDraft | null
  review: GraphReview | null
  phase: 'parse' | 'route' | 'workers' | 'merge' | 'waiting' | 'done'
  proposalId: string
  work: { id: string; actor: GraphDataActor; routeRevision: number; status: 'ready' | 'accepted' }
}

export type GraphDataProposal = { mapId: string; operationId: string; id: string } & (
  | { kind: 'parse'; reason: string; news: GraphNewsOutput[] }
  | { kind: 'split-report'; routeRevision: number; slotId: string; reason: string; claims: GraphClaimOutput[] }
  | { kind: 'split-merge'; routeRevision: number; reportIds: string[]; reason: string; selected: GraphClaimSelection[] }
  | { kind: 'route'; reason: string; slots: GraphRouteSlot[] }
  | { kind: 'report'; routeRevision: number; slotId: string; score: 0 | 0.5 | 1; reason: string }
  | { kind: 'merge'; routeRevision: number; reportIds: string[]; score: 0 | 0.5 | 1; reason: string }
)

export interface GraphNewsOutput { content: string; context: Record<string, ContextField> }
export interface GraphClaimOutput { content: string; category: string | null }
export interface GraphClaimSelection { reportId: string; index: number }
export interface GraphSplitReport extends Omit<GraphReport, 'score'> { claims: GraphClaimOutput[] }
export type GraphContentDraft =
  | { kind: 'parse'; reason: string; news: GraphNewsOutput[] }
  | { kind: 'split'; reason: string; selected: GraphClaimSelection[] }

export interface GraphSuccess<T> {
  ok: true
  requestId: string
  replayed: boolean
  data: T
}

export interface GraphFailure {
  ok: false
  requestId: string
  error: { code: string; message: string; retryable: boolean; errorId: string; currentRevision?: number }
}
