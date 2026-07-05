import { agentReadVerifyConfig } from '../api/agent-config'
import { serialReadVerifyState } from '../api/serialize'
import { verifyBuildGraph } from '../fact-verifier/verifier'
import { MAP_DEFAULT_SCOPE } from '../shared/map-scope'
import type { ColumnTransitionSpec, TransitionRunContext } from './types'

export const verifyTransitionSpec: ColumnTransitionSpec = {
  key: '2-3',
  loadNode: 'loadClaim',
  buildGraph: () => verifyBuildGraph(agentReadVerifyConfig()),
  readInitialInput: (ctx: TransitionRunContext, threadId: string) => ({
    mapId: ctx.mapId,
    parentNodeId: ctx.parentNodeId,
    scopeNodeId: ctx.scopeNodeId ?? MAP_DEFAULT_SCOPE,
    mode: ctx.mode,
    threadId,
  }),
  serialize: state => serialReadVerifyState(state as Parameters<typeof serialReadVerifyState>[0]),
}
