export interface AgentCall {
  callId: string
  sessionId?: string
  prompt: string
  agent: {
    name: string
    model?: string
    baseUrl?: string
    tools: string[]
  }
}

export interface AgentResult {
  text: string
  sessionId?: string
}

export type AgentEvent =
  | { type: 'delta'; channel: 'thinking' | 'text'; text: string }
  | { type: 'tool-start'; name: string; argsSummary?: string }
  | { type: 'tool-end'; name: string }

export interface AgentLoop {
  run(
    call: AgentCall,
    options: {
      signal: AbortSignal
      onEvent: (event: AgentEvent) => void
    },
  ): Promise<AgentResult>
  close(): Promise<void>
}

export type MapperStage = 'parse' | 'split' | 'verify'
export type MapperStep =
  | 'load'
  | 'route'
  | 'confirm-route'
  | 'workers'
  | 'merge'
  | 'validate'
  | 'save'
  | 'done'

export interface MapperTimeline {
  startX: 0 | 1 | 2 | 3
  endX: 0 | 1 | 2 | 3
  stateIndex?: 0 | 1 | 2 | 3
  activeScope: string
}

export interface SourceRecord {
  id: string
  uri: string
  kind: 'file' | 'url'
  label?: string
}

export interface NewsRecord {
  id: string
  sourceId?: string
  content: string
  context: NewsContext
}

export interface RouteRecord {
  parentId: string
  agentName: string
  priority: Priority
  hint?: string
  instanceId: string
}

export interface OpinionRecord {
  agentName: string
  instanceId: string
  priority: Priority
  score: Confidence
  reason: string
}

export interface ClaimRecord {
  id: string
  newsId?: string
  content: string
  category?: string
  sourceAgent?: string
  sourceInstanceId?: string
  verify?: {
    score: Confidence
    reason: string
    opinions: OpinionRecord[]
  }
}

export interface MapperDraftCall extends AgentResult {
  callId: string
  agentName: string
  instanceId?: string
}

export interface MapperRun {
  runId: string
  stage: MapperStage
  step: MapperStep
  status: 'running' | 'interrupted' | 'cancelled' | 'error'
  mode: ExecutionMode
  targetId: string
  error?: string
  draft: {
    routes: RouteRecord[]
    calls: MapperDraftCall[]
    output?: string
    claims?: ClaimRecord[]
    opinions?: OpinionRecord[]
    verify?: ClaimRecord['verify']
    saveIndex: number
  }
  updatedAt: string
}

export interface MapperDocument {
  id: string
  workspaceId: string
  name?: string
  sources: SourceRecord[]
  news: NewsRecord[]
  claims: ClaimRecord[]
  routes: RouteRecord[]
  timeline: MapperTimeline
  run?: MapperRun
  revision: number
  createdAt: string
  updatedAt: string
}

export type MapperToolKind = 'invoke' | 'validate' | 'save'
export type MapperDataPhase = 'workerOut' | 'persisted'

export interface MapperNodeRuntime {
  activeTool?: MapperToolKind
  pendingTool?: MapperToolKind
  activeSkill?: { name: string; argsSummary?: string }
  stream?: { thinking: string; text: string }
}

interface MapperNodeBase {
  id: string
  parentId?: string
  runtime?: MapperNodeRuntime
}

export interface MapperSourceNode extends MapperNodeBase {
  kind: 'source'
  params: Omit<SourceRecord, 'id'>
}

export interface MapperParseAgentNode extends MapperNodeBase {
  kind: 'parseAgent'
  parentId: string
  params: { agentName: string }
}

export interface MapperNewsNode extends MapperNodeBase {
  kind: 'news'
  params: Pick<NewsRecord, 'content'>
}

export interface MapperSubAgentNode extends MapperNodeBase {
  kind: 'subAgent'
  parentId: string
  params: Omit<RouteRecord, 'parentId'>
}

export interface MapperClaimNode extends MapperNodeBase {
  kind: 'claim'
  params: Pick<ClaimRecord, 'content' | 'category' | 'sourceAgent'> & {
    confidence?: Confidence
    verifyReason?: string
  }
  dataPhase: MapperDataPhase
  shouldSave: boolean
}

export interface MapperOpinionNode extends MapperNodeBase {
  kind: 'opinion'
  parentId: string
  params: {
    content: string
    confidence: Confidence
    priority: Priority
  }
  dataPhase: MapperDataPhase
}

