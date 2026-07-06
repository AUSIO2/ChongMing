/** auto 模式下同时推进的数据节点（Timeline work item）上限。 */

export const AGENT_DEFAULT_MAX_SUB_AGENT = 3

export function agentReadMaxSubAgent(): number {
  const raw = typeof process !== 'undefined' ? process.env?.MAX_SUB_AGENT : undefined
  const n = Number(raw ?? AGENT_DEFAULT_MAX_SUB_AGENT)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : AGENT_DEFAULT_MAX_SUB_AGENT
}
