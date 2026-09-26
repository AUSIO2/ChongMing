import { RuntimeMessage, messageFormat } from '../contracts/messages'
import { activityIsRecord } from '../contracts/activity'
import {
  ClientError, CLIENT_FILE_LIMIT, type ClientUploadInput, type ClientDownloadInput, type ClientFile, type ClientConnectInput, type ClientConnection, type ClientErrorData, type ClientGateway,
  type CommandInputMap, type CommandOutputMap, type QueryInputMap, type QueryOutputMap,
} from '../contracts/client'
import type { AppBootstrap, Asset } from '../contracts/control'
import type { GraphSuccess } from '../contracts/graph'
import type { GraphStreamEvent } from '../contracts/events'
export { ClientError } from '../contracts/client'

export const CLIENT_QUERY_METHODS = ['map.list', 'map.get', 'run.get', 'app.bootstrap', 'workspace.list', 'workspace.get', 'agent.list', 'asset.get', 'asset.list'] as const
export const CLIENT_COMMAND_METHODS = ['map.create', 'map.delete', 'graph.apply', 'run.start', 'run.cancel', 'run.pause', 'run.resume', 'review.update', 'review.answer',
  'workspace.create', 'workspace.update', 'workspace.delete', 'member.set', 'preferences.set', 'agent.create', 'agent.update', 'agent.delete',
  'agent.copy', 'settings.update', 'asset.delete', 'workspace.import'] as const
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024

// 用途：校验文件标识输入，发现不符合约束时立即报错。
function clientAssertFileId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.FILE_OPERATION_REQUIRES_A_UUID)
}
// 用途：校验文件名输入，发现不符合约束时立即报错。
function clientAssertFilename(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > 255 || /[\x00-\x1f\x7f/\\]/.test(value)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.USE_A_FILENAME_WITHOUT_PATHS_OR_CONTROL_CHARACTERS)
}
// 用途：校验上传内容输入，发现不符合约束时立即报错。
export function clientAssertUpload(requestId: unknown, value: unknown): asserts value is ClientUploadInput {
  clientAssertFileId(requestId)
  if (!clientIsObject(value) || Object.keys(value).some(key => !['workspaceId', 'filename', 'mediaType', 'bytes'].includes(key))) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.INVALID_UPLOAD_INPUT)
  clientAssertFileId(value.workspaceId); clientAssertFilename(value.filename)
  if (typeof value.mediaType !== 'string' || !value.mediaType.trim() || value.mediaType.length > 255 || /[\x00-\x1f\x7f]/.test(value.mediaType)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.INVALID_MEDIA_TYPE)
  if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength > CLIENT_FILE_LIMIT) throw clientCreateError('FILE_TOO_LARGE', RuntimeMessage.UPLOAD_MUST_CONTAIN_AT_MOST_64_MIB_OF_BYTES)
}
// 用途：校验下载内容输入，发现不符合约束时立即报错。
export function clientAssertDownload(value: unknown): asserts value is ClientDownloadInput {
  if (!clientIsObject(value) || Object.keys(value).some(key => !['kind', 'id'].includes(key)) || !['asset', 'map', 'workspace'].includes(String(value.kind))) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.CHOOSE_AN_ASSET_MAP_OR_WORKSPACE_TO_DOWNLOAD)
  clientAssertFileId(value.id)
}
// 用途：读取摘要，并把结构化结果交给调用方。
async function clientReadDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
// 用途：读取字节，并把结构化结果交给调用方。
async function clientReadBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  const decoded = !!encoding && encoding !== 'identity'
  if (declared !== null && (!/^[0-9]+$/.test(declared) || (!decoded && Number(declared) > CLIENT_FILE_LIMIT))) {
    await response.body?.cancel(); throw clientCreateError('FILE_TOO_LARGE', RuntimeMessage.DOWNLOAD_EXCEEDS_64_MIB)
  }
  if (!response.body) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_NO_FILE_BODY)
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > CLIENT_FILE_LIMIT) throw clientCreateError('FILE_TOO_LARGE', RuntimeMessage.DOWNLOAD_EXCEEDS_64_MIB)
      chunks.push(part.value)
    }
    if (!decoded && declared !== null && size !== Number(declared)) throw clientCreateError('FILE_INTEGRITY', RuntimeMessage.DOWNLOADED_FILE_LENGTH_DOES_NOT_MATCH)
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  } finally { await reader.cancel(); reader.releaseLock() }
}

