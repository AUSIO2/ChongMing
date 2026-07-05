import { agentReadParseConfig } from '../api/agent-config'
import { serialReadParseState } from '../api/serialize'
import { parseBuildGraph } from '../fact-parser/parser'
import type { ColumnTransitionSpec, TransitionRunContext } from './types'

export const parseTransitionSpec: ColumnTransitionSpec = {
  key: '0-1',
  loadNode: 'loadSource',
  buildGraph: () => parseBuildGraph(agentReadParseConfig()),
  readInitialInput: (ctx: TransitionRunContext, threadId: string) => ({
    mapId: ctx.mapId,
    parentNodeId: ctx.parentNodeId,
    mode: ctx.mode,
    threadId,
  }),
  serialize: state => serialReadParseState(state as Parameters<typeof serialReadParseState>[0]),
}