export type MapperNode =
  | MapperSourceNode
  | MapperParseAgentNode
  | MapperNewsNode
  | MapperSubAgentNode
  | MapperClaimNode
  | MapperOpinionNode

export interface MapperSnapshot {
  mapId: string
  name?: string
  nodes: MapperNode[]
  edges: Array<{ id: string; from: string; to: string }>
  runPhase: 'idle' | 'running' | 'interrupted' | 'completed' | 'error'
  mode: ExecutionMode
  activeNodeId?: string
  pendingAction?: 'confirm-route' | 'validate' | 'save'
  pendingTool?: MapperToolKind
  agentStream?: {
    node: 'route' | 'merge'
    thinking: string
    text: string
  }
  error?: string
  timeline: MapperTimeline
  activeNews?: NewsRecord
}

export interface MapperMapSummary {
  id: string
  workspaceId: string
  name?: string
  newsCount: number
  claimCount: number
  createdAt: string
  updatedAt: string
}

export interface MapperLeaseInfo {
  holderId: string
  acquiredAt: string
  heartbeatAt: string
  expiresAt: string
  isMine: boolean
}

export interface MapperLeaseResult {
  ok: boolean
  lease: MapperLeaseInfo | null
}

export type MapperQuery =
  | { type: 'map.list'; workspaceId: string }
  | { type: 'map.snapshot'; mapId: string }

export type MapperNodeCreate =
  | { kind: 'source'; uri: string; sourceKind: 'file' | 'url'; label?: string }
  | { kind: 'news'; sourceId?: string; content: string; context?: NewsContext }
  | { kind: 'claim'; newsId?: string; content: string; category?: string; sourceAgent?: string }
  | {
      kind: 'route'
      parentId: string
      agentName: string
      priority: Priority
      hint?: string
      instanceId?: string
    }

export type MapperNodePatch =
  | { kind: 'source'; uri?: string; sourceKind?: 'file' | 'url'; label?: string }
  | { kind: 'news'; content?: string; context?: NewsContext }
  | { kind: 'claim'; content?: string; category?: string; sourceAgent?: string }
  | { kind: 'route'; priority?: Priority; hint?: string }

export type MapperCommand =
  | { type: 'map.create'; workspaceId: string; name?: string }
  | { type: 'map.rename'; mapId: string; name: string }
  | { type: 'map.delete'; mapId: string }
  | { type: 'node.create'; mapId: string; node: MapperNodeCreate }
  | { type: 'node.update'; mapId: string; nodeId: string; patch: MapperNodePatch }
  | { type: 'node.delete'; mapId: string; nodeId: string }
  | { type: 'timeline.update'; mapId: string; patch: Partial<MapperTimeline> }
  | { type: 'lease.acquire'; mapId: string }
  | { type: 'lease.release'; mapId: string }
  | {
      type: 'run.start'
      mapId: string
      mode: ExecutionMode
      selectedNodeId?: string
    }
  | {
      type: 'run.continue'
      mapId: string
      decision?: {
        output?: string
        routes?: RouteRecord[]
        claims?: ClaimRecord[]
        opinions?: OpinionRecord[]
        verify?: ClaimRecord['verify']
        mode?: ExecutionMode
      }
    }
  | { type: 'run.cancel'; mapId: string }
  | { type: 'run.set-mode'; mapId: string; mode: ExecutionMode }
  | { type: 'claims.dedup'; mapId: string }
  | {
      type: 'routes.batch-update'
      mapId: string
      patch: {
        priority?: Priority
        hint?: string
        agentName?: string
        parentId?: string
      }
    }

export type MapperReadResult =
  | { type: 'map.list'; maps: MapperMapSummary[] }
  | { type: 'map.snapshot'; snapshot: MapperSnapshot | null }

export type MapperDispatchResult =
  | { type: 'map.deleted'; mapId: string }
  | { type: 'map.updated'; snapshot: MapperSnapshot }
  | {
      type: 'lease.updated'
      mapId: string
      ok: MapperLeaseResult['ok']
      lease: MapperLeaseResult['lease']
    }

export interface MapperUpdated {
  mapId: string
  snapshot: MapperSnapshot
}

export interface MapperAPI {
  read(query: MapperQuery): Promise<MapperReadResult>
  dispatch(command: MapperCommand): Promise<MapperDispatchResult>
  watch(listener: (event: MapperUpdated) => void): () => void
}
import type {
  Confidence,
  ExecutionMode,
  NewsContext,
  Priority,
} from '../shared/types'
