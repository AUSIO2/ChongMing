// 管理资产上传、读取、引用和删除，并以授权事务导入导出含附件的数据包。
import { RuntimeMessage } from '../../../contracts/messages'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Persistence, StorageSession } from '../../ports/persistence'
import type { AgentProfile, Asset, ControlCommand, ControlQuery, DefinitionView, ImportResult, MapBundle, Page, WorkspaceBundle } from '../../../contracts/control'
import type { DefinitionCatalog, SourceLocatorValue } from '../../../contracts/data-definition'
import type { GraphNode, GraphNodeInput, GraphPayload } from '../../../contracts/graph'
import type { AuthService, RequestContext } from '../identity/identity-service'
import type { ControlService } from '../workspace/workspace-service'
import { ASSET_BYTE_LIMIT, BUNDLE_BYTE_LIMIT, bundlesAssertSize, bundlesConvertV3, bundlesCreateImport, bundlesReadAgents, bundlesReadDefinitionClosure, bundlesReadMapDocument, bundlesReadWorkspace } from './bundle-codec'
import { GraphError } from '../shared/domain-error'
import { SOURCE_MEDIA_TYPES, type SourceReader } from '../../ports/source-reader'
import { inputReadId, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../graph/graph-record'
import { definitionsReadPayloadReferences } from '../shared/data-definition'

export interface AssetUploadInput {
  workspaceId: string; filename: string; mediaType: string; size: number; sha256: string; requestId: string
}

/**
 * source-text 只允许读取确定字段；通配引用由定义 helper 负责展开。
 *
 * @param payload 通用数据 payload。
 * @param pointer 定义中已验证的确定 JSON Pointer。
 */
function assetsReadPointer(payload: GraphPayload, pointer: string): unknown {
  let value: unknown = payload
  for (const part of pointer.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/**
 * 读取器只接受现有受限 asset/url 定位结构；普通 uri 字段不会自动触发网络访问。
 *
 * @param value 注册类型中 source-text 绑定指向的未知字段。
 */
function assetsReadLocator(value: unknown): SourceLocatorValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GraphError(422, 'INVALID_SOURCE', RuntimeMessage.EXPECTED_A_SOURCE_NODE)
  const locator = value as Record<string, unknown>
  if (locator.kind === 'asset' && typeof locator.assetId === 'string' && typeof locator.mediaType === 'string') {
    return { kind: 'asset', assetId: locator.assetId, mediaType: locator.mediaType }
  }
  if (locator.kind === 'url' && typeof locator.url === 'string') return { kind: 'url', url: locator.url }
  throw new GraphError(422, 'INVALID_SOURCE', RuntimeMessage.EXPECTED_A_SOURCE_NODE)
}
type DeleteCommand = Extract<ControlCommand, { method: 'asset.delete' }>
type ImportCommand = Extract<ControlCommand, { method: 'workspace.import' }>
interface AssetDocument extends Omit<Asset, 'id'> {
  _id: string; blobId: string; state: 'ready' | 'deleted'
  uploadKey?: string; inputHash?: string; deletedAt?: string
}
interface AssetReceipt {
  _id: string; userId: string; hash: string; workspaceId: string
  data: ImportResult | { assetId: string; deleted: true }
}
/**
 * 将声明的 SHA-256 转为小写并验证 64 位十六进制格式。
 *
 * @param value 尚未验证格式的 SHA-256 摘要输入。
 */
function assetsReadHash(value: unknown): string {
  const hash = inputReadString(value, 'sha256').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.SHA256_MUST_CONTAIN_64_HEX_DIGITS)
  return hash
}
/**
 * 校验附件显示文件名、媒体类型、长度和摘要，拒绝路径字符及超限上传。
 *
 * @param input 除工作区和请求身份外、需要校验的上传元数据。
 */
function assetsReadMetadata(input: Omit<AssetUploadInput, 'workspaceId' | 'requestId'>) {
  const filename = inputReadString(input.filename, 'filename').trim()
  if (Buffer.byteLength(filename) > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.FILENAME_MUST_BE_A_SINGLE_SAFE_DISPLAY_NAME)
  const mediaType = inputReadString(input.mediaType, 'mediaType').trim()
  if (mediaType.length > 255 || /[\x00-\x1f\x7f]/.test(mediaType) || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]*)?$/.test(mediaType)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_MEDIATYPE)
  const size = inputReadRevision(input.size, 'size')
  if (size > ASSET_BYTE_LIMIT) throw new GraphError(413, 'ASSET_LIMIT', RuntimeMessage.ASSET_EXCEEDS_64_MIB)
  return { filename, mediaType, size, sha256: assetsReadHash(input.sha256) }
}
/**
 * 解析资产删除或工作区导入命令，要求稳定请求身份和各自的前置条件。
 *
 * @param value 来自公共命令边界、尚未解析的资产删除或工作区导入命令。
 */
