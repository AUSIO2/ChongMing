// 定义有限运行计划、Operation 冻结输入、阶段结果、审核和 Run 状态。
import type { DefinitionCatalog, DefinitionRef, ExecutionAgentDefinition, ExecutionSpec } from './data-definition'
import type { GraphPayload } from './graph'
import type { GraphBranchScope } from './graph-branch'
import type { EvidenceFrozenClaim, EvidenceLibraryRef, EvidenceUseRef } from './evidence-library'

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
  libraryClaimRefs?: EvidenceUseRef[]
  /** Server-assigned on acceptance; clients and models never choose a formal node identity. */
  nodeId?: string
}

export interface GraphCandidateRef { workId: string; key: string }

// 运行目录只投影读取时的轻摘要，不复制定义、正文或完整Operation。
export interface GraphRunSummary {
  runId: string
  status: GraphRun['status']
  // 归档标记取实际存储归属，与完成或失败状态独立。
  archived: boolean
  mode: GraphRun['mode']
  paused: boolean
  createdAt: string
  updatedAt: string
  stepCount: number
  operationCount: number
  pendingReviewCount: number
  // 保存的outputRefs总数，包含复用产物引用，不是候选数。
  outputCount: number
}

// 单Map的有界目录；状态取每页读取时值，版本只绑定匹配成员和创建时间。
export interface GraphRunPage {
  mapId: string
  items: GraphRunSummary[]
  nextCursor: string | null
  directoryVersion: string
}

// 一次待结果审核的实际发布条目；正文沿同一审核下不可编辑的候选键读取。
export interface GraphPublicationItem extends GraphCandidateRef {
  stageId: string
  slotId: string
  port: string
  typeRef: DefinitionRef
  directlySelected: boolean
  // 实际发布集合中直接引用本候选的条目，去重但不展开完整路径。
  referencedBy: GraphCandidateRef[]
}

// 只读权威预览，不分配节点身份，也不取得任何运行控制权。
export interface GraphPublicationPreview {
  mapId: string
  runId: string
  operationId: string
  reviewId: string
  reviewRevision: number
  specHash: string
  // 后端计算的不透明版本；仅用于结果批准的内容条件，不是权限凭据。
  publicationVersion: string
  ports: Array<{ port: string; typeRef: DefinitionRef; count: number }>
  items: GraphPublicationItem[]
}

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

interface GraphStagePlan {
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

interface GraphOutputRef {
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

type GraphPlanSource =
  | { kind: 'scope'; nodeIds: string[] }
  | { kind: 'step'; stepId: string; port: string }

interface GraphPlanBinding { port: string; source: GraphPlanSource }

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
  libraryClaimRefs?: EvidenceLibraryRef[]
}

// 每步完整材料只保存一次，Operation 仅保存获权引用与精确定义。
export interface GraphLibraryClaimSet { stepId: string; claims: EvidenceFrozenClaim[] }

export interface GraphRunPlan { steps: GraphRunStep[] }

interface GraphRunStepState {
  stepId: string
  status: 'pending' | 'running' | 'completed' | 'skipped' | 'failed'
  operationIds: string[]
}

interface GraphRunState {
  id: string
  scope: { nodeIds: string[] }
  plan: GraphRunPlan
  definitions: DefinitionCatalog
  agents: ExecutionAgentDefinition[]
  tools: Array<{ name: string; description: string }>
  libraryClaimSets?: GraphLibraryClaimSet[]
  paused: boolean
  regenerate: boolean
  mode: 'auto' | 'human-in-loop'
  error?: { code: string; message: string; workId: string }
  steps: GraphRunStepState[]
  operations: GraphOperation[]
  createdAt: string
  updatedAt: string
}

// 当前协议建立的运行始终冻结分支范围与预算，进入终态后也保留这些信息。
export interface GraphCurrentRun extends GraphRunState {
  branchState: { scope: GraphBranchScope; version: string }
  maxAgentSlots: number
  status: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
}

// 旧执行的只读终态归档没有可执行分支证明，早期迁移也可能没有槽位预算。
interface GraphArchivedRun extends GraphRunState {
  branchState?: undefined
  maxAgentSlots?: number
  status: 'completed' | 'failed' | 'cancelled'
}

export type GraphRun = GraphCurrentRun | GraphArchivedRun
