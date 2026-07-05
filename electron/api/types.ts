import type {
  Confidence,
  ExecutionMode,
  NewsContext,
  Priority,
  MapSubAgentParams,
} from '../shared/types'
import type { ErrorCode } from '../shared/errors'
import type { CatalogSubAgent } from './sub-agent-catalog'

export type { Confidence, ExecutionMode, NewsContext, Priority, MapSubAgentParams }
export type { CatalogSubAgent }

// ==========================================
// Map DTO
// ==========================================

export interface DisplayClaim {
  claimId: string
  content: string
  category?: string
  sourceAgent?: string
  verifyResult?: DisplayVerifyResult
}

export interface DisplayOpinion {
  agentName: string
  instanceId: string
  priority: Priority
  score: Confidence
  reason: string
  rawResponse: string
}

export interface DisplayVerifyResult {
  score: Confidence
  reason: string
  opinions: DisplayOpinion[]
  rawMergeResponse: string
  verifiedAt: string
}

export interface GraphSplitRecordDto {
  agentName: string
  priority: Priority
  instanceId: string
  claims: Array<{ content: string; category?: string; sourceAgent?: string }>
  rawResponse: string
}

export interface DisplaySplitMeta {
  model: string
  routeInstructions?: MapSubAgentParams[]
  subAgentResults: GraphSplitRecordDto[]
  rawMergeResponse: string
  splitAt: string
}

export interface MapTimelineDto {
  startX: 0 | 1 | 2 | 3
  endX: 0 | 1 | 2 | 3
  stateIndex?: 0 | 1 | 2 | 3
  activeScope: string
}

export interface DisplayMap {
  _id: string
  /** 用户自定义名称；未设置时 UI 显示「Map」。 */
  name?: string
  content: string
  context: NewsContext
  claims: DisplayClaim[]
  splitMeta?: DisplaySplitMeta
  timeline: MapTimelineDto
  mapRun?: MapRunPersist
  mapGraph?: MapGraphPersist
  confidence?: number
  confidenceUpdatedAt?: string
  createdAt: string
  updatedAt: string
}

export interface DisplayMapSummary {
  _id: string
  name?: string
  content: string
  claimCount: number
  createdAt: string
  updatedAt: string
}

export interface CreateMapInput {
  _id?: string
  name?: string
  content: string
  context: NewsContext
  scopeNodeId?: string
}

export interface UpdateMapInput {
  name?: string
  scopeNodeId?: string
  content?: string
  context?: NewsContext
  timeline?: Partial<MapTimelineDto>
}

// ==========================================
// Graph DTO
// ==========================================

/** 列间过渡 key：父数据列 x → 子数据列 x+1 */
export type TransitionKey = '0-1' | '1-2' | '2-3'

export type GraphInterruptNode = 'confirmRoute' | 'validate' | 'save'
export type GraphToolKind = 'invoke' | 'validate' | 'save'

export function apiCanWriteRoute(pendingTool?: GraphToolKind): boolean {
  return pendingTool === 'invoke'
}

export interface GraphInterruptFocus {
  kind: 'source' | 'news' | 'subAgent' | 'claim' | 'opinion'
  id: string
}

export interface GraphParseState {
  mapId: string
  parentNodeId: string
  newsNodeId: string
  mode: ExecutionMode
  sourceUri: string
  sourceKind: 'file' | 'url'
  rawContent: string
  routeInstructions: MapSubAgentParams[]
  subAgentResults: GraphSplitRecordDto[]
  parsedContent: string
}

export interface GraphClaimDto {
  content: string
  category?: string
  sourceAgent?: string
  shouldSave?: boolean
}

export type GraphClaim = GraphClaimDto

export interface GraphSplitState {
  mapId: string
  parentNodeId: string
  mode: ExecutionMode
  content: string
  visibleContext: Record<string, string>
  routeInstructions: MapSubAgentParams[]
  subAgentResults: GraphSplitRecordDto[]
  mergedClaims: GraphClaimDto[]
  rawMergeResponse: string
  saveIndex: number
}

export interface GraphVerifyState {
  mapId: string
  parentNodeId: string
  scopeNodeId: string
  mode: ExecutionMode
  claimContent: string
  originalContent: string
  visibleContext: Record<string, string>
  routeInstructions: MapSubAgentParams[]
  subAgentOpinions: DisplayOpinion[]
  finalScore: Confidence
  finalReason: string
  rawMergeResponse: string
  opinionSaveIndex: number
}

