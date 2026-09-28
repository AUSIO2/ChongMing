// 桌面主进程 IPC 边界：限制可信主框架、校验请求并管理调用取消与事件转发。
import { RuntimeMessage } from '../../contracts/messages'
import type { LocalServiceState } from '../../contracts/desktop'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { CLIENT_CHANNELS } from './ipc-channels'
import { CLIENT_COMMAND_METHODS, CLIENT_QUERY_METHODS, clientReadError, clientAssertUpload, clientAssertDownload } from '../../client/graph-client'
import { ClientError, type ClientBridgeResult, type ClientConnectInput, type ClientGateway, type CommandInputMap, type QueryInputMap } from '../../contracts/client'

function clientCreateIpcError(/* 用于识别 IPC 输入或权限失败的稳定错误码。 */ code: string, /* 可返回渲染器的公开错误说明，不包含本机内部异常。 */ message: string): ClientError {
  // 将桥接输入或权限错误包装为不可重试的客户端错误。
  return new ClientError({ code, message, status: 400, retryable: false })
}
export function clientAssertSender(/* Electron 提供的发送窗口和框架元信息，不信任消息内容自报身份。 */ event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, /* 主进程当前允许访问桥接的窗口内容；null 或已销毁时拒绝。 */ contents: WebContents | null, /* 应用受信任入口地址，用于核对文件路径或网络源。 */ rendererUrl: string): void {
  // 仅允许指定窗口的主框架访问桥接，并校验其文件路径或网络来源。
  const frame = event.senderFrame
  if (!contents || contents.isDestroyed() || event.sender !== contents || !frame
    || frame.routingId !== contents.mainFrame.routingId || frame.processId !== contents.mainFrame.processId) {
    throw clientCreateIpcError('IPC_FORBIDDEN', RuntimeMessage.ONLY_THE_APPLICATION_MAIN_FRAME_MAY_USE_THIS_BRIDGE)
  }
  const expected = new URL(rendererUrl), actual = new URL(frame.url)
  if (expected.protocol === 'file:'
    ? actual.protocol !== 'file:' || actual.host !== expected.host || actual.pathname !== expected.pathname
    : actual.protocol !== expected.protocol || actual.origin !== expected.origin) throw clientCreateIpcError('IPC_FORBIDDEN', RuntimeMessage.UNTRUSTED_APPLICATION_FRAME)
}
function clientReadCallId(/* 来自渲染器的未验证调用编号，用于关联活动请求和取消。 */ value: unknown): string {
  // 验证桥接调用编号的字符串格式，用于活动请求与取消消息匹配。
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw clientCreateIpcError('INVALID_CALL_ID', RuntimeMessage.INVALID_CLIENT_CALL_ID)
  return value
}
function clientReadParams(/* 来自 IPC 的未验证参数，必须是大小受限的 JSON 对象。 */ value: unknown): Record<string, unknown> {
  // 只接受 JSON 大小不超过 1 MiB 的对象参数。
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw clientCreateIpcError('INVALID_ARGUMENT', RuntimeMessage.REQUEST_PARAMS_MUST_BE_AN_OBJECT)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) throw clientCreateIpcError('INVALID_ARGUMENT', RuntimeMessage.REQUEST_EXCEEDS_1_MIB)
  return value as Record<string, unknown>
}
function clientReadConnection(/* 来自渲染器的未验证连接配置，按固定字段及类型验证。 */ value: unknown): ClientConnectInput {
  // 校验连接输入只含地址、令牌与记住开关，并返回对应字段。
  const item = clientReadParams(value)
  if (Object.keys(item).some(/* 连接配置对象中的实际键名，拒绝白名单外字段。 */ key => /* 查找连接输入中未允许的字段。 */  !['baseUrl', 'token', 'remember'].includes(key))
    || typeof item.baseUrl !== 'string' || typeof item.token !== 'string' || typeof item.remember !== 'boolean') {
    throw clientCreateIpcError('INVALID_ARGUMENT', RuntimeMessage.INVALID_CONNECTION_INPUT)
  }
  return { baseUrl: item.baseUrl, token: item.token, remember: item.remember }
}

