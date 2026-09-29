// 定义通用数据图、有限运行计划、Agent 工作授权与阶段提案协议。
import type {
  DefinitionCatalog,
  DefinitionRef,
  ExecutionAgentDefinition,
  ExecutionSpec,
  ExecutionStageSpec,
  JsonValue,
  OutputContract,
} from './data-definition'

export type GraphPayload = { [key: string]: JsonValue }

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

/** 旧工作区管理仍用这个形状解析默认 Agent；Run 只使用冻结 ExecutionSpec。 */
export interface GraphRunConfiguration {
  parse?: GraphAgentProfile
  split?: { router: GraphAgentProfile; merger: GraphAgentProfile; agents: GraphAgentProfile[] }
  router: GraphAgentProfile
  merger: GraphAgentProfile
  agents: GraphAgentProfile[]
  tools: Array<{ name: string; description: string }>
  maxSlots: number
}

// 一份通用数据实例。类型规则来自不可变 typeId/typeVersion，payload 不携带业务 kind。
export interface GraphNode {
  id: string
  revision: number
  typeId: string
  typeVersion: number
  payload: GraphPayload
  // 服务端从类型声明派生的节点引用索引；不接受客户端直接写入，也不扩大 successor 范围。
  payloadReferences?: Array<{ path: string; targetId: string }>
  createdAt: string
  updatedAt: string
  importedFrom?: { bundleId: string; nodeId: string; revision: number }
  validity?: 'current' | 'stale'
  producer?: {
    operationId: string
    transitionRef: DefinitionRef
    stageId: string
    workId: string
    agentRef: DefinitionRef
    agentName: string
  }
}

// successor 参与结构分支遍历；reference 只表达引用，不扩大结构范围。
export type GraphEdgeKind = 'successor' | 'reference'

export interface GraphEdgeInput {
  id: string
  kind: GraphEdgeKind
  from: string
  to: string
  label?: string
}

export interface GraphEdge extends GraphEdgeInput {
  revision: number
  createdAt: string
  updatedAt: string
}

export interface GraphNodeInput {
  id: string
  typeId: string
  typeVersion: number
  payload: GraphPayload
}

export interface GraphChanges {
  name?: string
  nodes?: { put?: GraphNodeInput[]; remove?: string[] }
  edges?: { put?: GraphEdgeInput[]; remove?: string[] }
}

// 人工编辑所依据的实际分支内容版本。null 只表示本次创建尚不存在的独立根。
export interface GraphBranchProof {
  rootIds: string[]
  expectedVersion: string | null
}

export interface GraphBranchLeaseProof {
  leaseId: string
  holderId: string
  fence: number
}

export interface GraphBranchScope {
  rootIds: string[]
  nodeIds: string[]
  edgeIds: string[]
}

export interface GraphBranchSnapshot {
  scope: GraphBranchScope
  version: string
  rootRevisions: Record<string, number>
  // 仅用于把读取到的分支证明与同一次公开图快照配对；并发裁决仍只比较 version。
  mapRevision: number
}

export interface GraphBranchOwnership {
  leaseId: string
  kind: 'editor' | 'run'
  rootIds: string[]
  ownerUserId: string
  holderId: string
  fence: number
  expiresAt: string | null
  leaseMs: number | null
  runId?: string
  scope: GraphBranchScope
}

export interface GraphBranchGrant extends GraphBranchOwnership {
  kind: 'editor'
  expiresAt: string
  leaseMs: number
  branch: GraphBranchSnapshot
  ownershipRevision: number
}

export type GraphBranchClaimResult =
  | { status: 'claimed'; grant: GraphBranchGrant }
  | { status: 'busy'; ownership: GraphBranchOwnership }

export interface GraphRunControlProof {
  leaseId: string
  holderId: string
  fence: number
}

// Run 范围占有属于后台运行；控制租约只授权一个客户端执行暂停、继续、取消和审核。
export interface GraphRunControl {
  leaseId: string
  runId: string
  ownerUserId: string
  holderId: string
  fence: number
  expiresAt: string
  leaseMs: number
}

export interface GraphRunControlGrant extends GraphRunControl {
  ownershipRevision: number
}

export type GraphRunControlClaimResult =
  | { status: 'claimed'; grant: GraphRunControlGrant }
  | { status: 'busy'; control: GraphRunControl }

// 一份冻结输入在命名端口中的身份。key 在一个 Operation group 内稳定。
export interface GraphPortDataRef {
  key: string
  port: string
  id: string
  revision: number
  type: DefinitionRef
}