export function assetsReadCommand(value: unknown): DeleteCommand | ImportCommand {
  const command = inputReadObject(value, ['requestId', 'method', 'params'], 'command')
  const requestId = inputReadId(command.requestId, 'requestId')
  if (command.method === 'asset.delete') {
    const item = inputReadObject(command.params, ['assetId', 'expectedSha256'], 'params')
    return { requestId, method: 'asset.delete', params: { assetId: inputReadId(item.assetId, 'assetId'), expectedSha256: assetsReadHash(item.expectedSha256) } }
  }
  if (command.method === 'workspace.import') {
    const item = inputReadObject(command.params, ['id', 'bundleAssetId', 'stagingWorkspaceId', 'name'], 'params')
    return { requestId, method: 'workspace.import', params: {
      id: inputReadId(item.id, 'id'), bundleAssetId: inputReadId(item.bundleAssetId, 'bundleAssetId'),
      stagingWorkspaceId: inputReadId(item.stagingWorkspaceId, 'stagingWorkspaceId'),
      name: item.name === null ? null : inputReadString(item.name, 'name').trim(),
    } }
  }
  throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_ASSET_OR_BUNDLE_COMMAND)
}
/**
 * 从资产记录投影公开元数据，隐藏存储路径、删除状态和上传幂等字段。
 *
 * @param document 包含内部存储身份和状态、准备投影为公开 Asset 的记录。
 */
function assetsReadView(document: AssetDocument): Asset {
  return { id: document._id, workspaceId: document.workspaceId, filename: document.filename, mediaType: document.mediaType,
    size: document.size, sha256: document.sha256, createdAt: document.createdAt }
}
/**
 * 仅将明确的 4xx 业务错误视作可清理未发布附件的回滚结果。
 *
 * @param error 需要判断事务是否明确回滚、从而允许清理附件的失败原因。
 */
function assetsIsRollback(error: unknown): boolean {
  return error instanceof GraphError && error.status >= 400 && error.status < 500
}
/**
 * 逐块统计长度和摘要并传递字节，流结束后核对声明值，防止伪造上传元数据。
 *
 * @param source 调用方提供且由本迭代器负责消费的上传或保存字节流。
 * @param expected 字节流必须精确匹配的声明长度和 SHA-256。
 */
async function* assetsReadChunks(source: AsyncIterable<Uint8Array>, expected: { size: number; sha256: string }) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > ASSET_BYTE_LIMIT || size > expected.size) throw new GraphError(413, 'ASSET_LIMIT', RuntimeMessage.UPLOAD_EXCEEDS_ITS_DECLARED_LENGTH_OR_64_MIB)
    hash.update(bytes)
    yield bytes
  }
  if (size !== expected.size) throw new GraphError(422, 'ASSET_INTEGRITY', RuntimeMessage.UPLOAD_LENGTH_DOES_NOT_MATCH)
  if (hash.digest('hex') !== expected.sha256) throw new GraphError(422, 'ASSET_INTEGRITY', RuntimeMessage.UPLOAD_SHA_256_DOES_NOT_MATCH)
}

/**
 * 组装资产元数据、不可变字节和收据访问，将授权事务与慢文件读取分开处理。
 *
 * @param database 提供资产元数据、图查询、事务和不可变附件的持久化入口。
 * @param auth 用于验证用户令牌并建立授权事务的身份服务。
 * @param control 用于检查工作区角色和创建导入工作区的管理服务。
 * @param options 私有来源访问开关和外部 URL 正文读取器。
 */
