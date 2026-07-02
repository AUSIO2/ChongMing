import type { SplitGraphStateDTO } from '../../electron/api/types'
import type { FlowNodeVM } from '../types/flow'
import { parseRouteIndexFromNodeId } from './routeNodeId'

export interface ClaimLike {
  content: string
  category?: string
  sourceAgent?: string
}

export function claimKey(c: ClaimLike): string {
  return `${c.content.trim()}|${c.category ?? ''}|${c.sourceAgent ?? ''}`
}

export function isClaimInList(claim: ClaimLike, list: ClaimLike[]): boolean {
  const key = claimKey(claim)
  return list.some(item => claimKey(item) === key)
}

export function findClaimIndex(claim: ClaimLike, list: ClaimLike[]): number {
  const key = claimKey(claim)
  return list.findIndex(item => claimKey(item) === key)
}

/** 从拓扑 claim 节点解析对应的事实数据 */
export function resolveClaimFromNode(
  node: FlowNodeVM,
  graphState: SplitGraphStateDTO | null,
  mergeDraft?: ClaimLike[],
): ClaimLike | null {
  if (node.kind !== 'claim' || node.isBridge) return null

  if (node.isPreview && mergeDraft) {
    const results = graphState?.subAgentResults ?? []
    const previews = mergeDraft.filter(
      m => !results.some(r => r.claims.some(c => isClaimInList(c, [m]))),
    )
    const row = Number(node.id.replace('preview:merged:', ''))
    return Number.isNaN(row) ? null : (previews[row] ?? null)
  }

  if (node.agentName != null && node.claimIndex != null && graphState) {
    if (node.parentId) {
      const resultIndex = parseRouteIndexFromNodeId(node.parentId)
      if (resultIndex != null && resultIndex < graphState.subAgentResults.length) {
        return graphState.subAgentResults[resultIndex]?.claims[node.claimIndex] ?? null
      }
    }
    return graphState.subAgentResults
      .find(r => r.agentName === node.agentName)
      ?.claims[node.claimIndex] ?? null
  }

  return null
}