// 用途：创建错误，供后续流程使用。
function clientCreateError(code: string, message: string, retryable = false, status = 0): ClientError {
  return new ClientError({ code, message, retryable, status })
}
// 用途：判断客户端请求是否满足当前条件。
function clientIsObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
// 用途：判断客户端请求是否满足当前条件。
function clientIsStrings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
// 用途：判断客户端请求是否满足当前条件。
function clientIsScore(value: unknown): boolean { return value === 0 || value === 0.5 || value === 1 }
// 用途：判断客户端请求是否满足当前条件。
function clientIsLocator(value: unknown): boolean {
  return clientIsObject(value) && (value.kind === 'asset'
    ? typeof value.assetId === 'string' && !!value.assetId && typeof value.mediaType === 'string'
    : value.kind === 'url' && typeof value.url === 'string')
}
// 用途：校验节点输入，发现不符合约束时立即报错。
function clientAssertNode(value: unknown, index: number): void {
  const clientCreateNodeError = () => clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RETURNED_INVALID_NODE_DATA_AT_NODES_VALUE, index))
  if (!clientIsObject(value) || typeof value.id !== 'string' || !value.id
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !clientIsObject(value.data)) throw clientCreateNodeError()
  const data = value.data
  let valid = false
  switch (data.kind) {
    case 'news':
      if (!clientIsObject(data.context)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RETURNED_MISSING_OR_INVALID_NEWS_CONTEXT_AT_NODES_VALUE, index))
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
// 用途：读取错误，并把结构化结果交给调用方。
export function clientReadError(error: unknown): ClientErrorData {
  if (error instanceof ClientError) return { code: error.code, message: error.message, retryable: error.retryable, status: error.status,
    errorId: error.errorId,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
  return { code: 'CLIENT_ERROR', message: RuntimeMessage.CLIENT_INTERNAL_ERROR, status: 0, retryable: false, errorId: crypto.randomUUID() }
}
// 用途：读取地址，并把结构化结果交给调用方。
export function clientReadBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw clientCreateError('INVALID_URL', RuntimeMessage.ENTER_A_VALID_HTTP_S_SERVICE_ADDRESS) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw clientCreateError('INVALID_URL', RuntimeMessage.SERVICE_ADDRESS_MUST_BE_AN_HTTP_S_ORIGIN_WITHOUT_CREDENTIALS_PATH_QUERY)
  }
  return url.origin
}
// 用途：校验数据输入，发现不符合约束时立即报错。
function clientAssertData(method: string, data: unknown): void {
  const fields: Record<string, string[]> = {
    'app.bootstrap': ['identity', 'settings', 'metadata'], 'map.get': ['mapId', 'workspaceId', 'name', 'revision', 'nodes', 'edges', 'run', 'updatedAt'],
    'run.get': ['id', 'scope', 'until', 'paused', 'regenerate', 'mode', 'status', 'configuration', 'operations', 'createdAt', 'updatedAt'],
    'asset.list': ['items', 'nextCursor'], 'workspace.list': ['items', 'nextCursor'], 'workspace.get': ['id', 'revision', 'agents', 'members', 'preferences'],
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
    if (!Array.isArray(data)) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.MAP_LIST_IS_MISSING)
    return
  }
  const required = fields[method] ?? ['snapshot', 'createdNodeIds', 'createdEdgeIds']
  if (!clientIsObject(data) || required.some(key => !Object.prototype.hasOwnProperty.call(data, key) || data[key] === undefined)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_IS_INCOMPLETE_FOR_VALUE, method))
  for (const key of ['nodes', 'edges', 'items', 'members', 'agents', 'tools', 'operations', 'createdNodeIds', 'createdEdgeIds', 'openMapIds', 'mapIds', 'assetIds']) {
    if (key in data && !Array.isArray(data[key])) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  for (const key of ['revision', 'workspaceRevision', 'size']) {
    if (key in data && (typeof data[key] !== 'number' || !Number.isSafeInteger(data[key]) || data[key] < 0)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  for (const key of ['id', 'mapId', 'workspaceId', 'assetId']) {
    if (key in data && (typeof data[key] !== 'string' || !data[key])) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  for (const key of ['identity', 'settings', 'metadata', 'preferences', 'nodeSelection', 'scope', 'llm', 'limits', 'configuration']) {
    if (key in data && !clientIsObject(data[key])) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  if ('deleted' in data && data.deleted !== true) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_DID_NOT_CONFIRM_DELETION)
  if ('run' in data && data.run !== null && !clientIsObject(data.run)) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_AN_INVALID_RUN)
  if ('run' in data && data.run !== null) clientAssertData('run.get', data.run)
  if (method === 'run.get' && (typeof data.paused !== 'boolean' || typeof data.regenerate !== 'boolean'
    || !clientIsObject(data.scope) || !clientIsStrings(data.scope.nodeIds)
    || !['news', 'claims', 'verified'].includes(String(data.until)))) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_RUN_CONTROLS)
  if (method === 'app.bootstrap' && (!clientIsObject(data.identity) || typeof data.identity.userId !== 'string'
    || typeof data.identity.displayName !== 'string' || typeof data.identity.hostAdmin !== 'boolean'
    || !clientIsObject(data.settings) || !clientIsObject(data.metadata))) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_DID_NOT_RETURN_AN_AUTHENTICATED_APPLICATION_IDENTITY)
  if (method === 'app.bootstrap') clientAssertData('settings.update', data.settings)
  if (method === 'map.get') {
    (data.nodes as unknown[]).forEach(clientAssertNode)
    for (const edge of data.edges as unknown[]) {
      if (!clientIsObject(edge) || !['id', 'from', 'to'].every(key => typeof edge[key] === 'string' && !!edge[key])
        || !['derived-from', 'mentions', 'verifies', 'related-to'].includes(String(edge.kind))) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_GRAPH_EDGE_DATA)
    }
  }
  if (method === 'asset.list') {
    for (const asset of data.items as unknown[]) clientAssertData('asset.get', asset)
    if (data.nextCursor !== null && typeof data.nextCursor !== 'string') throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.INVALID_ASSET_CURSOR)
  }
  if ('snapshot' in data) clientAssertData('map.get', data.snapshot)
}
// 用途：读取JSON，并把结构化结果交给调用方。
async function clientReadJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {})
    throw clientCreateError('RESPONSE_TOO_LARGE', RuntimeMessage.SERVICE_RESPONSE_EXCEEDS_16_MIB)
  }
  if (!response.body) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_NO_RESPONSE_BODY)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const chunks: string[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw clientCreateError('RESPONSE_TOO_LARGE', RuntimeMessage.SERVICE_RESPONSE_EXCEEDS_16_MIB) }
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    try { return JSON.parse(chunks.join('')) } catch { throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON, response.status >= 500, response.status) }
  } finally { reader.releaseLock() }
}
export interface ClientApiOptions { baseUrl: string; token: string; timeoutMs?: number; streamIdleMs?: number; fetch?: typeof globalThis.fetch }
// 用途：创建接口，供后续流程使用。
export function clientCreateApi(options: ClientApiOptions) {
  const baseUrl = clientReadBaseUrl(options.baseUrl)
  const token = options.token.trim()
  if (!token || /[^\x21-\x7e]/.test(token)) throw clientCreateError('INVALID_TOKEN', RuntimeMessage.ENTER_A_VALID_SERVICE_TOKEN)
  const timeoutMs = options.timeoutMs ?? 15000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw clientCreateError('INVALID_TIMEOUT', RuntimeMessage.REQUEST_TIMEOUT_MUST_BE_A_POSITIVE_INTEGER)
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const lifetime = new AbortController()

  // 用途：执行请求流程，并返回执行结果。
  async function clientRunRequest<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, duration = timeoutMs): Promise<T> {
    if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
    if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
    const controller = new AbortController(), abort = () => controller.abort()
    lifetime.signal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, duration)
    try {
      const result = await operation(controller.signal)
      if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
      if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
      if (timedOut) throw clientCreateError('REQUEST_TIMEOUT', RuntimeMessage.REQUEST_TIMED_OUT_RETRY_WITH_THE_SAME_REQUEST_ID, true)
      return result
    } catch (error) {
      if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
      if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
      if (timedOut) throw clientCreateError('REQUEST_TIMEOUT', RuntimeMessage.REQUEST_TIMED_OUT_RETRY_WITH_THE_SAME_REQUEST_ID, true)
      if (error instanceof ClientError) throw error
      throw clientCreateError('NETWORK_ERROR', RuntimeMessage.SERVICE_REQUEST_FAILED_OR_AN_HTTP_REDIRECT_WAS_REFUSED, true)
    } finally {
      clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort)
    }
  }
  // 用途：读取响应，并把结构化结果交给调用方。
  async function clientReadReply<T>(response: Response, method: string, requestId?: string): Promise<GraphSuccess<T>> {
      const value = await clientReadJson(response)
      if (!response.ok || !clientIsObject(value) || value.ok !== true) {
        const detail = clientIsObject(value) && clientIsObject(value.error) ? value.error : {}
        throw new ClientError({
          status: response.status, code: typeof detail.code === 'string' ? detail.code : 'HTTP_ERROR',
          message: typeof detail.message === 'string' ? detail.message : RuntimeMessage.SERVICE_REQUEST_FAILED,
          retryable: typeof detail.retryable === 'boolean' ? detail.retryable : response.status >= 500 || response.status === 429,
          errorId: typeof detail.errorId === 'string' && /^[0-9a-f-]{36}$/i.test(detail.errorId) ? detail.errorId : crypto.randomUUID(),
          ...(typeof detail.currentRevision === 'number' ? { currentRevision: detail.currentRevision } : {}),
        })
      }
      if (typeof value.requestId !== 'string' || !value.requestId || typeof value.replayed !== 'boolean'
        || !Object.prototype.hasOwnProperty.call(value, 'data') || (requestId !== undefined && value.requestId !== requestId)) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_DID_NOT_RETURN_THE_MATCHING_REQUEST_RESULT)
      clientAssertData(method, value.data)
      return value as unknown as GraphSuccess<T>
  }
  // 用途：发送请求消息，让其他组件收到状态变化。
  function clientSendRequest<T>(path: '/api/v1/query' | '/api/v1/command', method: string, body: unknown, requestId?: string, signal?: AbortSignal): Promise<GraphSuccess<T>> {
    return clientRunRequest(async signal => {
      const response = await fetcher(new URL(path, baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal,
      })
      return clientReadReply<T>(response, method, requestId)
    }, signal)
  }
  return {
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async watch(mapId: string, onEvent: (event: GraphStreamEvent) => void, signal?: AbortSignal): Promise<void> {
      clientAssertFileId(mapId)
      if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
      if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
      const idleMs = options.streamIdleMs ?? 45000
      if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw clientCreateError('INVALID_TIMEOUT', RuntimeMessage.STREAM_IDLE_TIMEOUT_MUST_BE_POSITIVE)
      const controller = new AbortController(), abort = () => controller.abort()
      lifetime.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true })
      let timedOut = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const cancelReader = () => { void reader?.cancel().catch(() => {}) }
      const expire = () => { timedOut = true; controller.abort() }
      let timer = setTimeout(expire, timeoutMs)
      controller.signal.addEventListener('abort', cancelReader, { once: true })
      const touch = () => { if (sawSnapshot) { clearTimeout(timer); timer = setTimeout(expire, idleMs) } }
      const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder()
      let parts: string[] = [], lineBytes = 0, frameBytes = 0, data: string[] = [], eventName = '', previousCR = false, sawSnapshot = false
      const add = (part: string) => {
        parts.push(part); lineBytes += encoder.encode(part).byteLength
        if (frameBytes + lineBytes > MAX_RESPONSE_BYTES) throw clientCreateError('STREAM_TOO_LARGE', RuntimeMessage.REAL_TIME_FRAME_EXCEEDS_16_MIB)
      }
      const line = () => {
        const value = parts.join(''); parts = []; frameBytes += lineBytes + 1; lineBytes = 0
        if (value === '') {
          if (data.length) {
            let event: unknown
            try { event = JSON.parse(data.join('\n')) } catch { throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_REAL_TIME_JSON_FRAME) }
            if (!clientIsObject(event) || (eventName && eventName !== event.type)) throw clientCreateError('INVALID_STREAM', RuntimeMessage.REAL_TIME_EVENT_TYPE_DOES_NOT_MATCH)
            if (event.type === 'snapshot') {
              clientAssertData('map.get', event.snapshot)
              if ((event.snapshot as { mapId: string }).mapId !== mapId) throw clientCreateError('INVALID_STREAM', RuntimeMessage.REAL_TIME_STREAM_RETURNED_ANOTHER_MAP)
              sawSnapshot = true
              touch()
            } else if (event.type === 'activity') {
              if (!sawSnapshot || !Array.isArray(event.items) || event.items.length > 1000 || !event.items.every(item => activityIsRecord(item) && item.mapId === mapId)) throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_REAL_TIME_ACTIVITY)
              touch()
            } else if (event.type === 'refresh') {
              if (!sawSnapshot || !['workspace', 'settings'].includes(String(event.scope))) throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_REAL_TIME_REFRESH)
            } else if (event.type === 'error') {
              if (!clientIsObject(event.error) || typeof event.error.code !== 'string' || typeof event.error.message !== 'string'
                || typeof event.error.status !== 'number' || typeof event.error.retryable !== 'boolean'
                || typeof event.error.errorId !== 'string' || !/^[0-9a-f-]{36}$/i.test(event.error.errorId)) throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_REAL_TIME_ERROR)
            } else throw clientCreateError('INVALID_STREAM', RuntimeMessage.UNKNOWN_REAL_TIME_EVENT)
            onEvent(event as unknown as GraphStreamEvent)
            if (event.type === 'error') throw new ClientError(event.error as unknown as ClientErrorData)
          }
          data = []; eventName = ''; frameBytes = 0
          return
        }
        if (value.startsWith(':')) { frameBytes -= encoder.encode(value).byteLength + 1; return }
        const index = value.indexOf(':'), field = index === -1 ? value : value.slice(0, index)
        const text = index === -1 ? '' : value.slice(index + 1).replace(/^ /, '')
        if (field === 'data') data.push(text)
        else if (field === 'event') eventName = text
      }
      const consume = (text: string) => {
        if (!text.length) return
        let start = previousCR && text.startsWith('\n') ? 1 : 0
        previousCR = false
        for (let index = start; index < text.length; index++) {
          if (text[index] !== '\r' && text[index] !== '\n') continue
          add(text.slice(start, index)); line()
          if (text[index] === '\r') {
            if (text[index + 1] === '\n') index++
            else if (index === text.length - 1) previousCR = true
          }
          start = index + 1
        }
        if (start < text.length) add(text.slice(start))
      }
      try {
        const response = await fetcher(new URL('/api/v1/maps/' + mapId + '/events', baseUrl), {
          method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
          headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' },
        })
        if (!response.ok) { await clientReadReply(response, 'map.get'); throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_EVENT_RESPONSE) }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
          await response.body?.cancel(); throw clientCreateError('INVALID_STREAM', RuntimeMessage.SERVICE_DID_NOT_RETURN_AN_EVENT_STREAM)
        }
        reader = response.body.getReader(); touch()
        while (!controller.signal.aborted) {
          const part = await reader.read()
          if (part.done) break
          touch()
          let text: string
          try { text = decoder.decode(part.value, { stream: true }) }
          catch { throw clientCreateError('INVALID_STREAM', RuntimeMessage.REAL_TIME_STREAM_IS_NOT_VALID_UTF_8) }
          consume(text)
        }
        try { consume(decoder.decode()) }
        catch (error) { if (error instanceof ClientError) throw error; throw clientCreateError('INVALID_STREAM', RuntimeMessage.REAL_TIME_STREAM_ENDED_INSIDE_UTF_8_TEXT) }
        if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
        if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
        if (timedOut) throw clientCreateError('STREAM_TIMEOUT', RuntimeMessage.REAL_TIME_CONNECTION_STOPPED_RESPONDING, true)
        throw clientCreateError('STREAM_ENDED', RuntimeMessage.REAL_TIME_CONNECTION_ENDED_RECONNECT_FOR_A_FRESH_SNAPSHOT, true)
      } catch (error) {
        if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
        if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
        if (timedOut) throw clientCreateError('STREAM_TIMEOUT', RuntimeMessage.REAL_TIME_CONNECTION_STOPPED_RESPONDING, true)
        if (error instanceof ClientError) throw error
        throw clientCreateError('NETWORK_ERROR', RuntimeMessage.REAL_TIME_CONNECTION_FAILED, true)
      } finally {
        clearTimeout(timer); controller.abort()
        await reader?.cancel().catch(() => {}); reader?.releaseLock()
        controller.signal.removeEventListener('abort', cancelReader)
        lifetime.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort)
      }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read<K extends keyof QueryInputMap>(method: K, params: QueryInputMap[K], signal?: AbortSignal): Promise<QueryOutputMap[K]> {
      if (!(CLIENT_QUERY_METHODS as readonly string[]).includes(method)) throw clientCreateError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_QUERY)
      return (await clientSendRequest<QueryOutputMap[K]>('/api/v1/query', method, { method, params }, undefined, signal)).data
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    dispatch<K extends keyof CommandInputMap>(requestId: string, method: K, params: CommandInputMap[K], signal?: AbortSignal): Promise<GraphSuccess<CommandOutputMap[K]>> {
      if (!(CLIENT_COMMAND_METHODS as readonly string[]).includes(method)) return Promise.reject(clientCreateError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_COMMAND))
      if (typeof requestId !== 'string' || !requestId) return Promise.reject(clientCreateError('INVALID_REQUEST_ID', RuntimeMessage.COMMAND_NEEDS_A_STABLE_REQUEST_ID))
      return clientSendRequest('/api/v1/command', method, { requestId, method, params }, requestId, signal)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async upload(requestId: string, input: ClientUploadInput, signal?: AbortSignal): Promise<GraphSuccess<Asset>> {
      clientAssertUpload(requestId, input)
      const bytes = new Uint8Array(input.bytes), workspaceId = input.workspaceId, filename = input.filename.trim(), mediaType = input.mediaType.trim()
      return clientRunRequest(async signal => {
        const digest = await clientReadDigest(bytes)
        signal.throwIfAborted()
        const url = new URL('/api/v1/assets', baseUrl)
        url.searchParams.set('workspaceId', workspaceId); url.searchParams.set('filename', filename)
        const response = await fetcher(url, { method: 'POST', credentials: 'omit', redirect: 'error', signal,
          headers: { authorization: 'Bearer ' + token, 'content-type': mediaType,
            'idempotency-key': requestId, 'x-content-sha256': digest }, body: bytes.buffer })
        const result = await clientReadReply<Asset>(response, 'asset.get', requestId)
        if (result.data.workspaceId !== workspaceId || result.data.sha256 !== digest || result.data.size !== bytes.byteLength
          || result.data.filename !== filename || result.data.mediaType !== mediaType) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.UPLOAD_RESULT_DOES_NOT_MATCH_THIS_FILE)
        return result
      }, signal, options.timeoutMs ?? 120000)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async download(input: ClientDownloadInput, signal?: AbortSignal): Promise<ClientFile> {
      clientAssertDownload(input)
      const { kind, id } = input
      return clientRunRequest(async signal => {
        const path = kind === 'asset' ? '/api/v1/assets/' + id + '/content'
          : '/api/v1/' + (kind === 'map' ? 'maps/' : 'workspaces/') + id + '/export'
        const response = await fetcher(new URL(path, baseUrl), { method: 'GET', credentials: 'omit', redirect: 'error', signal,
          headers: { authorization: 'Bearer ' + token } })
        if (!response.ok) { await clientReadReply(response, 'asset.get'); throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.INVALID_FILE_RESPONSE) }
        const bytes = await clientReadBytes(response)
        const digest = response.headers.get('etag')
        if (kind === 'asset' && (!digest || !/^"[a-f0-9]{64}"$/.test(digest)
          || await clientReadDigest(bytes) !== digest.slice(1, -1))) throw clientCreateError('FILE_INTEGRITY', RuntimeMessage.DOWNLOADED_FILE_CHECKSUM_DOES_NOT_MATCH)
        const disposition = response.headers.get('content-disposition') ?? ''
        const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1]
        const plain = /filename="([^"]+)"/i.exec(disposition)?.[1]
        let filename: string
        try { filename = encoded ? decodeURIComponent(encoded) : plain ?? kind + '-' + id + '.json' }
        catch { throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.INVALID_DOWNLOAD_FILENAME) }
        clientAssertFilename(filename)
        return { filename, mediaType: response.headers.get('content-type') ?? 'application/octet-stream', bytes }
      }, signal, options.timeoutMs ?? 120000)
    },
    // 用途：关闭当前模块并释放占用的资源。
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
export interface ClientGatewayOptions { baseUrl: string; timeoutMs?: number; streamIdleMs?: number; fetch?: typeof globalThis.fetch; store?: ClientConnectionStore }
// 用途：创建网关，供后续流程使用。
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
  // 用途：处理客户端请求相关工作，并把结果交给调用方。
  function clientEnqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation)
    tail = result.then(() => undefined, () => undefined)
    return result
  }
  // 用途：读取接口，并把结构化结果交给调用方。
  async function clientReadApi(): Promise<ClientApi> {
    await initialized
    if (closed || !active) throw clientCreateError('NOT_CONNECTED', RuntimeMessage.CONNECT_TO_THE_SERVICE_FIRST)
    return active
  }
  return {
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async watch(mapId, onEvent, signal) { return (await clientReadApi()).watch(mapId, onEvent, signal) },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async getConnection(): Promise<ClientConnection> {
      await initialized
      return { baseUrl, configured: active !== null, remembered, canRemember: options.store?.canRemember() ?? false }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    connect(input: ClientConnectInput): Promise<AppBootstrap> {
      if (closed) return Promise.reject(clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED))
      const version = ++generation
      pending?.close(); active?.close(); active = null; remembered = false
      return clientEnqueueOperation(async () => {
        await initialized
        if (version !== generation) throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
        await options.store?.clear()
        const url = clientReadBaseUrl(input.baseUrl)
        baseUrl = url
        const candidate = clientCreateApi({ ...options, baseUrl: url, token: input.token })
        pending = candidate
        try {
          const bootstrap = await candidate.read('app.bootstrap', {})
          if (version !== generation) throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
          const saved = await options.store?.save({ ...input, baseUrl: url }) ?? false
          if (version !== generation) throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
          active?.close()
          active = candidate; pending = null; baseUrl = url; remembered = saved
          return bootstrap
        } catch (error) { candidate.close(); if (pending === candidate) pending = null; throw error }
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    disconnect(): Promise<void> {
      generation++
      pending?.close(); active?.close(); active = null; remembered = false
      return clientEnqueueOperation(async () => { await initialized; await options.store?.clear() })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read(method, params, signal) { return (await clientReadApi()).read(method, params, signal) },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async dispatch(requestId, method, params, signal) { return (await clientReadApi()).dispatch(requestId, method, params, signal) },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async upload(requestId, input, signal) { return (await clientReadApi()).upload(requestId, input, signal) },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async download(input, signal) { return (await clientReadApi()).download(input, signal) },
    // 用途：关闭当前模块并释放占用的资源。
    close(): void {
      closed = true; generation++
      pending?.close(); active?.close(); active = null
    },
  }
}
