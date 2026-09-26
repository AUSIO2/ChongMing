import { RuntimeMessage } from '../../contracts/messages'
import type { LocalServiceState } from '../../contracts/desktop'
import type { DiagnosticReporter } from '../../contracts/diagnostics'
import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { CLIENT_CHANNELS } from './ipc-channels'
import { CLIENT_COMMAND_METHODS, CLIENT_QUERY_METHODS, clientReadError, clientAssertUpload, clientAssertDownload } from '../../client/graph-client'
import { ClientError, type ClientBridgeResult, type ClientConnectInput, type ClientGateway, type CommandInputMap, type QueryInputMap } from '../../contracts/client'

// 用途：创建错误，供后续流程使用。
function clientCreateIpcError(code: string, message: string): ClientError {
  return new ClientError({ code, message, status: 400, retryable: false })
}
// 用途：校验客户端请求输入，发现不符合约束时立即报错。
export function clientAssertSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, contents: WebContents | null, rendererUrl: string): void {
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
// 用途：读取标识，并把结构化结果交给调用方。
function clientReadCallId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw clientCreateIpcError('INVALID_CALL_ID', RuntimeMessage.INVALID_CLIENT_CALL_ID)
  return value
}
// 用途：读取参数，并把结构化结果交给调用方。
function clientReadParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw clientCreateIpcError('INVALID_ARGUMENT', RuntimeMessage.REQUEST_PARAMS_MUST_BE_AN_OBJECT)
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) throw clientCreateIpcError('INVALID_ARGUMENT', RuntimeMessage.REQUEST_EXCEEDS_1_MIB)
  return value as Record<string, unknown>
}
// 用途：读取连接，并把结构化结果交给调用方。
function clientReadConnection(value: unknown): ClientConnectInput {
  const item = clientReadParams(value)
  if (Object.keys(item).some(key => !['baseUrl', 'token', 'remember'].includes(key))
    || typeof item.baseUrl !== 'string' || typeof item.token !== 'string' || typeof item.remember !== 'boolean') {
    throw clientCreateIpcError('INVALID_ARGUMENT', RuntimeMessage.INVALID_CONNECTION_INPUT)
  }
  return { baseUrl: item.baseUrl, token: item.token, remember: item.remember }
}

