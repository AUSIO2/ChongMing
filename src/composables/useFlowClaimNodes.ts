import type {
  GraphType,
  SplitGraphStateDTO,
  VerifyGraphStateDTO,
} from '../../electron/api/types'
import { createInitialFlowNodes } from './useFlowTopology'
import type { FlowNodeVM } from '../types/flow'
import {
  buildUnifiedFlowNodes,
  type UnifiedFlowInput,
} from './useUnifiedFlowFromNews'

const CLAIM_CATEGORY_LABELS: Record<string, string> = {
  data: '数据',
  quote: '引用',
  event: '事件',
  causal: '因果',
  other: '其他',
}

export function claimTypeLabel(category?: string): string {
  if (!category) return '未分类'
  return CLAIM_CATEGORY_LABELS[category] ?? category
}

/** @deprecated 由 buildUnifiedFlowNodes 替代，保留 claimTypeLabel 导出 */
export function buildClaimNodes(
  _graphState: SplitGraphStateDTO | VerifyGraphStateDTO | null,
  _pipelineNodes: FlowNodeVM[],
): FlowNodeVM[] {
  return []
}

export function resolveFlowNode(
  id: string | null,
  graphType: GraphType | null,
  flowNodes: FlowNodeVM[],
  graphState: SplitGraphStateDTO | VerifyGraphStateDTO | null,
  extra?: Partial<UnifiedFlowInput>,
): FlowNodeVM | null {
  if (!id) return null

  const inPipeline = flowNodes.find(n => n.id === id)
  if (inPipeline) return inPipeline

  const initial = createInitialFlowNodes(graphType ?? 'split').find(n => n.id === id)
  if (initial) return initial

  if (extra?.news != null) {
    return resolveFlowNodeFromUnified(id, {
      news: extra.news,
      graphState,
      graphType,
      runtimeNodes: flowNodes,
      pipelineStatus: extra.pipelineStatus ?? 'idle',
      activeClaimId: extra.activeClaimId ?? null,
      claimsToVerify: extra.claimsToVerify ?? [],
      commitMergedClaims: extra.commitMergedClaims ?? null,
      isSplitCommitStep: extra.isSplitCommitStep ?? false,
    })
  }

  return null
}

function resolveFlowNodeFromUnified(id: string, input: UnifiedFlowInput): FlowNodeVM | null {
  return buildUnifiedFlowNodes(input).find(n => n.id === id) ?? null
}
