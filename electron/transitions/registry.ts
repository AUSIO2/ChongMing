import type { TransitionKey } from '../api/types'
import type { ColumnTransitionSpec } from './types'
import { parseTransitionSpec } from './parse'
import { splitTransitionSpec } from './split'
import { verifyTransitionSpec } from './verify'

export type { TransitionRunContext, ColumnTransitionSpec } from './types'

export const TRANSITION_REGISTRY: Record<TransitionKey, ColumnTransitionSpec> = {
  '0-1': parseTransitionSpec,
  '1-2': splitTransitionSpec,
  '2-3': verifyTransitionSpec,
}

export function transitionReadSpec(key: TransitionKey): ColumnTransitionSpec {
  return TRANSITION_REGISTRY[key]
}
