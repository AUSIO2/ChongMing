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
// 新闻 DTO
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
  claims: Array<{ content: string; category?: string; sourceAgent?: string }>
  rawResponse: string
}

export interface DisplaySplitMeta {
  model: string
  subAgentResults: GraphSplitRecordDto[]
  rawMergeResponse: string
  splitAt: string
}

export interface DisplayNews {
  _id: string
  content: string
  context: NewsContext
  claims: DisplayClaim[]
  splitMeta?: DisplaySplitMeta
  confidence?: number
  confidenceUpdatedAt?: string
  createdAt: string
  updatedAt: string
}

export interface DisplayNewsSummary {
  _id: string
  content: string
  claimCount: number
  createdAt: string
  updatedAt: string
}

export interface CreateNewsInput {
  _id?: string
  content: string
  context: NewsContext
}

export interface UpdateNewsInput {
  content?: string
  context?: NewsContext
}

// ==========================================
// Graph DTO
// ==========================================

export type GraphType = 'split' | 'verify'
export type GraphInterruptNode = 'subAgent' | 'merge' | 'save'
export type GraphToolKind = 'invoke' | 'validate' | 'save'

/** interrupt 焦点：一次中断对应一个 Map 节点 */
export interface GraphInterruptFocus {
  kind: 'news' | 'subAgent' | 'claim' | 'opinion'
  id: string
}

export interface GraphClaimDto {
  content: string
  category?: string
  sourceAgent?: string
}

export interface GraphSplitState {
  newsId: string
  mode: ExecutionMode
  content: string
  visibleContext: Record<string, string>
  routeInstructions: MapSubAgentParams[]
  subAgentResults: GraphSplitRecordDto[]
  mergedClaims: GraphClaimDto[]
  rawMergeResponse: string
  /** 按条 save 的游标（下一条待落盘的 mergedClaims 下标） */
  saveIndex: number
}

export interface GraphVerifyState {
  newsId: string
  claimId: string
  mode: ExecutionMode
  claimContent: string
  originalContent: string
  visibleContext: Record<string, string>
  routeInstructions: MapSubAgentParams[]
  subAgentOpinions: DisplayOpinion[]
  finalScore: Confidence
  finalReason: string
  rawMergeResponse: string
  /** 按条 opinion save 游标 */
  opinionSaveIndex: number
}

export interface StartSplitInput {
  newsId: string
  mode?: ExecutionMode
  /**
   * 可选人工预置路由，与 AI Route Agent 结果合并（不替代 route）。
   * 每条含 agentName / priority / hint? / instanceId?。
   */
  routeInstructions?: MapSubAgentParams[]
}

export interface StartVerifyInput {
  newsId: string
  claimId: string
  mode?: ExecutionMode
  /** 可选人工预置核查槽，与 AI Route Agent 结果合并 */
  routeInstructions?: MapSubAgentParams[]
}

export interface StartGraphResult {
  runId: string
}

export interface GraphInterruptedPayload {
  runId: string
  graphType: GraphType
  nextNode: GraphInterruptNode
  mode: ExecutionMode
  state: GraphSplitState | GraphVerifyState
  /** Map 焦点：一次 interrupt 一个节点 */
  focus?: GraphInterruptFocus
  pendingTool?: GraphToolKind
}

export interface GraphActiveRun {
  runId: string
  newsId: string
  graphType: GraphType
  mode: ExecutionMode
  nextNode?: GraphInterruptNode
  focus?: GraphInterruptFocus
  pendingTool?: GraphToolKind
  state?: GraphSplitState | GraphVerifyState
}

export interface GraphCompletedPayload {
  runId: string
  graphType: GraphType
  state: GraphSplitState | GraphVerifyState
}

export interface GraphErrorPayload {
  runId: string
  newsId: string
  graphType: GraphType
  code: ErrorCode
  msg: string
  failedNode?: string
}

export type GraphProgressEvent = 'node_enter' | 'node_exit' | 'fanout_spawn'

export interface GraphProgressPayload {
  runId: string
  newsId: string
  graphType: GraphType
  event: GraphProgressEvent
  node: string
  agentName?: string
  spawnIndex?: number
}

export type SplitStatePatch = Partial<GraphSplitState>
export type VerifyStatePatch = Partial<GraphVerifyState>
export type GraphStatePatch = SplitStatePatch | VerifyStatePatch | null

// ==========================================
// ElectronAPI — preload 暴露给渲染进程
// ==========================================

export interface NewsAPI {
  create(input: CreateNewsInput): Promise<DisplayNews>
  list(): Promise<DisplayNewsSummary[]>
  get(newsId: string): Promise<DisplayNews | null>
  update(newsId: string, patch: UpdateNewsInput): Promise<DisplayNews>
}

export interface CatalogAPI {
  list(module: 'split' | 'verify'): Promise<CatalogSubAgent[]>
}

export interface GraphAPI {
  startSplit(input: StartSplitInput): Promise<StartGraphResult>
  startVerify(input: StartVerifyInput): Promise<StartGraphResult>
  resume(runId: string, modifications: GraphStatePatch): Promise<void>
  setMode(runId: string, mode: ExecutionMode): Promise<void>
  cancel(runId: string): Promise<void>
  getActiveRun(newsId: string): Promise<GraphActiveRun | null>
}

export interface GraphEventAPI {
  onInterrupted(callback: (payload: GraphInterruptedPayload) => void): () => void
  onCompleted(callback: (payload: GraphCompletedPayload) => void): () => void
  onError(callback: (payload: GraphErrorPayload) => void): () => void
  onProgress(callback: (payload: GraphProgressPayload) => void): () => void
}

export interface ElectronAPI {
  news: NewsAPI
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
