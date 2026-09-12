import type {
  AgentList, AppBootstrap, Asset, ClusterSettings, ControlCommand, ControlQuery, ImportResult,
  Member, Page, Preferences, WorkspaceSummary, WorkspaceView,
} from './control'
import type { GraphCommand, GraphMapSummary, GraphQuery, GraphRun, GraphSnapshot, GraphSuccess, GraphWriteResult } from './graph'

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
}
export type CommandInputMap = { [K in PublicCommand['method']]: Extract<PublicCommand, { method: K }>['params'] }
export interface CommandOutputMap {
  'map.create': GraphWriteResult
  'map.delete': { mapId: string; deleted: true }
  'graph.apply': GraphWriteResult
  'run.start': GraphWriteResult
  'run.cancel': GraphWriteResult
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
export interface ClientConnection { baseUrl: string; configured: boolean; remembered: boolean; canRemember: boolean }
export interface ClientConnectInput { baseUrl: string; token: string; remember: boolean }
export interface ClientErrorData { status: number; code: string; message: string; retryable: boolean; currentRevision?: number }
export class ClientError extends Error implements ClientErrorData {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly currentRevision?: number
  constructor(input: ClientErrorData) {
    super(input.message)
    this.name = 'ClientError'
    this.status = input.status
    this.code = input.code
    this.retryable = input.retryable
    this.currentRevision = input.currentRevision
  }
}
export interface ClientGateway {
  getConnection(): Promise<ClientConnection>
  connect(input: ClientConnectInput): Promise<AppBootstrap>
  disconnect(): Promise<void>
  read<K extends keyof QueryInputMap>(method: K, params: QueryInputMap[K], signal?: AbortSignal): Promise<QueryOutputMap[K]>
  dispatch<K extends keyof CommandInputMap>(requestId: string, method: K, params: CommandInputMap[K], signal?: AbortSignal): Promise<GraphSuccess<CommandOutputMap[K]>>
}
export type ClientBridgeResult<T> = { ok: true; value: T } | { ok: false; error: ClientErrorData }
/** Plain serializable values only: AbortSignal stays in the Renderer adapter. */
export interface ClientBridge {
  getConnection(): Promise<ClientBridgeResult<ClientConnection>>
  connect(input: ClientConnectInput): Promise<ClientBridgeResult<AppBootstrap>>
  disconnect(): Promise<ClientBridgeResult<null>>
  read<K extends keyof QueryInputMap>(callId: string, method: K, params: QueryInputMap[K]): Promise<ClientBridgeResult<QueryOutputMap[K]>>
  dispatch<K extends keyof CommandInputMap>(callId: string, requestId: string, method: K, params: CommandInputMap[K]): Promise<ClientBridgeResult<GraphSuccess<CommandOutputMap[K]>>>
  cancel(callId: string): void
}
declare global { interface Window { chongmingClient?: ClientBridge } }
