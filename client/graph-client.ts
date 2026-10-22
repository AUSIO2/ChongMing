// 公共客户端传输与连接管理：验证响应、处理取消和 SSE，并保护文件完整性及登录代次。
import { RuntimeMessage, messageFormat } from '../contracts/messages'
import { activityIsRecord } from '../contracts/activity'
import {
  ClientError, CLIENT_FILE_LIMIT, type ClientUploadInput, type ClientDownloadInput, type ClientFile, type ClientConnectInput, type ClientConnection, type ClientErrorData, type ClientGateway,
  type CommandInputMap, type CommandOutputMap, type QueryInputMap, type QueryOutputMap,
} from '../contracts/client'
import type { AppBootstrap, Asset } from '../contracts/control'
import type { GraphSuccess } from '../contracts/graph-api'
import type { GraphBranchSnapshot } from '../contracts/graph-branch'
import type { GraphStreamEvent } from '../contracts/events'
import type { EvidenceClaimRef, EvidenceUseSummary } from '../contracts/evidence-library'
import type { DefinitionRef } from '../contracts/data-definition'
import type { AuthSession, AuthMessage } from '../contracts/auth'
import type { ClientAccountGateway } from '../contracts/client'
export { ClientError } from '../contracts/client'

export const CLIENT_QUERY_METHODS = ['map.list', 'map.get', 'branch.get', 'run.get', 'run.list', 'run.publication.preview', 'app.bootstrap', 'workspace.list', 'workspace.get', 'agent.list', 'model.get', 'definition.get', 'definition.library.get', 'asset.get', 'asset.list', 'evidence.get', 'evidence.search', 'evidence.relations', 'evidence.uses', 'evidence.use.get'] as const satisfies readonly (keyof QueryInputMap)[]
export const CLIENT_COMMAND_METHODS = ['map.create', 'map.rename', 'map.delete', 'graph.apply', 'run.start', 'run.cancel', 'run.pause', 'run.resume', 'review.answer',
  'branch.claim', 'branch.renew', 'branch.release', 'run.control.claim', 'run.control.renew', 'run.control.release',
  'workspace.create', 'workspace.update', 'workspace.delete', 'member.set', 'preferences.set', 'agent.create', 'agent.update', 'agent.delete',
  'agent.copy', 'model.update', 'definition.publish', 'settings.update', 'asset.delete', 'workspace.import', 'evidence.collect', 'evidence.withdraw'] as const satisfies readonly (keyof CommandInputMap)[]
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024
type ClientResponseMethod = keyof QueryOutputMap | keyof CommandOutputMap | 'branch.ownership' | 'run.control'
type ClientPublicationIdentity = Pick<QueryOutputMap['run.publication.preview'], 'mapId' | 'runId' | 'operationId' | 'reviewId' | 'reviewRevision'>
const GRAPH_WRITE_FIELDS = ['snapshot', 'createdNodeIds', 'createdEdgeIds']

/**
 * 校验文件操作使用的 UUID 格式，防止无效标识进入请求路径。
 *
 * @param value 外部传入的文件资源或上传请求标识，在使用前验证为 UUID。
 */
function clientAssertFileId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.FILE_OPERATION_REQUIRES_A_UUID)
}
/**
 * 要求文件名非空且不含路径或控制字符，并按 UTF-8 字节限制名称长度。
 *
 * @param value 外部给出的文件名称，必须是不含路径的受限 UTF-8 文本。
 */
function clientAssertFilename(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || new TextEncoder().encode(value).length > 255 || /[\x00-\x1f\x7f/\\]/.test(value)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.USE_A_FILENAME_WITHOUT_PATHS_OR_CONTROL_CHARACTERS)
}
/**
 * 验证上传请求编号、工作区、文件元信息及字节类型和大小。
 *
 * @param requestId 尚未验证的上传幂等编号，必须为 UUID。
 * @param value 尚未验证的上传对象，含工作区、文件元信息和有界字节数组。
 */
export function clientAssertUpload(requestId: unknown, value: unknown): asserts value is ClientUploadInput {
  clientAssertFileId(requestId)
  if (!clientIsObject(value) || Object.keys(value).some(key => /* 检查上传对象是否夹带未支持的属性。 */  !['workspaceId', 'filename', 'mediaType', 'bytes'].includes(key))) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.INVALID_UPLOAD_INPUT)
  clientAssertFileId(value.workspaceId); clientAssertFilename(value.filename)
  if (typeof value.mediaType !== 'string' || !value.mediaType.trim() || value.mediaType.length > 255 || /[\x00-\x1f\x7f]/.test(value.mediaType)) throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.INVALID_MEDIA_TYPE)
  if (!(value.bytes instanceof Uint8Array) || value.bytes.byteLength > CLIENT_FILE_LIMIT) throw clientCreateError('FILE_TOO_LARGE', RuntimeMessage.UPLOAD_MUST_CONTAIN_AT_MOST_64_MIB_OF_BYTES)
}
/**
 * 验证下载目标类型及 UUID，拒绝额外字段。
 *
 * @param value 尚未验证的下载目标，必须是固定资源类型和 UUID 的组合。
 */
export function clientAssertDownload(value: unknown): asserts value is ClientDownloadInput {
  if (!clientIsObject(value) || Object.keys(value).some(key => /* 检查下载对象是否只包含目标类型和编号。 */  !['kind', 'id'].includes(key))
    || value.kind !== 'asset' && value.kind !== 'map' && value.kind !== 'workspace') throw clientCreateError('INVALID_ARGUMENT', RuntimeMessage.CHOOSE_AN_ASSET_MAP_OR_WORKSPACE_TO_DOWNLOAD)
  clientAssertFileId(value.id)
}
/**
 * 计算文件的 SHA-256 摘要并编码为小写十六进制字符串。
 *
 * @param bytes 需要校验的文件字节；创建独立视图副本交给 Web Crypto，不修改输入。
 */
async function clientReadDigest(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  return [...new Uint8Array(digest)].map(byte => /* 将摘要字节编码为固定两位的十六进制。 */  byte.toString(16).padStart(2, '0')).join('')
}
/**
 * 按 64 MiB 上限流式读取下载内容，校验未压缩响应的声明长度，并始终释放读取器。
 *
 * @param response 下载 HTTP 响应；本函数消耗并最终取消、释放其内容读取器。
 */
async function clientReadBytes(response: Response): Promise<Uint8Array> {
  const declared = response.headers.get('content-length')
  const encoding = response.headers.get('content-encoding')?.trim().toLowerCase()
  const decoded = !!encoding && encoding !== 'identity'
  if (declared !== null && (!/^[0-9]+$/.test(declared) || (!decoded && Number(declared) > CLIENT_FILE_LIMIT))) {
    await response.body?.cancel().catch(() => {
      // 清理失败不覆盖已确定的文件超限错误。
    })
    throw clientCreateError('FILE_TOO_LARGE', RuntimeMessage.DOWNLOAD_EXCEEDS_64_MIB)
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
  } finally {
    await reader.cancel().catch(() => {
      // 保留读取错误，并继续释放已失败流的锁。
    })
    reader.releaseLock()
  }
}

/**
 * 创建包含错误码、文案、重试建议和 HTTP 状态的客户端错误。
 *
 * @param code 调用方指定的可程序识别错误码。
 * @param message 可展示给客户端使用者的错误说明。
 * @param retryable 是否建议重试，缺省为 false。
 * @param status 关联 HTTP 状态码，缺省零表示尚无服务端 HTTP 状态。
 */
function clientCreateError(code: string, message: string, retryable = false, status = 0): ClientError {
  return new ClientError({ code, message, retryable, status })
}
/**
 * 判断未知值是否为非空且非数组的对象。
 *
 * @param value 需要在协议边界判断为普通对象的未知值。
 */
function clientIsObject(value: unknown): value is Record<string, unknown> {
   return value !== null && typeof value === 'object' && !Array.isArray(value) }
/**
 * 判断输入是否为全由字符串组成的数组。
 *
 * @param value 需要验证为字符串数组的未知值。
 */
function clientIsStrings(value: unknown): value is string[] {
   return Array.isArray(value) && value.every(item => /* 确认数组当前成员为字符串。 */  typeof item === 'string') }
/** 校验来源脚注的版本、合法字段路径与从 1 起始的完整行范围。 */
function clientIsSourceAnchors(value: unknown): boolean {
  return Array.isArray(value) && value.length <= 64 && value.every(anchor => clientIsObject(anchor)
    && typeof anchor.path === 'string' && /^\/(?:[^~]|~[01])*$/.test(anchor.path)
    && Number.isSafeInteger(anchor.sourceRevision) && Number(anchor.sourceRevision) >= 0
    && Number.isSafeInteger(anchor.startLine) && Number(anchor.startLine) >= 1
    && Number.isSafeInteger(anchor.endLine) && Number(anchor.endLine) >= Number(anchor.startLine)
    && typeof anchor.quote === 'string')
}
/**
 * 只接受有界、可序列化 JSON；具体 payload 字段约束由服务端的精确定义版本保证。
 *
 * @param value 来自远端 payload、定义或执行结果的未知值。
 * @param depth 当前递归深度，防止畸形响应制造无界遍历。
 */
function clientIsJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.length <= 4096 && value.every(item => clientIsJson(item, depth + 1))
  return clientIsObject(value) && Object.keys(value).length <= 4096
    && Object.values(value).every(item => clientIsJson(item, depth + 1))
}
/**
 * 验证通用数据实例信封；客户端不按业务类型猜测 payload 结构。
 *
 * @param value 响应节点数组中的未验证节点，不修改原对象。
 * @param index 该节点在响应数组中的零基位置，用于指明错误路径。
 */
