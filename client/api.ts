import {
  ClientError, type ClientConnectInput, type ClientConnection, type ClientErrorData, type ClientGateway,
  type CommandInputMap, type CommandOutputMap, type QueryInputMap, type QueryOutputMap,
} from '../contracts/client'
import type { AppBootstrap } from '../contracts/control'
import type { GraphSuccess } from '../contracts/graph'
export { ClientError } from '../contracts/client'

export const CLIENT_QUERY_METHODS = ['map.list', 'map.get', 'run.get', 'app.bootstrap', 'workspace.list', 'workspace.get', 'agent.list', 'asset.get'] as const
export const CLIENT_COMMAND_METHODS = ['map.create', 'map.delete', 'graph.apply', 'run.start', 'run.cancel', 'review.update', 'review.answer',
  'workspace.create', 'workspace.update', 'workspace.delete', 'member.set', 'preferences.set', 'agent.create', 'agent.update', 'agent.delete',
  'agent.copy', 'settings.update', 'asset.delete', 'workspace.import'] as const
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

function clientCreateError(code: string, message: string, retryable = false, status = 0): ClientError {
  return new ClientError({ code, message, retryable, status })
}
function clientIsObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clientIsStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function clientIsScore(value: unknown): boolean { return value === 0 || value === 0.5 || value === 1 }
function clientIsLocator(value: unknown): boolean {
  return clientIsObject(value) && (value.kind === 'asset'
    ? typeof value.assetId === 'string' && !!value.assetId && typeof value.mediaType === 'string'
    : value.kind === 'url' && typeof value.url === 'string')
}
function clientAssertNode(value: unknown, index: number): void {
  const clientCreateNodeError = () => clientCreateError('INVALID_RESPONSE', 'Service returned invalid Node data at nodes[' + index + ']')
  if (!clientIsObject(value) || typeof value.id !== 'string' || !value.id
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !clientIsObject(value.data)) throw clientCreateNodeError()
  const data = value.data
  let valid = false
  switch (data.kind) {
    case 'news':
      if (!clientIsObject(data.context)) throw clientCreateError('INVALID_RESPONSE', 'Service returned missing or invalid news.context at nodes[' + index + ']')
      valid = typeof data.content === 'string' && Object.values(data.context).every(field =>
        clientIsObject(field) && typeof field.value === 'string' && typeof field.visibleToAI === 'boolean')
      break
    case 'claim':
      valid = typeof data.content === 'string' && (data.category === null || typeof data.category === 'string')
      break
    case 'source':
      valid = clientIsLocator(data.locator) && (data.label === null || typeof data.label === 'string')
      break
    case 'evidence':
      valid = typeof data.content === 'string' && clientIsLocator(data.locator) && typeof data.capturedAt === 'string'
      break
    case 'verification':
      valid = clientIsScore(data.score) && typeof data.reason === 'string' && clientIsStrings(data.reportIds)
        && Array.isArray(data.opinions) && data.opinions.every(opinion => clientIsObject(opinion)
          && ['id', 'slotId', 'agentId', 'agentName', 'angle', 'reason', 'createdAt'].every(key => typeof opinion[key] === 'string')
          && typeof opinion.routeRevision === 'number' && Number.isSafeInteger(opinion.routeRevision) && opinion.routeRevision >= 0
          && clientIsScore(opinion.score) && clientIsStrings(opinion.tools))
      break
  }
  if (!valid) throw clientCreateNodeError()
}
export function clientReadError(error: unknown): ClientErrorData {
  if (error instanceof ClientError) return { code: error.code, message: error.message, retryable: error.retryable, status: error.status,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
  return { code: 'CLIENT_ERROR', message: error instanceof Error ? error.message : 'Client request failed', status: 0, retryable: false }
}
export function clientReadBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw clientCreateError('INVALID_URL', 'Enter a valid HTTP(S) service address') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw clientCreateError('INVALID_URL', 'Service address must be an HTTP(S) origin without credentials, path, query or fragment')
  }
  return url.origin
}
function clientAssertData(method: string, data: unknown): void {
  const fields: Record<string, string[]> = {
    'app.bootstrap': ['identity', 'settings', 'metadata'], 'map.get': ['mapId', 'workspaceId', 'name', 'revision', 'nodes', 'edges', 'run', 'updatedAt'],
    'run.get': ['id', 'mode', 'status', 'configuration', 'operation', 'createdAt', 'updatedAt'],
    'workspace.list': ['items', 'nextCursor'], 'workspace.get': ['id', 'revision', 'agents', 'members', 'preferences'],
    'agent.list': ['scope', 'revision', 'items'], 'asset.get': ['id', 'workspaceId', 'filename', 'mediaType', 'size', 'sha256'],
    'workspace.create': ['id', 'revision', 'agents', 'members'], 'workspace.update': ['id', 'revision', 'agents', 'members'],
    'workspace.delete': ['workspaceId', 'deleted'], 'member.set': ['userId', 'member', 'workspaceRevision'],
    'preferences.set': ['workspaceId', 'revision', 'openMapIds', 'currentMapId', 'nodeSelection'],
    'agent.create': ['scope', 'revision', 'items'], 'agent.update': ['scope', 'revision', 'items'], 'agent.delete': ['scope', 'revision', 'items'],
    'agent.copy': ['id', 'revision', 'agents'], 'settings.update': ['revision', 'llm', 'tools', 'limits'],
    'asset.delete': ['assetId', 'deleted'], 'workspace.import': ['workspaceId', 'mapIds', 'assetIds'],
    'map.delete': ['mapId', 'deleted'],
  }
  if (method === 'map.list') {
    if (!Array.isArray(data)) throw clientCreateError('INVALID_RESPONSE', 'Map list is missing')
    return
  }
  const required = fields[method] ?? ['snapshot', 'createdNodeIds', 'createdEdgeIds']
  if (!clientIsObject(data) || required.some(key => !Object.prototype.hasOwnProperty.call(data, key) || data[key] === undefined)) throw clientCreateError('INVALID_RESPONSE', 'Service response is incomplete for ' + method)
  for (const key of ['nodes', 'edges', 'items', 'members', 'agents', 'tools', 'createdNodeIds', 'createdEdgeIds', 'openMapIds', 'mapIds', 'assetIds']) {
    if (key in data && !Array.isArray(data[key])) throw clientCreateError('INVALID_RESPONSE', 'Service response has an invalid ' + key)
  }
  for (const key of ['revision', 'workspaceRevision', 'size']) {
    if (key in data && (typeof data[key] !== 'number' || !Number.isSafeInteger(data[key]) || data[key] < 0)) throw clientCreateError('INVALID_RESPONSE', 'Service response has an invalid ' + key)
  }
  for (const key of ['id', 'mapId', 'workspaceId', 'assetId']) {
    if (key in data && (typeof data[key] !== 'string' || !data[key])) throw clientCreateError('INVALID_RESPONSE', 'Service response has an invalid ' + key)
  }
  for (const key of ['identity', 'settings', 'metadata', 'preferences', 'nodeSelection', 'scope', 'llm', 'limits', 'configuration', 'operation']) {
    if (key in data && !clientIsObject(data[key])) throw clientCreateError('INVALID_RESPONSE', 'Service response has an invalid ' + key)
  }
  if ('deleted' in data && data.deleted !== true) throw clientCreateError('INVALID_RESPONSE', 'Service did not confirm deletion')
  if ('run' in data && data.run !== null && !clientIsObject(data.run)) throw clientCreateError('INVALID_RESPONSE', 'Service returned an invalid Run')
  if (method === 'app.bootstrap' && (!clientIsObject(data.identity) || typeof data.identity.userId !== 'string'
    || typeof data.identity.displayName !== 'string' || typeof data.identity.hostAdmin !== 'boolean'
    || !clientIsObject(data.settings) || !clientIsObject(data.metadata))) throw clientCreateError('INVALID_RESPONSE', 'Service did not return an authenticated application identity')
  if (method === 'app.bootstrap') clientAssertData('settings.update', data.settings)
  if (method === 'map.get') {
    (data.nodes as unknown[]).forEach(clientAssertNode)
    for (const edge of data.edges as unknown[]) {
      if (!clientIsObject(edge) || !['id', 'from', 'to'].every(key => typeof edge[key] === 'string' && !!edge[key])
        || !['mentions', 'verifies', 'related-to'].includes(String(edge.kind))) throw clientCreateError('INVALID_RESPONSE', 'Service returned invalid Graph edge data')
    }
  }
  if ('snapshot' in data) clientAssertData('map.get', data.snapshot)
}
async function clientReadJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw clientCreateError('RESPONSE_TOO_LARGE', 'Service response exceeds 16 MiB')
  }
  if (!response.body) throw clientCreateError('INVALID_RESPONSE', 'Service returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw clientCreateError('RESPONSE_TOO_LARGE', 'Service response exceeds 16 MiB') }
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    try { return JSON.parse(chunks.join('')) } catch { throw clientCreateError('INVALID_RESPONSE', 'Service returned invalid JSON', response.status >= 500, response.status) }
  } finally { reader.releaseLock() }
}
export interface ClientApiOptions { baseUrl: string; token: string; timeoutMs?: number; fetch?: typeof globalThis.fetch }
export function clientCreateApi(options: ClientApiOptions) {
  const baseUrl = clientReadBaseUrl(options.baseUrl)
  const token = options.token.trim()
  if (!token || /[^\x21-\x7e]/.test(token)) throw clientCreateError('INVALID_TOKEN', 'Enter a valid service token')
  const timeoutMs = options.timeoutMs ?? 15000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw clientCreateError('INVALID_TIMEOUT', 'Request timeout must be a positive integer')
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const lifetime = new AbortController()

  async function clientSendRequest<T>(path: '/api/v1/query' | '/api/v1/command', method: string, body: unknown, requestId?: string, signal?: AbortSignal): Promise<GraphSuccess<T>> {
    if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', 'Connection was closed')
    if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', 'Request was cancelled')
    const controller = new AbortController()
    const abort = () => controller.abort()
    lifetime.signal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
    try {
      const response = await fetcher(new URL(path, baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal: controller.signal,
      })
      const value = await clientReadJson(response)
      if (!response.ok || !clientIsObject(value) || value.ok !== true) {
        const detail = clientIsObject(value) && clientIsObject(value.error) ? value.error : {}
        throw new ClientError({
          status: response.status, code: typeof detail.code === 'string' ? detail.code : 'HTTP_ERROR',
          message: typeof detail.message === 'string' ? detail.message : 'Service request failed',
          retryable: typeof detail.retryable === 'boolean' ? detail.retryable : response.status >= 500 || response.status === 429,
          ...(typeof detail.currentRevision === 'number' ? { currentRevision: detail.currentRevision } : {}),
        })
      }
      if (typeof value.requestId !== 'string' || !value.requestId || typeof value.replayed !== 'boolean'
        || !Object.prototype.hasOwnProperty.call(value, 'data') || (requestId !== undefined && value.requestId !== requestId)) throw clientCreateError('INVALID_RESPONSE', 'Service did not return the matching request result')
      clientAssertData(method, value.data)
      if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', 'Connection was closed')
      if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', 'Request was cancelled')
      return value as unknown as GraphSuccess<T>
    } catch (error) {
      if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', 'Connection was closed')
      if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', 'Request was cancelled')
      if (timedOut) throw clientCreateError('REQUEST_TIMEOUT', 'Request timed out; retry with the same request ID', true)
      if (error instanceof ClientError) throw error
      throw clientCreateError('NETWORK_ERROR', 'Service request failed or an HTTP redirect was refused', true)
    } finally {
      clearTimeout(timer)
      lifetime.signal.removeEventListener('abort', abort)
      signal?.removeEventListener('abort', abort)
    }
  }
  return {
    async read<K extends keyof QueryInputMap>(method: K, params: QueryInputMap[K], signal?: AbortSignal): Promise<QueryOutputMap[K]> {
      if (!(CLIENT_QUERY_METHODS as readonly string[]).includes(method)) throw clientCreateError('UNKNOWN_METHOD', 'Unknown public query')
      return (await clientSendRequest<QueryOutputMap[K]>('/api/v1/query', method, { method, params }, undefined, signal)).data
    },
    dispatch<K extends keyof CommandInputMap>(requestId: string, method: K, params: CommandInputMap[K], signal?: AbortSignal): Promise<GraphSuccess<CommandOutputMap[K]>> {
      if (!(CLIENT_COMMAND_METHODS as readonly string[]).includes(method)) return Promise.reject(clientCreateError('UNKNOWN_METHOD', 'Unknown public command'))
      if (typeof requestId !== 'string' || !requestId) return Promise.reject(clientCreateError('INVALID_REQUEST_ID', 'Command needs a stable request ID'))
      return clientSendRequest('/api/v1/command', method, { requestId, method, params }, requestId, signal)
    },
    close(): void { lifetime.abort() },
  }
}
export type ClientApi = ReturnType<typeof clientCreateApi>
/** Main provides this concrete OS-backed store; browser callers omit it and keep tokens in memory. */
export interface ClientConnectionStore {
  load(): Promise<{ baseUrl: string; token: string | null; remembered: boolean } | null>
  save(input: ClientConnectInput): Promise<boolean>
  clear(): Promise<void>
  canRemember(): boolean
}
export interface ClientGatewayOptions { baseUrl: string; timeoutMs?: number; fetch?: typeof globalThis.fetch; store?: ClientConnectionStore }
export function clientCreateGateway(options: ClientGatewayOptions): ClientGateway & { close(): void } {
  let baseUrl = clientReadBaseUrl(options.baseUrl)
  let active: ClientApi | null = null
  let pending: ClientApi | null = null
  let remembered = false
  let generation = 0
  let closed = false
  let tail: Promise<unknown> = Promise.resolve()
  const initialized = (async () => {
    const saved = await options.store?.load()
    if (!saved || generation !== 0) return
    baseUrl = clientReadBaseUrl(saved.baseUrl)
    if (saved.token) active = clientCreateApi({ ...options, baseUrl, token: saved.token })
    remembered = !!saved.token && saved.remembered
  })()
  function clientEnqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
  async function clientReadApi(): Promise<ClientApi> {
    await initialized
    if (closed || !active) throw clientCreateError('NOT_CONNECTED', 'Connect to the service first')
    return active
  }
  return {
    async getConnection(): Promise<ClientConnection> {
      await initialized
      return { baseUrl, configured: active !== null, remembered, canRemember: options.store?.canRemember() ?? false }
    },
    connect(input: ClientConnectInput): Promise<AppBootstrap> {
      if (closed) return Promise.reject(clientCreateError('DISCONNECTED', 'Connection was closed'))
      const version = ++generation
      pending?.close(); active?.close(); active = null; remembered = false
      return clientEnqueueOperation(async () => {
        await initialized
        if (version !== generation) throw clientCreateError('CONNECTION_CHANGED', 'Connection request was superseded')
        await options.store?.clear()
        const url = clientReadBaseUrl(input.baseUrl)
        baseUrl = url
        const candidate = clientCreateApi({ ...options, baseUrl: url, token: input.token })
        pending = candidate
        try {
          const bootstrap = await candidate.read('app.bootstrap', {})
          if (version !== generation) throw clientCreateError('CONNECTION_CHANGED', 'Connection request was superseded')
          const saved = await options.store?.save({ ...input, baseUrl: url }) ?? false
          if (version !== generation) throw clientCreateError('CONNECTION_CHANGED', 'Connection request was superseded')
          active?.close()
          active = candidate; pending = null; baseUrl = url; remembered = saved
          return bootstrap
        } catch (error) { candidate.close(); if (pending === candidate) pending = null; throw error }
      })
    },
    disconnect(): Promise<void> {
      generation++
      pending?.close(); active?.close(); active = null; remembered = false
      return clientEnqueueOperation(async () => { await initialized; await options.store?.clear() })
    },
    async read(method, params, signal) { return (await clientReadApi()).read(method, params, signal) },
    async dispatch(requestId, method, params, signal) { return (await clientReadApi()).dispatch(requestId, method, params, signal) },
    close(): void {
      closed = true; generation++
      pending?.close(); active?.close(); active = null
    },
  }
}
