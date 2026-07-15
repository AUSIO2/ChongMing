import type {
  GraphParseState,
  GraphSplitState,
  GraphVerifyState,
  TransitionKey,
} from '../api/types'
import type { ExecutionMode } from '../shared/types'

export interface TransitionRunContext {
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  scopeNodeId?: string
  mode?: ExecutionMode
}

export type GraphTransitionState = GraphSplitState | GraphVerifyState | GraphParseState

export interface ColumnTransitionSpec {
  key: TransitionKey
  loadNode: string
  /**
   * 构建图。agents 来自当前 Map 所属工作区（已激活 prompt overlay）。
   * 未传 agents 时回落磁盘 catalog（测试）。
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildGraph: (agents?: import('../shared/types').AgentDoc[]) => any
  readInitialInput: (
    ctx: TransitionRunContext,
    threadId: string,
  ) => Record<string, unknown>
  serialize: (state: Record<string, unknown>) => GraphTransitionState
}