// 用途：处理客户端请求相关工作，并把结果交给调用方。
export function clientRegisterIpc(input: { ipc: IpcMain; gateway: ClientGateway; rendererUrl: string; contents: () => WebContents | null;
  localState?: () => LocalServiceState; diagnostics?: DiagnosticReporter }): () => void {
  const calls = new Map<string, { owner: WebContents; controller: AbortController; file: boolean }>()
  const cancelled = new Set<string>()
  const senders = new Set<WebContents>()
    // 用途：创建响应，供后续流程使用。
    async function clientCreateReply<T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<ClientBridgeResult<T>> {
    try { clientAssertSender(event, input.contents(), input.rendererUrl); return { ok: true, value: await operation() } }
    catch (error) { return { ok: false, error: clientReadError(error) } }
  }
    // 用途：执行客户端请求流程，并返回执行结果。
    async function clientRunCall<T>(event: IpcMainInvokeEvent, rawId: unknown, operation: (signal: AbortSignal) => Promise<T>, file = false): Promise<T> {
    const id = clientReadCallId(rawId)
    if (calls.has(id)) throw clientCreateIpcError('CALL_EXISTS', RuntimeMessage.CLIENT_CALL_ID_IS_ALREADY_ACTIVE)
    if (calls.size >= 32) throw clientCreateIpcError('TOO_MANY_REQUESTS', RuntimeMessage.TOO_MANY_ACTIVE_CLIENT_REQUESTS)
    // ponytail: two bounded in-memory transfers; use streaming IPC if larger files become necessary.
    if (file && [...calls.values()].filter(call => call.file).length >= 2) throw clientCreateIpcError('TOO_MANY_REQUESTS', RuntimeMessage.ONLY_TWO_FILE_TRANSFERS_MAY_RUN_AT_ONCE)
    if (cancelled.delete(id)) throw clientCreateIpcError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
    const controller = new AbortController()
    calls.set(id, { owner: event.sender, controller, file })
    const sender = event.sender
    if (!senders.has(sender)) {
      senders.add(sender)
      sender.once('destroyed', () => {
        for (const [id, call] of calls) if (call.owner === sender) { call.controller.abort(); calls.delete(id) }
        senders.delete(sender)
      })
    }
    try { return await operation(controller.signal) } finally { calls.delete(id) }
  }
  input.ipc.handle(CLIENT_CHANNELS.connectLocal, event => clientCreateReply(event, () => {
    if (!input.gateway.connectLocal) throw clientCreateIpcError('LOCAL_UNAVAILABLE', RuntimeMessage.LOCAL_SERVICE_IS_UNAVAILABLE)
    return input.gateway.connectLocal()
  }))
  input.ipc.handle(CLIENT_CHANNELS.localState, event => clientCreateReply(event, async () => input.localState?.() ?? { status: 'stopped' }))
  input.ipc.handle(CLIENT_CHANNELS.connection, event => clientCreateReply(event, () => input.gateway.getConnection()))
  input.ipc.handle(CLIENT_CHANNELS.connect, (event, value) => clientCreateReply(event, () => input.gateway.connect(clientReadConnection(value))))
  input.ipc.handle(CLIENT_CHANNELS.disconnect, event => clientCreateReply(event, async () => { await input.gateway.disconnect(); return null }))
  input.ipc.handle(CLIENT_CHANNELS.read, (event, id, method, params) => clientCreateReply(event, async () => {
    if (!(CLIENT_QUERY_METHODS as readonly string[]).includes(method)) throw clientCreateIpcError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_QUERY)
    const value = clientReadParams(params)
    return clientRunCall(event, id, signal => input.gateway.read(method as keyof QueryInputMap, value as QueryInputMap[keyof QueryInputMap], signal))
  }))
  input.ipc.handle(CLIENT_CHANNELS.dispatch, (event, id, requestId, method, params) => clientCreateReply(event, async () => {
    if (!(CLIENT_COMMAND_METHODS as readonly string[]).includes(method)) throw clientCreateIpcError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_COMMAND)
    clientReadCallId(requestId)
    const value = clientReadParams(params)
    return clientRunCall(event, id, signal => input.gateway.dispatch(requestId, method as keyof CommandInputMap, value as CommandInputMap[keyof CommandInputMap], signal))
  }))
  input.ipc.handle(CLIENT_CHANNELS.upload, (event, id, requestId, value) => clientCreateReply(event, async () => {
    clientAssertUpload(requestId, value)
    return clientRunCall(event, id, signal => input.gateway.upload(requestId, value, signal), true)
  }))
  input.ipc.handle(CLIENT_CHANNELS.download, (event, id, value) => clientCreateReply(event, async () => {
    clientAssertDownload(value)
    return clientRunCall(event, id, signal => input.gateway.download(value, signal), true)
  }))
  input.ipc.handle(CLIENT_CHANNELS.watch, (event, id, mapId) => clientCreateReply(event, async () => {
    clientAssertDownload({ kind: 'map', id: mapId })
    return clientRunCall(event, id, async signal => {
      let sequence = 0
      await input.gateway.watch(mapId, message => {
        if (signal.aborted) return
        clientAssertSender(event, input.contents(), input.rendererUrl)
        event.sender.send(CLIENT_CHANNELS.stream, { watchId: id, sequence: ++sequence, event: message })
      }, signal)
      return null
    })
  }))
  const cancel = (event: IpcMainEvent, rawId: unknown) => {
    try {
      clientAssertSender(event, input.contents(), input.rendererUrl)
      const id = clientReadCallId(rawId)
      const call = calls.get(id)
      if (call?.owner === event.sender) call.controller.abort()
      else if (!call) {
        // Covers cancel arriving before its invoke, with bounded retained IDs.
        cancelled.add(id)
        if (cancelled.size > 512) cancelled.delete(cancelled.values().next().value!)
      }
    } catch { /* Invalid frames have no cancellation authority. */ }
  }
  input.ipc.on(CLIENT_CHANNELS.cancel, cancel)
  const diagnostic = (event: IpcMainEvent, value: unknown) => {
    try {
      clientAssertSender(event, input.contents(), input.rendererUrl)
      const item = clientReadParams(value)
      if (Object.keys(item).some(key => !['errorId', 'source'].includes(key)) || typeof item.errorId !== 'string'
        || !/^[0-9a-f-]{36}$/i.test(item.errorId) || !['vue', 'window', 'promise', 'router'].includes(String(item.source))) return
      input.diagnostics?.report({ name: 'renderer.failed', severity: 'error', errorId: item.errorId, context: { reason: String(item.source) } })
    } catch { /* untrusted diagnostic frames have no reporting authority */ }
  }
  input.ipc.on(CLIENT_CHANNELS.diagnostic, diagnostic)
  return () => {
    for (const call of calls.values()) call.controller.abort()
    calls.clear(); cancelled.clear()
    for (const channel of [CLIENT_CHANNELS.connectLocal, CLIENT_CHANNELS.localState, CLIENT_CHANNELS.connection, CLIENT_CHANNELS.connect, CLIENT_CHANNELS.disconnect, CLIENT_CHANNELS.read, CLIENT_CHANNELS.dispatch, CLIENT_CHANNELS.upload, CLIENT_CHANNELS.download, CLIENT_CHANNELS.watch]) input.ipc.removeHandler(channel)
    input.ipc.removeListener(CLIENT_CHANNELS.cancel, cancel)
    input.ipc.removeListener(CLIENT_CHANNELS.diagnostic, diagnostic)
  }
}
