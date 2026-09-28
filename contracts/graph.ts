// 定义图快照、执行计划、工作授权、Agent 提案及公共读写协议。
// 新闻上下文值及是否允许进入模型输入的可见性。
export interface ContextField {
  value: string
  visibleToAI: boolean
}

// 持久化业务节点数据，按来源、证据、新闻、陈述或核验结果区分结构。
export type GraphNodeData =
  | { kind: 'source'; locator: GraphLocator; label: string | null }
  | { kind: 'evidence'; content: string; locator: GraphLocator; capturedAt: string }
  | { kind: 'news'; content: string; context: Record<string, ContextField> }
  | { kind: 'claim'; content: string; category: string | null }
  | { kind: 'verification'; score: 0 | 0.5 | 1; reason: string; reportIds: string[]; opinions: GraphReport[] }

// 来源定位信息，指向已存资产或外部 URL。
export type GraphLocator = { kind: 'asset'; assetId: string; mediaType: string } | { kind: 'url'; url: string }

// 已解析供执行使用的 Agent 内容、工具和模型设置。
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

// 一次 Run 使用的解析、拆分及核验配置快照，包含工具目录与槽位上限。
export interface GraphRunConfiguration {
  parse?: GraphAgentProfile
  split?: { router: GraphAgentProfile; merger: GraphAgentProfile; agents: GraphAgentProfile[] }
  router: GraphAgentProfile
  merger: GraphAgentProfile
  agents: GraphAgentProfile[]
  tools: Array<{ name: string; description: string }>
  maxSlots: number
}

// 一次分工中的槽位身份、Agent、调查角度、优先级和允许工具。
export interface GraphRouteSlot {
  id: string
  agentId: string
  angle: string
  priority: 'high' | 'medium' | 'low'
  hint: string
  tools: string[]
}

// 带版本与批准状态的分工方案，报告必须绑定对应路由版本。
export interface GraphRoute {
  revision: number
  reason: string
  slots: GraphRouteSlot[]
  approved: boolean
}

// 待接受的合并结果，固定所依据的路由版本与报告编号。
export interface GraphMergeDraft {
  id: string
  routeRevision: number
  reportIds: string[]
  score: 0 | 0.5 | 1
  reason: string
}

/** 可信桥接绑定的角色身份由认证后的执行授权确定，不接受模型参数指定身份。 */
export type GraphDataActor = { role: 'parse' | 'router' | 'merge' } | { role: 'worker'; slotId: string }

// 证明某次领取身份的工作编号、持有者和 fence，用于隔离旧执行。
export interface GraphWorkProof {
  workId: string
  holderId: string
  fence: number
}

// 某次 Operation 下一个角色的可执行工作描述。
export interface GraphWork {
  workId: string
  mapId: string
  runId: string
  operationId: string
  actor: GraphDataActor
  routeRevision: number
}

// 授予特定 Host 的工作及租约证明，包含服务端到期时间与租约时长。
export interface GraphWorkGrant extends GraphWork, GraphWorkProof {
  hostId: string
  expiresAt: string
  leaseMs: number
}

// Host 工作生命周期协议，除 claim 外均需携带当前租约证明。
export type GraphWorkCommand =
  | { method: 'claim'; params: { hostId: string; holderId: string; mapId: string; workId: string; deploymentId: string } }
  | { method: 'read'; params: GraphWorkProof & { mapId: string } }
  | { method: 'renew'; params: GraphWorkProof & { mapId: string } }
  | { method: 'release'; params: GraphWorkProof & { mapId: string } }
  | { method: 'fail'; params: GraphWorkProof & { mapId: string; message: string } }

// 图中的业务节点、版本和来源投影；执行状态由 Run/Operation 单独表达。
export interface GraphNode {
  id: string
  revision: number
  data: GraphNodeData
  createdAt: string
  updatedAt: string
  importedFrom?: { bundleId: string; nodeId: string; revision: number }
  validity?: 'current' | 'stale'
  /** 从已接纳的 Operation 历史投影出的只读来源信息，不代表可执行节点。 */
  producer?: { operationId: string; kind: 'parse' | 'split'; inputId: string; agentId: string; agentName: string; slotId?: string; angle?: string }
}