export interface MapRunPersist {
  runId: string
  threadId: string
  transitionKey: TransitionKey
  parentNodeId: string
  mode: ExecutionMode
  gate?: GraphInterruptNode
  pendingTool?: GraphToolKind
  activeNodeId?: string
  status: 'running' | 'interrupted' | 'error'
  updatedAt: string
}

export interface MapGraphPersist {
  nodes: unknown[]
  edges: unknown[]
  runPhase: string
  mode: ExecutionMode
  activeNodeId?: string
  pendingTool?: GraphToolKind
  nextNode?: GraphInterruptNode
  transitionKey?: TransitionKey
  draft?: GraphSplitState | GraphVerifyState | GraphParseState
  error?: string
  updatedAt: string
}

export interface StartTransitionInput {
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  scopeNodeId?: string
  mode?: ExecutionMode
}

export interface StartGraphResult {
  runId: string
}

export interface GraphInterruptedPayload {
  runId: string
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  nextNode: GraphInterruptNode
  mode: ExecutionMode
  state: GraphSplitState | GraphVerifyState | GraphParseState
  focus?: GraphInterruptFocus
  pendingTool?: GraphToolKind
}

export interface GraphActiveRun {
  runId: string
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  mode: ExecutionMode
  threadId?: string
  nextNode?: GraphInterruptNode
  focus?: GraphInterruptFocus
  pendingTool?: GraphToolKind
  state?: GraphSplitState | GraphVerifyState | GraphParseState
}

export interface GraphCompletedPayload {
  runId: string
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  state: GraphSplitState | GraphVerifyState | GraphParseState
}

export interface GraphStatePayload {
  runId: string
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  completedNode: string
  state: GraphSplitState | GraphVerifyState | GraphParseState
}

export interface GraphErrorPayload {
  runId: string
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  code: ErrorCode
  msg: string
  failedNode?: string
}

export type GraphProgressGraphEvent = 'node_enter' | 'node_exit' | 'fanout_spawn'

export type GraphProgressPayload = {
  runId: string
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
} & (
  | {
    event: GraphProgressGraphEvent
    node: string
    agentName?: string
    spawnIndex?: number
    nodeId?: string
    parentNodeId?: string
  }
  | {
    event: 'subagent_tool'
    phase: 'start' | 'end'
    nodeId: string
    toolName: string
    argsSummary?: string
  }
)

export type SplitStatePatch = Partial<GraphSplitState>
export type VerifyStatePatch = Partial<GraphVerifyState>
export type ParseStatePatch = Partial<GraphParseState>
export type GraphStatePatch = SplitStatePatch | VerifyStatePatch | ParseStatePatch | null

// ==========================================
// ElectronAPI
// ==========================================

export interface MapAPI {
  create(input: CreateMapInput): Promise<DisplayMap>
  list(): Promise<DisplayMapSummary[]>
  get(mapId: string): Promise<DisplayMap | null>
  update(mapId: string, patch: UpdateMapInput): Promise<DisplayMap>
  delete(mapId: string): Promise<void>
  saveMapPersistence(
    mapId: string,
    data: {
      mapRun?: MapRunPersist | null
      mapGraph?: MapGraphPersist | null
    },
  ): Promise<void>
}

export interface CatalogAPI {
  list(module: 'split' | 'verify'): Promise<CatalogSubAgent[]>
}

export interface RestoreRunInput {
  mapId: string
  runId: string
  threadId: string
  transitionKey: TransitionKey
  parentNodeId: string
  scopeNodeId?: string
  mode: ExecutionMode
  gate: GraphInterruptNode
  pendingTool?: GraphToolKind
  activeNodeId?: string
  draft: GraphSplitState | GraphVerifyState | GraphParseState
}

export interface GraphAPI {
  runTransition(input: StartTransitionInput): Promise<StartGraphResult>
  resume(runId: string, modifications: GraphStatePatch): Promise<void>
  setMode(runId: string, mode: ExecutionMode): Promise<void>
  cancel(runId: string): Promise<void>
  getActiveRun(mapId: string): Promise<GraphActiveRun | null>
  restore(input: RestoreRunInput): Promise<StartGraphResult>
}

export interface GraphEventAPI {
  onInterrupted(callback: (payload: GraphInterruptedPayload) => void): () => void
  onState(callback: (payload: GraphStatePayload) => void): () => void
  onCompleted(callback: (payload: GraphCompletedPayload) => void): () => void
  onError(callback: (payload: GraphErrorPayload) => void): () => void
  onProgress(callback: (payload: GraphProgressPayload) => void): () => void
}

export interface ElectronAPI {
  map: MapAPI
  catalog: CatalogAPI
  graph: GraphAPI
  events: GraphEventAPI
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
