import type {
  MapClaimParams,
  ExecutionMode,
  MapSnapshot,
  MapNewsParams,
  MapSubAgentParams,
  CatalogSubAgent,
} from './types'

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

  startRun(
    mapId: string,
    mode?: ExecutionMode,
  ): Promise<{ runId: string; snapshot: MapSnapshot }>
  startParse(
    mapId: string,
    sourceId?: string,
  ): Promise<{ runId: string; snapshot: MapSnapshot }>
  addSourceChain(
    mapId: string,
    input: { uri: string; kind?: 'file' | 'url'; label?: string },
  ): Promise<MapSnapshot>
  continueStep(mapId: string): Promise<MapSnapshot>
  cancel(mapId: string): Promise<MapSnapshot>
  setMode(mapId: string, mode: ExecutionMode): Promise<MapSnapshot>

  unloadMap(mapId: string): void

  onUpdated(cb: (mapId: string, reason: MapUpdateReason) => void): () => void
}
