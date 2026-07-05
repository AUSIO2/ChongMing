import type { TransitionKey } from '../../electron/api/types'
import { parseProjSpec } from './parse'
import { splitProjSpec, projReadSplitClaimParent } from './split'
import type { ProjSpec } from './types'
import { verifyProjSpec, projUpdateVerifyOpinion } from './verify'

export const PROJ_REGISTRY: Record<TransitionKey, ProjSpec> = {
  '0-1': parseProjSpec,
  '1-2': splitProjSpec,
  '2-3': verifyProjSpec,
}

export function projReadSpec(key: TransitionKey): ProjSpec {
  return PROJ_REGISTRY[key]
}

export { projReadGatePolicy, projCanPruneRoutes } from './gate-policy'
export type { ProjGatePolicy, ProjUpdateContext } from './gate-policy'
export type { ProjSpec } from './types'
export { projDeleteSubtree, projResetDefaultNews, projUpdateRouteSlots } from './hitl-column'
export { projReadSplitClaimParent } from './split'
export { projUpdateVerifyOpinion } from './verify'
