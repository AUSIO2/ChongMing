import { clientCreateGateway } from '../client/api'
import { ClientError, type ClientBridge, type ClientBridgeResult, type ClientGateway } from '../contracts/client'

function apiReadResult<T>(result: ClientBridgeResult<T>): T {
  if (!result || typeof result.ok !== 'boolean') throw new ClientError({ code: 'INVALID_BRIDGE_RESPONSE', message: 'Desktop bridge returned no result', status: 0, retryable: false })
  if (!result.ok) throw new ClientError(result.error)
  return result.value
}
function apiCreateAbortError(): ClientError {
  return new ClientError({ code: 'REQUEST_ABORTED', message: 'Request was cancelled', status: 0, retryable: false })
}
function apiCreateBridge(bridge: ClientBridge): ClientGateway {
  async function apiRunCall<T>(operation: (callId: string) => Promise<ClientBridgeResult<T>>, signal?: AbortSignal): Promise<T> {
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
    async getConnection() { return apiReadResult(await bridge.getConnection()) },
    async connect(input) { return apiReadResult(await bridge.connect(input)) },
    async disconnect() { apiReadResult(await bridge.disconnect()) },
    read(method, params, signal) { return apiRunCall(callId => bridge.read(callId, method, params), signal) },
    dispatch(requestId, method, params, signal) { return apiRunCall(callId => bridge.dispatch(callId, requestId, method, params), signal) },
  }
}

export function apiCreateGateway(input: { bridge?: ClientBridge; baseUrl?: string } = {}): ClientGateway {
  const bridge = input.bridge ?? (typeof window === 'undefined' ? undefined : window.chongmingClient)
  if (bridge) return apiCreateBridge(bridge)
  if (typeof window !== 'undefined' && window.location.protocol === 'file:') {
    const apiRejectRequest = async (): Promise<never> => { throw new ClientError({ code: 'DESKTOP_BRIDGE_UNAVAILABLE', message: 'Desktop client bridge is unavailable', status: 0, retryable: false }) }
    return { getConnection: apiRejectRequest, connect: apiRejectRequest, disconnect: apiRejectRequest, read: apiRejectRequest, dispatch: apiRejectRequest }
  }
  return clientCreateGateway({ baseUrl: input.baseUrl ?? (typeof window === 'undefined' ? 'http://127.0.0.1:4320' : window.location.origin) })
}

/** Constructing this gateway is lazy: no browser globals in Node and no request before connect/read. */
export const api = apiCreateGateway()
