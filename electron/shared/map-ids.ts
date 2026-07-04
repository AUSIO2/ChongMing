/**
 * Map 节点 id 规则 —— Electron 与渲染进程 Port 共用，保证 focus / 投影一致。
 *
 * - news 根：NEWS_ROOT_ID
 * - subAgent：sub:${instanceId}
 * - claim（merge/落库）：String(saveIndex+1)，与 saveOneClaim 一致
 * - opinion：opinion:${claimId}:${index}
 */

export const NEWS_ROOT_ID = '__news_root__'

export function subAgentId(instanceId: string): string {
  return `sub:${instanceId}`
}

/** merge 后 / 落库 claim 的节点 id（saveIndex 为 mergedClaims 下标）。 */
export function mergedClaimNodeId(saveIndex: number): string {
  return String(saveIndex + 1)
}

/**
 * Mock 等非 merge 路径下，挂在某个 SubAgent 下的临时 claim id。
 * 真机 save 焦点不会使用此格式。
 */
export function workerClaimNodeId(instanceId: string, index: number): string {
  return `claim:${instanceId}:${index}`
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
