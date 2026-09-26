import type { LocalServiceState } from './desktop'
import type {
  AgentList, AppBootstrap, Asset, ClusterSettings, ControlCommand, ControlQuery, ImportResult,
  Member, Page, Preferences, WorkspaceSummary, WorkspaceView,
} from './control'
import type { GraphCommand, GraphMapSummary, GraphQuery, GraphRun, GraphSnapshot, GraphSuccess, GraphWriteResult } from './graph'
import type { GraphStreamEvent } from './events'

type PublicQuery = GraphQuery | ControlQuery
type PublicCommand = GraphCommand | ControlCommand
export type QueryInputMap = { [K in PublicQuery['method']]: Extract<PublicQuery, { method: K }>['params'] }
export interface QueryOutputMap {
  'map.list': GraphMapSummary[]
  'map.get': GraphSnapshot
  'run.get': GraphRun
  'app.bootstrap': AppBootstrap
  'workspace.list': Page<WorkspaceSummary>
  'workspace.get': WorkspaceView
  'agent.list': AgentList
  'asset.get': Asset
  'asset.list': Page<Asset>
}
export type CommandInputMap = { [K in PublicCommand['method']]: Extract<PublicCommand, { method: K }>['params'] }
export interface CommandOutputMap {
  'map.create': GraphWriteResult
  'map.delete': { mapId: string; deleted: true }
  'graph.apply': GraphWriteResult
  'run.start': GraphWriteResult
  'run.cancel': GraphWriteResult
  'run.pause': GraphWriteResult
  'run.resume': GraphWriteResult
  'review.update': GraphWriteResult
  'review.answer': GraphWriteResult
  'workspace.create': WorkspaceView
  'workspace.update': WorkspaceView
  'workspace.delete': { workspaceId: string; deleted: true }
  'member.set': { userId: string; member: Member | null; workspaceRevision: number }
  'preferences.set': Preferences
  'agent.create': AgentList
  'agent.update': AgentList
  'agent.delete': AgentList
  'agent.copy': WorkspaceView
  'settings.update': ClusterSettings
  'asset.delete': { assetId: string; deleted: true }
  'workspace.import': ImportResult
}
export interface ClientConnection { mode?: 'local' | 'remote'; baseUrl: string; configured: boolean; remembered: boolean; canRemember: boolean }
export interface ClientConnectInput { baseUrl: string; token: string; remember: boolean }
export interface ClientErrorData { status: number; code: string; message: string; retryable: boolean; errorId: string; currentRevision?: number }
export class ClientError extends Error implements ClientErrorData {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly errorId: string
  readonly currentRevision?: number
  // 用途：初始化ClientError实例。
  constructor(input: Omit<ClientErrorData, 'errorId'> & { errorId?: string }) {
    super(input.message)
    this.name = 'ClientError'
    this.status = input.status
    this.code = input.code
    this.retryable = input.retryable
    this.errorId = input.errorId ?? crypto.randomUUID()
    this.currentRevision = input.currentRevision
  }
}
export interface ClientGateway {
  connectLocal?(): Promise<AppBootstrap>
  watch(mapId: string, onEvent: (event: GraphStreamEvent) => void, signal?: AbortSignal): Promise<void>
  getConnection(): Promise<ClientConnection>
  connect(input: ClientConnectInput): Promise<AppBootstrap>
  disconnect(): Promise<void>
  read<K extends keyof QueryInputMap>(method: K, params: QueryInputMap[K], signal?: AbortSignal): Promise<QueryOutputMap[K]>
  dispatch<K extends keyof CommandInputMap>(requestId: string, method: K, params: CommandInputMap[K], signal?: AbortSignal): Promise<GraphSuccess<CommandOutputMap[K]>>
  upload(requestId: string, input: ClientUploadInput, signal?: AbortSignal): Promise<GraphSuccess<Asset>>
  download(input: ClientDownloadInput, signal?: AbortSignal): Promise<ClientFile>
}
export const CLIENT_FILE_LIMIT = 64 * 1024 * 1024
export interface ClientUploadInput { workspaceId: string; filename: string; mediaType: string; bytes: Uint8Array }
export type ClientDownloadInput = { kind: 'asset' | 'map' | 'workspace'; id: string }
export interface ClientFile { filename: string; mediaType: string; bytes: Uint8Array }
export type ClientBridgeResult<T> = { ok: true; value: T } | { ok: false; error: ClientErrorData }
/** Plain serializable values only: AbortSignal stays in the Renderer adapter. */
export interface ClientBridge {
  connectLocal(): Promise<ClientBridgeResult<AppBootstrap>>
  localState(): Promise<ClientBridgeResult<LocalServiceState>>
  onLocalState(listener: (state: LocalServiceState) => void): () => void
  reportError(input: { errorId: string; source: 'vue' | 'window' | 'promise' | 'router' }): void
  watch(watchId: string, mapId: string): Promise<ClientBridgeResult<null>>
  onStream(listener: (message: { watchId: string; sequence: number; event: GraphStreamEvent }) => void): () => void
  getConnection(): Promise<ClientBridgeResult<ClientConnection>>
  connect(input: ClientConnectInput): Promise<ClientBridgeResult<AppBootstrap>>
  disconnect(): Promise<ClientBridgeResult<null>>
  read<K extends keyof QueryInputMap>(callId: string, method: K, params: QueryInputMap[K]): Promise<ClientBridgeResult<QueryOutputMap[K]>>
  dispatch<K extends keyof CommandInputMap>(callId: string, requestId: string, method: K, params: CommandInputMap[K]): Promise<ClientBridgeResult<GraphSuccess<CommandOutputMap[K]>>>
  upload(callId: string, requestId: string, input: ClientUploadInput): Promise<ClientBridgeResult<GraphSuccess<Asset>>>
  download(callId: string, input: ClientDownloadInput): Promise<ClientBridgeResult<ClientFile>>
  cancel(callId: string): void
}
declare global { interface Window { chongmingClient?: ClientBridge } }
