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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  buildGraph: () => any
  readInitialInput: (
    ctx: TransitionRunContext,
    threadId: string,
  ) => Record<string, unknown>
  serialize: (state: Record<string, unknown>) => GraphTransitionState
}
