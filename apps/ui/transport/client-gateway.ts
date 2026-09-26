import { clientCreateGateway } from '../../../client/graph-client'
import { ClientError, type ClientBridge, type ClientBridgeResult, type ClientGateway } from '../../../contracts/client'
import { RuntimeMessage } from '../../../contracts/messages'

// 用途：读取结果，并把结构化结果交给调用方。
function apiReadResult<T>(result: ClientBridgeResult<T>): T {
  if (!result || typeof result.ok !== 'boolean') throw new ClientError({ code: 'INVALID_BRIDGE_RESPONSE', message: RuntimeMessage.DESKTOP_BRIDGE_RETURNED_NO_RESULT, status: 0, retryable: false })
  if (!result.ok) throw new ClientError(result.error)
  return result.value
}
// 用途：创建错误，供后续流程使用。
function apiCreateAbortError(): ClientError {
  return new ClientError({ code: 'REQUEST_ABORTED', message: RuntimeMessage.REQUEST_WAS_CANCELLED, status: 0, retryable: false })
}
// 用途：创建网关，供后续流程使用。
export function apiCreateGateway(input: { bridge?: ClientBridge; baseUrl?: string } = {}): ClientGateway {
  const bridge = input.bridge ?? (typeof window === 'undefined' ? undefined : window.chongmingClient)
  if (!bridge) {
    if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
      const apiRejectRequest = async (): Promise<never> => { throw new ClientError({ code: 'DESKTOP_BRIDGE_UNAVAILABLE', message: RuntimeMessage.DESKTOP_CLIENT_BRIDGE_IS_UNAVAILABLE, status: 0, retryable: false }) }
      return { watch: apiRejectRequest, getConnection: apiRejectRequest, connect: apiRejectRequest, disconnect: apiRejectRequest, read: apiRejectRequest, dispatch: apiRejectRequest, upload: apiRejectRequest, download: apiRejectRequest }
    }
    return clientCreateGateway({ baseUrl: input.baseUrl ?? (typeof window === 'undefined' ? 'http://127.0.0.1:4320' : window.location.origin) })
  }
  const apiRunCall = async <T>(operation: (callId: string) => Promise<ClientBridgeResult<T>>, signal?: AbortSignal): Promise<T> => {
    if (signal?.aborted) throw apiCreateAbortError()
    const callId = crypto.randomUUID()
    let started = false
    let rejectAbort: (reason: ClientError) => void = () => {}
    const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
    const abort = () => {
      if (started) bridge.cancel(callId)
      rejectAbort(apiCreateAbortError())
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await Promise.race([
        Promise.resolve().then(async () => {
          if (signal?.aborted) throw apiCreateAbortError()
          started = true
          return apiReadResult(await operation(callId))
        }),
        aborted,
      ])
    } finally { signal?.removeEventListener('abort', abort) }
  }
  return {
    // 用途：处理界面相关工作，并把结果交给调用方。
    async connectLocal() { return apiReadResult(await bridge.connectLocal()) },
    // 用途：处理界面相关工作，并把结果交给调用方。
    async watch(mapId, onEvent, signal) {
      if (signal?.aborted) throw apiCreateAbortError()
      let dispose = () => {}, closed = false
      const lifetime = new AbortController()
      const abort = () => lifetime.abort()
      signal?.addEventListener('abort', abort, { once: true })
      let rejectStream!: (error: unknown) => void
      const failed = new Promise<never>((_resolve, reject) => { rejectStream = reject })
      try {
        await Promise.race([apiRunCall(watchId => {
          let sequence = 0
          dispose = bridge.onStream(message => {
            if (closed || message.watchId !== watchId) return
            try {
              if (message.sequence !== sequence + 1) throw new ClientError({ code: 'STREAM_SEQUENCE', message: RuntimeMessage.REAL_TIME_UPDATES_ARRIVED_OUT_OF_SEQUENCE, status: 0, retryable: true })
              sequence = message.sequence
              onEvent(message.event)
            } catch (error) { closed = true; rejectStream(error); lifetime.abort() }
          })
          return bridge.watch(watchId, mapId)
        }, lifetime.signal), failed])
      } finally { closed = true; dispose(); lifetime.abort(); signal?.removeEventListener('abort', abort) }
    },
    // 用途：处理界面相关工作，并把结果交给调用方。
    async getConnection() { return apiReadResult(await bridge.getConnection()) },
    // 用途：处理界面相关工作，并把结果交给调用方。
    async connect(input) { return apiReadResult(await bridge.connect(input)) },
    // 用途：处理界面相关工作，并把结果交给调用方。
    async disconnect() { apiReadResult(await bridge.disconnect()) },
    // 用途：处理界面相关工作，并把结果交给调用方。
    read(method, params, signal) { return apiRunCall(callId => bridge.read(callId, method, params), signal) },
    // 用途：处理界面相关工作，并把结果交给调用方。
    dispatch(requestId, method, params, signal) { return apiRunCall(callId => bridge.dispatch(callId, requestId, method, params), signal) },
    // 用途：处理界面相关工作，并把结果交给调用方。
    upload(requestId, input, signal) { return apiRunCall(callId => bridge.upload(callId, requestId, input), signal) },
    // 用途：处理界面相关工作，并把结果交给调用方。
    download(input, signal) { return apiRunCall(callId => bridge.download(callId, input), signal) },
  }
}

/** Constructing this gateway is lazy: no browser globals in Node and no request before connect/read. */
export const api = apiCreateGateway()