export interface GraphOperationGroup {
  id: string
  inputRefs: GraphPortDataRef[]
  contextRefs: GraphPortDataRef[]
  sealed: boolean
}

// 模型提交的新候选。正式节点身份由服务端在发布时分配。
export interface GraphProposedOutput {
  key: string
  port: string
  typeRef: DefinitionRef
  payload: GraphPayload
  sourceKeys?: string[]
  /** Server-assigned on acceptance; clients and models never choose a formal node identity. */
  nodeId?: string
}

export interface GraphCandidateRef { workId: string; key: string }

// plan 只能实例化冻结规格允许的后续阶段、Agent 和工具。
export interface GraphPlanSlot {
  id: string
  stageId: string
  agentRef: DefinitionRef
  angle: string
  hint: string
  priority: 'high' | 'medium' | 'low'
  tools: string[]
}

export interface GraphStagePlan {
  revision: number
  reason: string
  slots: GraphPlanSlot[]
  approved: boolean
}

export type GraphStageResult = {
  workId: string
  stageId: string
  slotId: string
  acceptedAt: string
  reason: string
} & (
  | { mode: 'outputs'; outputs: GraphProposedOutput[] }
  | { mode: 'selection'; selection: GraphCandidateRef[] }
  | { mode: 'plan'; plan: GraphStagePlan }
)

// 一个阶段模板及其实例化 Work 集合；空 outputs 也通过 accepted result 明确完成。
export interface GraphStageGroup {
  stageId: string
  expectedWorkIds: string[]
  results: GraphStageResult[]
  planSlots: GraphPlanSlot[]
  closed: boolean
}

export interface GraphReview {
  id: string
  kind: 'plan' | 'result'
  revision: number
  state: 'pending' | 'answered'
  decision: 'approve' | 'reject' | null
  createdAt: string
  answeredAt: string | null
}

export interface GraphOutputRef {
  id: string
  revision: number
  port: string
  workId: string
  key: string
}

// 每个 Operation 绑定一个转换、封闭输入组和完整冻结执行规格。
export interface GraphOperation {
  id: string
  stepId: string
  transitionRef: DefinitionRef
  specHash: string
  executionSpec: ExecutionSpec
  group: GraphOperationGroup
  externalInputs: Record<string, string>
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'skipped'
  stages: GraphStageGroup[]
  outputRefs: GraphOutputRef[]
  review: GraphReview | null
  reusedFromOperationId?: string
}

export type GraphPlanSource =
  | { kind: 'scope'; nodeIds: string[] }
  | { kind: 'step'; stepId: string; port: string }

export interface GraphPlanBinding { port: string; source: GraphPlanSource }

export type GraphPlanGrouping =
  | { mode: 'each' }
  | { mode: 'all' }
  | { mode: 'explicit'; groups: Array<{ id: string; members: Record<string, string[]> }> }

export interface GraphRunStep {
  id: string
  transitionRef: DefinitionRef
  dependsOn: string[]
  input: GraphPlanBinding[]
  context: GraphPlanBinding[]
  grouping: GraphPlanGrouping
  onEmpty: 'skip' | 'fail'
}

export interface GraphRunPlan { steps: GraphRunStep[] }

export interface GraphRunStepState {
  stepId: string
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
  operationIds: string[]
}

export interface GraphRun {
  id: string
  scope: { nodeIds: string[] }
  // 新运行冻结启动时的结构范围摘要；终态 legacyArchive 可缺省。
  branchState?: { scope: GraphBranchScope; version: string }
  plan: GraphRunPlan
  definitions: DefinitionCatalog
  agents: ExecutionAgentDefinition[]
  tools: Array<{ name: string; description: string }>
  maxAgentSlots: number
  paused: boolean
  regenerate: boolean
  mode: 'auto' | 'human-in-loop'
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
  error?: { code: string; message: string; workId: string }
  steps: GraphRunStepState[]
  operations: GraphOperation[]
  createdAt: string
  updatedAt: string
}

// 已领取 Work 的可信阶段/槽位身份。Host 位置和业务类型都不参与身份判断。
export interface GraphWork {
  workId: string
  mapId: string
  runId: string
  operationId: string
  stageId: string
  slotId: string
  specHash: string
  priority: 'high' | 'medium' | 'low'
}

export interface GraphWorkProof { workId: string; holderId: string; fence: number }

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

