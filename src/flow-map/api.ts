import type {
  MapClaimParams,
  ExecutionMode,
  MapSnapshot,
  MapNewsParams,
  MapSubAgentParams,
  CatalogSubAgent,
} from './types'
import type { MapTimeline } from './timeline'

/** 后端推送导致快照变化的原因（用户 mutation 返回值已更新 store，无需 refresh）。 */
export type MapUpdateReason = 'progress' | 'interrupt' | 'completed' | 'error'

export interface AddSubAgentInput {
  mapId: string
  parentNodeId: string
  params: Omit<MapSubAgentParams, 'instanceId'> & { instanceId?: string }
}

export type UpdateNodeParamsPatch =
  | Partial<MapNewsParams>
  | Partial<Pick<MapSubAgentParams, 'priority' | 'hint'>>
  | Partial<Pick<MapClaimParams, 'content' | 'category'>>

export interface UpdateNodeParamsInput {
  mapId: string
  nodeId: string
  params: UpdateNodeParamsPatch
}

export interface MapAPI {
  getSnapshot(mapId: string): Promise<MapSnapshot>

  getSubAgentCatalog(parentNodeId: string): Promise<CatalogSubAgent[]>

  addSubAgent(input: AddSubAgentInput): Promise<MapSnapshot>
  updateNodeParams(input: UpdateNodeParamsInput): Promise<MapSnapshot>
  removeNode(input: { mapId: string; nodeId: string }): Promise<MapSnapshot>

  updateTimeline(
    mapId: string,
    patch: Partial<MapTimeline>,
  ): Promise<MapSnapshot>
  runTimeline(
    mapId: string,
    mode?: ExecutionMode,
    selectedNewsId?: string | null,
  ): Promise<{
    runId: string
    snapshot: MapSnapshot
    status: 'done' | 'interrupted'
  }>
  startRun(
    mapId: string,
    mode?: ExecutionMode,
    selectedNewsId?: string | null,
  ): Promise<{ runId: string; snapshot: MapSnapshot }>
  startParse(
    mapId: string,
    sourceId?: string,
  ): Promise<{ runId: string; snapshot: MapSnapshot }>
  addSourceChain(
    mapId: string,
    input: { uri: string; kind?: 'file' | 'url'; label?: string },
  ): Promise<MapSnapshot>
  addRootNews(mapId: string, content?: string): Promise<MapSnapshot>
  addRootClaim(mapId: string, content?: string): Promise<MapSnapshot>
  continueStep(mapId: string): Promise<MapSnapshot>
  cancel(mapId: string): Promise<MapSnapshot>
  setMode(mapId: string, mode: ExecutionMode): Promise<MapSnapshot>

  flushMap(mapId: string): Promise<void>
  toolDedupClaims(mapId: string): Promise<MapSnapshot>
  toolBatchUpdateSubAgents(
    mapId: string,
    patch: { priority?: import('./types').Priority, hint?: string, agentName?: string, parentNodeId?: string },
  ): Promise<MapSnapshot>

  unloadMap(mapId: string): void

  onUpdated(cb: (mapId: string, reason: MapUpdateReason) => void): () => void
}
