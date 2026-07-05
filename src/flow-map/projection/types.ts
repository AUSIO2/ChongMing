import type {
  GraphParseState,
  GraphSplitState,
  GraphStatePatch,
  GraphVerifyState,
  TransitionKey,
} from '../../electron/api/types'
import type { MapGraphDoc } from '../graph-doc'
import type { MapNodeKind } from '../types'
import type { ProjUpdateContext } from './gate-policy'

export interface ProjSpec {
  key: TransitionKey
  readAnchorId(state: GraphParseState | GraphSplitState | GraphVerifyState): string
  pruneKinds: MapNodeKind[]
  resetDefaultNews?: boolean
  updateGraph(
    doc: MapGraphDoc,
    state: GraphParseState | GraphSplitState | GraphVerifyState,
    ctx?: ProjUpdateContext,
  ): void
  updateDraft?(doc: MapGraphDoc): void
  readResume?(doc: MapGraphDoc): GraphStatePatch | null
}
