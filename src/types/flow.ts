export type FlowNodePhase = 'hidden' | 'entering' | 'active' | 'done' | 'paused'

export type FlowNodeCategory = 'agent' | 'info'
export type FlowStage = 'split' | 'verify'
export type FlowAgentRole = 'load' | 'route' | 'worker' | 'merge' | 'save'
export type FlowInfoType = 'claim' | 'opinion'

export type PipelineStatus = 'idle' | 'running' | 'selectClaims' | 'completed' | 'error'

/** 画布交互阶段（面向用户的流程状态） */
export type FlowPhase =
  | 'idle'
  | 'running'
  | 'awaitingSplit'
  | 'awaitingSplitCommit'
  | 'awaitingVerifyRoute'
  | 'awaitingVerifyCommit'
  | 'selectClaims'
  | 'error'

export const FLOW_PHASE_LABELS: Record<FlowPhase, string> = {
  idle: '空闲',
  running: '运行中',
  awaitingSplit: '待拆分',
  awaitingSplitCommit: '待确认合并',
  awaitingVerifyRoute: '待配置核查',
  awaitingVerifyCommit: '待确认核查',
  selectClaims: '选择事实',
  error: '出错',
}

export interface FlowNodeVM {
  id: string
  nodeCategory: FlowNodeCategory
  kind: string
  label: string
  stage: FlowStage
  agentRole?: FlowAgentRole
  infoType?: FlowInfoType
  isBridge?: boolean
  /** 合并阶段标记移除，保存前以虚线展示 */
  pendingDelete?: boolean
  /** 合并新增、尚未写入文档的预览事实 */
  isPreview?: boolean
  agentName?: string
  claimId?: string
  claimIndex?: number
  parentId?: string
  spawnIndex?: number
  phase: FlowNodePhase
}

export interface FlowEdgeVM {
  id: string
  from: string
  to: string
  phase: 'hidden' | 'entering' | 'visible'
  edgeKind?: 'pipeline' | 'infoFanOut' | 'aggregate' | 'graphBridge' | 'mergeBridge'
}

export interface LayoutNode extends FlowNodeVM {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutEdge {
  id: string
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
  phase: FlowEdgeVM['phase']
  edgeKind?: FlowEdgeVM['edgeKind']
}