// 业务节点之间允许的关系种类。
export type GraphEdgeKind = 'derived-from' | 'mentions' | 'verifies' | 'related-to'

// 图边的稳定编号、关系种类及有向两端。
export interface GraphEdgeInput {
  id: string
  kind: GraphEdgeKind
  from: string
  to: string
}

// 持久化图边，补充版本及创建更新时间。
export interface GraphEdge extends GraphEdgeInput {
  revision: number
  createdAt: string
  updatedAt: string
}

// 一次图编辑的可选改名和节点、边增删集合。
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

// 某个图版本的完整公开状态，含业务节点、边和当前 Run。
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

// 绑定槽位与路由版本的核验意见，保留 Agent 和使用工具信息。
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

// 路由或结果的人工审核状态及独立审核版本。
export interface GraphReview {
  id: string
  kind: 'route' | 'result'
  revision: number
  state: 'pending' | 'answered'
  decision: 'approve' | 'reject' | null
  createdAt: string
  answeredAt: string | null
}

// 针对一个目标节点的执行记录，保存输入输出引用、角色报告、草稿与审核状态。
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

// 一次图执行计划及其配置快照，汇总各 Operation 和暂停、失败、终止状态。
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

// 图列表使用的概况及版本，省略完整节点与执行细节。
export interface GraphMapSummary {
  id: string
  workspaceId: string
  revision: number
  name: string
  nodeCount: number
  claimCount: number
  updatedAt: string
}

// 图写入后的公开快照以及本次创建的节点、边编号。
export interface GraphWriteResult {
  snapshot: GraphSnapshot
  createdNodeIds: string[]
  createdEdgeIds: string[]
}

// 公共图查询的参数协议。
export type GraphQuery =
  | { method: 'map.list'; params: { workspaceId: string } }
  | { method: 'map.get'; params: { mapId: string } }
  | { method: 'run.get'; params: { mapId: string; runId: string } }

// 带幂等请求编号的公共图命令，变更需匹配图及必要的审核版本。
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

// 提供给已授权执行角色的业务输入及上下文，包含本次工作和提案编号。
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

// Agent 提交的解析、分工、报告或合并结果，按种类绑定必要路由与报告信息。
export type GraphDataProposal = { mapId: string; operationId: string; id: string } & (
  | { kind: 'parse'; reason: string; news: GraphNewsOutput[] }
  | { kind: 'split-report'; routeRevision: number; slotId: string; reason: string; claims: GraphClaimOutput[] }
  | { kind: 'split-merge'; routeRevision: number; reportIds: string[]; reason: string; selected: GraphClaimSelection[] }
  | { kind: 'route'; reason: string; slots: GraphRouteSlot[] }
  | { kind: 'report'; routeRevision: number; slotId: string; score: 0 | 0.5 | 1; reason: string }
  | { kind: 'merge'; routeRevision: number; reportIds: string[]; score: 0 | 0.5 | 1; reason: string }
)

// 解析阶段产出的新闻正文及上下文。
export interface GraphNewsOutput { content: string; context: Record<string, ContextField> }
// 拆分阶段产出的陈述正文及可选类别。
export interface GraphClaimOutput { content: string; category: string | null }
// 合并阶段按报告编号和报告内索引选择陈述。
export interface GraphClaimSelection { reportId: string; index: number }
// 拆分角色的报告，以陈述列表替代核验评分。
export interface GraphSplitReport extends Omit<GraphReport, 'score'> { claims: GraphClaimOutput[] }
// 待接纳的解析新闻草稿或拆分选择草稿。
export type GraphContentDraft =
  | { kind: 'parse'; reason: string; news: GraphNewsOutput[] }
  | { kind: 'split'; reason: string; selected: GraphClaimSelection[] }

// 成功响应携带请求编号和收据重放标记，业务结果位于 data。
export interface GraphSuccess<T> {
  ok: true
  requestId: string
  replayed: boolean
  data: T
}

// 失败响应携带请求编号及可重试性、诊断编号和可选当前版本。
export interface GraphFailure {
  ok: false
  requestId: string
  error: { code: string; message: string; retryable: boolean; errorId: string; currentRevision?: number }
}
