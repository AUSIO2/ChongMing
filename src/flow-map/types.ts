/**
 * Map 层 Port —— 前端唯一可见的图与工具语义。
 *
 * 主判据：
 *   - 节点 = 有可修改的 params / 数据
 *   - 工具 = 无参动作（只能 continue / cancel），挂在 runtime / 快照级 pendingTool
 *   - 一次 interrupt 对应一个焦点节点（activeNodeId 唯一）
 *
 * 硬边界（NEVER 出现在本文件）：
 *   - split / verify 阶段名、GraphType、routeInstructions、
 *     subAgentResults、pendingValidatedClaims、verifyByClaimId、FlowScope
 *   - isBridge、edge.kind
 */

export type NodeKind = 'news' | 'subAgent' | 'claim' | 'opinion'

/** 工具：无 params，不是图上的独立实体。 */
export type ToolKind = 'invoke' | 'validate' | 'save'

export type DataPhase = 'workerOut' | 'pendingValidated' | 'persisted'

export type RunPhase = 'idle' | 'running' | 'interrupted' | 'completed' | 'error'

export type ExecutionMode = 'auto' | 'human-in-loop'

export type Priority = 'high' | 'medium' | 'low'

export type Confidence = 1 | 0.5 | 0

// ---------- 参数（节点的可编辑数据） ----------

export interface NewsParams {
  title?: string
  content: string
}

/**
 * SubAgent 槽位参数 — 对齐后端 RouteInstruction 可编辑面。
 * promptPath / model / tools 属注册表，不在此。
 */
export interface SubAgentParams {
  agentName: string
  displayLabel: string
  description?: string
  /** route 必填；扇出排序与 merge 加权 */
  priority: Priority
  /** route 可选；注入 SubAgent prompt 的 {{hint}} */
  hint?: string
}

/** 对齐 RawClaim / SplitClaim（priority 在槽上，不在 claim 上） */
export interface ClaimParams {
  content: string
  category?: string
  sourceAgent?: string
}

/** 对齐 SubAgentOpinion：reason→content，score→confidence */
export interface OpinionParams {
  content: string
  confidence: Confidence
  priority: Priority
  evidence?: string
}

// ---------- 节点 ----------

interface MapNodeBase {
  id: string
  /** 拓扑父节点。undefined 表示挂在新闻根。 */
  parentId?: string
  /**
   * 焦点工具标记。与快照级 activeNodeId / pendingTool 成对；
   * 仅焦点节点可有值，由 Adapter 写入。
   */
  runtime?: {
    /** 当前正在执行的工具（正在跑）。无工具参数。 */
    activeTool?: ToolKind
    /** 等待确认的工具（焦点节点上）。无工具参数。 */
    pendingTool?: ToolKind
  }
}

export interface NewsMapNode extends MapNodeBase {
  kind: 'news'
  params: NewsParams
}

export interface SubAgentMapNode extends MapNodeBase {
  kind: 'subAgent'
  params: SubAgentParams
}

export interface ClaimMapNode extends MapNodeBase {
  kind: 'claim'
  params: ClaimParams
  dataPhase: DataPhase
}

export interface OpinionMapNode extends MapNodeBase {
  kind: 'opinion'
  params: OpinionParams
  dataPhase: DataPhase
}

export type MapNode = NewsMapNode | SubAgentMapNode | ClaimMapNode | OpinionMapNode

// ---------- 边 ----------

export interface MapEdge {
  id: string
  from: string
  to: string
}

// ---------- 快照 ----------

export interface MapSnapshot {
  newsId: string
  nodes: MapNode[]
  edges: MapEdge[]
  runPhase: RunPhase
  mode: ExecutionMode
  /**
   * HITL 焦点节点 id。
   * interrupted 时必须有且仅有一个；与 pendingTool 成对出现。
   */
  activeNodeId?: string
  /** 焦点节点上等待确认的工具（无参）。 */
  pendingTool?: ToolKind
  /** 最近一次运行/API 错误；runPhase 可为 error，拓扑仍保留。 */
  error?: string
}

// ---------- Catalog（可添加的 SubAgent 目录） ----------

export interface SubAgentEntry {
  agentName: string
  displayLabel: string
  description?: string
  /** catalog 默认 priority，加槽时写入 SubAgentParams */
  defaultPriority?: Priority
}
