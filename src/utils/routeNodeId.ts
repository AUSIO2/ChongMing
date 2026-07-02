export function subAgentNodeId(routeIndex: number) {
  return `subAgent:${routeIndex}`
}

export function splitWorkerNodeId(routeIndex: number) {
  return `split:worker:${routeIndex}`
}

export function parseRouteIndexFromNodeId(id: string): number | null {
  const m = id.match(/^(?:subAgent|split:worker):(\d+)$/)
  return m ? Number(m[1]) : null
}