function clientAssertNode(
  /* 服务端返回、尚未验证的通用节点。 */ value: unknown,
  /* 报错使用的节点数组位置。 */ index: number,
): asserts value is Record<string, unknown> & { id: string; revision: number; typeId: string; typeVersion: number } {
  // 校验节点内容和可选人工创建身份；历史缺省来源保持未知。
  const clientCreateNodeError = () => /* 为当前节点位置生成协议响应错误。 */  clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RETURNED_INVALID_NODE_DATA_AT_NODES_VALUE, index))
  if (!clientIsObject(value) || typeof value.id !== 'string' || !value.id
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.typeId !== 'string' || !value.typeId
    || typeof value.typeVersion !== 'number' || !Number.isSafeInteger(value.typeVersion) || value.typeVersion < 1
    || typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt))
    || typeof value.updatedAt !== 'string' || Number.isNaN(Date.parse(value.updatedAt))
    || !clientIsObject(value.payload) || !clientIsJson(value.payload)) throw clientCreateNodeError()
  if (value.validity !== undefined && value.validity !== 'current' && value.validity !== 'stale') throw clientCreateNodeError()
  if (value.manualOrigin !== undefined && (!clientIsObject(value.manualOrigin)
    || typeof value.manualOrigin.userId !== 'string' || !value.manualOrigin.userId.trim())) throw clientCreateNodeError()
  if (value.libraryClaimRefs !== undefined) clientAssertLibraryUseRefs(value.libraryClaimRefs)
}
function clientAssertLibraryUseRefs(
  /* 正式节点返回的库引用元信息。 */ value: unknown,
): void {
  // 节点元信息只接纳有限、唯一且带明确理由的固定库引用。
  if (!Array.isArray(value) || value.length > 32) clientInvalidEvidenceUse()
  const ids = new Set<string>()
  for (const ref of value) {
    if (!clientIsObject(ref) || typeof ref.entryId !== 'string' || !ref.entryId.trim()
      || ids.has(ref.entryId) || typeof ref.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.contentDigest)
      || typeof ref.reason !== 'string' || !ref.reason.trim()) clientInvalidEvidenceUse()
    ids.add(ref.entryId)
  }
}
function clientInvalidEvidenceUse(): never {
  // 使用响应损坏不作为成功或当前引用返回给界面。
  throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'evidence use'))
}
function clientAssertEvidenceUse(
  /* 未验证的使用摘要或单条历史消费者详情。 */ value: unknown,
  /* 单件详情必须保存原消费者正文，列表只含摘要。 */ detail: boolean,
): asserts value is Pick<EvidenceUseSummary, 'id' | 'workspaceId' | 'ref'> {
  // 使用身份、材料身份、真实消费者版本与原运行上下文必须一致。
  if (!clientIsObject(value) || typeof value.id !== 'string' || !value.id.trim()
    || typeof value.workspaceId !== 'string' || !value.workspaceId.trim() || !clientIsObject(value.ref)
    || typeof value.ref.entryId !== 'string' || !value.ref.entryId.trim()
    || typeof value.ref.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.ref.contentDigest)
    || typeof value.reason !== 'string' || !value.reason.trim() || value.kind !== 'work' && value.kind !== 'manual'
    || typeof value.startedAt !== 'string' || Number.isNaN(Date.parse(value.startedAt))
    || value.endedAt !== null && (typeof value.endedAt !== 'string' || Number.isNaN(Date.parse(value.endedAt)))) clientInvalidEvidenceUse()
  const consumer = clientReadRelationRef(value.consumer)
  for (const key of ['runId', 'operationId', 'workId', 'reusedFromOperationId']) {
    if (value[key] !== null && (typeof value[key] !== 'string' || !value[key].trim())) clientInvalidEvidenceUse()
    if (value.kind === 'manual' && value[key] !== null) clientInvalidEvidenceUse()
  }
  if (value.kind === 'work' && (value.runId === null || value.operationId === null || value.workId === null)) clientInvalidEvidenceUse()
  if (detail) {
    clientAssertNode(value.consumerSnapshot, 0)
    if (value.consumerSnapshot.id !== consumer.nodeId
      || value.consumerSnapshot.revision !== consumer.revision) clientInvalidEvidenceUse()
  }
}
/**
 * 检查固定 Claim 来源标识及版本，供证据条目和节点依据共同使用。
 *
 * @param value 未验证的来源引用。
 */
function clientIsEvidenceClaimRef(value: unknown): value is EvidenceClaimRef {
  return clientIsObject(value) && typeof value.mapId === 'string' && !!value.mapId.trim()
    && typeof value.nodeId === 'string' && !!value.nodeId.trim()
    && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision >= 0
}
/**
 * 检查四种显式收录依据的公开引用形状。
 *
 * @param value 未验证的依据引用。
 */
function clientIsEvidenceBasis(value: unknown): boolean {
  if (!clientIsObject(value)) return false
  if (value.kind === 'manual') return typeof value.text === 'string' && !!value.text.trim()
  if (value.kind === 'node') return clientIsEvidenceClaimRef(value.ref)
  if (value.kind === 'asset') return typeof value.assetId === 'string' && !!value.assetId.trim()
    && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256)
  return value.kind === 'library' && clientIsObject(value.ref) && typeof value.ref.entryId === 'string'
    && !!value.ref.entryId.trim() && typeof value.ref.contentDigest === 'string' && /^[a-f0-9]{64}$/.test(value.ref.contentDigest)
}
/**
 * 验证库条目的固定 0/1 判断、Claim 快照、适用范围及管理状态。
 *
 * @param value 服务端返回的未验证证据条目。
 */
function clientAssertEvidenceEntry(value: unknown): void {
  const invalid = () => /* 将畸形条目归一化为公共客户端协议错误。 */ clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'evidence entry'))
  if (!clientIsObject(value) || !clientIsJson(value)
    || !['id', 'workspaceId', 'collectedBy'].every(key => /* 确认证据条目的身份字段非空。 */ typeof value[key] === 'string' && !!value[key].trim())
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
    || value.confidence !== 0 && value.confidence !== 1
    || typeof value.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentDigest)
    || typeof value.collectedAt !== 'string' || Number.isNaN(Date.parse(value.collectedAt))
    || value.status !== 'active' && value.status !== 'withdrawn' && value.status !== 'superseded'
    || value.statusReason !== null && typeof value.statusReason !== 'string'
    || value.replacementEntryId !== null && typeof value.replacementEntryId !== 'string'
    || !clientIsObject(value.claim) || !clientIsEvidenceClaimRef(value.claim.origin)
    || !clientIsObject(value.claim.type) || typeof value.claim.type.id !== 'string' || !value.claim.type.id.trim()
    || !Number.isSafeInteger(value.claim.type.version) || Number(value.claim.type.version) < 1
    || typeof value.claim.definitionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.claim.definitionDigest)
    || !clientIsObject(value.applicability) || !clientIsObject(value.decision)
    || typeof value.decision.reason !== 'string' || !value.decision.reason.trim()
    || !Array.isArray(value.decision.basisRefs) || !value.decision.basisRefs.every(clientIsEvidenceBasis)) throw invalid()
  const scope = value.applicability
  if (!['subject', 'event', 'place'].every(key => /* 检查适用范围可选文本保持明确的 null 或字符串。 */ scope[key] === null || typeof scope[key] === 'string')
    || !clientIsStrings(scope.conditions)) throw invalid()
  if (scope.time !== null) {
    const range = scope.time
    if (!clientIsObject(range) || typeof range.from !== 'string' || typeof range.to !== 'string') throw invalid()
    const from = Date.parse(range.from), to = Date.parse(range.to)
    if (Number.isNaN(from) || Number.isNaN(to) || from > to) throw invalid()
  }
  clientAssertNode(value.claim.nodeSnapshot, 0)
  const snapshot = value.claim.nodeSnapshot, origin = value.claim.origin
  if (snapshot.id !== origin.nodeId
    || snapshot.revision !== origin.revision || snapshot.typeId !== value.claim.type.id
    || snapshot.typeVersion !== value.claim.type.version) throw invalid()
}

function clientInvalidEvidenceRelations(): never {
  // 关系响应损坏统一归为协议错误，避免将邻域误当作普通图或库条目。
  throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'evidence relations'))
}

function clientReadRelationRef(
  /* 响应中未校验的精确来源引用。 */ value: unknown,
): EvidenceClaimRef {
  // 建立节点/边共同使用的窄身份类型，不依赖泛型或强制类型转换。
  if (!clientIsObject(value) || typeof value.mapId !== 'string' || !value.mapId.trim()
    || typeof value.nodeId !== 'string' || !value.nodeId.trim()
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0) clientInvalidEvidenceRelations()
  return { mapId: value.mapId, nodeId: value.nodeId, revision: value.revision }
}

function clientAssertEvidenceRelations(
  /* 尚未验证形状、身份和端点闭包的公开关系视图。 */ value: unknown,
): asserts value is Pick<QueryOutputMap['evidence.relations'], 'workspaceId' | 'entryId'> {
  // 校验有限快照与真实边身份，旧记录只允许明确 null，节点分数保留普通 JSON。
  if (!clientIsObject(value) || typeof value.workspaceId !== 'string' || !value.workspaceId.trim()
    || typeof value.entryId !== 'string' || !value.entryId.trim()
    || typeof value.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.contentDigest)
    || value.snapshot === undefined) clientInvalidEvidenceRelations()
  if (value.snapshot === null) return
  const snapshot = value.snapshot
  if (!clientIsObject(snapshot) || snapshot.version !== 1 || typeof snapshot.capturedAt !== 'string'
    || Number.isNaN(Date.parse(snapshot.capturedAt)) || typeof snapshot.rootKey !== 'string'
    || !snapshot.rootKey.trim() || typeof snapshot.truncated !== 'boolean'
    || !Array.isArray(snapshot.nodes) || !snapshot.nodes.length || snapshot.nodes.length > 128
    || !Array.isArray(snapshot.edges) || snapshot.edges.length > 256) clientInvalidEvidenceRelations()
  const refs = new Map<string, EvidenceClaimRef>()
  const identities = new Set<string>()
  let rootCount = 0
  for (const node of snapshot.nodes) {
    if (!clientIsObject(node) || typeof node.key !== 'string' || !node.key.trim() || refs.has(node.key)
      || typeof node.role !== 'string' || !['claim', 'upstream', 'downstream', 'basis', 'dependency'].includes(node.role)
      || typeof node.definitionDigest !== 'string' || !/^[a-f0-9]{64}$/.test(node.definitionDigest)
      || !clientIsObject(node.nodeSnapshot)) clientInvalidEvidenceRelations()
    const ref = clientReadRelationRef(node.ref)
    clientAssertNode(node.nodeSnapshot, refs.size)
    if (ref.nodeId !== node.nodeSnapshot.id || ref.revision !== node.nodeSnapshot.revision) clientInvalidEvidenceRelations()
    const identity = JSON.stringify(ref)
    if (identities.has(identity)) clientInvalidEvidenceRelations()
    identities.add(identity)
    refs.set(node.key, ref)
    if (node.role === 'claim') {
      rootCount += 1
      if (node.key !== snapshot.rootKey || node.nodeSnapshot.typeId !== 'factcheck.claim') clientInvalidEvidenceRelations()
    }
  }
  if (rootCount !== 1 || !refs.has(snapshot.rootKey)) clientInvalidEvidenceRelations()
  const edgeKeys = new Set<string>()
  for (const relation of snapshot.edges) {
    if (!clientIsObject(relation) || typeof relation.key !== 'string' || !relation.key.trim() || edgeKeys.has(relation.key)
      || typeof relation.from !== 'string' || typeof relation.to !== 'string') clientInvalidEvidenceRelations()
    const from = refs.get(relation.from), to = refs.get(relation.to)
    if (!from || !to) clientInvalidEvidenceRelations()
    edgeKeys.add(relation.key)
    if (relation.kind === 'basis') {
      if (!Number.isSafeInteger(relation.basisIndex) || Number(relation.basisIndex) < 0
        || Number(relation.basisIndex) >= 64 || relation.to !== snapshot.rootKey) clientInvalidEvidenceRelations()
      continue
    }
    if (typeof relation.mapId !== 'string' || relation.mapId !== from.mapId || relation.mapId !== to.mapId) clientInvalidEvidenceRelations()
    if (relation.kind === 'payload') {
      if (typeof relation.path !== 'string' || !relation.path.startsWith('/')) clientInvalidEvidenceRelations()
      continue
    }
    if (relation.kind !== 'graph' || !clientIsObject(relation.edge)) clientInvalidEvidenceRelations()
    const edge = relation.edge
    if (typeof edge.id !== 'string' || !edge.id.trim() || !Number.isSafeInteger(edge.revision) || Number(edge.revision) < 0
      || edge.from !== from.nodeId || edge.to !== to.nodeId || edge.kind !== 'successor' && edge.kind !== 'reference'
      || typeof edge.createdAt !== 'string' || Number.isNaN(Date.parse(edge.createdAt))
      || typeof edge.updatedAt !== 'string' || Number.isNaN(Date.parse(edge.updatedAt))
      || edge.label !== undefined && typeof edge.label !== 'string') clientInvalidEvidenceRelations()
    if (edge.sourceAnchors !== undefined) {
      if (edge.kind !== 'successor' || !Array.isArray(edge.sourceAnchors) || edge.sourceAnchors.length > 64) clientInvalidEvidenceRelations()
      for (const anchor of edge.sourceAnchors) {
        if (!clientIsObject(anchor) || typeof anchor.path !== 'string' || !/^\/(?:[^~]|~[01])*$/.test(anchor.path)
          || typeof anchor.quote !== 'string' || typeof anchor.sourceRevision !== 'number'
          || !Number.isSafeInteger(anchor.sourceRevision) || anchor.sourceRevision < 0 || anchor.sourceRevision > from.revision
          || typeof anchor.startLine !== 'number' || !Number.isSafeInteger(anchor.startLine) || anchor.startLine < 1
          || typeof anchor.endLine !== 'number' || !Number.isSafeInteger(anchor.endLine) || anchor.endLine < anchor.startLine) clientInvalidEvidenceRelations()
      }
    }
  }
}
/**
 * 将已知客户端异常投影为可序列化错误，未知异常隐藏细节并生成本地诊断编号。
 *
 * @param error 任意调用失败值，只有 ClientError 可保留公开字段，其他值脱敏。
 */
