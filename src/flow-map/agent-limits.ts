/**
 * 渲染进程可读：auto 模式下 Timeline 并行 pick 上限。
 * 勿从 electron/api/agent-config 引入（会拖入 fs 等 Node 模块）。
 */
export const AGENT_DEFAULT_MAX_SUB_AGENT = 3

export function agentReadMaxSubAgent(): number {
  const raw = typeof import.meta !== 'undefined'
    ? import.meta.env?.VITE_MAX_SUB_AGENT
    : undefined
  const n = Number(raw ?? AGENT_DEFAULT_MAX_SUB_AGENT)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : AGENT_DEFAULT_MAX_SUB_AGENT
}
