// 公共客户端传输与连接管理：验证响应、处理取消和 SSE，并保护文件完整性及登录代次。
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

function clientAssertFileId(/* 外部传入的文件资源或上传请求标识，在使用前验证为 UUID。 */ value: unknown): asserts value is string {
  // 校验文件操作使用的 UUID 格式，防止无效标识进入请求路径。
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.FILE_OPERATION_REQUIRES_A_UUID)
}
function clientAssertFilename(/* 外部给出的文件名称，必须是不含路径的受限 UTF-8 文本。 */ value: unknown): asserts value is string {
  // 要求文件名非空且不含路径或控制字符，并按 UTF-8 字节限制名称长度。
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > 255 || /[\x00-\x1f\x7f/\\]/.test(value)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.USE_A_FILENAME_WITHOUT_PATHS_OR_CONTROL_CHARACTERS)
}
export function clientAssertUpload(/* 尚未验证的上传幂等编号，必须为 UUID。 */ requestId: unknown, /* 尚未验证的上传对象，含工作区、文件元信息和有界字节数组。 */ value: unknown): asserts value is ClientUploadInput {
  // 验证上传请求编号、工作区、文件元信息及字节类型和大小。
  clientAssertFileId(requestId)
  if (!clientIsObject(value) || Object.keys(value).some(/* 上传对象枚举出的属性名，拒绝协议未定义字段。 */ key => /* 检查上传对象是否夹带未支持的属性。 */  !['workspaceId', 'filename', 'mediaType', 'bytes'].includes(key))) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.INVALID_UPLOAD_INPUT)
  clientAssertFileId(value.workspaceId); clientAssertFilename(value.filename)
  if (typeof value.mediaType !== 'string' || !value.mediaType.trim() || value.mediaType.length > 255 || /[\x00-\x1f\x7f]/.test(value.mediaType)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.INVALID_MEDIA_TYPE)
  if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength > CLIENT_FILE_LIMIT) throw clientCreateError('FILE_TOO_LARGE', RuntimeMessage.UPLOAD_MUST_CONTAIN_AT_MOST_64_MIB_OF_BYTES)
}
export function clientAssertDownload(/* 尚未验证的下载目标，必须是固定资源类型和 UUID 的组合。 */ value: unknown): asserts value is ClientDownloadInput {
  // 验证下载目标类型及 UUID，拒绝额外字段。
  if (!clientIsObject(value) || Object.keys(value).some(/* 下载目标对象的属性名，限制为 kind 和 id。 */ key => /* 检查下载对象是否只包含目标类型和编号。 */  !['kind', 'id'].includes(key)) || !['asset', 'map', 'workspace'].includes(String(value.kind))) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.CHOOSE_AN_ASSET_MAP_OR_WORKSPACE_TO_DOWNLOAD)
  clientAssertFileId(value.id)
}
async function clientReadDigest(/* 需要校验的文件字节；创建独立视图副本交给 Web Crypto，不修改输入。 */ bytes: Uint8Array): Promise<string> {
  // 计算文件的 SHA-256 摘要并编码为小写十六进制字符串。
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(/* SHA-256 结果中的一个无符号字节，输出为两位十六进制。 */ byte => /* 将摘要字节编码为固定两位的十六进制。 */  byte.toString(16).padStart(2, '0')).join('')
}
async function clientReadBytes(/* 下载 HTTP 响应；本函数消耗并最终取消、释放其内容读取器。 */ response: Response): Promise<Uint8Array> {
  // 按 64 MiB 上限流式读取下载内容，校验未压缩响应的声明长度，并始终释放读取器。
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

function clientCreateError(/* 调用方指定的可程序识别错误码。 */ code: string, /* 可展示给客户端使用者的错误说明。 */ message: string, /* 是否建议重试，缺省为 false。 */ retryable = false, /* 关联 HTTP 状态码，缺省零表示尚无服务端 HTTP 状态。 */ status = 0): ClientError {
  // 创建包含错误码、文案、重试建议和 HTTP 状态的客户端错误。
  return new ClientError({ code, message, retryable, status })
}
function clientIsObject(/* 需要在协议边界判断为普通对象的未知值。 */ value: unknown): value is Record<string, unknown> {
  // 判断未知值是否为非空且非数组的对象。
   return value !== null && typeof value === 'object' && !Array.isArray(value) }
function clientIsStrings(/* 需要验证为字符串数组的未知值。 */ value: unknown): value is string[] {
  // 判断输入是否为全由字符串组成的数组。
   return Array.isArray(value) && value.every(/* 已确认数组中的当前成员，逐项检查是否为字符串。 */ item => /* 确认数组当前成员为字符串。 */  typeof item === 'string') }
function clientIsScore(/* 服务端返回的待检查评分，只允许零、半分或一分。 */ value: unknown): boolean {
  // 只接受核验协议规定的三个评分值。
   return value === 0 || value === 0.5 || value === 1 }
function clientIsLocator(/* 服务端返回的未知来源定位器，按 asset/url 分支检查字段。 */ value: unknown): boolean {
  // 验证定位器是带资产编号和媒体类型的资产引用，或带字符串地址的 URL 引用。
  return clientIsObject(value) && (value.kind === 'asset'
    ? typeof value.assetId === 'string' && !!value.assetId && typeof value.mediaType === 'string'
    : value.kind === 'url' && typeof value.url === 'string')
}
function clientAssertNode(/* 响应节点数组中的未验证节点，不修改原对象。 */ value: unknown, /* 该节点在响应数组中的零基位置，用于指明错误路径。 */ index: number): void {
  // 按节点种类验证快照中的业务数据，错误中保留节点所在数组位置。
  const clientCreateNodeError = () => /* 为当前节点位置生成协议响应错误。 */  clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RETURNED_INVALID_NODE_DATA_AT_NODES_VALUE, index))
  if (!clientIsObject(value) || typeof value.id !== 'string' || !value.id
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !clientIsObject(value.data)) throw clientCreateNodeError()
  const data = value.data
  let valid = false
  switch (data.kind) {
    case 'news':
      if (!clientIsObject(data.context)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RETURNED_MISSING_OR_INVALID_NEWS_CONTEXT_AT_NODES_VALUE, index))
      valid = typeof data.content === 'string' && Object.values(data.context).every(/* 新闻 context 中的未知字段对象，必须包含文本值和可见性。 */ field => /* 校验新闻上下文字段同时具有字符串值和可见性开关。 */
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
        && Array.isArray(data.opinions) && data.opinions.every(/* 核验节点中的未知意见对象，逐项检查角色元信息及评分。 */ opinion => /* 验证核验意见中的身份、路由版本、评分和工具列表结构。 */  clientIsObject(opinion)
          && ['id', 'slotId', 'agentId', 'agentName', 'angle', 'reason', 'createdAt'].every(/* 意见协议要求的字符串字段名，用于读取当前意见对应值。 */ key => /* 要求意见中的指定元信息字段为字符串。 */  typeof opinion[key] === 'string')
          && typeof opinion.routeRevision === 'number' && Number.isSafeInteger(opinion.routeRevision) && opinion.routeRevision >= 0
          && clientIsScore(opinion.score) && clientIsStrings(opinion.tools))
      break
  }
  if (!valid) throw clientCreateNodeError()
}
export function clientReadError(/* 任意调用失败值，只有 ClientError 可保留公开字段，其他值脱敏。 */ error: unknown): ClientErrorData {
  // 将已知客户端异常投影为可序列化错误，未知异常隐藏细节并生成本地诊断编号。
  if (error instanceof ClientError) return { code: error.code, message: error.message, retryable: error.retryable, status: error.status,
    errorId: error.errorId,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
  return { code: 'CLIENT_ERROR', message: RuntimeMessage.CLIENT_INTERNAL_ERROR, status: 0, retryable: false, errorId: crypto.randomUUID() }
}
export function clientReadBaseUrl(/* 用户或存储提供的服务地址，验证后仅返回无凭据的 HTTP(S) 源。 */ value: string): string {
  // 将服务地址规范化为 HTTP(S) 源，拒绝凭据、路径、查询和片段。
  let url: URL
  try { url = new URL(value.trim()) } catch { throw clientCreateError('INVALID_URL', RuntimeMessage.ENTER_A_VALID_HTTP_S_SERVICE_ADDRESS) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw clientCreateError('INVALID_URL', RuntimeMessage.SERVICE_ADDRESS_MUST_BE_AN_HTTP_S_ORIGIN_WITHOUT_CREDENTIALS_PATH_QUERY)
  }
  return url.origin
}
function clientAssertData(/* 原请求的公共方法名，决定响应必须包含哪些业务字段。 */ method: string, /* 服务端 JSON 的未验证业务值，递归检查必要结构。 */ data: unknown): void {
  // 按公开方法检查必要字段和关键业务结构，并递归验证快照、Run 和资产列表。
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
  if (!clientIsObject(data) || required.some(/* 当前方法要求的字段名，检测缺失或 undefined。 */ key => /* 找出响应中缺少或明确为 undefined 的必要字段。 */  !Object.prototype.hasOwnProperty.call(data, key) || data[key] === undefined)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_IS_INCOMPLETE_FOR_VALUE, method))
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
      if (!clientIsObject(edge) || !['id', 'from', 'to'].every(/* 图边身份字段名，要求其值为非空字符串。 */ key => /* 验证图边的编号和两端节点标识均为非空字符串。 */  typeof edge[key] === 'string' && !!edge[key])
        || !['derived-from', 'mentions', 'verifies', 'related-to'].includes(String(edge.kind))) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_GRAPH_EDGE_DATA)
    }
  }
  if (method === 'asset.list') {
    for (const asset of data.items as unknown[]) clientAssertData('asset.get', asset)
    if (data.nextCursor !== null && typeof data.nextCursor !== 'string') throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.INVALID_ASSET_CURSOR)
  }
  if ('snapshot' in data) clientAssertData('map.get', data.snapshot)
}
async function clientReadJson(/* 待读取的 HTTP 响应，本函数消耗其正文并按字节限制 UTF-8 JSON 体积。 */ response: Response): Promise<unknown> {
  // 按 16 MiB 上限流式解码 UTF-8 响应并解析 JSON，读取结束或失败时释放流锁。
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {
      // 忽略超大响应被取消时的清理异常，保留后续的响应超限错误。
    })
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
// 固定凭据 HTTP 客户端配置，可注入 fetch 并分别控制请求与流空闲期限。
export interface ClientApiOptions { baseUrl: string; token: string; timeoutMs?: number; streamIdleMs?: number; fetch?: typeof globalThis.fetch }
export function clientCreateApi(/* 固定源和令牌及可选传输配置；普通请求缺省 15000 毫秒，流空闲缺省 45000 毫秒。 */ options: ClientApiOptions) {
  // 创建固定服务地址和令牌的 HTTP 客户端，为请求与事件流持有共同的取消生命周期。
  const baseUrl = clientReadBaseUrl(options.baseUrl)
  const token = options.token.trim()
  if (!token || /[^\x21-\x7e]/.test(token)) throw clientCreateError('INVALID_TOKEN', RuntimeMessage.ENTER_A_VALID_SERVICE_TOKEN)
  const timeoutMs = options.timeoutMs ?? 15000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw clientCreateError('INVALID_TIMEOUT', RuntimeMessage.REQUEST_TIMEOUT_MUST_BE_A_POSITIVE_INTEGER)
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const lifetime = new AbortController()

  async function clientRunRequest<T>(/* 实际网络操作，必须使用本层组合出的信号，并把结果或失败返回给生命周期管理器。 */ operation: (/* 本次请求专属的组合信号，包含关闭、外部取消和超时影响。 */ signal: AbortSignal) => Promise<T>, /* 可选的调用者取消信号，由调用方拥有，客户端只监听。 */ signal?: AbortSignal, /* 本次操作的毫秒期限，省略时沿用客户端普通请求超时。 */ duration = timeoutMs): Promise<T> {
    // 合并客户端关闭、调用者取消和超时信号，执行一次请求并归一化失败，最后清理监听器与定时器。
    if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
    if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
    const controller = new AbortController(), abort = () => /* 将客户端关闭或调用者取消传递给本次请求。 */ controller.abort()
    lifetime.signal.addEventListener('abort', abort, { once: true })
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => {
      // 标记请求超时并中断网络操作，以便将失败报告为可重试超时。
      timedOut = true; controller.abort()
    }, duration)
    try {
      const result = await operation(controller.signal)
      // 即使底层操作未及时响应取消，也不接纳关闭、取消或超时之后返回的结果。
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
  async function clientReadReply<T>(/* 服务端 HTTP 响应，消耗正文并解码成功或失败结构。 */ response: Response, /* 原请求方法，决定成功响应所需的业务结构。 */ method: string, /* 可选预期业务请求编号；提供时要求服务端返回相同编号。 */ requestId?: string): Promise<GraphSuccess<T>> {
    // 解析成功或失败响应，核对命令响应的 requestId 并验证业务数据结构后返回结果。
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
  function clientSendRequest<T>(/* 由内部调用选择的固定查询或写命令端点，不接受任意路径。 */ path: '/api/v1/query' | '/api/v1/command', /* 本次请求的业务方法名，供返回结构校验使用。 */ method: string, /* 待 JSON 序列化的完整请求对象，包含方法、参数和必要的请求编号。 */ body: unknown, /* 可选写入幂等编号，用于核对响应；普通查询不指定。 */ requestId?: string, /* 可选调用方取消信号，转入统一请求生命周期。 */ signal?: AbortSignal): Promise<GraphSuccess<T>> {
    // 携带服务令牌发送查询或命令 JSON，禁止重定向，并在请求生命周期内验证响应。
    return clientRunRequest(async /* 统一请求包装器创建的组合取消信号，绑定本次 fetch。 */ signal => {
      // 使用本次请求的取消信号发送 POST，再核对响应与原请求是否匹配。
      const response = await fetcher(new URL(path, baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal,
      })
      return clientReadReply<T>(response, method, requestId)
    }, signal)
  }
  return {
    async watch(/* 目标图的 UUID，既用于事件端点也用于首帧归属验证。 */ mapId: string, /* 接收已验证事件的调用方回调，回调由订阅流程同步调用。 */ onEvent: (/* 已通过 SSE 类型及业务结构检查的事件，错误事件随后也会终止订阅。 */ event: GraphStreamEvent) => void, /* 可选订阅取消信号，由调用方控制持续流的结束。 */ signal?: AbortSignal): Promise<void> {
      // 订阅指定图的 SSE 流，验证首个快照、事件结构和帧大小；取消时释放资源，断流时将是否可重连交给调用者。
      clientAssertFileId(mapId)
      if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
      if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
      const idleMs = options.streamIdleMs ?? 45000
      if (!Number.isSafeInteger(idleMs) || idleMs < 1) throw clientCreateError('INVALID_TIMEOUT', RuntimeMessage.STREAM_IDLE_TIMEOUT_MUST_BE_POSITIVE)
      const controller = new AbortController(), abort = () => /* 将客户端关闭或调用者取消传递给当前事件流。 */ controller.abort()
      lifetime.signal.addEventListener('abort', abort, { once: true }); signal?.addEventListener('abort', abort, { once: true })
      let timedOut = false, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const cancelReader = () => {
        // 主动取消读取器，使等待中的流读取能随取消信号结束。
        void reader?.cancel().catch(() => {
          // 忽略读取器取消时的清理错误，由订阅主流程报告原始失败原因。
        })
      }
      const expire = () => {
        // 标记事件流超时并中断连接，交由订阅主流程生成可重试错误。
        timedOut = true; controller.abort()
      }
      // 首个快照必须在请求超时前到达；仅收到心跳不能延长建立有效订阅的期限。
      let timer = setTimeout(expire, timeoutMs)
      controller.signal.addEventListener('abort', cancelReader, { once: true })
      const touch = () => {
        // 仅在收到首个有效快照后，重置事件流的空闲超时。
        if (sawSnapshot) { clearTimeout(timer); timer = setTimeout(expire, idleMs) }
      }
      const decoder = new TextDecoder('utf-8', { fatal: true }), encoder = new TextEncoder()
      let parts: string[] = [], lineBytes = 0, frameBytes = 0, data: string[] = [], eventName = '', previousCR = false, sawSnapshot = false
      const add = (/* 当前尚未完成一行的解码文本片段，加入帧字节配额。 */ part: string) => {
        // 累积尚未结束的一行文本，并按 UTF-8 字节数限制当前事件帧大小。
        parts.push(part); lineBytes += encoder.encode(part).byteLength
        if (frameBytes + lineBytes > MAX_RESPONSE_BYTES) throw clientCreateError('STREAM_TOO_LARGE', RuntimeMessage.REAL_TIME_FRAME_EXCEEDS_16_MIB)
      }
      const line = () => {
        // 解析一条 SSE 行，在空行处组装并校验完整事件，然后通知订阅者并重置帧状态。
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
              if (!sawSnapshot || !Array.isArray(event.items) || event.items.length > 1000 || !event.items.every(/* 活动事件中的未验证条目，须匹配当前图且符合活动摘要协议。 */ item =>
                /* 确认活动条目符合协议且属于当前订阅图。 */
                activityIsRecord(item) && item.mapId === mapId)) throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_REAL_TIME_ACTIVITY)
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
      const consume = (/* 新解码出的 SSE 文本块，可能从上一块的半行或 CRLF 中间继续。 */ text: string) => {
        // 从解码文本中分离 SSE 行，保留跨数据块的半行和 CRLF 状态。
        if (!text.length) return
        // 上一块以 CR 结束时，本块开头的 LF 属于同一个换行，不能再生成一条空行。
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
        await reader?.cancel().catch(() => {
          // 忽略结束订阅时的读取器清理错误，保留订阅本身的结束或失败原因。
        }); reader?.releaseLock()
        controller.signal.removeEventListener('abort', cancelReader)
        lifetime.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort)
      }
    },
    async read<K extends keyof QueryInputMap>(/* 公开查询方法名，执行前检查其属于客户端白名单。 */ method: K, /* 与该查询方法对应的业务参数，作为请求 JSON 传递。 */ params: QueryInputMap[K], /* 可选查询取消信号，交给统一请求包装器。 */ signal?: AbortSignal): Promise<QueryOutputMap[K]> {
      // 验证公开查询方法，发送查询并返回已校验的业务数据。
      if (!(CLIENT_QUERY_METHODS as readonly string[]).includes(method)) throw clientCreateError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_QUERY)
      return (await clientSendRequest<QueryOutputMap[K]>('/api/v1/query', method, { method, params }, undefined, signal)).data
    },
    dispatch<K extends keyof CommandInputMap>(/* 非空且跨重试稳定的写入请求编号，用于服务端收据判重。 */ requestId: string, /* 公开写命令名，提交前检查白名单。 */ method: K, /* 该命令的业务参数，重试相同编号时应保持内容不变。 */ params: CommandInputMap[K], /* 可选写入取消信号，取消本地等待不证明服务端未提交。 */ signal?: AbortSignal): Promise<GraphSuccess<CommandOutputMap[K]>> {
      // 验证公开命令和稳定请求标识，提交命令并返回包含重放标记的完整响应。
      if (!(CLIENT_COMMAND_METHODS as readonly string[]).includes(method)) return Promise.reject(clientCreateError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_COMMAND))
      if (typeof requestId !== 'string' || !requestId) return Promise.reject(clientCreateError('INVALID_REQUEST_ID', RuntimeMessage.COMMAND_NEEDS_A_STABLE_REQUEST_ID))
      return clientSendRequest('/api/v1/command', method, { requestId, method, params }, requestId, signal)
    },
    async upload(/* 文件上传的 UUID 幂等编号，重复上传同一内容时沿用。 */ requestId: string, /* 待上传元信息与字节；验证后立即复制内容以固定本次请求。 */ input: ClientUploadInput, /* 可选上传取消信号，由调用方负责触发。 */ signal?: AbortSignal): Promise<GraphSuccess<Asset>> {
      // 校验并复制待上传文件，以稳定请求标识上传内容，并核对返回资产是否对应原文件。
      clientAssertUpload(requestId, input)
      const bytes = new Uint8Array(input.bytes), workspaceId = input.workspaceId, filename = input.filename.trim(), mediaType = input.mediaType.trim()
      return clientRunRequest(async /* 上传专属组合信号，上传前检查取消并绑定 fetch。 */ signal => {
        // 计算文件摘要，携带幂等键上传字节，并核对服务端的工作区、摘要、大小、文件名和媒体类型。
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
    async download(/* 已选择的资源类型和 UUID，决定固定下载端点。 */ input: ClientDownloadInput, /* 可选下载取消信号，交给统一文件请求生命周期。 */ signal?: AbortSignal): Promise<ClientFile> {
      // 下载资产或图与工作区导出内容，限制大小、验证资产摘要，并返回经校验的文件名和字节。
      clientAssertDownload(input)
      const { kind, id } = input
      return clientRunRequest(async /* 下载专属组合信号，绑定读取资产或导出端点的请求。 */ signal => {
        // 读取所选下载端点，校验资产完整性并解析响应中的文件名和媒体类型。
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
    close(): void {
      // 中断此客户端持有的全部请求和订阅，使后续请求报告连接已关闭。
      lifetime.abort()
    },
  }
}
// 固定地址及令牌的 HTTP 客户端能力类型，包含统一关闭操作。
export type ClientApi = ReturnType<typeof clientCreateApi>
/** 桌面主进程注入系统加密存储；浏览器省略存储，仅在内存中保留令牌。 */
export interface ClientConnectionStore {
  // 恢复地址及可用令牌；不存在或可容忍的损坏返回 null，其他读取故障可拒绝。
  load(): Promise<{ baseUrl: string; token: string | null; remembered: boolean } | null>
  // 保存连接选项并返回是否实际记住令牌，调用方不能仅依据 remember 输入判断。
  save(/* 需要持久化的地址、令牌和记住意愿，实际是否记住由存储能力决定。 */ input: ClientConnectInput): Promise<boolean>
  // 清除持久化连接配置，供登出和新连接验证前调用。
  clear(): Promise<void>
  // 报告当前环境是否允许安全记住令牌。
  canRemember(): boolean
}
// 可切换连接网关配置，可选系统凭据存储供桌面环境使用。
export interface ClientGatewayOptions { baseUrl: string; timeoutMs?: number; streamIdleMs?: number; fetch?: typeof globalThis.fetch; store?: ClientConnectionStore }
export function clientCreateGateway(/* 网关初始地址、传输期限和可选凭据存储；凭据未接存储时仅保留在内存。 */ options: ClientGatewayOptions): ClientGateway & { // 永久关闭网关并取消活动与候选连接，已保存的凭据由 disconnect 单独清除。
  close(): void } {
  // 管理当前与待登录的客户端、连接代次和凭据存储队列，使切换登录与退出按顺序完成。
  let baseUrl = clientReadBaseUrl(options.baseUrl)
  let active: ClientApi | null = null
  let pending: ClientApi | null = null
  let remembered = false
  // 每次登录、退出和关闭都会推进代次，阻止迟到的验证结果重新激活旧连接。
  let generation = 0
  let closed = false
  let tail: Promise<unknown> = Promise.resolve()
  const initialized = (async () => {
    // 恢复已保存的服务地址和令牌，但不覆盖恢复期间已发生的登录或退出操作。
    const saved = await options.store?.load()
    if (!saved || generation !== 0) return
    baseUrl = clientReadBaseUrl(saved.baseUrl)
    if (saved.token) active = clientCreateApi({ ...options, baseUrl, token: saved.token })
    remembered = !!saved.token && saved.remembered
  })()
  function clientEnqueueOperation<T>(/* 要按序执行的登录或凭据变更；成功失败均不阻塞后续排队任务。 */ operation: () => Promise<T>): Promise<T> {
    // 将登录和凭据写入串行排队，单次失败继续传给调用者，同时允许后续操作执行。
    const result = tail.then(operation, operation)
    tail = result.then(() => /* 在前一项操作成功后释放队列尾部，不把其结果传给下一项操作。 */ undefined, () => /* 吸收队列尾部的拒绝，使后续登录或清理仍可执行；原调用者仍持有失败结果。 */ undefined)
    return result
  }
  async function clientReadApi(): Promise<ClientApi> {
    // 等待凭据恢复完成，确认网关仍开放且存在已配置客户端，再交给请求使用。
    await initialized
    if (closed || !active) throw clientCreateError('NOT_CONNECTED', RuntimeMessage.CONNECT_TO_THE_SERVICE_FIRST)
    return active
  }
  return {
    async watch(/* 需要订阅的图编号，交给当前固定凭据客户端验证。 */ mapId, /* 调用方的事件观察者，直接转交当前客户端。 */ onEvent, /* 可选调用者取消信号，不进入登录串行队列。 */ signal) {
      // 取得当前客户端并直接启动订阅，避免长期事件流阻塞登录和退出队列。
      return (await clientReadApi()).watch(mapId, onEvent, signal)
    },
    async getConnection(): Promise<ClientConnection> {
      // 等待连接恢复完成后返回服务地址、配置状态和凭据记忆能力。
      await initialized
      return { baseUrl, configured: active !== null, remembered, canRemember: options.store?.canRemember() ?? false }
    },
    connect(/* 用户选择的新服务地址、令牌与记住开关，先使旧连接失效再验证候选连接。 */ input: ClientConnectInput): Promise<AppBootstrap> {
      // 立即使旧连接和待登录结果失效，再串行验证新凭据、保存连接选项并激活新客户端。
      if (closed) return Promise.reject(clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED))
      const version = ++generation
      pending?.close(); active?.close(); active = null; remembered = false
      return clientEnqueueOperation(async () => {
        // 清除旧凭据并验证候选连接，仅当登录代次仍匹配时保存凭据并接纳客户端。
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
    disconnect(): Promise<void> {
      // 立即取消当前及待登录客户端，再将持久化凭据清除排入连接操作队列。
      generation++
      pending?.close(); active?.close(); active = null; remembered = false
      return clientEnqueueOperation(async () => {
        // 等待初始凭据读取完成后清除存储，防止退出先于恢复结束而遗漏旧凭据。
        await initialized; await options.store?.clear()
      })
    },
    async read(/* 待转发的公共查询方法。 */ method, /* 查询方法对应的业务参数，原样交给活动客户端。 */ params, /* 调用方可选的读取取消信号。 */ signal) {
      // 取得当前客户端后转发查询及调用者取消信号。
      return (await clientReadApi()).read(method, params, signal)
    },
    async dispatch(/* 调用方提供的稳定业务幂等编号。 */ requestId, /* 待转发的公共写命令。 */ method, /* 写命令对应参数，交给活动客户端提交。 */ params, /* 调用方可选的写请求取消信号。 */ signal) {
      // 取得当前客户端后转发命令，保留调用者提供的请求标识和取消信号。
      return (await clientReadApi()).dispatch(requestId, method, params, signal)
    },
    async upload(/* 上传操作的稳定业务幂等编号。 */ requestId, /* 含工作区及文件内容的上传输入，交给活动客户端验证并复制。 */ input, /* 调用方可选的上传取消信号。 */ signal) {
      // 取得当前客户端后转发文件上传及其幂等请求标识。
      return (await clientReadApi()).upload(requestId, input, signal)
    },
    async download(/* 含资源类型与编号的下载目标。 */ input, /* 调用方可选的下载取消信号。 */ signal) {
      // 取得当前客户端后转发文件下载及调用者取消信号。
      return (await clientReadApi()).download(input, signal)
    },
    close(): void {
      // 永久关闭网关并中断当前和待登录客户端，使未完成登录失效，同时保留已保存的连接配置。
      closed = true; generation++
      pending?.close(); active?.close(); active = null
    },
  }
}