export function assetsCreateService(database: Persistence, auth: AuthService, control: ControlService, options: { allowPrivateSources?: boolean; readUrl: SourceReader }) {
  const blobs = database.blobs
  const metadata = database.records<AssetDocument>('control_assets')
  const receipts = database.records<AssetReceipt>('asset_receipts')
  const graphs = database.records<{ _id: string; workspaceId: string; deletedAt?: unknown; nodes: GraphNode[] }>(GRAPH_COLLECTION)

  /**
   * 在请求会话中读取可用资产，并要求调用者能查看其所属工作区。
   *
   * @param ctx 已经解析身份并携带可选存储会话的请求上下文。
   * @param assetId 需要读取、鉴权且必须处于 ready 状态的资产身份。
   */
  async function assetsReadDocument(ctx: RequestContext, assetId: string): Promise<AssetDocument> {
    inputReadId(assetId, 'assetId')
    const document = await metadata.get(assetId, ctx.session)
    if (!document) throw new GraphError(404, 'ASSET_NOT_FOUND', RuntimeMessage.ASSET_IS_NOT_AVAILABLE)
    await control.requireRole(ctx, document.workspaceId, 'viewer')
    if (document.state !== 'ready') throw new GraphError(404, 'ASSET_NOT_FOUND', RuntimeMessage.ASSET_IS_NOT_AVAILABLE)
    return document
  }
  /**
   * 将经长度和摘要校验的字节流交给附件存储，不在此步骤发布业务元数据。
   *
   * @param source 需要验证后写入附件存储的字节流。
   * @param meta 文件名、声明长度和摘要校验基准。
   */
  async function assetsWriteBlob(source: AsyncIterable<Uint8Array>, meta: { filename: string; size: number; sha256: string }): Promise<string> {
    return blobs.write(assetsReadChunks(source, meta), meta.filename)
  }

  /**
   * 读取完整附件并复核保存的长度与摘要，返回已验证字节。
   *
   * @param document 包含 blobId 和完整性元数据的 ready 资产记录。
   */
  async function assetsReadBytes(document: AssetDocument): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of assetsReadChunks(blobs.read(document.blobId), document)) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  /**
   * 按用户作用域内的键读取资产操作收据，拒绝同键不同输入。
   *
   * @param ctx 限定用户、权限和可选事务快照的请求上下文。
   * @param key 由用户、操作作用域和请求身份生成的收据主键。
   * @param hash 当前操作输入的稳定摘要。
   */
  async function assetsReadReceipt(ctx: RequestContext, key: string, hash: string): Promise<AssetReceipt | null> {
    const prior = await receipts.get(key, ctx.session)
    if (prior && prior.hash !== hash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_HAS_DIFFERENT_INPUT)
    return prior
  }
  /**
   * 要求资产写入沿用已授权的活动事务，避免脱离身份校验单独提交。
   *
   * @param ctx 必须代表已授权写事务的请求上下文。
   */
  function assetsRequireTransaction(ctx: RequestContext): void {
    if (!ctx.mutation || !ctx.session?.inTransaction()) throw new Error(RuntimeMessage.ASSET_MUTATION_REQUIRES_THE_AUTHENTICATED_TRANSACTION)
  }
  /**
   * 沿用已有会话或临时建立事务，使导出所读元数据来自同一快照。
   *
   * @param ctx 调用导出操作时已有的只读或事务请求上下文。
   * @param callback 需要在一致元数据快照中执行的导出读取回调。
   */
  async function assetsReadSnapshot<T>(ctx: RequestContext, callback: (context: RequestContext) => Promise<T>): Promise<T> {
    if (ctx.session) return callback(ctx)
    return database.transaction(session => /* 将新建存储会话传给只读导出回调，不把它标记为授权写事务。 */ callback({ ...ctx, session, mutation: false }))
  }

  /**
   * 按类型声明去重收集附件引用，检查附件仍可用且属于同一工作区。
   *
   * @param ctx 用于读取附件元数据的一致请求快照。
   * @param workspaceId 所有节点和附件必须归属的工作区身份。
   * @param nodes 需要收集并校验附件定位器的导出节点。
   */
  async function assetsReadBundleFiles(ctx: RequestContext, workspaceId: string, nodes: GraphNode[]): Promise<AssetDocument[]> {
    const definitions = await control.definitions(ctx, workspaceId)
    const references = assetsCollectNodeAssetReferences(definitions, nodes)
    const ids = [...new Set(references.map(reference => reference.id))]
    const rows = ids.length ? await metadata.list({ _id: ids, workspaceId, state: 'ready' }, ctx.session) : []
    if (rows.length !== ids.length || references.some(reference => reference.expectedMediaType !== undefined
      && rows.find(asset => asset._id === reference.id)?.mediaType !== reference.expectedMediaType)) {
      throw new GraphError(422, 'ASSET_REFERENCE', RuntimeMessage.A_REFERENCED_ASSET_IS_NOT_AVAILABLE)
    }
    return rows
  }
  /**
   * 读取目录、不可变包体和历史 Agent 快照，只带出实际节点类型可达的完整依赖闭包。
   *
   * @param ctx 导出一致快照的授权上下文。
   * @param workspaceId 定义所属工作区。
   * @param nodes 决定精确包闭包的节点。
   * @param editableAgents 导出保留的 Agent 配置，其显式绑定也必须纳入闭包。
   */
  async function assetsReadBundleDefinitions(ctx: RequestContext, workspaceId: string, nodes: GraphNode[],
    editableAgents: AgentProfile[]) {
    const catalog = await control.definitions(ctx, workspaceId)
    const agents = await control.definitionAgents(ctx, workspaceId)
    return bundlesReadDefinitionClosure(workspaceId, nodes, catalog, async (id, ref) => await control.read(ctx, {
      method: 'definition.get', params: { workspaceId: id, packageId: ref.id, packageVersion: ref.version },
    }) as DefinitionView, agents, editableAgents)
  }
  /**
   * 使用注册引用声明展开 payload；相邻 mediaType 仅在声明的定位对象确实提供时追加检查。
   *
   * @param definitions 已经发布并完整校验的定义目录。
   * @param nodes 已解析通用信封、准备写入或删除检查的节点。
   */
  function assetsCollectNodeAssetReferences(
    definitions: DefinitionCatalog,
    nodes: Array<Pick<GraphNodeInput, 'typeId' | 'typeVersion' | 'payload'>>,
  ): Array<{ id: string; expectedMediaType?: string }> {
    return nodes.flatMap(node => definitionsReadPayloadReferences(definitions, { id: node.typeId, version: node.typeVersion }, node.payload)
      .filter(item => item.definition.target.kind === 'asset').map(item => {
        const parentPath = item.definition.path.replace(/\/[^/]+$/, '')
        const parent = assetsReadPointer(node.payload, parentPath)
        const expectedMediaType = parent && typeof parent === 'object' && !Array.isArray(parent)
          && typeof (parent as Record<string, unknown>).mediaType === 'string' ? String((parent as Record<string, unknown>).mediaType) : undefined
        return { id: item.value, ...(expectedMediaType ? { expectedMediaType } : {}) }
      }))
  }
  /**
   * @param ctx 读取定义目录所用的授权事务。
   * @param workspaceId 所有引用必须归属的工作区。
   * @param nodes 已解析通用信封、准备写入或删除检查的节点。
   */
  async function assetsReadNodeAssetReferences(
    ctx: RequestContext,
    workspaceId: string,
    nodes: Array<Pick<GraphNodeInput, 'typeId' | 'typeVersion' | 'payload'>>,
  ): Promise<Array<{ id: string; expectedMediaType?: string }>> {
    return assetsCollectNodeAssetReferences(await control.definitions(ctx, workspaceId), nodes)
  }
  /**
   * 先估算包体大小，再读入并附加 Base64 附件，最终复核完整序列化大小。
   *
   * @param bundle 已经构造但尚未附加 Base64 内容的便携数据包。
   * @param files 数据包引用、需要读取并编码内容的资产记录。
   */
  async function assetsAttachBundle<T extends MapBundle | WorkspaceBundle>(bundle: T, files: AssetDocument[]): Promise<T> {
    let estimated = Buffer.byteLength(JSON.stringify(bundle))
    for (const file of files) estimated += Math.ceil(file.size / 3) * 4 + Buffer.byteLength(JSON.stringify(assetsReadView(file))) + 64
    if (estimated > BUNDLE_BYTE_LIMIT) throw new GraphError(413, 'BUNDLE_LIMIT', RuntimeMessage.THE_COMPLETE_BASE64_BUNDLE_EXCEEDS_64_MIB)
    for (const file of files) {
      const bytes = await assetsReadBytes(file)
      bundle.assets.push({ id: file._id, filename: file.filename, mediaType: file.mediaType, size: file.size, sha256: file.sha256, contentBase64: bytes.toString('base64') })
    }
    bundlesAssertSize(bundle)
    return bundle
  }

  return {
    /**
     * 按冻结字段读取受限定位器，校验附件范围、文本类型、大小和 UTF-8；URL 仍走既有网络策略。
     *
     * @param workspaceId 执行授权所属的工作区身份，用于限制资产范围。
     * @param node 已由 Work 输入授权的通用数据节点。
     * @param path 冻结 source-text 绑定指定的定位器字段。
     */
    async readSource(workspaceId: string, node: GraphNode,
      path: string): Promise<string> {
      const locator = assetsReadLocator(assetsReadPointer(node.payload, path))
      let bytes: Buffer
      const supported = SOURCE_MEDIA_TYPES
      if (locator.kind === 'asset') {
        const file = await metadata.get(locator.assetId)
        if (!file || file.workspaceId !== workspaceId || file.state !== 'ready' || file.mediaType !== locator.mediaType) throw new GraphError(404, 'ASSET_NOT_FOUND', RuntimeMessage.SOURCE_ASSET_IS_NOT_AVAILABLE_IN_THIS_WORKSPACE)
        if (!supported.has(file.mediaType.split(';')[0].trim().toLowerCase())) throw new GraphError(422, 'UNSUPPORTED_MEDIA_TYPE', RuntimeMessage.SOURCE_MUST_BE_UTF_8_TEXT_MARKDOWN_HTML_OR_JSON)
        if (file.size > 1_048_576) throw new GraphError(413, 'SOURCE_LIMIT', RuntimeMessage.SOURCE_EXCEEDS_1_MIB)
        bytes = await assetsReadBytes(file)
      } else {
        return options.readUrl(locator.url, options.allowPrivateSources === true)
      }
      try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
      catch { throw new GraphError(422, 'SOURCE_ENCODING', RuntimeMessage.SOURCE_MUST_CONTAIN_VALID_UTF_8) }
    },
    async initialize(): Promise<void> {
      // 建立上传幂等索引、工作区资产查询索引和资产收据索引。
      await Promise.all([
        metadata.index(['uploadKey'], { unique: true, sparse: true }),
        metadata.index(['workspaceId', 'state', 'createdAt', '_id']),
        receipts.index(['userId', 'workspaceId']),
      ])
    },
    /**
     * 校验上传字节并在授权事务中发布资产元数据；同请求重放仍核对字节，确定回滚后才清理私有附件。
     *
     * @param token 发起上传的用户令牌；发布阶段会在事务中再次验证。
     * @param value 包含工作区、请求身份和文件完整性声明的上传输入。
     * @param source 需要完整消费并与声明长度和摘要匹配的上传字节流。
     */
    async upload(token: string, value: AssetUploadInput, source: AsyncIterable<Uint8Array>): Promise<{ data: Asset; replayed: boolean }> {
      const workspaceId = inputReadId(value.workspaceId, 'workspaceId'), requestId = inputReadId(value.requestId, 'requestId')
      const meta = assetsReadMetadata(value)
      const initial = await auth.read(token)
      await control.requireRole(initial, workspaceId, 'editor')
      const uploadKey = storeCreateInputHash({ userId: initial.actor.userId, workspaceId, requestId })
      const inputHash = storeCreateInputHash({ workspaceId, ...meta })
      const prior = (await metadata.list({ uploadKey }))[0]
      if (prior?.inputHash !== undefined && prior.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.UPLOAD_REQUESTID_HAS_DIFFERENT_INPUT)
      if (prior?.state === 'deleted') throw new GraphError(410, 'ASSET_GONE', RuntimeMessage.THE_UPLOADED_ASSET_WAS_DELETED)
      const candidateId = randomUUID()
      let blobId: string | undefined
      if (prior) {
        // 即使重放也校验实际字节，不能让伪造的摘要头绕过长度和完整性检查。
        for await (const _chunk of assetsReadChunks(source, meta)) { /* 消费并校验上传流，不重复保存附件。 */ }
      } else blobId = await assetsWriteBlob(source, meta)
      let result: { data: Asset; replayed: boolean }
      try { result = await auth.transact(token, async ctx => {
        // 发布前重查编辑权限及上传收据，接纳唯一元数据记录或返回并发请求已发布的资产。
        await control.requireRole(ctx, workspaceId, 'editor')
        const existing = (await metadata.list({ uploadKey }, ctx.session))[0]
        if (existing) {
          if (existing.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.UPLOAD_REQUESTID_HAS_DIFFERENT_INPUT)
          if (existing.state !== 'ready') throw new GraphError(410, 'ASSET_GONE', RuntimeMessage.THE_UPLOADED_ASSET_WAS_DELETED)
          return { data: assetsReadView(existing), replayed: true }
        }
        if (!blobId) throw new GraphError(409, 'ASSET_GONE', RuntimeMessage.ORIGINAL_UPLOAD_NO_LONGER_EXISTS)
        const document: AssetDocument = { _id: candidateId, workspaceId, ...meta, blobId, state: 'ready',
          createdAt: new Date().toISOString(), uploadKey, inputHash }
        await metadata.insert(document, ctx.session)
        return { data: assetsReadView(document), replayed: false }
      }) } catch (error) {
        if (blobId && assetsIsRollback(error)) await blobs.remove(blobId).catch(() => {
          // 回滚后的孤立附件清理失败不应覆盖原始上传错误。
          })
        throw error
      }
      if (blobId && result.data.id !== candidateId) await blobs.remove(blobId).catch(() => {
        // 并发重放多写的附件没有业务引用，清理失败不改变已成功的上传结果。
        })
      // 事务结果不确定时保留私有附件，防止删除可能已经被成功发布的资产引用的字节。
      return result
    },
    /**
     * 验证工作区绑定游标后按时间倒序、身份正序分页返回可用资产。
     *
     * @param ctx 限定资产列表权限和存储会话的请求上下文。
     * @param input 已解析的工作区、可选游标和页大小。
     */
    async list(ctx: RequestContext, input: Extract<ControlQuery, { method: 'asset.list' }>['params']): Promise<Page<Asset>> {
      const workspaceId = inputReadId(input.workspaceId, 'workspaceId')
      await control.requireRole(ctx, workspaceId, 'viewer')
      let cursor: { createdAt: string; id: string } | undefined
      if (input.cursor !== undefined) {
        try {
          if (input.cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error(RuntimeMessage.CURSOR)
          const bytes = Buffer.from(input.cursor, 'base64url')
          if (bytes.toString('base64url') !== input.cursor) throw new Error(RuntimeMessage.CURSOR)
          const value = inputReadObject(JSON.parse(bytes.toString('utf8')), ['workspaceId', 'createdAt', 'id'], 'cursor')
          if (value.workspaceId !== workspaceId) throw new Error(RuntimeMessage.WORKSPACE)
          const createdAt = inputReadString(value.createdAt, 'cursor.createdAt')
          if (new Date(createdAt).toISOString() !== createdAt) throw new Error(RuntimeMessage.TIMESTAMP)
          cursor = { createdAt, id: inputReadId(value.id, 'cursor.id') }
        } catch { throw new GraphError(400, 'INVALID_CURSOR', RuntimeMessage.CURSOR_DOES_NOT_MATCH_THIS_ASSET_QUERY) }
      }
      const limit = input.limit ?? 50
      const rows = (await metadata.list({ workspaceId, state: 'ready' }, ctx.session))
        .filter(doc => /* 只保留游标之后的资产，使用身份打破相同创建时间的并列。 */ !cursor || doc.createdAt < cursor.createdAt || (doc.createdAt === cursor.createdAt && doc._id > cursor.id))
        .sort((a, b) => /* 以创建时间倒序及身份正序固定分页顺序。 */ b.createdAt.localeCompare(a.createdAt) || a._id.localeCompare(b._id)).slice(0, limit + 1)
      const items = rows.slice(0, limit).map(assetsReadView)
      const last = items[items.length - 1]
      return { items, nextCursor: rows.length > limit
        ? Buffer.from(JSON.stringify({ workspaceId, createdAt: last.createdAt, id: last.id })).toString('base64url') : null }
    },
    /**
     * 校验资产查看权限并返回公开元数据。
     *
     * @param ctx 限定读取权限和存储会话的请求上下文。
     * @param assetId 需要返回公开元数据的资产身份。
     */
    async read(ctx: RequestContext, assetId: string): Promise<Asset> {
      return assetsReadView(await assetsReadDocument(ctx, assetId)) },
    /**
     * 校验资产查看权限后打开字节流，调用方负责消费或销毁该流。
     *
     * @param ctx 限定字节读取权限和存储会话的请求上下文。
     * @param assetId 需要打开不可变内容流的资产身份。
     */
    async content(ctx: RequestContext, assetId: string): Promise<{ asset: Asset; stream: Readable }> {
      const document = await assetsReadDocument(ctx, assetId)
      return { asset: assetsReadView(document), stream: blobs.read(document.blobId) }
    },
    /**
     * 要求工作区编辑权限，并按注册定义验证每个附件引用可用且属于同一工作区。
     *
     * @param ctx 必须具有目标工作区编辑权限的请求上下文。
     * @param workspaceId 所有附件定位器必须归属的目标工作区身份。
     * @param nodes 准备写入图、需要验证附件引用的节点数据。
     */
    async assertReferences(ctx: RequestContext, workspaceId: string, nodes: GraphNodeInput[]): Promise<void> {
      await control.requireRole(ctx, workspaceId, 'editor')
      for (const reference of await assetsReadNodeAssetReferences(ctx, workspaceId, nodes)) {
        const asset = await metadata.get(reference.id, ctx.session)
        if (!asset || asset.workspaceId !== workspaceId || asset.state !== 'ready'
          || (reference.expectedMediaType !== undefined && asset.mediaType !== reference.expectedMediaType)) {
          throw new GraphError(422, 'ASSET_REFERENCE', RuntimeMessage.REFERENCE_REQUIRES_A_READY_ASSET_IN_THE_SAME_WORKSPACE_WITH_MATCHING_MEDIA)
        }
      }
    },
    /**
     * 内部产物不需要伪造用户 RequestContext，但附件仍必须 ready、同工作区且媒体类型一致。
     *
     * @param workspaceId 已由工作租约授权的目标工作区。
     * @param nodes Agent 拟发布的服务端产物。
     * @param definitions Run 冻结的精确定义目录，不重读可变工作区目录。
     * @param session 与图提交及工作区写栅栏共用的事务会话。
     */
    async assertInternalReferences(workspaceId: string, nodes: GraphNodeInput[],
      definitions: DefinitionCatalog,
      session?: StorageSession | null): Promise<void> {
      for (const reference of assetsCollectNodeAssetReferences(definitions, nodes)) {
        const asset = await metadata.get(reference.id, session)
        if (!asset || asset.workspaceId !== workspaceId || asset.state !== 'ready'
          || (reference.expectedMediaType !== undefined && asset.mediaType !== reference.expectedMediaType)) {
          throw new GraphError(422, 'ASSET_REFERENCE', RuntimeMessage.REFERENCE_REQUIRES_A_READY_ASSET_IN_THE_SAME_WORKSPACE_WITH_MATCHING_MEDIA)
        }
      }
    },
    /**
     * 在授权事务中按摘要前置条件逻辑删除未被引用的资产，并写入用户作用域的删除收据。
     *
     * @param ctx 必须携带已授权事务和所有者身份的请求上下文。
     * @param input 经过协议解析或待再次解析的资产删除命令。
     */
    async delete(ctx: RequestContext, input: DeleteCommand): Promise<{ data: { assetId: string; deleted: true }; replayed: boolean }> {
      assetsRequireTransaction(ctx)
      const command = assetsReadCommand(input) as DeleteCommand
      const document = await metadata.get(command.params.assetId, ctx.session)
      if (!document) throw new GraphError(404, 'ASSET_NOT_FOUND', RuntimeMessage.ASSET_IS_NOT_AVAILABLE)
      await control.requireRole(ctx, document.workspaceId, 'owner')
      const hash = storeCreateInputHash(command.params)
      const key = storeCreateInputHash({ userId: ctx.actor.userId, method: command.method, assetId: document._id, requestId: command.requestId })
      if (await assetsReadReceipt(ctx, key, hash)) return { data: { assetId: document._id, deleted: true }, replayed: true }
      if (document.state !== 'ready') throw new GraphError(410, 'ASSET_GONE', RuntimeMessage.ASSET_WAS_DELETED)
      if (document.sha256 !== command.params.expectedSha256) throw new GraphError(409, 'ASSET_CONFLICT', RuntimeMessage.ASSET_DIGEST_DOES_NOT_MATCH)
      const graphRows = await graphs.list({ workspaceId: document.workspaceId, deletedAt: null }, ctx.session)
      const referenced = (await Promise.all(graphRows.map(async graph =>
        (await assetsReadNodeAssetReferences(ctx, document.workspaceId, graph.nodes)).some(reference => reference.id === document._id)))).some(Boolean)
      if (referenced) throw new GraphError(409, 'ASSET_IN_USE', RuntimeMessage.ASSET_IS_REFERENCED_BY_A_MAP)
      await metadata.replace({ ...document, state: 'deleted', deletedAt: new Date().toISOString() }, ctx.session)
      const data = { assetId: document._id, deleted: true as const }
      await receipts.insert({ _id: key, userId: ctx.actor.userId, hash, workspaceId: document.workspaceId, data }, ctx.session)
      return { data, replayed: false }
    },
    /**
     * 在一致元数据快照中导出单图与 Agent 配置，事务外读取不可变附件字节。
     *
     * @param ctx 限定单图导出权限和一致快照的请求上下文。
     * @param mapId 需要导出的未删除图身份。
     */
    async exportMap(ctx: RequestContext, mapId: string): Promise<MapBundle> {
      inputReadId(mapId, 'mapId')
      const { bundle, files } = await assetsReadSnapshot(ctx, async snapshotCtx => {
        // 校验图及查看权限，提取可携带的节点、边、配置和所需附件元数据。
        const document = await database.graph(snapshotCtx.session).read(mapId)
        if (!document || document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_IS_NOT_AVAILABLE)
        const workspace = await control.requireRole(snapshotCtx, document.workspaceId, 'viewer')
        const map = bundlesReadMapDocument(document)
        const files = await assetsReadBundleFiles(snapshotCtx, document.workspaceId, map.nodes)
        const definitions = await assetsReadBundleDefinitions(snapshotCtx, document.workspaceId, map.nodes, workspace.agents)
        const bundle: MapBundle = { format: 'chongming-map', version: 4, id: randomUUID(), exportedAt: new Date().toISOString(),
          map, agents: bundlesReadAgents(workspace.agents, definitions.agents), definitions, assets: [] }
        return { bundle, files }
      })
      return assetsAttachBundle(bundle, files)
    },
    /**
     * 要求工作区所有者权限，在一致快照中收集全部图与配置后附加附件。
     *
     * @param ctx 必须具有所有者权限的工作区导出请求上下文。
     * @param workspaceId 需要完整导出且不超过包限制的工作区身份。
     */
    async exportWorkspace(ctx: RequestContext, workspaceId: string): Promise<WorkspaceBundle> {
      inputReadId(workspaceId, 'workspaceId')
      const { bundle, files } = await assetsReadSnapshot(ctx, async snapshotCtx => {
        // 在同一读事务中限制图数和包体大小，校验图与资产引用并构造工作区包。
        const workspace = await control.requireRole(snapshotCtx, workspaceId, 'owner')
        const rows = (await graphs.list({ workspaceId, deletedAt: null }, snapshotCtx.session)).sort((a, b) => /* 按图身份稳定排列导出内容，减少存储返回顺序造成的差异。 */ a._id.localeCompare(b._id))
        if (rows.length > 100) throw new GraphError(413, 'BUNDLE_LIMIT', RuntimeMessage.A_BUNDLE_SUPPORTS_AT_MOST_100_MAPS)
        const store = database.graph(snapshotCtx.session)
        const maps = []
        let size = 0
        for (const row of rows) {
          const document = await store.read(row._id)
          if (!document || document.deletedAt) throw new GraphError(409, 'EXPORT_CONFLICT', RuntimeMessage.MAP_CHANGED_WHILE_EXPORTING)
          const map = bundlesReadMapDocument(document)
          size += Buffer.byteLength(JSON.stringify(map))
          if (size > BUNDLE_BYTE_LIMIT) throw new GraphError(413, 'BUNDLE_LIMIT', RuntimeMessage.BUNDLE_EXCEEDS_64_MIB)
          maps.push(map)
        }
        const nodes = maps.flatMap(map => /* 汇集所有导出图的节点，以统一去重检查附件引用。 */ map.nodes)
        const files = await assetsReadBundleFiles(snapshotCtx, workspaceId, nodes)
        const definitions = await assetsReadBundleDefinitions(snapshotCtx, workspaceId, nodes, workspace.agents)
        const bundle: WorkspaceBundle = { format: 'chongming-workspace', version: 4, id: randomUUID(), exportedAt: new Date().toISOString(),
          workspace: { name: workspace.name, description: workspace.description, agents: bundlesReadAgents(workspace.agents, definitions.agents) }, maps, definitions, assets: [] }
        return { bundle, files }
      })
      return assetsAttachBundle(bundle, files)
    },
    /**
     * 校验导入包并先写入附件，再用授权事务创建工作区、图和导入收据；重复请求返回已导入的对象 ID。
     *
     * @param token 发起导入且发布阶段会再次验证的用户令牌。
     * @param input 包含暂存包资产、目标工作区身份和稳定请求身份的导入命令。
     */
    async importWorkspace(token: string, input: ImportCommand): Promise<{ data: ImportResult; replayed: boolean }> {
      const command = assetsReadCommand(input) as ImportCommand
      const initial = await auth.read(token)
      const staging = command.params.stagingWorkspaceId
      await control.requireRole(initial, staging, 'owner')
      const hash = storeCreateInputHash(command.params)
      const key = storeCreateInputHash({ userId: initial.actor.userId, method: command.method, staging, requestId: command.requestId })
      const prior = await assetsReadReceipt(initial, key, hash)
      if (prior) {
        await control.requireRole(initial, prior.workspaceId, 'viewer')
        return { data: prior.data as ImportResult, replayed: true }
      }
      const bundleAsset = await assetsReadDocument(initial, command.params.bundleAssetId)
      if (bundleAsset.workspaceId !== staging) throw new GraphError(400, 'BUNDLE_SCOPE_MISMATCH', RuntimeMessage.BUNDLE_ASSET_BELONGS_TO_ANOTHER_STAGING_WORKSPACE)
      const bytes = await assetsReadBytes(bundleAsset)
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.BUNDLE_IS_NOT_VALID_UTF_8_JSON) }
      // v3 必须明确经过一次业务结构转换；不在 v4 解析器中宽松接纳 data/kind。
      const version = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>).version : undefined
      const bundle = version === 3 ? bundlesConvertV3(parsed, await control.definitions(initial, staging)) : bundlesReadWorkspace(parsed)
      const prepared = bundlesCreateImport(bundle, command.params.id, command.params.name)
      const files: AssetDocument[] = []
      let publishing = false
      try {
        for (const asset of prepared.assets) {
          const meta = assetsReadMetadata(asset.original)
          const blobId = await assetsWriteBlob(Readable.from([Buffer.from(asset.original.contentBase64, 'base64')]), meta)
          files.push({ _id: asset.id, workspaceId: prepared.workspace.id, ...meta, blobId, state: 'ready', createdAt: new Date().toISOString() })
        }
        publishing = true
        const result = await auth.transact(token, async ctx => {
          // 在实际发布时重查暂存区权限、资产和幂等收据，原子保存所有元数据及图。
          await control.requireRole(ctx, staging, 'owner')
          const receipt = await assetsReadReceipt(ctx, key, hash)
          if (receipt) {
            await control.requireRole(ctx, receipt.workspaceId, 'viewer')
            return { data: receipt.data as ImportResult, replayed: true }
          }
          await assetsReadDocument(ctx, bundleAsset._id)
          await control.createWorkspace(ctx, prepared.workspace, prepared.agents, undefined, prepared.definitions)
          for (const file of files) await metadata.insert(file, ctx.session)
          const store = database.graph(ctx.session)
          for (const document of prepared.maps) {
            if (!await store.create(document)) throw new GraphError(409, 'IMPORT_CONFLICT', RuntimeMessage.IMPORTED_MAP_ID_ALREADY_EXISTS)
          }
          const data: ImportResult = { workspaceId: prepared.workspace.id, mapIds: prepared.maps.map(map => /* 返回重映射后的图 ID，供调用方打开导入内容。 */ map.id), assetIds: files.map(file => /* 返回本次导入创建的附件元数据 ID。 */ file._id) }
          await receipts.insert({ _id: key, userId: ctx.actor.userId, hash, workspaceId: prepared.workspace.id, data }, ctx.session)
          return { data, replayed: false }
        })
        if (result.replayed) for (const file of files) await blobs.remove(file.blobId).catch(() => {
          // 并发请求已完成导入，本次多写的附件没有引用；清理失败不改变已成功的导入结果。
        })
        return result
      } catch (error) {
        // 发布前或明确回滚时可以清理附件；提交结果不确定时必须保留，避免删除可能已被引用的数据。
        if (!publishing || assetsIsRollback(error)) await Promise.all(files.map(file => /* 清理本次失败导入尚未发布的附件。 */ blobs.remove(file.blobId).catch(() => {
          // 附件清理失败不能覆盖原始导入错误，允许留下未被引用的文件。
        })))
        throw error
      }
    },
    async cleanupDeleted(): Promise<number> {
      // 在用户事务外清理已逻辑删除资产的字节，返回实际删除附件数量。
      let count = 0
      for (const document of await metadata.list({ state: 'deleted' })) if (await blobs.remove(document.blobId)) count++
      return count
    },
  }
}
export type AssetsService = ReturnType<typeof assetsCreateService>
