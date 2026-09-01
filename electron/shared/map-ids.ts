import type { MapSubAgentParams, RouteInstructionDraft } from './types'

export const MAP_DEFAULT_CHAIN_ID = 'default'
export const MAP_DEFAULT_NEWS_ID = `news:${MAP_DEFAULT_CHAIN_ID}`

export function mapIdIsDefaultNews(nodeId: string): boolean {
  return nodeId === MAP_DEFAULT_NEWS_ID
}

export function mapIdCreateChain(): string {
  return crypto.randomUUID().slice(0, 8)
}

export function mapIdCreateSource(chainId: string): string {
  return `source:${chainId}`
}

export function mapIdCreateParse(chainId: string): string {
  return `parse:${chainId}`
}

export function mapIdCreateNews(chainId: string): string {
  return `news:${chainId}`
}

export function mapIdReadChain(nodeId: string): string | undefined {
  for (const prefix of ['source:', 'parse:', 'news:']) {
    if (nodeId.startsWith(prefix)) return nodeId.slice(prefix.length)
  }
  return undefined
}

export function mapIdCreateRoute(
  route: Pick<MapSubAgentParams, 'instanceId'>,
  parentId?: string,
): string {
  return parentId && !mapIdIsDefaultNews(parentId)
    ? `sub:${parentId}:${route.instanceId}`
    : `sub:${route.instanceId}`
}

export function mapIdCreateClaim(index: number, newsId?: string): string {
  return newsId && !mapIdIsDefaultNews(newsId)
    ? `claim:${newsId}:${index + 1}`
    : String(index + 1)
}

export function mapIdCreateOpinion(claimId: string, index: number): string {
  return `opinion:${claimId}:${index}`
}

export function mapIdReadAgentName(instanceId: string): string {
  const match = instanceId.match(/^(.*)#\d+$/)
  return match?.[1] ?? instanceId
}

function mapIdReadInstanceIndex(instanceId: string): number | undefined {
  const match = instanceId.match(/#(\d+)$/)
  if (!match) return undefined
  const index = Number(match[1])
  return Number.isFinite(index) ? index : undefined
}

export function mapIdCreateInstance(
  agentName: string,
  existing: Array<Pick<MapSubAgentParams, 'instanceId'>> = [],
): string {
  let next = 1
  for (const item of existing) {
    if (mapIdReadAgentName(item.instanceId) !== agentName) continue
    next = Math.max(next, (mapIdReadInstanceIndex(item.instanceId) ?? 0) + 1)
  }
  return `${agentName}#${next}`
}

export function mapIdUpdateInstance(
  drafts: RouteInstructionDraft[],
  existing: Array<Pick<MapSubAgentParams, 'instanceId'>> = [],
): MapSubAgentParams[] {
  const allocated: MapSubAgentParams[] = []
  for (const draft of drafts) {
    allocated.push({
      ...draft,
      instanceId: draft.instanceId
        ?? mapIdCreateInstance(draft.agentName, [...existing, ...allocated]),
    })
  }
  return allocated
}