export interface GraphSnapshot {
  mapId: string
  workspaceId: string
  revision: number
  name: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  runs: GraphRun[]
  ownershipRevision: number
  ownerships: GraphBranchOwnership[]
  runControls: GraphRunControl[]
  updatedAt: string
}

export interface GraphMapSummary {
  id: string
  workspaceId: string
  revision: number
  name: string
  nodeCount: number
  typeCounts: Record<string, number>
  updatedAt: string
}

export interface GraphWriteResult {
  snapshot: GraphSnapshot
  createdNodeIds: string[]
  createdEdgeIds: string[]
  // 仅当证明与返回 snapshot 属于同一次提交时提供；重放若已有更新则省略。
  branch?: GraphBranchSnapshot
  // run.start 成功时原子授予启动窗口；终态 Run 不返回控制租约。
  runControl?: GraphRunControlGrant
}

export type GraphQuery =
  | { method: 'map.list'; params: { workspaceId: string } }
  | { method: 'map.get'; params: { mapId: string } }
  | { method: 'branch.get'; params: { mapId: string; rootIds: string[] } }
  | { method: 'run.get'; params: { mapId: string; runId: string } }

export type GraphCommand =
  | { requestId: string; method: 'map.create'; params: { workspaceId: string; expectedRevision: number; id: string; name: string } }
  | { requestId: string; method: 'map.delete'; params: { mapId: string; expectedRevision: number } }
  | { requestId: string; method: 'graph.apply'; params: { mapId: string; branch: GraphBranchProof; lease?: GraphBranchLeaseProof; changes: GraphChanges } }
  | { requestId: string; method: 'branch.claim'; params: { mapId: string; rootIds: string[]; holderId: string } }
  | { requestId: string; method: 'branch.renew'; params: { mapId: string; lease: GraphBranchLeaseProof } }
  | { requestId: string; method: 'branch.release'; params: { mapId: string; lease: GraphBranchLeaseProof } }
  | { requestId: string; method: 'run.control.claim'; params: { mapId: string; runId: string; holderId: string } }
  | { requestId: string; method: 'run.control.renew'; params: { mapId: string; runId: string; control: GraphRunControlProof } }
  | { requestId: string; method: 'run.control.release'; params: { mapId: string; runId: string; control: GraphRunControlProof } }
  | {
      requestId: string
      method: 'run.start'
      params: {
        mapId: string
        id: string
        branch: GraphBranchProof
        lease?: GraphBranchLeaseProof
        scope: { nodeIds: string[] }
        plan: GraphRunPlan
        regenerate?: boolean
        mode: 'auto' | 'human-in-loop'
      }
    }
  | { requestId: string; method: 'run.cancel'; params: { mapId: string; runId: string; control?: GraphRunControlProof } }
  | { requestId: string; method: 'run.pause'; params: { mapId: string; runId: string; control?: GraphRunControlProof } }
  | { requestId: string; method: 'run.resume'; params: { mapId: string; runId: string; control?: GraphRunControlProof } }
  | {
      requestId: string
      method: 'review.answer'
      params: {
        mapId: string
        runId: string
        operationId: string
        reviewId: string
        expectedReviewRevision: number
        decision: 'approve' | 'reject'
        control?: GraphRunControlProof
      }
    }

// data_read 只返回当前 Work 获权的投影、依赖结果和冻结合同。
export interface GraphDataRead {
  mapId: string
  runId: string
  operationId: string
  transitionRef: DefinitionRef
  specHash: string
  inputs: Record<string, Array<{ key: string; node: GraphNode }>>
  context: Record<string, Array<{ key: string; node: GraphNode }>>
  priorStageResults: GraphStageResult[]
  promptVariables: Record<string, string>
  stage: {
    id: string
    slotId: string
    agent: ExecutionAgentDefinition
    tools: Array<{ name: string; description: string }>
    plan?: ExecutionStageSpec['plan']
  }
  outputContract: OutputContract
  proposalId: string
  work: { id: string; stageId: string; slotId: string; specHash: string; status: 'ready' | 'accepted' }
}

export type GraphDataProposal = {
  mapId: string
  operationId: string
  id: string
  specHash: string
  reason: string
} & (
  | { kind: 'outputs'; outputs: GraphProposedOutput[] }
  | { kind: 'selection'; selection: GraphCandidateRef[] }
  | { kind: 'plan'; slots: GraphPlanSlot[] }
)

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
