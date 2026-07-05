/**
 * Map 节点 id 规则 —— Electron 与渲染进程 Port 共用，保证 focus / 投影一致。
 *
 * - news 根：NEWS_ROOT_ID
 * - subAgent：sub:${instanceId}，instanceId = agentName#n
 * - claim（merge/落库）：String(saveIndex+1)
 * - opinion：opinion:${claimId}:${index}
 *
 * 核查与拆分共用 instanceId；作用域由 parentId（claim / news 根）区分。
 */

import type { MapSubAgentParams, RouteInstructionDraft } from './types'

export const NEWS_ROOT_ID = '__news_root__'

export function mapIdCreateSubAgent(instanceId: string): string {
  return `sub:${instanceId}`
}

export function mapIdReadSubAgent(nodeId: string): string | undefined {
  return nodeId.startsWith('sub:') ? nodeId.slice('sub:'.length) : undefined
}

export function mapIdCreateRoute(route: Pick<MapSubAgentParams, 'instanceId'>): string {
  return mapIdCreateSubAgent(route.instanceId)
}

export function mapIdCreateClaim(saveIndex: number): string {
  return String(saveIndex + 1)
}

export function mapIdCreateOpinion(claimId: string, index: number): string {
  return `opinion:${claimId}:${index}`
}

export function mapIdCreateEdge(from: string, to: string): string {
  return `e:${from}->${to}`
}

export const DRAFT_CLAIM_PREFIX = 'draft:'

export function mapIdCreateDraftClaim(index: number): string {
  return `${DRAFT_CLAIM_PREFIX}${index}`
}

export function mapIdIsDraftClaim(id: string): boolean {
  return id.startsWith(DRAFT_CLAIM_PREFIX)
}

export function mapIdReadDraftIndex(id: string): number | undefined {
  if (!mapIdIsDraftClaim(id)) return undefined
  const n = Number.parseInt(id.slice(DRAFT_CLAIM_PREFIX.length), 10)
  return Number.isFinite(n) ? n : undefined
}

/** 与 Map draft:N 同序的 SubAgent 产出 claim（含槽位字段）。 */
export interface MapSubAgentClaimRow {
  content: string
  category?: string
  sourceAgent?: string
  agentName: string
  instanceId?: string
}

export function mapIdReadSubAgentClaim(
  results: Array<{
    agentName: string
    instanceId?: string
    claims: Array<{ content: string; category?: string; sourceAgent?: string }>
  }>,
): MapSubAgentClaimRow[] {
  return results.flatMap(result =>
    result.claims.map(claim => ({
      content: claim.content,
      category: claim.category,
      sourceAgent: claim.sourceAgent ?? result.agentName,
      agentName: result.agentName,
      instanceId: result.instanceId,
    })),
  )
}

/** 从 instanceId（agentName#n）解析 agentName。 */
export function mapIdReadAgentName(instanceId: string): string {
  const hash = instanceId.lastIndexOf('#')
  return hash >= 0 ? instanceId.slice(0, hash) : instanceId
}

function mapIdReadInstanceIndex(instanceId: string): number | undefined {
  const hash = instanceId.lastIndexOf('#')
  if (hash < 0) return undefined
  const n = Number.parseInt(instanceId.slice(hash + 1), 10)
  return Number.isFinite(n) ? n : undefined
}

/**
 * 在同一 parent 作用域内为 agentName 分配下一个 instanceId（agentName#n）。
 */
export function mapIdCreateInstance(
  agentName: string,
  existing: Array<Pick<MapSubAgentParams, 'instanceId'>>,
): string {
  let max = 0
  for (const item of existing) {
    if (mapIdReadAgentName(item.instanceId) !== agentName) continue
    const idx = mapIdReadInstanceIndex(item.instanceId)
    if (idx !== undefined && idx > max) max = idx
  }
  return `${agentName}#${max + 1}`
}

/** 写路径唯一补齐：对 drafts 逐条补 instanceId，existing 为同 parent 已有槽。 */
export function mapIdUpdateInstance(
  drafts: RouteInstructionDraft[],
  existing: Array<Pick<MapSubAgentParams, 'instanceId'>> = [],
): MapSubAgentParams[] {
  const allocated: MapSubAgentParams[] = []
  for (const draft of drafts) {
    const instanceId = draft.instanceId
      ?? mapIdCreateInstance(draft.agentName, [...existing, ...allocated])
    allocated.push({ ...draft, instanceId })
  }
  return allocated
}

/** 从 Map 节点 id 推断 interrupt 焦点 kind（restore 时 deriveInterruptFocus 无结果则用）。 */
export function mapIdReadNodeFocus(
  activeNodeId: string,
): { kind: 'news' | 'subAgent' | 'claim' | 'opinion'; id: string } {
  if (activeNodeId === NEWS_ROOT_ID) {
    return { kind: 'news', id: NEWS_ROOT_ID }
  }
  if (activeNodeId.startsWith('sub:')) {
    return { kind: 'subAgent', id: activeNodeId }
  }
  if (activeNodeId.startsWith('opinion:')) {
    return { kind: 'opinion', id: activeNodeId }
  }
  return { kind: 'claim', id: activeNodeId }
}

export type MapInterruptTool = 'invoke' | 'validate' | 'save'

export interface MapInterruptFocus {
  kind: 'news' | 'subAgent' | 'claim' | 'opinion'
  id: string
}

/** LangGraph 中断点 → Map 焦点节点与 pendingTool。 */
export function mapIdReadInterruptFocus(
  graphType: 'split' | 'verify',
  nextNode: string,
  state: {
    claimId?: string
    saveIndex?: number
    opinionSaveIndex?: number
  },
): { focus?: MapInterruptFocus; pendingTool?: MapInterruptTool } {
  if (nextNode === 'confirmRoute') {
    if (graphType === 'split') {
      return { focus: { kind: 'news', id: NEWS_ROOT_ID }, pendingTool: 'invoke' }
    }
    return { focus: { kind: 'claim', id: state.claimId! }, pendingTool: 'invoke' }
  }
  if (nextNode === 'validate') {
    if (graphType === 'split') {
      return { focus: { kind: 'news', id: NEWS_ROOT_ID }, pendingTool: 'validate' }
    }
    return { focus: { kind: 'claim', id: state.claimId! }, pendingTool: 'validate' }
  }
  if (nextNode === 'save') {
    if (graphType === 'split') {
      return {
        focus: { kind: 'claim', id: mapIdCreateClaim(state.saveIndex ?? 0) },
        pendingTool: 'save',
      }
    }
    const index = state.opinionSaveIndex ?? 0
    return {
      focus: { kind: 'opinion', id: mapIdCreateOpinion(state.claimId!, index) },
      pendingTool: 'save',
    }
  }
  return {}
}
