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
  /** 与 routeInstructions 槽位对应，同名多槽时区分父节点 */
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
  /** 拆分槽位历史，bootstrap Map 图用 */
  routeInstructions?: MapSubAgentParams[]
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
  mapRun?: MapRunPersist
  mapGraph?: MapGraphPersist
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
/**
 * LangGraph 中断点名称。对人/Map 而言对应工具（非 Map 节点）：
 *   confirmRoute → invoke；validate → validate；save → save。
 * merge 是图内 LLM 步骤，不做人审中断点，也不投影为 Map 节点。
 */
export type GraphInterruptNode = 'confirmRoute' | 'validate' | 'save'
export type GraphToolKind = 'invoke' | 'validate' | 'save'

/**
 * 当前暂停点是否允许 resume 时写入 routeInstructions。
 * 仅 pendingTool=invoke（confirmRoute）为 true。
 */
export function apiCanWriteRoute(pendingTool?: GraphToolKind): boolean {
  return pendingTool === 'invoke'
}

/** interrupt 焦点：一次中断对应一个 Map 节点 */
export interface GraphInterruptFocus {
  kind: 'news' | 'subAgent' | 'claim' | 'opinion'
  id: string
}

export interface GraphClaimDto {
  content: string
  category?: string
  sourceAgent?: string
  /** 是否保留待落库；默认 true；仅 merge 可改为 false */
  shouldSave?: boolean
}

/** 与 extractor `GraphClaim` 同形 */
export type GraphClaim = GraphClaimDto

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

/** News.mapRun — 未完成运行会话 */
export interface MapRunPersist {
  runId: string
  threadId: string
  graphType: GraphType
  mode: ExecutionMode
  gate?: GraphInterruptNode
  pendingTool?: GraphToolKind
  activeNodeId?: string
  status: 'running' | 'interrupted' | 'error'
  claimId?: string
  updatedAt: string
}

/** News.mapGraph — Map 图快照（可 hydrate 为 MapGraphDoc） */
export interface MapGraphPersist {
  nodes: unknown[]
  edges: unknown[]
  runPhase: string
  mode: ExecutionMode
  activeNodeId?: string
  pendingTool?: GraphToolKind
  nextNode?: GraphInterruptNode
  graphType?: GraphType
  draft?: GraphSplitState | GraphVerifyState
  error?: string
  updatedAt: string
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
  threadId?: string
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

export type GraphProgressGraphEvent = 'node_enter' | 'node_exit' | 'fanout_spawn'

export type GraphProgressPayload = {
  runId: string
  newsId: string
  graphType: GraphType
} & (
  | {
    event: GraphProgressGraphEvent
    node: string
    agentName?: string
    spawnIndex?: number
    /** fanout_spawn：SubAgent Map 节点 id */
    nodeId?: string
    /** fanout_spawn：父节点 id（news 根或 claim） */
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
export type GraphStatePatch = SplitStatePatch | VerifyStatePatch | null

// ==========================================
// ElectronAPI — preload 暴露给渲染进程
// ==========================================

export interface NewsAPI {
  create(input: CreateNewsInput): Promise<DisplayNews>
  list(): Promise<DisplayNewsSummary[]>
  get(newsId: string): Promise<DisplayNews | null>
  update(newsId: string, patch: UpdateNewsInput): Promise<DisplayNews>
  saveMapPersistence(
    newsId: string,
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
  newsId: string
  runId: string
  threadId: string
  graphType: GraphType
  mode: ExecutionMode
  gate: GraphInterruptNode
  pendingTool?: GraphToolKind
  activeNodeId?: string
  draft: GraphSplitState | GraphVerifyState
}

export interface GraphAPI {
  startSplit(input: StartSplitInput): Promise<StartGraphResult>
  startVerify(input: StartVerifyInput): Promise<StartGraphResult>
  resume(runId: string, modifications: GraphStatePatch): Promise<void>
  setMode(runId: string, mode: ExecutionMode): Promise<void>
  cancel(runId: string): Promise<void>
  getActiveRun(newsId: string): Promise<GraphActiveRun | null>
  /** 从 News.mapRun 恢复 HITL 等待循环 */
  restore(input: RestoreRunInput): Promise<StartGraphResult>
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
