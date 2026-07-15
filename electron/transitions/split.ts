import {
  agentReadSplitConfig,
  agentReadSplitConfigFromDocs,
} from '../api/agent-config'
import { serialReadSplitState } from '../api/serialize'
import { splitBuildGraph } from '../fact-extractor/extractor'
import { MAP_DEFAULT_SCOPE } from '../shared/map-scope'
import type { ColumnTransitionSpec, TransitionRunContext } from './types'

export const splitTransitionSpec: ColumnTransitionSpec = {
  key: '1-2',
  loadNode: 'loadNews',
  buildGraph: agents => splitBuildGraph(
    agents?.length
      ? agentReadSplitConfigFromDocs(agents)
      : agentReadSplitConfig(),
  ),
  readInitialInput: (ctx: TransitionRunContext, threadId: string) => ({
    mapId: ctx.mapId,
    parentNodeId: ctx.parentNodeId,
    mode: ctx.mode,
    threadId,
  }),
  serialize: state => serialReadSplitState(state as Parameters<typeof serialReadSplitState>[0]),
}

export function splitReadDefaultContext(mapId: string): TransitionRunContext {
  return {
    mapId,
    transitionKey: '1-2',
    parentNodeId: MAP_DEFAULT_SCOPE,
  }
}
