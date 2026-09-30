// 定义公共客户端的查询、写入、文件、连接与桌面 IPC 契约及结构化错误。
import type { LocalServiceState } from './desktop'
import type {
  AgentList, AppBootstrap, Asset, ClusterSettings, ControlCommand, ControlQuery, DefinitionPublishResult, DefinitionView, ImportResult,
  Member, Page, Preferences, WorkspaceSummary, WorkspaceView,
} from './control'
import type { GraphBranchClaimResult, GraphBranchGrant, GraphBranchSnapshot, GraphCommand, GraphMapSummary, GraphQuery, GraphRun, GraphRunControlClaimResult, GraphRunControlGrant, GraphSnapshot, GraphSuccess, GraphWriteResult } from './graph'
import type { GraphStreamEvent } from './events'

// 客户端可访问的图查询与管理查询集合。
type PublicQuery = GraphQuery | ControlQuery
// 客户端可提交的图写命令与管理写命令集合。
type PublicCommand = GraphCommand | ControlCommand
// 按公开查询方法映射其参数类型。
export type QueryInputMap = { [K in PublicQuery['method']]: Extract<PublicQuery, { method: K }>['params'] }
// 按公开查询方法映射返回业务数据类型。
export interface QueryOutputMap {
  'map.list': GraphMapSummary[]
  'map.get': GraphSnapshot
  'branch.get': GraphBranchSnapshot
  'run.get': GraphRun
  'app.bootstrap': AppBootstrap
  'workspace.list': Page<WorkspaceSummary>
  'workspace.get': WorkspaceView
  'agent.list': AgentList
  'definition.get': DefinitionView
  'asset.get': Asset
  'asset.list': Page<Asset>
}
// 按公开写命令映射参数类型，请求编号由调用接口单独传入。
export type CommandInputMap = { [K in PublicCommand['method']]: Extract<PublicCommand, { method: K }>['params'] }
// 按公开写命令映射业务结果，传输层另附收据重放信息。
export interface CommandOutputMap {
  'map.create': GraphWriteResult
  'map.delete': { mapId: string; deleted: true }
  'graph.apply': GraphWriteResult
  'branch.claim': GraphBranchClaimResult
  'branch.renew': GraphBranchGrant
  'branch.release': { released: boolean; ownershipRevision: number }
  'run.control.claim': GraphRunControlClaimResult
  'run.control.renew': GraphRunControlGrant
  'run.control.release': { released: boolean; ownershipRevision: number }
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
  'definition.publish': DefinitionPublishResult
  'settings.update': ClusterSettings
  'asset.delete': { assetId: string; deleted: true }
  'workspace.import': ImportResult
}
// 可向界面公开的连接状态，包含安全记住能力而不包含令牌。
export interface ClientConnection { mode?: 'local' | 'remote'; baseUrl: string; configured: boolean; remembered: boolean; canRemember: boolean }
// 建立连接时提供的服务源、令牌和记住意愿。
export interface ClientConnectInput { baseUrl: string; token: string; remember: boolean }
// 可跨网络或 IPC 返回的结构化错误，保留诊断编号及可选冲突版本。
export interface ClientErrorData { status: number; code: string; message: string; retryable: boolean; errorId: string; currentRevision?: number }
export class ClientError extends Error implements ClientErrorData {
  readonly status: number
  readonly code: string
  readonly retryable: boolean
  readonly errorId: string
  readonly currentRevision?: number
  /**
   * 将传输错误字段保存为可识别的客户端异常，缺少诊断编号时生成本地编号。
   *
   * @param input 可公开的传输错误字段；可选 errorId 缺省时生成本地 UUID。
   */
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
// 统一连接、业务与文件能力；具体 HTTP 或 IPC 适配器负责取消及错误归一化。
export interface ClientGateway {
  // 支持本地服务的平台可提供此操作，建立连接后返回当前身份及应用配置。
  connectLocal?(): Promise<AppBootstrap>
  /**
   * 订阅指定图事件直到结束或失败；调用方持有取消信号并决定是否重新订阅。
   *
   * @param mapId 订阅目标图的业务编号。
   * @param onEvent 调用方的同步事件观察者，接收传输适配器验证后的图事件。
   * @param signal 可选的调用方取消信号，用于结束持续订阅。
   */
  watch(mapId: string, onEvent: (event: GraphStreamEvent) => void, signal?: AbortSignal): Promise<void>
  // 返回可展示的连接状态与记住能力，不包含令牌原文。
  getConnection(): Promise<ClientConnection>
  /**
   * 验证新服务凭据并切换活动连接，返回认证后的应用引导数据。
   *
   * @param input 待验证的服务地址、令牌与记住意愿，由网关管理连接切换。
   */
  connect(input: ClientConnectInput): Promise<AppBootstrap>
  // 取消当前连接及请求，并等待持久化凭据清除。
  disconnect(): Promise<void>
  /**
   * 按公开方法读取对应数据，支持调用方取消。
   *
   * @param method 决定输入及输出类型的公开查询方法。
   * @param params 与所选查询方法匹配的业务输入。
   * @param signal 可选查询取消信号，调用方保留控制权。
   */
  read<K extends keyof QueryInputMap>(method: K, params: QueryInputMap[K], signal?: AbortSignal): Promise<QueryOutputMap[K]>
  /**
   * 提交公共写命令；不确定结果重试时沿用同一 requestId 和相同请求内容。
   *
   * @param requestId 业务命令的稳定幂等编号，不确定结果重试必须沿用同一编号及内容。
   * @param method 决定命令输入及输出类型的公开方法。
   * @param params 写命令的业务输入，包括相应资源版本条件。
   * @param signal 可选本地取消信号，取消不等于撤销已提交的服务端写入。
   */
  dispatch<K extends keyof CommandInputMap>(requestId: string, method: K, params: CommandInputMap[K], signal?: AbortSignal): Promise<GraphSuccess<CommandOutputMap[K]>>
  /**
   * 按稳定请求编号上传有大小上限的文件，返回资产及重放信息。
   *
   * @param requestId 上传业务的稳定幂等编号。
   * @param input 目标工作区、文件元信息和有大小上限的内存字节。
   * @param signal 可选上传取消信号。
   */
  upload(requestId: string, input: ClientUploadInput, signal?: AbortSignal): Promise<GraphSuccess<Asset>>
  /**
   * 下载固定资源目标，返回已读取的文件字节和元信息。
   *
   * @param input 固定资源类型和业务编号组成的下载目标。
   * @param signal 可选下载取消信号。
   */
  download(input: ClientDownloadInput, signal?: AbortSignal): Promise<ClientFile>
}
export const CLIENT_FILE_LIMIT = 64 * 1024 * 1024
// 有大小上限的内存文件输入，工作区决定上传归属。
export interface ClientUploadInput { workspaceId: string; filename: string; mediaType: string; bytes: Uint8Array }
// 固定类型的下载目标，不允许调用方传入任意下载 URL。
export type ClientDownloadInput = { kind: 'asset' | 'map' | 'workspace'; id: string }
// 下载后交给调用方的文件名、媒体类型和完整内容字节。
export interface ClientFile { filename: string; mediaType: string; bytes: Uint8Array }
// IPC 可序列化结果；错误字段保留业务错误码，不依赖 Error 实例跨进程传播。
export type ClientBridgeResult<T> = { ok: true; value: T } | { ok: false; error: ClientErrorData }
/** 桥接只传可序列化的值；AbortSignal 留在渲染器适配器，通过调用编号转发取消。 */
export interface ClientBridge {
  // 通过主进程建立本地连接，以可序列化的成功或错误结构返回。
  connectLocal(): Promise<ClientBridgeResult<AppBootstrap>>
  // 查询不含凭据的本地服务运行状态。
  localState(): Promise<ClientBridgeResult<LocalServiceState>>
  /**
   * 监听本地服务状态变化，调用方负责调用返回函数解除监听。
   *
   * @param listener 观察本地服务无凭据状态的页面回调，返回的退订函数由调用方持有。
   */
  onLocalState(listener: (state: LocalServiceState) => void): () => void
  /**
   * 仅上报诊断编号和固定来源，不传原始错误内容。
   *
   * @param input 仅允许诊断关联编号与固定错误来源，不得夹带异常文本。
   */
  reportError(input: { errorId: string; source: 'vue' | 'window' | 'promise' | 'router' }): void
  /**
   * 以独立 watchId 建立图订阅；应先注册 onStream，结束后返回空成功值或错误。
   *
   * @param watchId 渲染器分配的本次订阅编号，用于过滤事件和发起取消。
   * @param mapId 目标图的业务编号，由主进程校验。
   */
  watch(watchId: string, mapId: string): Promise<ClientBridgeResult<null>>
  /**
   * 接收带订阅编号和递增序号的流消息，调用方负责按编号隔离并解除监听。
   *
   * @param listener 观察流消息的页面回调，调用方负责按订阅编号及序号隔离。
   */
  onStream(listener: (message: { watchId: string; sequence: number; event: GraphStreamEvent }) => void): () => void
  // 从主进程读取连接状态，不返回认证令牌。
  getConnection(): Promise<ClientBridgeResult<ClientConnection>>
  /**
   * 将连接输入交给主进程验证并建立连接。
   *
   * @param input 渲染器提交的服务地址、令牌及记住意愿，主进程必须重新校验。
   */
  connect(input: ClientConnectInput): Promise<ClientBridgeResult<AppBootstrap>>
  // 请求主进程断开连接，完成后返回空成功值。
  disconnect(): Promise<ClientBridgeResult<null>>
  /**
   * 以 callId 登记一次查询；取消通过独立 cancel 通道传递。
   *
   * @param callId 一次查询的 IPC 生命周期编号，用于取消，不作为业务幂等键。
   * @param method 公开查询方法名，由主进程限制允许范围。
   * @param params 与查询类型匹配的可序列化参数。
   */
  read<K extends keyof QueryInputMap>(callId: string, method: K, params: QueryInputMap[K]): Promise<ClientBridgeResult<QueryOutputMap[K]>>
  /**
   * 同时传递调用生命周期编号与业务幂等编号，两者职责不同。
   *
   * @param callId 一次写调用的 IPC 生命周期编号，用于取消和并发跟踪。
   * @param requestId 写业务的稳定幂等编号，与 callId 的生命周期用途独立。
   * @param method 公开写命令名，由主进程校验白名单。
   * @param params 与写命令匹配的可序列化业务输入。
   */
  dispatch<K extends keyof CommandInputMap>(callId: string, requestId: string, method: K, params: CommandInputMap[K]): Promise<ClientBridgeResult<GraphSuccess<CommandOutputMap[K]>>>
  /**
   * 传递受大小限制的文件字节，callId 用于取消，requestId 用于幂等。
   *
   * @param callId 一次文件上传的 IPC 生命周期编号，用于取消。
   * @param requestId 上传业务的稳定幂等编号，用于收据重放。
   * @param input 可通过 IPC 复制的文件字节与元信息，主进程限制大小和并发。
   */
  upload(callId: string, requestId: string, input: ClientUploadInput): Promise<ClientBridgeResult<GraphSuccess<Asset>>>
  /**
   * 按资源类型及编号请求下载，主进程负责权限与文件并发限制。
   *
   * @param callId 一次下载的 IPC 生命周期编号，用于取消。
   * @param input 只含固定资源类型和编号的下载目标。
   */
  download(callId: string, input: ClientDownloadInput): Promise<ClientBridgeResult<ClientFile>>
  /**
   * 按所属调用编号发送取消提示，允许早于对应 invoke 到达。
   *
   * @param callId 当前窗口拥有的调用编号，取消通知允许早于 invoke 到达。
   */
  cancel(callId: string): void
}
declare global { interface Window { chongmingClient?: ClientBridge } }