export function clientReadError(error: unknown): ClientErrorData {
  if (error instanceof ClientError) return { code: error.code, message: error.message, retryable: error.retryable, status: error.status,
    errorId: error.errorId,
    ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }) }
  return { code: 'CLIENT_ERROR', message: RuntimeMessage.CLIENT_INTERNAL_ERROR, status: 0, retryable: false, errorId: crypto.randomUUID() }
}
/**
 * 将服务地址规范化为 HTTP(S) 源，拒绝凭据、路径、查询和片段。
 *
 * @param value 用户或存储提供的服务地址，验证后仅返回无凭据的 HTTP(S) 源。
 */
export function clientReadBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value.trim()) } catch { throw clientCreateError('INVALID_URL', RuntimeMessage.ENTER_A_VALID_HTTP_S_SERVICE_ADDRESS) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw clientCreateError('INVALID_URL', RuntimeMessage.SERVICE_ADDRESS_MUST_BE_AN_HTTP_S_ORIGIN_WITHOUT_CREDENTIALS_PATH_QUERY)
  }
  return url.origin
}
function clientAssertRunPage(
  /* 目录查询返回、尚未通过摘要与分页检查的数据。 */ value: unknown,
  /* 请求发出时固定的Map与页大小，用于防止错配响应。 */ params: unknown,
): void {
  // 只检查公开摘要合同，不在客户端重新排序、筛选运行或计算目录版本。
  const invalid = () => {
    // 将错Map或损坏的摘要统一留在公共响应错误边界。
    return clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'run.list'))
  }
  if (!clientIsObject(value) || !clientIsObject(params) || typeof value.mapId !== 'string' || !value.mapId.trim()
    || value.mapId !== params.mapId || typeof value.directoryVersion !== 'string' || !value.directoryVersion.trim()
    || !Array.isArray(value.items)) throw invalid()
  const limit = typeof params.limit === 'number' ? Math.min(params.limit, 100) : 25
  if (value.items.length > limit || value.items.length > 100
    || value.nextCursor !== null && (typeof value.nextCursor !== 'string' || !value.nextCursor.trim() || value.nextCursor.length > 1024)
    || value.nextCursor !== null && !value.items.length) throw invalid()
  const ids = new Set<string>()
  const items: unknown[] = value.items
  for (const item of items) {
    if (!clientIsObject(item) || typeof item.runId !== 'string' || !item.runId.trim() || ids.has(item.runId)
      || item.status !== 'running' && item.status !== 'waiting' && item.status !== 'completed' && item.status !== 'failed' && item.status !== 'cancelled'
      || item.mode !== 'auto' && item.mode !== 'human-in-loop' || typeof item.archived !== 'boolean' || typeof item.paused !== 'boolean') throw invalid()
    for (const field of ['createdAt', 'updatedAt']) {
      const timestamp = item[field]
      if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) throw invalid()
    }
    for (const field of ['stepCount', 'operationCount', 'pendingReviewCount', 'outputCount']) {
      const count = item[field]
      if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) throw invalid()
    }
    if (Number(item.pendingReviewCount) > Number(item.operationCount)) throw invalid()
    ids.add(item.runId)
  }
}

function clientInvalidPublicationPreview(): never {
  // 将损坏的预览字段和互相矛盾的集合统一报告为公开响应错误。
  throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'run.publication.preview'))
}

function clientIsPublicationType(
  /* 服务端预览端口或候选声明的精确类型。 */ value: unknown,
): value is DefinitionRef {
  // 仅校验公开类型身份，不在客户端解释其业务 schema。
  return clientIsObject(value) && typeof value.id === 'string' && !!value.id.trim()
    && typeof value.version === 'number' && Number.isSafeInteger(value.version) && value.version >= 1
}

function clientAssertDefinitionView(
  /* 原查询所属范围，库目录与工作区目录互不替代。 */ method: 'definition.get' | 'definition.library.get',
  /* 未校验的目录与可选精确包响应。 */ value: unknown,
  /* 发出读取时固定的范围和精确包参数。 */ params: unknown,
): void {
  // 核对身份及页面读取需要的容器结构，不重做Schema、依赖闭包或不可变语义校验。
  const invalid = (): ClientError => {
    // 将错范围、错版本和损坏容器统一留在原公共协议错误边界。
    return clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, method))
  }
  if (!clientIsObject(value) || !clientIsObject(params)) throw invalid()
  if (method === 'definition.get') {
    if (typeof value.workspaceId !== 'string' || !value.workspaceId.trim() || value.workspaceId !== params.workspaceId) throw invalid()
  } else if (!clientIsObject(value.scope) || value.scope.kind !== 'library') throw invalid()
  const catalog = value.catalog
  if (!clientIsObject(catalog) || !Number.isSafeInteger(catalog.revision) || Number(catalog.revision) < 0
    || !Array.isArray(catalog.packages) || !Array.isArray(catalog.index)
    || !Array.isArray(catalog.dataTypes) || !Array.isArray(catalog.transitions)) throw invalid()
  for (const item of catalog.packages) {
    if (!clientIsObject(item) || !clientIsPublicationType(item.ref) || typeof item.digest !== 'string' || !item.digest.trim()) throw invalid()
  }
  for (const item of catalog.index) {
    if (!clientIsObject(item) || item.kind !== 'dataType' && item.kind !== 'transition'
      || !clientIsPublicationType(item.ref) || !clientIsPublicationType(item.packageRef)) throw invalid()
  }
  clientAssertDefinitionEntries(catalog, invalid)
  const needsPackage = params.packageId !== undefined || params.packageVersion !== undefined
  if (needsPackage && (typeof params.packageId !== 'string' || !params.packageId.trim()
    || !Number.isSafeInteger(params.packageVersion) || Number(params.packageVersion) < 1)) throw invalid()
  if (value.package !== undefined || needsPackage) {
    const pkg = value.package
    if (!clientIsObject(pkg) || !clientIsPublicationType(pkg) || typeof pkg.title !== 'string'
      || pkg.schemaDialect !== 'http://json-schema.org/draft-07/schema#' || !clientIsObject(pkg.dependencies)
      || !Array.isArray(pkg.dependencies.packages) || !pkg.dependencies.packages.every(clientIsPublicationType)
      || !Array.isArray(pkg.dependencies.agents) || !pkg.dependencies.agents.every((/* 声明的精确Agent身份。 */ ref) =>
        /* Agent版本0属于有效身份，不拿类型版本下界替代。 */ clientIsObject(ref) && typeof ref.id === 'string' && !!ref.id.trim()
          && Number.isSafeInteger(ref.version) && Number(ref.version) >= 0)) throw invalid()
    if (needsPackage && (pkg.id !== params.packageId || pkg.version !== params.packageVersion)) throw invalid()
    clientAssertDefinitionEntries(pkg, invalid)
  }
}

function clientAssertDefinitionEntries(
  /* 目录或精确包中尚未校验的定义列表容器。 */ value: Record<string, unknown>,
  /* 所属查询统一创建的公开响应错误。 */ invalid: () => ClientError,
): void {
  // 只建立定义中心与既有Agent绑定浏览所读取的对象和列表，不执行定义规则。
  if (!Array.isArray(value.dataTypes) || !Array.isArray(value.transitions)) throw invalid()
  for (const type of value.dataTypes) {
    if (!clientIsObject(type) || !clientIsPublicationType(type) || typeof type.title !== 'string'
      || !clientIsObject(type.schema) || !Array.isArray(type.successorTypes) || !type.successorTypes.every(clientIsPublicationType)
      || !Array.isArray(type.references) || !clientIsObject(type.agentProjection)
      || !clientIsStrings(type.agentProjection.include) || !Array.isArray(type.agentProjection.mapEntryFilters)) throw invalid()
  }
  for (const transition of value.transitions) {
    if (!clientIsObject(transition) || !clientIsPublicationType(transition) || typeof transition.title !== 'string'
      || !clientIsObject(transition.ports) || !Array.isArray(transition.ports.input)
      || !Array.isArray(transition.ports.context) || !Array.isArray(transition.ports.output)
      || !clientIsObject(transition.execution) || !Array.isArray(transition.execution.stages)
      || typeof transition.execution.resultStage !== 'string' || !clientIsObject(transition.review)) throw invalid()
    for (const stage of transition.execution.stages) {
      if (!clientIsObject(stage) || typeof stage.id !== 'string' || !stage.id.trim()
        || !clientIsObject(stage.agentRef) || typeof stage.agentRef.id !== 'string' || !stage.agentRef.id.trim()
        || !Number.isSafeInteger(stage.agentRef.version) || Number(stage.agentRef.version) < 0) throw invalid()
    }
  }
}

