import type { TransitionKey } from '../api/types'
import type { ExecutionMode } from '../shared/types'

export interface TransitionRunContext {
  mapId: string
  transitionKey: TransitionKey
  parentNodeId: string
  scopeNodeId?: string
  mode?: ExecutionMode
}

export interface ColumnTransitionSpec {
  key: TransitionKey
  loadNode: string
  buildGraph: () => ReturnType<typeof import('../fact-extractor/extractor').splitBuildGraph>
  readInitialInput: (
    ctx: TransitionRunContext,
    threadId: string,
  ) => Record<string, unknown>
  serialize: (state: Record<string, unknown>) => import('../api/types').GraphSplitState
    | import('../api/types').GraphVerifyState
}
