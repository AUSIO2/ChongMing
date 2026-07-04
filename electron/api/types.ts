import type {
  Confidence,
  ExecutionMode,
  NewsContext,
  Priority,
  RouteInstruction,
} from '../shared/types'

export type { Confidence, ExecutionMode, NewsContext, Priority, RouteInstruction }

// ==========================================
// 新闻 DTO
// ==========================================

export interface SplitClaimDTO {
  claimId: string
  content: string
  category?: string
  sourceAgent?: string
  verifyResult?: VerifyResultDTO
}

export interface SubAgentOpinionDTO {
  agentName: string
  priority: Priority
  score: Confidence
  reason: string
  rawResponse: string
}

export interface VerifyResultDTO {
  score: Confidence
  reason: string
  opinions: SubAgentOpinionDTO[]
  rawMergeResponse: string
  verifiedAt: string
}

export interface SubAgentSplitRecordDTO {
  agentName: string
  priority: Priority
  claims: Array<{ content: string; category?: string; sourceAgent?: string }>
  rawResponse: string
}

export interface SplitMetaDTO {
  model: string
  subAgentResults: SubAgentSplitRecordDTO[]
  rawMergeResponse: string
  splitAt: string
}

export interface NewsDocumentDTO {
  _id: string
  content: string
  context: NewsContext
  claims: SplitClaimDTO[]
  splitMeta?: SplitMetaDTO
  confidence?: number
  confidenceUpdatedAt?: string
  createdAt: string
  updatedAt: string
}

export interface NewsDocumentSummaryDTO {
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
  /** @deprecated 请使用 claims CRUD 接口 */
  claims?: SplitClaimDTO[]
}

export interface CreateClaimInput {
  claimId?: string
  content: string
  category?: string
  sourceAgent?: string
}

export interface UpdateClaimInput {
  content?: string
  category?: string
  sourceAgent?: string
}

// ==========================================
// Graph DTO
// ==========================================

export type GraphType = 'split' | 'verify'
export type GraphInterruptNode = 'subAgent' | 'merge' | 'save'
export type MapToolKind = 'invoke' | 'validate' | 'save'

/** interrupt 焦点：一次中断对应一个 Map 节点 */
export interface GraphInterruptFocus {
  kind: 'news' | 'subAgent' | 'claim' | 'opinion'
  id: string
}

export interface RawClaimDTO {
  content: string
  category?: string
  sourceAgent?: string
}

export interface SplitGraphStateDTO {
  newsId: string
  mode: ExecutionMode
  content: string
  visibleContext: Record<string, string>
  routeInstructions: RouteInstruction[]
  subAgentResults: SubAgentSplitRecordDTO[]
  mergedClaims: RawClaimDTO[]
  rawMergeResponse: string
  /** 按条 save 的游标（下一条待落盘的 mergedClaims 下标） */
  saveIndex: number
}

export interface VerifyGraphStateDTO {
  newsId: string
  claimId: string
  mode: ExecutionMode
  claimContent: string
  originalContent: string
  visibleContext: Record<string, string>
  routeInstructions: RouteInstruction[]
  subAgentOpinions: SubAgentOpinionDTO[]
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
  routeInstructions?: RouteInstruction[]
}

export interface StartVerifyInput {
  newsId: string
  claimId: string
  mode?: ExecutionMode
  /** 可选人工预置核查槽，与 AI Route Agent 结果合并 */
  routeInstructions?: RouteInstruction[]
}

export interface StartGraphResult {
  runId: string
}

export interface GraphInterruptedPayload {
  runId: string
  graphType: GraphType
  nextNode: GraphInterruptNode
  mode: ExecutionMode
  state: SplitGraphStateDTO | VerifyGraphStateDTO
  /** Map 焦点：一次 interrupt 一个节点 */
  focus?: GraphInterruptFocus
  pendingTool?: MapToolKind
}

export interface ActiveRunDTO {
  runId: string
  newsId: string
  graphType: GraphType
  mode: ExecutionMode
  nextNode?: GraphInterruptNode
  focus?: GraphInterruptFocus
  pendingTool?: MapToolKind
  state?: SplitGraphStateDTO | VerifyGraphStateDTO
}

export interface GraphCompletedPayload {
  runId: string
  graphType: GraphType
  state: SplitGraphStateDTO | VerifyGraphStateDTO
}

export interface GraphErrorPayload {
  runId: string
  graphType: GraphType
  error: string
}

export type GraphProgressEvent = 'node_enter' | 'node_exit' | 'fanout_spawn'

export interface GraphProgressPayload {
  runId: string
  graphType: GraphType
  event: GraphProgressEvent
  node: string
  agentName?: string
  spawnIndex?: number
}

export type SplitStatePatch = Partial<SplitGraphStateDTO>
export type VerifyStatePatch = Partial<VerifyGraphStateDTO>
export type GraphStatePatch = SplitStatePatch | VerifyStatePatch | null

// ==========================================
// ElectronAPI — preload 暴露给渲染进程
// ==========================================

export interface NewsAPI {
  create(input: CreateNewsInput): Promise<NewsDocumentDTO>
  list(): Promise<NewsDocumentSummaryDTO[]>
  get(newsId: string): Promise<NewsDocumentDTO | null>
  update(newsId: string, patch: UpdateNewsInput): Promise<NewsDocumentDTO>
}

export interface ClaimsAPI {
  list(newsId: string): Promise<SplitClaimDTO[]>
  create(newsId: string, input: CreateClaimInput): Promise<SplitClaimDTO>
  update(newsId: string, claimId: string, patch: UpdateClaimInput): Promise<SplitClaimDTO>
  delete(newsId: string, claimId: string): Promise<void>
}

export interface CatalogEntryDTO {
  agentName: string
  displayLabel: string
  description?: string
  defaultPriority?: Priority
  module: 'split' | 'verify'
}

export interface CatalogAPI {
  list(module: 'split' | 'verify'): Promise<CatalogEntryDTO[]>
}

export interface GraphAPI {
  startSplit(input: StartSplitInput): Promise<StartGraphResult>
  startVerify(input: StartVerifyInput): Promise<StartGraphResult>
  resume(runId: string, modifications: GraphStatePatch): Promise<void>
  setMode(runId: string, mode: ExecutionMode): Promise<void>
  cancel(runId: string): Promise<void>
  getActiveRun(newsId: string): Promise<ActiveRunDTO | null>
}

export interface GraphEventAPI {
  onInterrupted(callback: (payload: GraphInterruptedPayload) => void): () => void
  onCompleted(callback: (payload: GraphCompletedPayload) => void): () => void
  onError(callback: (payload: GraphErrorPayload) => void): () => void
  onProgress(callback: (payload: GraphProgressPayload) => void): () => void
}

export interface ElectronAPI {
  news: NewsAPI
  claims: ClaimsAPI
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
