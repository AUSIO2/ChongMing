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
}

export interface StartSplitInput {
  newsId: string
  mode?: ExecutionMode
}

export interface StartVerifyInput {
  newsId: string
  claimId: string
  mode?: ExecutionMode
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

export interface GraphAPI {
  startSplit(input: StartSplitInput): Promise<StartGraphResult>
  startVerify(input: StartVerifyInput): Promise<StartGraphResult>
  resume(runId: string, modifications: GraphStatePatch): Promise<void>
  setMode(runId: string, mode: ExecutionMode): Promise<void>
  cancel(runId: string): Promise<void>
}

export interface GraphEventAPI {
  onInterrupted(callback: (payload: GraphInterruptedPayload) => void): () => void
  onCompleted(callback: (payload: GraphCompletedPayload) => void): () => void
  onError(callback: (payload: GraphErrorPayload) => void): () => void
}

export interface ElectronAPI {
  news: NewsAPI
  claims: ClaimsAPI
  graph: GraphAPI
  events: GraphEventAPI
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
