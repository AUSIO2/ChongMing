import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from 'electron'
import { CLIENT_CHANNELS } from './client-channels'
import { CLIENT_COMMAND_METHODS, CLIENT_QUERY_METHODS, clientReadError } from '../client/api'
import { ClientError, type ClientBridgeResult, type ClientConnectInput, type ClientGateway, type CommandInputMap, type QueryInputMap } from '../contracts/client'

function clientCreateIpcError(code: string, message: string): ClientError {
  return new ClientError({ code, message, status: 400, retryable: false })
}
export function clientAssertSender(event: Pick<IpcMainInvokeEvent, 'sender' | 'senderFrame'>, contents: WebContents | null, rendererUrl: string): void {
  const frame = event.senderFrame
  if (!contents || contents.isDestroyed() || event.sender !== contents || !frame
    || frame.routingId !== contents.mainFrame.routingId || frame.processId !== contents.mainFrame.processId) {
    throw clientCreateIpcError('IPC_FORBIDDEN', 'Only the application main frame may use this bridge')
  }
  const expected = new URL(rendererUrl), actual = new URL(frame.url)
  if (expected.protocol === 'file:'
    ? actual.protocol !== 'file:' || actual.host !== expected.host || actual.pathname !== expected.pathname
    : actual.protocol !== expected.protocol || actual.origin !== expected.origin) throw clientCreateIpcError('IPC_FORBIDDEN', 'Untrusted application frame')
}
function clientReadCallId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw clientCreateIpcError('INVALID_CALL_ID', 'Invalid client call id')
  return value
}
function clientReadParams(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw clientCreateIpcError('INVALID_ARGUMENT', 'Request params must be an object')
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 1024 * 1024) throw clientCreateIpcError('INVALID_ARGUMENT', 'Request exceeds 1 MiB')
  return value as Record<string, unknown>
}
function clientReadConnection(value: unknown): ClientConnectInput {
  const item = clientReadParams(value)
  if (Object.keys(item).some(key => !['baseUrl', 'token', 'remember'].includes(key))
    || typeof item.baseUrl !== 'string' || typeof item.token !== 'string' || typeof item.remember !== 'boolean') {
    throw clientCreateIpcError('INVALID_ARGUMENT', 'Invalid connection input')
  }
  return { baseUrl: item.baseUrl, token: item.token, remember: item.remember }
}

export function clientRegisterIpc(input: { ipc: IpcMain; gateway: ClientGateway; rendererUrl: string; contents: () => WebContents | null }): () => void {
  const calls = new Map<string, { owner: WebContents; controller: AbortController }>()
  const cancelled = new Set<string>()
  const senders = new Set<WebContents>()
  async function clientCreateReply<T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<ClientBridgeResult<T>> {
    try { clientAssertSender(event, input.contents(), input.rendererUrl); return { ok: true, value: await operation() } }
    catch (error) { return { ok: false, error: clientReadError(error) } }
  }
  async function clientRunCall<T>(event: IpcMainInvokeEvent, rawId: unknown, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const id = clientReadCallId(rawId)
    if (calls.has(id)) throw clientCreateIpcError('CALL_EXISTS', 'Client call id is already active')
    if (cancelled.delete(id)) throw clientCreateIpcError('REQUEST_ABORTED', 'Request was cancelled')
    const controller = new AbortController()
    calls.set(id, { owner: event.sender, controller })
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
  input.ipc.handle(CLIENT_CHANNELS.connection, event => clientCreateReply(event, () => input.gateway.getConnection()))
  input.ipc.handle(CLIENT_CHANNELS.connect, (event, value) => clientCreateReply(event, () => input.gateway.connect(clientReadConnection(value))))
  input.ipc.handle(CLIENT_CHANNELS.disconnect, event => clientCreateReply(event, async () => { await input.gateway.disconnect(); return null }))
  input.ipc.handle(CLIENT_CHANNELS.read, (event, id, method, params) => clientCreateReply(event, async () => {
    if (!(CLIENT_QUERY_METHODS as readonly string[]).includes(method)) throw clientCreateIpcError('UNKNOWN_METHOD', 'Unknown public query')
    const value = clientReadParams(params)
    return clientRunCall(event, id, signal => input.gateway.read(method as keyof QueryInputMap, value as QueryInputMap[keyof QueryInputMap], signal))
  }))
  input.ipc.handle(CLIENT_CHANNELS.dispatch, (event, id, requestId, method, params) => clientCreateReply(event, async () => {
    if (!(CLIENT_COMMAND_METHODS as readonly string[]).includes(method)) throw clientCreateIpcError('UNKNOWN_METHOD', 'Unknown public command')
    clientReadCallId(requestId)
    const value = clientReadParams(params)
    return clientRunCall(event, id, signal => input.gateway.dispatch(requestId, method as keyof CommandInputMap, value as CommandInputMap[keyof CommandInputMap], signal))
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
  return () => {
    for (const call of calls.values()) call.controller.abort()
    calls.clear(); cancelled.clear()
    for (const channel of [CLIENT_CHANNELS.connection, CLIENT_CHANNELS.connect, CLIENT_CHANNELS.disconnect, CLIENT_CHANNELS.read, CLIENT_CHANNELS.dispatch]) input.ipc.removeHandler(channel)
    input.ipc.removeListener(CLIENT_CHANNELS.cancel, cancel)
  }
}