function clientAssertPublicationPreview(
  /* 尚未通过身份、端口统计和引用元数据检查的预览响应。 */ value: unknown,
): asserts value is ClientPublicationIdentity {
  // 校验权威集合的协议自洽，不重新选择候选或推断图的引用与发布规则。
  if (!clientIsObject(value)) clientInvalidPublicationPreview()
  for (const field of ['mapId', 'runId', 'operationId', 'reviewId', 'specHash', 'publicationVersion']) {
    const identity = value[field]
    if (typeof identity !== 'string' || !identity.trim()) clientInvalidPublicationPreview()
  }
  if (typeof value.publicationVersion !== 'string' || value.publicationVersion.length > 2048
    || typeof value.reviewRevision !== 'number' || !Number.isSafeInteger(value.reviewRevision) || value.reviewRevision < 0
    || !Array.isArray(value.ports) || !Array.isArray(value.items)) clientInvalidPublicationPreview()
  const ports = new Map<string, { typeRef: DefinitionRef; count: number; actualCount: number }>()
  const portValues: unknown[] = value.ports
  for (const port of portValues) {
    if (!clientIsObject(port) || typeof port.port !== 'string' || !port.port.trim() || ports.has(port.port)
      || !clientIsPublicationType(port.typeRef) || typeof port.count !== 'number'
      || !Number.isSafeInteger(port.count) || port.count < 0) clientInvalidPublicationPreview()
    ports.set(port.port, { typeRef: port.typeRef, count: port.count, actualCount: 0 })
  }
  const candidates = new Map<string, string[]>()
  const itemValues: unknown[] = value.items
  for (const item of itemValues) {
    if (!clientIsObject(item)) clientInvalidPublicationPreview()
    for (const field of ['workId', 'key', 'stageId', 'slotId', 'port']) {
      const identity = item[field]
      if (typeof identity !== 'string' || !identity.trim()) clientInvalidPublicationPreview()
    }
    if (typeof item.port !== 'string' || !clientIsPublicationType(item.typeRef)
      || typeof item.directlySelected !== 'boolean' || !Array.isArray(item.referencedBy)) clientInvalidPublicationPreview()
    const port = ports.get(item.port)
    const candidateKey = JSON.stringify([item.workId, item.key])
    if (!port || port.typeRef.id !== item.typeRef.id || port.typeRef.version !== item.typeRef.version
      || candidates.has(candidateKey)) clientInvalidPublicationPreview()
    const referencedBy: string[] = []
    const referenceValues: unknown[] = item.referencedBy
    for (const reference of referenceValues) {
      if (!clientIsObject(reference) || typeof reference.workId !== 'string' || !reference.workId.trim()
        || typeof reference.key !== 'string' || !reference.key.trim()) clientInvalidPublicationPreview()
      const referenceKey = JSON.stringify([reference.workId, reference.key])
      if (referencedBy.includes(referenceKey)) clientInvalidPublicationPreview()
      referencedBy.push(referenceKey)
    }
    if (!item.directlySelected && referencedBy.length === 0) clientInvalidPublicationPreview()
    candidates.set(candidateKey, referencedBy)
    port.actualCount += 1
  }
  for (const references of candidates.values()) {
    for (const reference of references) {
      if (!candidates.has(reference)) clientInvalidPublicationPreview()
    }
  }
  for (const port of ports.values()) {
    if (port.actualCount !== port.count) clientInvalidPublicationPreview()
  }
}

function clientAssertPublicationIdentity(
  /* 已通过结构检查、等待与原查询绑定的服务端预览身份。 */ value: ClientPublicationIdentity,
  /* 发出该查询时保存的审核身份和预期版本。 */ params: unknown,
): void {
  // 拒绝另一图或另一审核的成功响应，防止跨审核错配进入界面。
  if (!clientIsObject(params)) clientInvalidPublicationPreview()
  for (const field of ['mapId', 'runId', 'operationId', 'reviewId'] as const) {
    if (value[field] !== params[field]) clientInvalidPublicationPreview()
  }
  if (value.reviewRevision !== params.expectedReviewRevision) clientInvalidPublicationPreview()
}

function clientAssertModelConnection(
  /* 公开模型连接响应，只允许状态与非秘密字段。 */ value: unknown,
  /* 原始查询或写命令的目标scope。 */ params: unknown,
): void {
  // 白名单拒绝Key及密文，不能只检查必要字段后把额外秘密对象交给Renderer。
  function invalid(): never { throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'model connection')) }
  const exact = (record: Record<string, unknown>, keys: string[]): boolean =>
    keys.length === Object.keys(record).length && keys.every(key => Object.prototype.hasOwnProperty.call(record, key))
  if (!clientIsObject(value) || !exact(value, ['scope', 'revision', 'provider', 'model', 'baseUrl', 'apiKeyConfigured', 'effective'])
    || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || typeof value.apiKeyConfigured !== 'boolean'
    || !clientIsObject(value.scope) || !clientIsObject(params) || !clientIsObject(params.scope)) invalid()
  const scope = value.scope, expected = params.scope
  const keys = scope.kind === 'workspace' ? ['kind', 'workspaceId'] : ['kind', 'workspaceId', 'agentId']
  if (scope.kind !== 'workspace' && scope.kind !== 'agent' || !exact(scope, keys)
    || typeof scope.workspaceId !== 'string' || !scope.workspaceId
    || scope.kind !== expected.kind || scope.workspaceId !== expected.workspaceId
    || scope.kind === 'agent' && (typeof scope.agentId !== 'string' || !scope.agentId || scope.agentId !== expected.agentId)) invalid()
  const effective = value.effective
  if (!clientIsObject(effective) || !exact(effective, ['provider', 'model', 'baseUrl', 'apiKeyConfigured', 'apiKeySource'])
    || typeof effective.apiKeyConfigured !== 'boolean'
    || effective.apiKeySource !== null && effective.apiKeySource !== 'agent' && effective.apiKeySource !== 'workspace'
    || effective.apiKeyConfigured !== (effective.apiKeySource !== null)
    || effective.apiKeySource === 'agent' && scope.kind !== 'agent') invalid()
  for (const connection of [value, effective]) {
    for (const key of ['provider', 'model', 'baseUrl']) if (connection[key] !== null && (typeof connection[key] !== 'string' || !connection[key].trim())) invalid()
    if (connection.baseUrl !== null) {
      try {
        const url = new URL(String(connection.baseUrl))
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) invalid()
      } catch { invalid() }
    }
  }
}

/**
 * 按公开方法检查必要字段和关键业务结构，并递归验证快照、Run 和资产列表。
 *
 * @param method 原请求的公共方法名，决定响应必须包含哪些业务字段。
 * @param data 服务端 JSON 的未验证业务值，递归检查必要结构。
 */
