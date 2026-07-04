/**
 * Map 节点 id 规则 —— Electron 与渲染进程 Port 共用，保证 focus / 投影一致。
 *
 * - news 根：NEWS_ROOT_ID
 * - subAgent：sub:${instanceId}
 * - claim（merge/落库）：String(saveIndex+1)，与 saveOneClaim 一致
 * - opinion：opinion:${claimId}:${index}
 */

import type { MapSubAgentParams } from './types'

export const NEWS_ROOT_ID = '__news_root__'

export function subAgentId(instanceId: string): string {
  return `sub:${instanceId}`
}

/** MapSubAgentParams → 稳定 instanceId（缺省用 agentName）。 */
export function routeInstanceId(route: Pick<MapSubAgentParams, 'agentName' | 'instanceId'>): string {
  return route.instanceId ?? route.agentName
}

/** MapSubAgentParams → Map subAgent 节点 id。 */
export function routeNodeId(route: Pick<MapSubAgentParams, 'agentName' | 'instanceId'>): string {
  return subAgentId(routeInstanceId(route))
}

/** merge 后 / 落库 claim 的节点 id（saveIndex 为 mergedClaims 下标）。 */
export function mergedClaimNodeId(saveIndex: number): string {
  return String(saveIndex + 1)
}

/** opinion 节点 id；claimId 为父 claim 的 Map 节点 id。 */
export function opinionNodeId(claimId: string, index: number): string {
  return `opinion:${claimId}:${index}`
}

export function edgeId(from: string, to: string): string {
  return `e:${from}->${to}`
}

/** 核查槽默认 instanceId（claim 作用域内按 agentName 区分）。 */
export function verifyInstanceId(claimId: string, agentName: string, seq = 1): string {
  return seq <= 1 ? `${claimId}:${agentName}` : `${claimId}:${agentName}#${seq}`
}