export function clientRegisterIpc(/* 主进程装配的 IPC、网关、可信窗口获取器及可选状态和诊断能力。 */ input: { ipc: IpcMain; gateway: ClientGateway; rendererUrl: string; contents: () => WebContents | null;
  localState?: () => LocalServiceState; diagnostics?: DiagnosticReporter }): () => void {
  // 注册可信渲染器可用的请求与取消通道，维护活动调用并返回统一释放函数。
  const calls = new Map<string, { owner: WebContents; controller: AbortController; file: boolean }>()
  const cancelled = new Set<string>()
  const senders = new Set<WebContents>()
    async function clientCreateReply<T>(/* 当前 invoke 的真实发送框架，先校验来源再执行操作。 */ event: IpcMainInvokeEvent, /* 仅在框架验证通过后执行的异步业务操作。 */ operation: () => Promise<T>): Promise<ClientBridgeResult<T>> {
      // 验证调用框架后执行操作，把异常转换为可通过 IPC 返回的错误结构。
    try { clientAssertSender(event, input.contents(), input.rendererUrl); return { ok: true, value: await operation() } }
    catch (error) { return { ok: false, error: clientReadError(error) } }
  }
    async function clientRunCall<T>(/* 已通过来源校验的调用事件，其 sender 作为请求所有者。 */ event: IpcMainInvokeEvent, /* 尚未校验的桥接调用编号，校验后用于去重和取消匹配。 */ rawId: unknown, /* 实际请求操作，接收本层创建并随窗口销毁取消的信号。 */ operation: (/* 本次调用专属取消信号，由 IPC 控制器持有并交给下游操作。 */ signal: AbortSignal) => Promise<T>, /* 是否计入文件传输配额；缺省为普通请求。 */ file = false): Promise<T> {
      // 为调用分配取消信号并限制并发量，结束后删除活动记录，窗口销毁时中止其全部请求。
    const id = clientReadCallId(rawId)
    if (calls.has(id)) throw clientCreateIpcError('CALL_EXISTS', RuntimeMessage.CLIENT_CALL_ID_IS_ALREADY_ACTIVE)
    if (calls.size >= 32) throw clientCreateIpcError('TOO_MANY_REQUESTS', RuntimeMessage.TOO_MANY_ACTIVE_CLIENT_REQUESTS)
    // ponytail：当前最多并行两项有大小上限的内存传输；需要更大文件时改用流式 IPC。
    if (file && [...calls.values()].filter(/* 已登记的活动调用记录，用 file 标记统计文件传输并发。 */ call => /* 筛出正在运行的文件传输，执行最多两个并发传输的限制。 */  call.file).length >= 2) throw clientCreateIpcError('TOO_MANY_REQUESTS', RuntimeMessage.ONLY_TWO_FILE_TRANSFERS_MAY_RUN_AT_ONCE)
    if (cancelled.delete(id)) throw clientCreateIpcError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
    const controller = new AbortController()
    calls.set(id, { owner: event.sender, controller, file })
    const sender = event.sender
    if (!senders.has(sender)) {
      senders.add(sender)
      sender.once('destroyed', () => {
        // 窗口销毁时取消其全部活动请求并移除所有权记录。
        for (const [id, call] of calls) if (call.owner === sender) { call.controller.abort(); calls.delete(id) }
        senders.delete(sender)
      })
    }
    try { return await operation(controller.signal) } finally { calls.delete(id) }
  }
  input.ipc.handle(CLIENT_CHANNELS.connectLocal, /* 发起本地连接的 Electron invoke 事件，用于验证主框架权限。 */ event => /* 校验发起本地连接的框架，并包装连接结果。 */  clientCreateReply(event, () => {
    // 检查网关是否提供本地连接能力，再启动本地连接。
    if (!input.gateway.connectLocal) throw clientCreateIpcError('LOCAL_UNAVAILABLE', RuntimeMessage.LOCAL_SERVICE_IS_UNAVAILABLE)
    return input.gateway.connectLocal()
  }))
  input.ipc.handle(CLIENT_CHANNELS.localState, /* 查询本地状态的 invoke 事件，用于验证消息来源。 */ event => /* 校验状态查询来源并返回本地服务状态。 */  clientCreateReply(event, async () => /* 读取可选的本地状态提供器，缺省时报告已停止。 */  input.localState?.() ?? { status: 'stopped' }))
  input.ipc.handle(CLIENT_CHANNELS.connection, /* 查询连接信息的 invoke 事件，用于验证消息来源。 */ event => /* 校验连接查询来源并包装当前连接状态。 */  clientCreateReply(event, () => /* 向网关读取当前连接信息。 */  input.gateway.getConnection()))
  input.ipc.handle(CLIENT_CHANNELS.connect, (/* 建立远程连接的 invoke 事件，用于验证主框架权限。 */ event, /* 渲染器提交的连接输入，须在可信框架检查后校验字段。 */ value) => /* 校验连接请求来源并包装建立连接的结果。 */  clientCreateReply(event, () => /* 校验连接参数后调用网关建立远程连接。 */  input.gateway.connect(clientReadConnection(value))))
  input.ipc.handle(CLIENT_CHANNELS.disconnect, /* 断开连接的 invoke 事件，用于限制操作来源。 */ event => /* 校验断开请求来源并包装操作结果。 */  clientCreateReply(event, async () => {
    // 等待网关断开，再用空值确认操作完成。
     await input.gateway.disconnect(); return null }))
  input.ipc.handle(CLIENT_CHANNELS.read, (/* 发起业务查询的 invoke 事件，提供请求所有权。 */ event, /* 渲染器生成的查询调用编号，用于本次生命周期去重和取消。 */ id, /* 渲染器请求的查询名，执行前必须属于公开方法白名单。 */ method, /* 渲染器传入的未验证查询参数，须限制对象结构与大小。 */ params) => /* 校验读取请求来源并包装查询结果。 */  clientCreateReply(event, async () => {
    // 验证公开查询方法和对象参数，再登记可取消的调用。
    if (!(CLIENT_QUERY_METHODS as readonly string[]).includes(method)) throw clientCreateIpcError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_QUERY)
    const value = clientReadParams(params)
    return clientRunCall(event, id, /* IPC 为当前查询分配的取消信号，传给网关。 */ signal => /* 带上本次调用的取消信号向网关查询。 */  input.gateway.read(method as keyof QueryInputMap, value as QueryInputMap[keyof QueryInputMap], signal))
  }))
  input.ipc.handle(CLIENT_CHANNELS.dispatch, (/* 发起写命令的 invoke 事件，提供请求所有权。 */ event, /* 本次 IPC 写调用的生命周期编号，用于取消而非业务幂等。 */ id, /* 跨重试保持稳定的业务请求编号，执行前验证格式。 */ requestId, /* 渲染器请求的写命令名，须通过公共命令白名单。 */ method, /* 渲染器提交的未验证命令参数，先检查对象及体积限制。 */ params) => /* 校验写请求来源并包装命令结果。 */  clientCreateReply(event, async () => {
    // 验证公开命令、请求编号及参数，再登记可取消的写调用。
    if (!(CLIENT_COMMAND_METHODS as readonly string[]).includes(method)) throw clientCreateIpcError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_COMMAND)
    clientReadCallId(requestId)
    const value = clientReadParams(params)
    return clientRunCall(event, id, /* IPC 为本次命令分配的取消信号，原样传给网关。 */ signal => /* 保留幂等请求编号并转交命令、参数和取消信号。 */  input.gateway.dispatch(requestId, method as keyof CommandInputMap, value as CommandInputMap[keyof CommandInputMap], signal))
  }))
  input.ipc.handle(CLIENT_CHANNELS.upload, (/* 发起文件上传的 invoke 事件，先验证可信框架。 */ event, /* 当前上传调用的生命周期编号，用于取消和并发登记。 */ id, /* 上传业务的稳定幂等编号，与生命周期编号分别传递。 */ requestId, /* 渲染器提供的文件字节及元信息，上传前进行完整输入校验。 */ value) => /* 校验上传来源并包装文件上传结果。 */  clientCreateReply(event, async () => {
    // 验证文件输入和请求编号，再按文件传输配额执行上传。
    clientAssertUpload(requestId, value)
    return clientRunCall(event, id, /* 当前上传专属的取消信号，受窗口和调用生命周期控制。 */ signal => /* 将已验证文件连同取消信号发送给网关。 */  input.gateway.upload(requestId, value, signal), true)
  }))
  input.ipc.handle(CLIENT_CHANNELS.download, (/* 发起文件下载的 invoke 事件，先验证可信框架。 */ event, /* 当前下载调用的生命周期编号，用于取消和并发登记。 */ id, /* 渲染器提供的资源类型及编号，须拒绝额外 URL 字段。 */ value) => /* 校验下载来源并包装文件下载结果。 */  clientCreateReply(event, async () => {
    // 验证下载目标，再按文件传输配额执行下载。
    clientAssertDownload(value)
    return clientRunCall(event, id, /* 当前下载专属的取消信号，交由网关终止传输。 */ signal => /* 从网关下载已验证目标，支持本次调用取消。 */  input.gateway.download(value, signal), true)
  }))
  input.ipc.handle(CLIENT_CHANNELS.watch, (/* 发起图订阅的 invoke 事件，提供后续事件接收窗口。 */ event, /* 该持续订阅的调用编号，也用作转发消息的 watchId。 */ id, /* 渲染器请求订阅的图编号，按 UUID 校验后才交给网关。 */ mapId) => /* 校验订阅来源并包装订阅结束结果。 */  clientCreateReply(event, async () => {
    // 验证图编号，并为持续订阅登记可取消调用。
    clientAssertDownload({ kind: 'map', id: mapId })
    return clientRunCall(event, id, async /* 当前订阅的取消信号，取消后停止向窗口转发事件。 */ signal => {
      // 为订阅分配递增序号，持续转发事件直到网关订阅结束。
      let sequence = 0
      await input.gateway.watch(mapId, /* 网关返回的图事件，附加订阅编号和递增序号后转发。 */ message => {
        // 丢弃取消后的事件，每次转发前重新校验框架，再发送带订阅编号和序号的消息。
        if (signal.aborted) return
        clientAssertSender(event, input.contents(), input.rendererUrl)
        event.sender.send(CLIENT_CHANNELS.stream, { watchId: id, sequence: ++sequence, event: message })
      }, signal)
      return null
    })
  }))
  const cancel = (/* 取消消息的 Electron 来源，用于确认有权取消所属窗口调用。 */ event: IpcMainEvent, /* 取消消息中的未验证调用编号，可能先于对应 invoke 到达。 */ rawId: unknown) => {
    // 校验取消权限并中止所属调用；尚未收到调用时暂存有限数量的取消编号。
    try {
      clientAssertSender(event, input.contents(), input.rendererUrl)
      const id = clientReadCallId(rawId)
      const call = calls.get(id)
      if (call?.owner === event.sender) call.controller.abort()
      else if (!call) {
        // 取消可能先于 invoke 到达，因此暂存取消编号并限制缓存数量。
        cancelled.add(id)
        if (cancelled.size > 512) cancelled.delete(cancelled.values().next().value!)
      }
    } catch { /* 无效框架没有取消请求的权限。 */ }
  }
  input.ipc.on(CLIENT_CHANNELS.cancel, cancel)
  const diagnostic = (/* 诊断消息的 Electron 来源，必须属于受信任主框架。 */ event: IpcMainEvent, /* 来自渲染器的未验证诊断负载，仅允许诊断编号与固定来源。 */ value: unknown) => {
    // 仅接受可信框架给出的诊断编号和来源标签，将渲染器错误关联到主进程日志。
    try {
      clientAssertSender(event, input.contents(), input.rendererUrl)
      const item = clientReadParams(value)
      if (Object.keys(item).some(/* 诊断对象中的实际属性名，用于排除消息原文等额外字段。 */ key => /* 检查诊断输入是否夹带未允许的字段。 */  !['errorId', 'source'].includes(key)) || typeof item.errorId !== 'string'
        || !/^[0-9a-f-]{36}$/i.test(item.errorId) || !['vue', 'window', 'promise', 'router'].includes(String(item.source))) return
      input.diagnostics?.report({ name: 'renderer.failed', severity: 'error', errorId: item.errorId, context: { reason: String(item.source) } })
    } catch { /* 不可信框架没有上报诊断的权限。 */ }
  }
  input.ipc.on(CLIENT_CHANNELS.diagnostic, diagnostic)
  return () => {
    // 取消全部活动请求，清空缓存并移除注册的 IPC 处理器和监听器。
    for (const call of calls.values()) call.controller.abort()
    calls.clear(); cancelled.clear()
    for (const channel of [CLIENT_CHANNELS.connectLocal, CLIENT_CHANNELS.localState, CLIENT_CHANNELS.connection, CLIENT_CHANNELS.connect, CLIENT_CHANNELS.disconnect, CLIENT_CHANNELS.read, CLIENT_CHANNELS.dispatch, CLIENT_CHANNELS.upload, CLIENT_CHANNELS.download, CLIENT_CHANNELS.watch]) input.ipc.removeHandler(channel)
    input.ipc.removeListener(CLIENT_CHANNELS.cancel, cancel)
    input.ipc.removeListener(CLIENT_CHANNELS.diagnostic, diagnostic)
  }
}