function clientAssertData(
  /* 要验证完整图快照的固定方法。 */ method: 'map.get',
  /* 未验证快照；这里只声明后续一致性检查使用的已验证字段。 */ data: unknown,
): asserts data is { mapId: string; revision: number; nodes: Array<{ id: string; revision: number }> }
function clientAssertData(
  /* 要验证分支范围与版本证明的固定方法。 */ method: 'branch.get',
  /* 尚未解析的分支证明。 */ data: unknown,
): asserts data is GraphBranchSnapshot
function clientAssertData(
  /* 其余公开或内部响应方法；必须有明确响应字段定义。 */ method: ClientResponseMethod,
  /* 尚未验证的业务响应。 */ data: unknown,
  /* 有身份绑定的公开查询原参数；递归验证没有此上下文。 */ params?: unknown,
): void
function clientAssertData(
  /* 原请求的公共方法，决定成功响应必须满足的业务结构。 */ method: ClientResponseMethod,
  /* 尚未通过当前方法协议检查的服务端 JSON 业务数据。 */ data: unknown,
  /* 发出请求时冻结的公开查询参数，其对象形状仍在身份边界校验。 */ params?: unknown,
): void {
  // 按原公共方法验证成功响应，阻止损坏的业务字段进入调用者状态。
  if (method === 'model.get' || method === 'model.update') {
    clientAssertModelConnection(data, params)
    return
  }
  if (method === 'definition.get' || method === 'definition.library.get') {
    clientAssertDefinitionView(method, data, params)
    return
  }
  if (method === 'run.list') {
    clientAssertRunPage(data, params)
    return
  }
  if (method === 'run.publication.preview') {
    clientAssertPublicationPreview(data)
    clientAssertPublicationIdentity(data, params)
    return
  }
  if (method === 'evidence.get' || method === 'evidence.withdraw') {
    clientAssertEvidenceEntry(data)
    return
  }
  if (method === 'evidence.relations') {
    clientAssertEvidenceRelations(data)
    if (!clientIsObject(params) || data.workspaceId !== params.workspaceId || data.entryId !== params.entryId) clientInvalidEvidenceRelations()
    return
  }
  if (method === 'evidence.use.get') {
    clientAssertEvidenceUse(data, true)
    if (!clientIsObject(params) || data.workspaceId !== params.workspaceId || data.ref.entryId !== params.entryId || data.id !== params.usageId) clientInvalidEvidenceUse()
    return
  }
  const fields: Record<Exclude<ClientResponseMethod, 'model.get' | 'model.update' | 'map.list' | 'run.publication.preview' | 'run.list' | 'definition.get' | 'definition.library.get' | 'evidence.get' | 'evidence.withdraw' | 'evidence.relations' | 'evidence.use.get'>, readonly string[]> = {
    'app.bootstrap': ['identity', 'settings', 'metadata'], 'map.get': ['mapId', 'workspaceId', 'name', 'revision', 'nodes', 'edges', 'runs', 'ownershipRevision', 'ownerships', 'runControls', 'updatedAt'],
    'branch.get': ['scope', 'version'],
    'run.get': ['id', 'scope', 'plan', 'definitions', 'paused', 'regenerate', 'mode', 'status', 'operations', 'createdAt', 'updatedAt'],
    'asset.list': ['items', 'nextCursor'], 'workspace.list': ['items', 'nextCursor'], 'workspace.get': ['id', 'revision', 'agents', 'members', 'preferences'],
    'agent.list': ['scope', 'revision', 'items'], 'asset.get': ['id', 'workspaceId', 'filename', 'mediaType', 'size', 'sha256'],
    'evidence.collect': ['entry', 'replayed', 'existing', 'conflictEntryIds'],
    'evidence.search': ['items', 'nextCursor', 'libraryRevision'],
    'evidence.uses': ['workspaceId', 'entryId', 'items', 'nextCursor', 'usageRevision'],
    'workspace.create': ['id', 'revision', 'agents', 'members'], 'workspace.update': ['id', 'revision', 'agents', 'members'],
    'workspace.delete': ['workspaceId', 'deleted'], 'member.set': ['userId', 'member', 'workspaceRevision'],
    'preferences.set': ['workspaceId', 'revision', 'openMapIds', 'currentMapId', 'nodeSelection'],
    'agent.create': ['scope', 'revision', 'items'], 'agent.update': ['scope', 'revision', 'items'], 'agent.delete': ['scope', 'revision', 'items'],
    'agent.copy': ['id', 'revision', 'agents'], 'definition.publish': ['workspaceId', 'workspaceRevision', 'package'], 'settings.update': ['revision', 'llm', 'tools', 'limits'],
    'asset.delete': ['assetId', 'deleted'], 'workspace.import': ['workspaceId', 'mapIds', 'assetIds'],
    'map.delete': ['mapId', 'deleted'],
    'map.create': GRAPH_WRITE_FIELDS, 'map.rename': GRAPH_WRITE_FIELDS, 'graph.apply': GRAPH_WRITE_FIELDS,
    'run.start': GRAPH_WRITE_FIELDS, 'run.cancel': GRAPH_WRITE_FIELDS, 'run.pause': GRAPH_WRITE_FIELDS,
    'run.resume': GRAPH_WRITE_FIELDS, 'review.answer': GRAPH_WRITE_FIELDS,
    'branch.claim': ['status'], 'branch.ownership': ['leaseId', 'kind', 'rootIds', 'ownerUserId', 'holderId', 'fence', 'expiresAt', 'leaseMs', 'scope'],
    'branch.renew': ['leaseId', 'kind', 'rootIds', 'ownerUserId', 'holderId', 'fence', 'expiresAt', 'leaseMs', 'scope', 'branch', 'ownershipRevision'],
    'branch.release': ['released', 'ownershipRevision'],
    'run.control.claim': ['status'],
    'run.control': ['leaseId', 'runId', 'ownerUserId', 'holderId', 'fence', 'expiresAt', 'leaseMs'],
    'run.control.renew': ['leaseId', 'runId', 'ownerUserId', 'holderId', 'fence', 'expiresAt', 'leaseMs', 'ownershipRevision'],
    'run.control.release': ['released', 'ownershipRevision'],
  }
  if (method === 'map.list') {
    if (!Array.isArray(data)) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.MAP_LIST_IS_MISSING)
    return
  }
  const required = fields[method]
  if (!clientIsObject(data) || required.some(key => /* 找出响应中缺少或明确为 undefined 的必要字段。 */  !Object.prototype.hasOwnProperty.call(data, key) || data[key] === undefined)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_IS_INCOMPLETE_FOR_VALUE, method))
  for (const key of ['nodes', 'edges', 'runs', 'members', 'agents', 'tools', 'operations', 'ownerships', 'runControls', 'createdNodeIds', 'createdEdgeIds', 'openMapIds', 'mapIds', 'assetIds']) {
    if (key in data && !Array.isArray(data[key])) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  for (const key of ['revision', 'workspaceRevision', 'ownershipRevision', 'size']) {
    if (key in data && (typeof data[key] !== 'number' || !Number.isSafeInteger(data[key]) || data[key] < 0)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  for (const key of ['id', 'mapId', 'workspaceId', 'assetId']) {
    if (key in data && (typeof data[key] !== 'string' || !data[key])) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  for (const key of ['preferences', 'nodeSelection', 'llm', 'limits']) {
    if (key in data && !clientIsObject(data[key])) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, key))
  }
  if ('deleted' in data && data.deleted !== true) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_DID_NOT_CONFIRM_DELETION)
  if ('runs' in data) for (const run of data.runs as unknown[]) clientAssertData('run.get', run)
  if (method === 'run.get' && (typeof data.paused !== 'boolean' || typeof data.regenerate !== 'boolean'
    || !clientIsObject(data.scope) || !clientIsStrings(data.scope.nodeIds)
    || !clientIsObject(data.plan) || !Array.isArray(data.plan.steps)
    || !clientIsObject(data.definitions) || !Array.isArray(data.definitions.dataTypes)
    || !Array.isArray(data.definitions.transitions))) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_RUN_CONTROLS)
  if (method === 'app.bootstrap') {
    if (!clientIsObject(data.identity) || typeof data.identity.userId !== 'string'
      || typeof data.identity.displayName !== 'string' || typeof data.identity.hostAdmin !== 'boolean'
      || !clientIsObject(data.metadata)) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_DID_NOT_RETURN_AN_AUTHENTICATED_APPLICATION_IDENTITY)
    clientAssertData('settings.update', data.settings)
    if (data.metadata.clientLeases !== undefined
      && data.metadata.clientLeases !== 'required' && data.metadata.clientLeases !== 'none') {
      throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'clientLeases'))
    }
    if ('capabilities' in data.metadata) {
      const capabilities = data.metadata.capabilities
      if (!clientIsObject(capabilities)) {
        throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'metadata.capabilities'))
      }
      for (const key of ['evidenceLibrary', 'mapRename', 'publicationPreview', 'runHistory', 'libraryDefinitions', 'modelConnections']) {
        if (key in capabilities && typeof capabilities[key] !== 'boolean') {
          throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, `metadata.capabilities.${key}`))
        }
      }
    }
  }
  if (method === 'map.get') {
    (data.nodes as unknown[]).forEach(clientAssertNode)
    for (const edge of data.edges as unknown[]) {
      if (!clientIsObject(edge) || !['id', 'from', 'to'].every(key => /* 验证图边的编号和两端节点标识均为非空字符串。 */  typeof edge[key] === 'string' && !!edge[key])
        || typeof edge.createdAt !== 'string' || Number.isNaN(Date.parse(edge.createdAt))
        || edge.kind !== 'successor' && edge.kind !== 'reference'
        || edge.sourceAnchors !== undefined && (edge.kind !== 'successor' || !clientIsSourceAnchors(edge.sourceAnchors))) {
        throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_GRAPH_EDGE_DATA)
      }
    }
    for (const ownership of data.ownerships as unknown[]) clientAssertData('branch.ownership', ownership)
    for (const control of data.runControls as unknown[]) clientAssertData('run.control', control)
  }
  if (method === 'branch.ownership' || method === 'branch.renew') {
    if (!clientIsStrings(data.rootIds) || !clientIsObject(data.scope) || !clientIsStrings(data.scope.rootIds)
      || !clientIsStrings(data.scope.nodeIds) || !clientIsStrings(data.scope.edgeIds)
      || typeof data.fence !== 'number' || !Number.isSafeInteger(data.fence) || data.fence < 0
      || data.kind !== 'editor' && data.kind !== 'run' || typeof data.ownerUserId !== 'string' || typeof data.holderId !== 'string'
      || (data.kind === 'editor'
        ? typeof data.expiresAt !== 'string' || Number.isNaN(Date.parse(data.expiresAt)) || !Number.isSafeInteger(data.leaseMs) || Number(data.leaseMs) < 1
        : data.expiresAt !== null || data.leaseMs !== null)) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_RUN_CONTROLS)
    if (method === 'branch.ownership') return
  }
  if (method === 'branch.claim') {
    if (data.status === 'claimed') clientAssertData('branch.renew', data.grant)
    else if (data.status === 'busy') clientAssertData('branch.ownership', data.ownership)
    else throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'branch claim'))
  }
  if (method === 'branch.renew') {
    if (data.kind !== 'editor') throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'kind'))
  }
  if (method === 'run.control' || method === 'run.control.renew') {
    if (typeof data.runId !== 'string' || !data.runId || typeof data.ownerUserId !== 'string' || !data.ownerUserId
      || typeof data.holderId !== 'string' || !data.holderId || typeof data.expiresAt !== 'string' || Number.isNaN(Date.parse(data.expiresAt))
      || !Number.isSafeInteger(data.leaseMs) || Number(data.leaseMs) < 1 || !Number.isSafeInteger(data.fence) || Number(data.fence) < 1) {
      throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_RUN_CONTROLS)
    }
  }
  if (method === 'run.control.claim') {
    if (data.status === 'claimed') clientAssertData('run.control.renew', data.grant)
    else if (data.status === 'busy') clientAssertData('run.control', data.control)
    else throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'run control claim'))
  }
  if (method === 'branch.get') {
    const scope = data.scope
    if (!clientIsObject(scope) || !clientIsStrings(scope.rootIds) || !clientIsStrings(scope.nodeIds) || !clientIsStrings(scope.edgeIds)
      || !clientIsObject(data.rootRevisions)) {
      throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'branch'))
    }
    const { rootIds, nodeIds, edgeIds } = scope
    const rootRevisions = data.rootRevisions
    if (!rootIds.length || [...rootIds, ...nodeIds, ...edgeIds].some(id => !id.trim())
      || new Set(rootIds).size !== rootIds.length || new Set(nodeIds).size !== nodeIds.length || new Set(edgeIds).size !== edgeIds.length
      || rootIds.some(id => !nodeIds.includes(id)) || Object.keys(rootRevisions).length !== rootIds.length
      || rootIds.some(id => !Number.isSafeInteger(rootRevisions[id]) || Number(rootRevisions[id]) < 0)
      || !Number.isSafeInteger(data.mapRevision) || Number(data.mapRevision) < 0
      || typeof data.version !== 'string' || !data.version.trim()) {
      throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'branch'))
    }
  }
  if (method === 'asset.list') {
    if (!Array.isArray(data.items)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'items'))
    for (const asset of data.items) clientAssertData('asset.get', asset)
    if (data.nextCursor !== null && typeof data.nextCursor !== 'string') throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.INVALID_ASSET_CURSOR)
  }
  if (method === 'workspace.list' && !Array.isArray(data.items)) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'items'))
  if ((method === 'agent.list' || method === 'agent.create' || method === 'agent.update' || method === 'agent.delete')
    && (!clientIsObject(data.scope) || !Array.isArray(data.items))) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'agents'))
  if (method === 'evidence.collect') {
    clientAssertEvidenceEntry(data.entry)
    if (typeof data.replayed !== 'boolean' || typeof data.existing !== 'boolean' || !clientIsStrings(data.conflictEntryIds)) {
      throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'evidence collection'))
    }
  }
  if (method === 'evidence.search') {
    if (!Array.isArray(data.items) || data.items.length > 100 || !Number.isSafeInteger(data.libraryRevision)
      || Number(data.libraryRevision) < 0 || data.nextCursor !== null && typeof data.nextCursor !== 'string') {
      throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'evidence page'))
    }
    for (const item of data.items) {
      if (!clientIsObject(item) || typeof item.id !== 'string' || !item.id.trim() || typeof item.content !== 'string'
        || typeof item.contentDigest !== 'string' || item.confidence !== 0 && item.confidence !== 1
        || item.status !== 'active' && item.status !== 'withdrawn' && item.status !== 'superseded') {
        throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'evidence summary'))
      }
    }
  }
  if (method === 'evidence.uses') {
    if (!Array.isArray(data.items) || data.items.length > 100 || typeof data.entryId !== 'string' || !data.entryId.trim()
      || !Number.isSafeInteger(data.usageRevision) || Number(data.usageRevision) < 0
      || data.nextCursor !== null && typeof data.nextCursor !== 'string') clientInvalidEvidenceUse()
    for (const item of data.items) {
      clientAssertEvidenceUse(item, false)
      if (item.workspaceId !== data.workspaceId
        || item.ref.entryId !== data.entryId) clientInvalidEvidenceUse()
    }
    if (!clientIsObject(params) || data.workspaceId !== params.workspaceId || data.entryId !== params.entryId) clientInvalidEvidenceUse()
    return
  }
  let branch: GraphBranchSnapshot | undefined
  if (data.branch !== undefined) {
    const value = data.branch
    clientAssertData('branch.get', value)
    branch = value
  }
  if ('runControl' in data && data.runControl !== undefined) clientAssertData('run.control.renew', data.runControl)
  if ('snapshot' in data) {
    const snapshot = data.snapshot
    clientAssertData('map.get', snapshot)
    if (branch && (branch.mapRevision !== snapshot.revision || branch.scope.rootIds.some(
      /* 分支证明中必须能在本次快照找到相同版本的根节点。 */ id => {
        // 只检查快照与证明的配对关系，形状已分别在响应边界验证。
        const node = snapshot.nodes.find((/* 已验证的快照节点身份。 */ value) => /* 定位当前分支根。 */ value.id === id)
        return node === undefined || node.revision !== branch.rootRevisions[id]
      },
    ))) throw clientCreateError('INVALID_RESPONSE', messageFormat(RuntimeMessage.SERVICE_RESPONSE_HAS_AN_INVALID_VALUE, 'branch snapshot'))
  }
}
/**
 * 按 16 MiB 上限流式解码 UTF-8 响应并解析 JSON，读取结束或失败时释放流锁。
 *
 * @param response 待读取的 HTTP 响应，本函数消耗其正文并按字节限制 UTF-8 JSON 体积。
 */
