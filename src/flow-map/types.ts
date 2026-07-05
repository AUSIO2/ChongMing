import type {
  CatalogSubAgent,
  Confidence,
  ExecutionMode,
  Priority,
  MapSubAgentParams,
} from '../../electron/api/types'

/**
 * Map 层 Port —— 前端唯一可见的图与工具语义。
 *
 * 主判据：
 *   - 节点 = 有可修改的 params / 数据
 *   - 工具 = 无参动作（只能 continue / cancel），挂在 runtime / 快照级 pendingTool
 *   - ReAct skill = SubAgent 内 LLM 工具调用，挂在 runtime.activeSkill（与 HITL 工具无关）
 *   - 一次 interrupt 对应一个焦点节点（activeNodeId 唯一）
 *
 * SubAgent 节点参数唯一来源：`MapSubAgentParams`（与图状态 routeInstructions 同形）。
 *
 * 硬边界（NEVER 出现在本文件）：
 *   - split / verify 阶段名、GraphType、
 *     subAgentResults、pendingValidatedClaims、verifyByClaimId、FlowScope
 *   - isBridge、edge.kind
 */

export type { MapSubAgentParams, Priority, Confidence, ExecutionMode, CatalogSubAgent }

export type MapNodeKind = 'news' | 'subAgent' | 'claim' | 'opinion'

/** 工具：无 params，不是图上的独立实体。 */
export type MapToolKind = 'invoke' | 'validate' | 'save'

export type MapDataPhase = 'workerOut' | 'persisted'

export type MapRunPhase = 'idle' | 'running' | 'interrupted' | 'completed' | 'error'

// ---------- 参数（节点的可编辑数据） ----------

export interface MapNewsParams {
  content: string
}

/** 对齐 GraphClaim / PersistClaim（priority 在槽上，不在 claim 上） */
export interface MapClaimParams {
  content: string
  category?: string
  sourceAgent?: string
}

/** 对齐 GraphOpinion：reason→content，score→confidence（只读投影） */
export interface MapOpinionParams {
  content: string
  confidence: Confidence
  priority: Priority
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
    activeTool?: MapToolKind
    /** 等待确认的工具（焦点节点上）。无工具参数。 */
    pendingTool?: MapToolKind
    /** SubAgent ReAct 正在调用的 skill（如 web_search）。 */
    activeSkill?: {
      name: string
      argsSummary?: string
    }
  }
}

export interface MapNewsNode extends MapNodeBase {
  kind: 'news'
  params: MapNewsParams
}

export interface MapSubAgentNode extends MapNodeBase {
  kind: 'subAgent'
  /** 与后端 routeInstructions 条目同形，唯一槽位参数来源。 */
  params: MapSubAgentParams
}

export interface MapClaimNode extends MapNodeBase {
  kind: 'claim'
  params: MapClaimParams
  dataPhase: MapDataPhase
  /**
   * 草稿是否保留待落库。默认 true；仅 merge 可改为 false。
   * 与 dataPhase 正交：人审确认后 shouldSave=false 的节点会被剔除。
   */
  shouldSave: boolean
}

export interface MapOpinionNode extends MapNodeBase {
  kind: 'opinion'
  params: MapOpinionParams
  dataPhase: MapDataPhase
}

export type MapNode = MapNewsNode | MapSubAgentNode | MapClaimNode | MapOpinionNode

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
  runPhase: MapRunPhase
  mode: ExecutionMode
  /**
   * HITL 焦点节点 id。
   * interrupted 时必须有且仅有一个；与 pendingTool 成对出现。
   */
  activeNodeId?: string
  /** 焦点节点上等待确认的工具（无参）。 */
  pendingTool?: MapToolKind
  /** 最近一次运行/API 错误；runPhase 可为 error，拓扑仍保留。 */
  error?: string
}
