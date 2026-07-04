import type {
  MapClaimParams,
  ExecutionMode,
  MapSnapshot,
  MapNewsParams,
  MapSubAgentParams,
  CatalogSubAgent,
} from './types'

export interface AddSubAgentInput {
  newsId: string
  /** 父节点 id：NEWS_ROOT_ID → 新增拆分 SubAgent；已持久化 claim id → 该事实的核查 SubAgent。 */
  parentNodeId: string
  /** 槽位参数；instanceId 可由调用方省略，Adapter 补齐。 */
  params: MapSubAgentParams
}

/** SubAgent 仅允许改 priority / hint；agentName / instanceId 加槽后固定。 */
export type UpdateNodeParamsPatch =
  | Partial<MapNewsParams>
  | Partial<Pick<MapSubAgentParams, 'priority' | 'hint'>>
  | Partial<Pick<MapClaimParams, 'content' | 'category'>>

export interface UpdateNodeParamsInput {
  newsId: string
  nodeId: string
  params: UpdateNodeParamsPatch
}

/**
 * Map 层对前端暴露的唯一 API。
 * 所有后端形态（LangGraph / IPC / HTTP）都通过实现该接口的 Adapter 暴露。
 *
 * 能力判定（能否加槽 / 编辑 / 删除）是快照上的纯函数（graph-ops），不走本接口。
 */
export interface MapAPI {
  getSnapshot(newsId: string): Promise<MapSnapshot>

  /** 可添加到 parentNodeId 下的 SubAgent 候选。 */
  getSubAgentCatalog(parentNodeId: string): Promise<CatalogSubAgent[]>

  addSubAgent(input: AddSubAgentInput): Promise<MapSnapshot>
  updateNodeParams(input: UpdateNodeParamsInput): Promise<MapSnapshot>
  removeNode(input: { newsId: string; nodeId: string }): Promise<MapSnapshot>

  startRun(
    newsId: string,
    mode?: ExecutionMode,
  ): Promise<{ runId: string; snapshot: MapSnapshot }>
  /** 在 human-in-loop 模式下推进当前焦点节点的一个工具步。 */
  continueStep(newsId: string): Promise<MapSnapshot>
  cancel(newsId: string): Promise<MapSnapshot>
  setMode(newsId: string, mode: ExecutionMode): Promise<MapSnapshot>

  /** 快照变化订阅。返回取消订阅函数。 */
  onUpdated(cb: (newsId: string) => void): () => void
}