async function clientReadJson(response: Response): Promise<unknown> {
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
      if (size > MAX_RESPONSE_BYTES) throw clientCreateError('RESPONSE_TOO_LARGE', RuntimeMessage.SERVICE_RESPONSE_EXCEEDS_16_MIB)
      try { chunks.push(decoder.decode(part.value, { stream: true })) }
      catch { throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON, false, response.status) }
    }
    try { chunks.push(decoder.decode()) }
    catch { throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON, false, response.status) }
    try { return JSON.parse(chunks.join('')) } catch { throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON, response.status >= 500, response.status) }
  } finally {
    await reader.cancel().catch(() => {
      // 终止未读完的响应；清理失败不覆盖格式、超限或读取错误。
    })
    reader.releaseLock()
  }
}
// 固定凭据 HTTP 客户端配置，可注入 fetch 并分别控制请求与流空闲期限。
export interface ClientApiOptions { baseUrl: string; token: string; timeoutMs?: number; streamIdleMs?: number; fetch?: typeof globalThis.fetch }
/**
 * 创建固定服务地址和令牌的 HTTP 客户端，为请求与事件流持有共同的取消生命周期。
 *
 * @param options 固定源和令牌及可选传输配置；普通请求缺省 15000 毫秒，流空闲缺省 45000 毫秒。
 */
export function clientCreateApi(options: ClientApiOptions) {
  const baseUrl = clientReadBaseUrl(options.baseUrl)
  const token = options.token.trim()
  if (!token || /[^\x21-\x7e]/.test(token)) throw clientCreateError('INVALID_TOKEN', RuntimeMessage.ENTER_A_VALID_SERVICE_TOKEN)
  const timeoutMs = options.timeoutMs ?? 15000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw clientCreateError('INVALID_TIMEOUT', RuntimeMessage.REQUEST_TIMEOUT_MUST_BE_A_POSITIVE_INTEGER)
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const lifetime = new AbortController()

  /**
   * 合并客户端关闭、调用者取消和超时信号，执行一次请求并归一化失败，最后清理监听器与定时器。
   *
   * @param operation 实际网络操作，必须使用本层组合出的信号，并把结果或失败返回给生命周期管理器。
   * @param signal 可选的调用者取消信号，由调用方拥有，客户端只监听。
   * @param duration 本次操作的毫秒期限，省略时沿用客户端普通请求超时。
   */
  async function clientRunRequest<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal, duration = timeoutMs): Promise<T> {
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
  /**
   * 解析成功或失败响应，核对命令响应的 requestId 并验证业务数据结构后返回结果。
   *
   * @param response 服务端 HTTP 响应，消耗正文并解码成功或失败结构。
   * @param method 原请求方法，决定成功响应所需的业务结构。
   * @param requestId 可选预期业务请求编号；提供时要求服务端返回相同编号。
   */
  async function clientReadReply<T>(
    /* 本次 HTTP 返回的成功或失败响应。 */ response: Response,
    /* 决定业务响应验证规则的方法。 */ method: ClientResponseMethod,
    /* 写命令期望的稳定请求编号，查询时省略。 */ requestId?: string,
    /* 发出查询时冻结的身份参数。 */ params?: unknown,
  ): Promise<GraphSuccess<T>> {
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
      clientAssertData(method, value.data, params)
      return value as unknown as GraphSuccess<T>
  }
  /**
   * 携带服务令牌发送查询或命令 JSON，禁止重定向，并在请求生命周期内验证响应。
   *
   * @param path 由内部调用选择的固定查询或写命令端点，不接受任意路径。
   * @param method 本次请求的业务方法名，供返回结构校验使用。
   * @param body 待 JSON 序列化的完整请求对象，包含方法、参数和必要的请求编号。
   * @param requestId 可选写入幂等编号，用于核对响应；普通查询不指定。
   * @param signal 可选调用方取消信号，转入统一请求生命周期。
   */
  function clientSendRequest<T>(
    /* 内部选定的固定查询或命令端点。 */ path: '/api/v1/query' | '/api/v1/command',
    /* 决定响应结构和身份校验的公开方法。 */ method: keyof QueryInputMap | keyof CommandInputMap,
    /* 由 read/dispatch 创建的信封；公开参数仍在服务及身份边界验证。 */ body: {
      method: keyof QueryInputMap | keyof CommandInputMap
      params: QueryInputMap[keyof QueryInputMap] | CommandInputMap[keyof CommandInputMap]
      requestId?: string
    },
    /* 可选稳定写入编号，普通查询不指定。 */ requestId?: string,
    /* 调用者拥有的取消信号。 */ signal?: AbortSignal,
  ): Promise<GraphSuccess<T>> {
    // 冻结有身份约束的查询参数，调用者后续修改不能改变已发请求的含义。
    const params = method === 'model.get' || method === 'model.update'
      ? clientIsObject(body.params) && 'scope' in body.params ? { scope: structuredClone(body.params.scope) } : undefined
      : method === 'definition.get' || method === 'definition.library.get' || method === 'run.list' || method === 'run.publication.preview' || method === 'evidence.relations'
        || method === 'evidence.uses' || method === 'evidence.use.get' ? structuredClone(body.params) : undefined
    return clientRunRequest(async (/* 合并了超时、关闭和调用者取消的请求信号。 */ signal) => {
      // 使用本次请求的取消信号发送 POST，再核对响应与原请求是否匹配。
      const response = await fetcher(new URL(path, baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
        body: JSON.stringify(body), redirect: 'error', credentials: 'omit', signal,
      })
      return clientReadReply<T>(response, method, requestId, params)
    }, signal)
  }
  return {
    /**
     * 订阅指定图的 SSE 流，验证首个快照、事件结构和帧大小；取消时释放资源，断流时将是否可重连交给调用者。
     *
     * @param mapId 目标图的 UUID，既用于事件端点也用于首帧归属验证。
     * @param onEvent 接收已验证事件的调用方回调，回调由订阅流程同步调用。
     * @param signal 可选订阅取消信号，由调用方控制持续流的结束。
     */
    async watch(mapId: string, onEvent: (event: GraphStreamEvent) => void, signal?: AbortSignal): Promise<void> {
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
      /**
       * 累积尚未结束的一行文本，并按 UTF-8 字节数限制当前事件帧大小。
       *
       * @param part 当前尚未完成一行的解码文本片段，加入帧字节配额。
       */
      const add = (part: string) => {
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
              if (event.snapshot.mapId !== mapId) throw clientCreateError('INVALID_STREAM', RuntimeMessage.REAL_TIME_STREAM_RETURNED_ANOTHER_MAP)
              sawSnapshot = true
              touch()
            } else if (event.type === 'activity') {
              if (!sawSnapshot || !Array.isArray(event.items) || event.items.length > 1000 || !event.items.every(item =>
                /* 确认活动条目符合协议且属于当前订阅图。 */
                activityIsRecord(item) && item.mapId === mapId)) throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_REAL_TIME_ACTIVITY)
              touch()
            } else if (event.type === 'refresh') {
              if (!sawSnapshot || event.scope !== 'workspace' && event.scope !== 'settings') throw clientCreateError('INVALID_STREAM', RuntimeMessage.INVALID_REAL_TIME_REFRESH)
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
      /**
       * 从解码文本中分离 SSE 行，保留跨数据块的半行和 CRLF 状态。
       *
       * @param text 新解码出的 SSE 文本块，可能从上一块的半行或 CRLF 中间继续。
       */
      const consume = (text: string) => {
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
        let response: Response
        try {
          response = await fetcher(new URL('/api/v1/maps/' + mapId + '/events', baseUrl), {
            method: 'GET', credentials: 'omit', redirect: 'error', signal: controller.signal,
            headers: { authorization: 'Bearer ' + token, accept: 'text/event-stream' },
          })
          if (!response.ok) await clientReadReply(response, 'map.get')
        } catch (error) {
          if (error instanceof ClientError) throw error
          throw clientCreateError('NETWORK_ERROR', RuntimeMessage.REAL_TIME_CONNECTION_FAILED, true)
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
          await response.body?.cancel().catch(() => {
            // 非事件流响应已被拒绝；取消正文的次级失败不能覆盖原协议错误。
          })
          throw clientCreateError('INVALID_STREAM', RuntimeMessage.SERVICE_DID_NOT_RETURN_AN_EVENT_STREAM)
        }
        reader = response.body.getReader(); touch()
        while (!controller.signal.aborted) {
          let part: ReadableStreamReadResult<Uint8Array>
          try { part = await reader.read() }
          catch (error) {
            if (error instanceof ClientError) throw error
            throw clientCreateError('NETWORK_ERROR', RuntimeMessage.REAL_TIME_CONNECTION_FAILED, true)
          }
          if (part.done) break
          touch()
          let text: string
          try { text = decoder.decode(part.value, { stream: true }) }
          catch { throw clientCreateError('INVALID_STREAM', RuntimeMessage.REAL_TIME_STREAM_IS_NOT_VALID_UTF_8) }
          consume(text)
        }
        let tail: string
        try { tail = decoder.decode() }
        catch { throw clientCreateError('INVALID_STREAM', RuntimeMessage.REAL_TIME_STREAM_ENDED_INSIDE_UTF_8_TEXT) }
        consume(tail)
        if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
        if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
        if (timedOut) throw clientCreateError('STREAM_TIMEOUT', RuntimeMessage.REAL_TIME_CONNECTION_STOPPED_RESPONDING, true)
        throw clientCreateError('STREAM_ENDED', RuntimeMessage.REAL_TIME_CONNECTION_ENDED_RECONNECT_FOR_A_FRESH_SNAPSHOT, true)
      } catch (error) {
        if (lifetime.signal.aborted) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
        if (signal?.aborted) throw clientCreateError('REQUEST_ABORTED', RuntimeMessage.REQUEST_WAS_CANCELLED)
        if (timedOut) throw clientCreateError('STREAM_TIMEOUT', RuntimeMessage.REAL_TIME_CONNECTION_STOPPED_RESPONDING, true)
        throw error
      } finally {
        clearTimeout(timer); controller.abort()
        await reader?.cancel().catch(() => {
          // 忽略结束订阅时的读取器清理错误，保留订阅本身的结束或失败原因。
        }); reader?.releaseLock()
        controller.signal.removeEventListener('abort', cancelReader)
        lifetime.signal.removeEventListener('abort', abort); signal?.removeEventListener('abort', abort)
      }
    },
    /**
     * 验证公开查询方法，发送查询并返回已校验的业务数据。
     *
     * @param method 公开查询方法名，执行前检查其属于客户端白名单。
     * @param params 与该查询方法对应的业务参数，作为请求 JSON 传递。
     * @param signal 可选查询取消信号，交给统一请求包装器。
     */
    async read<K extends keyof QueryInputMap>(
      /* 本次查询的方法，必须属于公共客户端目录。 */ method: K,
      /* 与公开方法对应的业务参数，同时用来绑定预览响应身份。 */ params: QueryInputMap[K],
      /* 调用者拥有的可选取消信号。 */ signal?: AbortSignal,
    ): Promise<QueryOutputMap[K]> {
      // 发送固定端点查询并验证响应；发布预览额外核对原审核身份和版本。
      if (!(CLIENT_QUERY_METHODS as readonly string[]).includes(method)) throw clientCreateError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_QUERY)
      const result = await clientSendRequest<QueryOutputMap[K]>('/api/v1/query', method, { method, params }, undefined, signal)
      return result.data
    },
    /**
     * 验证公开命令和稳定请求标识，提交命令并返回包含重放标记的完整响应。
     *
     * @param requestId 非空且跨重试稳定的写入请求编号，用于服务端收据判重。
     * @param method 公开写命令名，提交前检查白名单。
     * @param params 该命令的业务参数，重试相同编号时应保持内容不变。
     * @param signal 可选写入取消信号，取消本地等待不证明服务端未提交。
     */
    dispatch<K extends keyof CommandInputMap>(requestId: string, method: K, params: CommandInputMap[K], signal?: AbortSignal): Promise<GraphSuccess<CommandOutputMap[K]>> {
      if (!(CLIENT_COMMAND_METHODS as readonly string[]).includes(method)) return Promise.reject(clientCreateError('UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_PUBLIC_COMMAND))
      if (typeof requestId !== 'string' || !requestId) return Promise.reject(clientCreateError('INVALID_REQUEST_ID', RuntimeMessage.COMMAND_NEEDS_A_STABLE_REQUEST_ID))
      return clientSendRequest('/api/v1/command', method, { requestId, method, params }, requestId, signal)
    },
    /**
     * 校验并复制待上传文件，以稳定请求标识上传内容，并核对返回资产是否对应原文件。
     *
     * @param requestId 文件上传的 UUID 幂等编号，重复上传同一内容时沿用。
     * @param input 待上传元信息与字节；验证后立即复制内容以固定本次请求。
     * @param signal 可选上传取消信号，由调用方负责触发。
     */
    async upload(requestId: string, input: ClientUploadInput, signal?: AbortSignal): Promise<GraphSuccess<Asset>> {
      clientAssertUpload(requestId, input)
      const bytes = new Uint8Array(input.bytes), workspaceId = input.workspaceId, filename = input.filename.trim(), mediaType = input.mediaType.trim()
      return clientRunRequest(async signal => {
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
    /**
     * 下载资产或图与工作区导出内容，限制大小、验证资产摘要，并返回经校验的文件名和字节。
     *
     * @param input 已选择的资源类型和 UUID，决定固定下载端点。
     * @param signal 可选下载取消信号，交给统一文件请求生命周期。
     */
    async download(input: ClientDownloadInput, signal?: AbortSignal): Promise<ClientFile> {
      clientAssertDownload(input)
      const { kind, id } = input
      return clientRunRequest(async signal => {
        // 读取所选下载端点，校验资产完整性并解析响应中的文件名和媒体类型。
        const path = kind === 'asset' ? '/api/v1/assets/' + id + '/content'
          : '/api/v1/' + (kind === 'map' ? 'maps/' : 'workspaces/') + id + '/export'
        const response = await fetcher(new URL(path, baseUrl), { method: 'GET', credentials: 'omit', redirect: 'error', signal,
          headers: { authorization: 'Bearer ' + token } })
        if (!response.ok) await clientReadReply(response, 'asset.get')
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
  // 恢复地址及可用刷新凭据；不存在或可容忍的损坏返回 null，其他读取故障可拒绝。
  load(): Promise<{ baseUrl: string; refreshToken: string | null; remembered: boolean } | null>
  /**
   * 保存连接选项并返回是否实际记住令牌，调用方不能仅依据 remember 输入判断。
   *
   * @param input 需要持久化的地址、令牌和记住意愿，实际是否记住由存储能力决定。
   */
  save(input: { baseUrl: string; refreshToken?: string; remember: boolean }): Promise<boolean>
  // 清除持久化连接配置，供登出和新连接验证前调用。
  clear(): Promise<void>
  // 报告当前环境是否允许安全记住令牌。
  canRemember(): boolean
}
// 可切换连接网关配置，可选系统凭据存储供桌面环境使用。
export interface ClientGatewayOptions { baseUrl: string; timeoutMs?: number; streamIdleMs?: number; fetch?: typeof globalThis.fetch; store?: ClientConnectionStore }
/**
 * 管理当前与待登录的客户端、连接代次和凭据存储队列，使切换登录与退出按顺序完成。
 *
 * @param options 网关初始地址、传输期限和可选凭据存储；凭据未接存储时仅保留在内存。
 */
export function clientCreateGateway(options: ClientGatewayOptions): ClientGateway & { // 永久关闭网关并取消活动与候选连接，已保存的凭据由 disconnect 单独清除。
  close(): void } {
  let baseUrl = clientReadBaseUrl(options.baseUrl)
  let active: ClientApi | null = null
  let pending: ClientApi | null = null
  let remembered = false
  interface AccountState { baseUrl: string; refreshToken: string; session: AuthSession | null; remembered: boolean; refreshing?: Promise<void> }
  let accountState: AccountState | null = null
  let accountAttempt = 0
  const accountLifetime = new AbortController()
  // 每次登录、退出和关闭都会推进代次，阻止迟到的验证结果重新激活旧连接。
  let generation = 0
  let closed = false
  let tail: Promise<unknown> = Promise.resolve()
  const initialized = (async () => {
    // 恢复已保存的服务地址和令牌，但不覆盖恢复期间已发生的登录或退出操作。
    const saved = await options.store?.load()
    if (!saved || generation !== 0) return
    baseUrl = clientReadBaseUrl(saved.baseUrl)
    if (saved.refreshToken) accountState = { baseUrl, refreshToken: saved.refreshToken, session: null, remembered: saved.remembered }
    remembered = !!saved.refreshToken && saved.remembered
  })()
  /**
   * 将登录和凭据写入串行排队，单次失败继续传给调用者，同时允许后续操作执行。
   *
   * @param operation 要按序执行的登录或凭据变更；成功失败均不阻塞后续排队任务。
   */
  function clientEnqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = tail.then(operation, operation)
    tail = result.then(() => /* 在前一项操作成功后释放队列尾部，不把其结果传给下一项操作。 */ undefined, () => /* 吸收队列尾部的拒绝，使后续登录或清理仍可执行；原调用者仍持有失败结果。 */ undefined)
    return result
  }
  async function clientReadApi(): Promise<ClientApi> {
    // 等待凭据恢复完成，确认网关仍开放且存在已配置客户端，再交给请求使用。
    await initialized
    if (accountState) await clientRefreshAccount(accountState)
    if (closed || !active) throw clientCreateError('NOT_CONNECTED', RuntimeMessage.CONNECT_TO_THE_SERVICE_FIRST)
    return active
  }
  async function clientSendAccount(
    /* 认证请求明确选择的同一服务源。 */ origin: string,
    /* 受支持的固定认证动作，不接受任意路径。 */ action: string,
    /* 已按方法选定的认证字段，不含baseUrl。 */ body: object,
    /* 只有当前账户改密携带访问授权。 */ accessToken?: string,
  ): Promise<unknown> {
    // 认证独立发送一次，永不重放失败的登录、轮换或业务写入。
    if (closed) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
    const controller = new AbortController()
    const abort = (): void => { /* 网关关闭时终止自身认证请求。 */ controller.abort() }
    accountLifetime.signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { /* 认证等待沿用普通请求期限。 */ controller.abort() }, options.timeoutMs ?? 15_000)
    try {
      const response = await (options.fetch ?? globalThis.fetch)(new URL(`/api/v1/auth/${action}`, origin), {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify(body),
      })
      const value = await clientReadJson(response)
      if (closed) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
      if (!response.ok || !clientIsObject(value) || value.ok !== true) {
        const error = clientIsObject(value) && clientIsObject(value.error) ? value.error : {}
        throw new ClientError({ status: response.status, code: typeof error.code === 'string' ? error.code : 'HTTP_ERROR',
          message: typeof error.message === 'string' ? error.message : RuntimeMessage.SERVICE_REQUEST_FAILED,
          retryable: typeof error.retryable === 'boolean' ? error.retryable : response.status >= 500 || response.status === 429,
          errorId: typeof error.errorId === 'string' && /^[0-9a-f-]{36}$/i.test(error.errorId) ? error.errorId : undefined })
      }
      if (!Object.prototype.hasOwnProperty.call(value, 'data')) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON)
      return value.data
    } catch (error) {
      if (error instanceof ClientError) throw error
      if (closed) throw clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED)
      throw clientCreateError(controller.signal.aborted ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR', RuntimeMessage.SERVICE_REQUEST_FAILED, true)
    } finally {
      clearTimeout(timer)
      accountLifetime.signal.removeEventListener('abort', abort)
    }
  }
  function clientReadAccountSession(/* 尚未验证的认证成功数据。 */ value: unknown): AuthSession {
    // 只接纳完整的短期访问凭据和可轮换刷新凭据，不从JWT或未知字段猜测身份。
    if (!clientIsObject(value) || !clientIsObject(value.identity) || typeof value.identity.userId !== 'string'
      || !value.identity.userId || typeof value.identity.displayName !== 'string' || typeof value.identity.hostAdmin !== 'boolean'
      || typeof value.accessToken !== 'string' || !value.accessToken || /[^\x21-\x7e]/.test(value.accessToken)
      || typeof value.refreshToken !== 'string' || !value.refreshToken || /[^\x21-\x7e]/.test(value.refreshToken)
      || typeof value.accessExpiresAt !== 'string' || !(Date.parse(value.accessExpiresAt) > Date.now())
      || typeof value.refreshExpiresAt !== 'string' || !(Date.parse(value.refreshExpiresAt) > Date.now())) {
      throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON)
    }
    return { identity: { userId: value.identity.userId, displayName: value.identity.displayName, hostAdmin: value.identity.hostAdmin },
      accessToken: value.accessToken, accessExpiresAt: value.accessExpiresAt, refreshToken: value.refreshToken, refreshExpiresAt: value.refreshExpiresAt }
  }
  function clientCreateAccountApi(/* 当前激活或待验证的独立账户状态。 */ state: AccountState): ClientApi {
    // 只动态替换账户API的授权头；原业务客户端的取消、文件、事件和写入语义保持。
    return clientCreateApi({ ...options, baseUrl: state.baseUrl, token: state.session?.accessToken ?? '',
      fetch: (/* 原客户端发送的固定地址。 */ input, /* 原客户端拥有的完整请求选项。 */ init) => {
        const headers = new Headers(init?.headers)
        headers.set('authorization', `Bearer ${state.session?.accessToken ?? ''}`)
        return (options.fetch ?? globalThis.fetch)(input, { ...init, headers })
      } })
  }
  function clientAssertAccountCurrent(/* 正在轮换的原账户对象。 */ state: AccountState, /* 启动时活动连接代次。 */ epoch: number): void {
    // 退出、手工连接或成功切换账户后，旧刷新不再拥有当前连接。
    if (closed || generation !== epoch || accountState !== state) throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
  }
  async function clientSaveAccount(
    /* 本次实际轮换后的账户对象。 */ state: AccountState,
    /* 开始该账户动作时的活动连接代次。 */ epoch: number,
    /* 本次动作的安全记住意愿。 */ remember: boolean,
  ): Promise<void> {
    // 刷新、改密和退出共用同一凭据写队列，迟到保存不能落在退出清理之后。
    await clientEnqueueOperation(async () => {
      clientAssertAccountCurrent(state, epoch)
      const saved = await options.store?.save({ baseUrl: state.baseUrl, refreshToken: state.refreshToken, remember }) ?? false
      clientAssertAccountCurrent(state, epoch)
      state.remembered = saved
      remembered = saved
    })
  }
  async function clientRefreshAccount(/* 需要在请求前核对期限的账户状态。 */ state: AccountState): Promise<void> {
    // 到期前30秒只合并一次轮换；失败不会自动重发原业务调用。
    if (state.session && Date.parse(state.session.accessExpiresAt) - Date.now() > 30_000) return
    if (state.refreshing) return state.refreshing
    const epoch = generation
    state.refreshing = (async (): Promise<void> => {
      try {
        const session = clientReadAccountSession(await clientSendAccount(state.baseUrl, 'refresh', { refreshToken: state.refreshToken }))
        clientAssertAccountCurrent(state, epoch)
        if (state.session && state.session.identity.userId !== session.identity.userId) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON)
        state.session = session
        state.refreshToken = session.refreshToken
        if (!active) active = clientCreateAccountApi(state)
        await clientSaveAccount(state, epoch, state.remembered)
      } finally { state.refreshing = undefined }
    })()
    return state.refreshing
  }
  async function clientActivateAccount(
    /* 页面本次明确提交的目标服务。 */ origin: string,
    /* 账户登录或验证后的已解析会话。 */ session: AuthSession,
    /* 用户本次安全记住意愿。 */ remember: boolean,
    /* 本次认证开始时的意图代次。 */ attempt: number,
  ): Promise<AppBootstrap> {
    // 先验证候选账户与bootstrap；全部成功后才替换仍有效的旧连接。
    if (closed || attempt !== accountAttempt) throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
    const state: AccountState = { baseUrl: origin, refreshToken: session.refreshToken, session, remembered: false }
    const candidate = clientCreateAccountApi(state)
    let activated = false
    try {
      const bootstrap = await candidate.read('app.bootstrap', {})
      if (bootstrap.identity.userId !== session.identity.userId) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON)
      await clientEnqueueOperation(async () => {
        // 较晚完成的旧认证不能覆盖后一次登录或已退出的连接。
        if (closed || attempt !== accountAttempt) throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
        const saved = await options.store?.save({ baseUrl: origin, refreshToken: session.refreshToken, remember }) ?? false
        if (closed || attempt !== accountAttempt) {
          await options.store?.save({ baseUrl, ...(accountState ? { refreshToken: accountState.refreshToken } : {}), remember: remembered })
          throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
        }
        active?.close()
        active = candidate
        baseUrl = origin
        accountState = state
        state.remembered = saved
        remembered = saved
        generation += 1
        activated = true
      })
      return bootstrap
    } finally { if (!activated) candidate.close() }
  }
  async function clientAccountMessage(/* 目标固定服务源。 */ origin: string, /* 固定账户动作。 */ action: string, /* 本动作公开输入。 */ body: object): Promise<AuthMessage> {
    // 辅助账户动作不切换当前连接，也不携带当前账户的刷新凭据。
    const data = await clientSendAccount(clientReadBaseUrl(origin), action, body)
    if (!clientIsObject(data) || typeof data.message !== 'string') throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON)
    return { message: data.message }
  }
  function clientDisconnect(
    /* 旧退出清理时保留用户随后发起、尚未完成的新账户登录意图。 */ preserveAccountAttempt = false,
  ): Promise<void> {
    // 立即失效当前和待登录代次，再按原串行凭据队列清理本机状态。
    generation += 1
    if (!preserveAccountAttempt) accountAttempt += 1
    pending?.close()
    active?.close()
    active = null
    accountState = null
    remembered = false
    return clientEnqueueOperation(async () => { /* 恢复读取结束后才能清理其结果。 */ await initialized; await options.store?.clear() })
  }
  const account: ClientAccountGateway = {
    async registerUsername(/* 无邮件注册成功后接纳服务器原子创建的账户会话。 */ { baseUrl: origin, ...body }): Promise<AppBootstrap> {
      const attempt = ++accountAttempt
      await initialized
      const target = clientReadBaseUrl(origin)
      const session = clientReadAccountSession(await clientSendAccount(target, 'register-username', body))
      return clientActivateAccount(target, session, body.remember, attempt)
    },
    async loginUsername(/* 用户名密码登录沿用原连接激活和迟到响应边界。 */ { baseUrl: origin, ...body }): Promise<AppBootstrap> {
      const attempt = ++accountAttempt
      await initialized
      const target = clientReadBaseUrl(origin)
      const session = clientReadAccountSession(await clientSendAccount(target, 'login-username', body))
      return clientActivateAccount(target, session, body.remember, attempt)
    },
    register: (/* 只用于目标服务注册的公开输入。 */ { baseUrl: origin, ...body }) => clientAccountMessage(origin, 'register', body),
    resendVerification: (/* 不切换已有连接的邮箱重发输入。 */ { baseUrl: origin, ...body }) => clientAccountMessage(origin, 'resend-verification', body),
    forgotPassword: (/* 不透露邮箱是否存在的重置申请。 */ { baseUrl: origin, ...body }) => clientAccountMessage(origin, 'forgot-password', body),
    resetPassword: (/* 目标邮箱验证码和新密码，只交付目标服务。 */ { baseUrl: origin, ...body }) => clientAccountMessage(origin, 'reset-password', body),
    async login(/* 带明确服务源的登录输入。 */ { baseUrl: origin, ...body }): Promise<AppBootstrap> {
      const attempt = ++accountAttempt
      await initialized
      const target = clientReadBaseUrl(origin)
      const session = clientReadAccountSession(await clientSendAccount(target, 'login', body))
      return clientActivateAccount(target, session, body.remember, attempt)
    },
    async verifyEmail(/* 带明确服务源的邮箱验证输入。 */ { baseUrl: origin, ...body }): Promise<AppBootstrap> {
      const attempt = ++accountAttempt
      await initialized
      const target = clientReadBaseUrl(origin)
      const session = clientReadAccountSession(await clientSendAccount(target, 'verify-email', body))
      return clientActivateAccount(target, session, body.remember, attempt)
    },
    async changePassword(/* 只作用于当前已认证账户的密码变更。 */ body): Promise<AppBootstrap> {
      await initialized
      const state = accountState
      if (!state) throw clientCreateError('ACCOUNT_UNAVAILABLE', RuntimeMessage.CONNECT_TO_THE_SERVICE_FIRST)
      await clientRefreshAccount(state)
      const epoch = generation
      const session = clientReadAccountSession(await clientSendAccount(state.baseUrl, 'change-password', body, state.session?.accessToken))
      clientAssertAccountCurrent(state, epoch)
      if (session.identity.userId !== state.session?.identity.userId) throw clientCreateError('INVALID_RESPONSE', RuntimeMessage.SERVICE_RETURNED_INVALID_JSON)
      state.session = session
      state.refreshToken = session.refreshToken
      await clientSaveAccount(state, epoch, body.remember)
      return (await clientReadApi()).read('app.bootstrap', {})
    },
    async logout(): Promise<void> {
      // 正式接口以当前有效access撤销账户会话；手工共享令牌只断开本机。
      await initialized
      const state = accountState
      const epoch = generation
      const attempt = accountAttempt
      try {
        if (state) {
          await clientRefreshAccount(state)
          await clientSendAccount(state.baseUrl, 'logout', {}, state.session?.accessToken)
        }
      } finally {
        // 旧服务的退出响应不清理新连接；随后发起的新登录也保留其独立意图代次。
        if (generation === epoch && accountState === state) await clientDisconnect(accountAttempt !== attempt)
      }
    },
  }
  return {
    account,
    /**
     * 取得当前客户端并直接启动订阅，避免长期事件流阻塞登录和退出队列。
     *
     * @param mapId 需要订阅的图编号，交给当前固定凭据客户端验证。
     * @param onEvent 调用方的事件观察者，直接转交当前客户端。
     * @param signal 可选调用者取消信号，不进入登录串行队列。
     */
    async watch(mapId, onEvent, signal) {
      return (await clientReadApi()).watch(mapId, onEvent, signal)
    },
    async getConnection(): Promise<ClientConnection> {
      // 等待连接恢复完成后返回服务地址、配置状态和凭据记忆能力。
      await initialized
      return { baseUrl, configured: active !== null || accountState !== null, remembered, canRemember: options.store?.canRemember() ?? false,
        ...(accountState ? { account: true } : {}) }
    },
    /**
     * 立即使旧连接和待登录结果失效，再串行验证新凭据、保存连接选项并激活新客户端。
     *
     * @param input 用户选择的新服务地址、令牌与记住开关，先使旧连接失效再验证候选连接。
     */
    connect(input: ClientConnectInput): Promise<AppBootstrap> {
      if (closed) return Promise.reject(clientCreateError('DISCONNECTED', RuntimeMessage.CONNECTION_WAS_CLOSED))
      const version = ++generation
      accountAttempt += 1
      accountState = null
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
          await options.store?.save({ baseUrl: url, remember: false })
          if (version !== generation) throw clientCreateError('CONNECTION_CHANGED', RuntimeMessage.CONNECTION_REQUEST_WAS_SUPERSEDED)
          active = candidate; pending = null; baseUrl = url; remembered = false
          return bootstrap
        } catch (error) { candidate.close(); if (pending === candidate) pending = null; throw error }
      })
    },
    disconnect(): Promise<void> {
      // 立即取消当前及待登录客户端，再将持久化凭据清除排入连接操作队列。
      return clientDisconnect()
    },
    /**
     * 取得当前客户端后转发查询及调用者取消信号。
     *
     * @param method 待转发的公共查询方法。
     * @param params 查询方法对应的业务参数，原样交给活动客户端。
     * @param signal 调用方可选的读取取消信号。
     */
    async read(method, params, signal) {
      return (await clientReadApi()).read(method, params, signal)
    },
    /**
     * 取得当前客户端后转发命令，保留调用者提供的请求标识和取消信号。
     *
     * @param requestId 调用方提供的稳定业务幂等编号。
     * @param method 待转发的公共写命令。
     * @param params 写命令对应参数，交给活动客户端提交。
     * @param signal 调用方可选的写请求取消信号。
     */
    async dispatch(requestId, method, params, signal) {
      return (await clientReadApi()).dispatch(requestId, method, params, signal)
    },
    /**
     * 取得当前客户端后转发文件上传及其幂等请求标识。
     *
     * @param requestId 上传操作的稳定业务幂等编号。
     * @param input 含工作区及文件内容的上传输入，交给活动客户端验证并复制。
     * @param signal 调用方可选的上传取消信号。
     */
    async upload(requestId, input, signal) {
      return (await clientReadApi()).upload(requestId, input, signal)
    },
    /**
     * 取得当前客户端后转发文件下载及调用者取消信号。
     *
     * @param input 含资源类型与编号的下载目标。
     * @param signal 调用方可选的下载取消信号。
     */
    async download(input, signal) {
      return (await clientReadApi()).download(input, signal)
    },
    close(): void {
      // 永久关闭网关并中断当前和待登录客户端，使未完成登录失效，同时保留已保存的连接配置。
      closed = true; generation++; accountAttempt += 1; accountLifetime.abort(); accountState = null
      pending?.close(); active?.close(); active = null
    },
  }
}
