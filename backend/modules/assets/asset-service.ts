import { RuntimeMessage } from '../../../contracts/messages'
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import type { Persistence } from '../../ports/persistence'
import type { Asset, ControlCommand, ControlQuery, ImportResult, MapBundle, Page, WorkspaceBundle } from '../../../contracts/control'
import type { GraphNode, GraphNodeData } from '../../../contracts/graph'
import type { AuthService, RequestContext } from '../identity/identity-service'
import type { ControlService } from '../workspace/workspace-service'
import { ASSET_BYTE_LIMIT, BUNDLE_BYTE_LIMIT, bundlesAssertSize, bundlesCreateImport, bundlesReadAgents, bundlesReadMapDocument, bundlesReadWorkspace } from './bundle-codec'
import { GraphError } from '../shared/domain-error'
import { SOURCE_MEDIA_TYPES, type SourceReader } from '../../ports/source-reader'
import { inputReadId, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../graph/graph-record'

export interface AssetUploadInput {
  workspaceId: string; filename: string; mediaType: string; size: number; sha256: string; requestId: string
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
// 用途：读取摘要，并把结构化结果交给调用方。
function assetsReadHash(value: unknown): string {
  const hash = inputReadString(value, 'sha256').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.SHA256_MUST_CONTAIN_64_HEX_DIGITS)
  return hash
}
// 用途：读取元数据，并把结构化结果交给调用方。
function assetsReadMetadata(input: Omit<AssetUploadInput, 'workspaceId' | 'requestId'>) {
  const filename = inputReadString(input.filename, 'filename').trim()
  if (Buffer.byteLength(filename) > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.FILENAME_MUST_BE_A_SINGLE_SAFE_DISPLAY_NAME)
  const mediaType = inputReadString(input.mediaType, 'mediaType').trim()
  if (mediaType.length > 255 || /[\x00-\x1f\x7f]/.test(mediaType) || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]*)?$/.test(mediaType)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_MEDIATYPE)
  const size = inputReadRevision(input.size, 'size')
  if (size > ASSET_BYTE_LIMIT) throw new GraphError(413, 'ASSET_LIMIT', RuntimeMessage.ASSET_EXCEEDS_64_MIB)
  return { filename, mediaType, size, sha256: assetsReadHash(input.sha256) }
}
// 用途：读取命令，并把结构化结果交给调用方。
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
// 用途：读取视图，并把结构化结果交给调用方。
function assetsReadView(document: AssetDocument): Asset {
  return { id: document._id, workspaceId: document.workspaceId, filename: document.filename, mediaType: document.mediaType,
    size: document.size, sha256: document.sha256, createdAt: document.createdAt }
}
// 用途：判断资产是否满足当前条件。
function assetsIsRollback(error: unknown): boolean {
  return error instanceof GraphError && error.status >= 400 && error.status < 500
}
// 用途：读取资产，并把结构化结果交给调用方。
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

// 用途：创建服务，供后续流程使用。
export function assetsCreateService(database: Persistence, auth: AuthService, control: ControlService, options: { allowPrivateSources?: boolean; readUrl: SourceReader }) {
  const blobs = database.blobs
  const metadata = database.records<AssetDocument>('control_assets')
  const receipts = database.records<AssetReceipt>('asset_receipts')
  const graphs = database.records<{ _id: string; workspaceId: string; deletedAt?: unknown; nodes: GraphNode[] }>(GRAPH_COLLECTION)

  // 用途：读取文档，并把结构化结果交给调用方。
  async function assetsReadDocument(ctx: RequestContext, assetId: string): Promise<AssetDocument> {
    inputReadId(assetId, 'assetId')
    const document = await metadata.get(assetId, ctx.session)
    if (!document) throw new GraphError(404, 'ASSET_NOT_FOUND', RuntimeMessage.ASSET_IS_NOT_AVAILABLE)
    await control.requireRole(ctx, document.workspaceId, 'viewer')
    if (document.state !== 'ready') throw new GraphError(404, 'ASSET_NOT_FOUND', RuntimeMessage.ASSET_IS_NOT_AVAILABLE)
    return document
  }
  // 用途：处理资产相关工作，并把结果交给调用方。
  async function assetsWriteBlob(source: AsyncIterable<Uint8Array>, meta: { filename: string; size: number; sha256: string }): Promise<string> {
    return blobs.write(assetsReadChunks(source, meta), meta.filename)
  }

  // 用途：读取字节，并把结构化结果交给调用方。
  async function assetsReadBytes(document: AssetDocument): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of assetsReadChunks(blobs.read(document.blobId), document)) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  // 用途：读取收据，并把结构化结果交给调用方。
  async function assetsReadReceipt(ctx: RequestContext, key: string, hash: string): Promise<AssetReceipt | null> {
    const prior = await receipts.get(key, ctx.session)
    if (prior && prior.hash !== hash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', RuntimeMessage.REQUESTID_HAS_DIFFERENT_INPUT)
    return prior
  }
  // 用途：处理资产相关工作，并把结果交给调用方。
  function assetsRequireTransaction(ctx: RequestContext): void {
    if (!ctx.mutation || !ctx.session?.inTransaction()) throw new Error(RuntimeMessage.ASSET_MUTATION_REQUIRES_THE_AUTHENTICATED_TRANSACTION)
  }
  // 用途：读取快照，并把结构化结果交给调用方。
  async function assetsReadSnapshot<T>(ctx: RequestContext, callback: (context: RequestContext) => Promise<T>): Promise<T> {
    if (ctx.session) return callback(ctx)
    return database.transaction(session => callback({ ...ctx, session, mutation: false }))
  }

  // 用途：读取数据包文件，并把结构化结果交给调用方。
  async function assetsReadBundleFiles(ctx: RequestContext, workspaceId: string, nodes: GraphNode[]): Promise<AssetDocument[]> {
    const ids = [...new Set(nodes.flatMap(node => (node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset' ? [node.data.locator.assetId] : []))]
    const rows = ids.length ? await metadata.list({ _id: ids, workspaceId, state: 'ready' }, ctx.session) : []
    if (rows.length !== ids.length) throw new GraphError(422, 'ASSET_REFERENCE', RuntimeMessage.A_REFERENCED_ASSET_IS_NOT_AVAILABLE)
    for (const node of nodes) if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') {
      const locator = node.data.locator
      if (rows.find(asset => asset._id === locator.assetId)?.mediaType !== locator.mediaType) throw new GraphError(422, 'ASSET_REFERENCE', RuntimeMessage.ASSET_MEDIA_TYPE_DOES_NOT_MATCH_ITS_REFERENCE)
    }
    return rows
  }
  // 用途：处理资产相关工作，并把结果交给调用方。
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
    /** Internal execution only: the graph service has already checked the exact work grant. */
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readSource(workspaceId: string, node: GraphNode): Promise<string> {
      if (node.data.kind !== 'source') throw new GraphError(422, 'INVALID_SOURCE', RuntimeMessage.EXPECTED_A_SOURCE_NODE)
      const locator = node.data.locator
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
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize(): Promise<void> {
      await Promise.all([
        metadata.index(['uploadKey'], { unique: true, sparse: true }),
        metadata.index(['workspaceId', 'state', 'createdAt', '_id']),
        receipts.index(['userId', 'workspaceId']),
      ])
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
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
        // Replay still validates bytes: a forged digest header must not bypass length/integrity checks.
        for await (const _chunk of assetsReadChunks(source, meta)) { /* consume without storing another copy */ }
      } else blobId = await assetsWriteBlob(source, meta)
      let result: { data: Asset; replayed: boolean }
      try { result = await auth.transact(token, async ctx => {
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
        if (blobId && assetsIsRollback(error)) await blobs.remove(blobId).catch(() => {})
        throw error
      }
      if (blobId && result.data.id !== candidateId) await blobs.remove(blobId).catch(() => {})
      // On an uncertain transaction outcome, retain the private blob: deleting it could corrupt a committed Asset.
      return result
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
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
        .filter(doc => !cursor || doc.createdAt < cursor.createdAt || (doc.createdAt === cursor.createdAt && doc._id > cursor.id))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a._id.localeCompare(b._id)).slice(0, limit + 1)
      const items = rows.slice(0, limit).map(assetsReadView)
      const last = items[items.length - 1]
      return { items, nextCursor: rows.length > limit
        ? Buffer.from(JSON.stringify({ workspaceId, createdAt: last.createdAt, id: last.id })).toString('base64url') : null }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read(ctx: RequestContext, assetId: string): Promise<Asset> { return assetsReadView(await assetsReadDocument(ctx, assetId)) },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async content(ctx: RequestContext, assetId: string): Promise<{ asset: Asset; stream: Readable }> {
      const document = await assetsReadDocument(ctx, assetId)
      return { asset: assetsReadView(document), stream: blobs.read(document.blobId) }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async assertReferences(ctx: RequestContext, workspaceId: string, nodes: Array<{ data: GraphNodeData }>): Promise<void> {
      await control.requireRole(ctx, workspaceId, 'editor')
      for (const node of nodes) if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') {
        const asset = await metadata.get(node.data.locator.assetId, ctx.session)
        if (!asset || asset.workspaceId !== workspaceId || asset.state !== 'ready' || asset.mediaType !== node.data.locator.mediaType) throw new GraphError(422, 'ASSET_REFERENCE', RuntimeMessage.REFERENCE_REQUIRES_A_READY_ASSET_IN_THE_SAME_WORKSPACE_WITH_MATCHING_MEDIA)
      }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
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
      const referenced = (await graphs.list({ workspaceId: document.workspaceId, deletedAt: null }, ctx.session)).some(graph =>
        graph.nodes.some(node => (node.data.kind === 'source' || node.data.kind === 'evidence')
          && node.data.locator.kind === 'asset' && node.data.locator.assetId === document._id))
      if (referenced) throw new GraphError(409, 'ASSET_IN_USE', RuntimeMessage.ASSET_IS_REFERENCED_BY_A_MAP)
      await metadata.replace({ ...document, state: 'deleted', deletedAt: new Date().toISOString() }, ctx.session)
      const data = { assetId: document._id, deleted: true as const }
      await receipts.insert({ _id: key, userId: ctx.actor.userId, hash, workspaceId: document.workspaceId, data }, ctx.session)
      return { data, replayed: false }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async exportMap(ctx: RequestContext, mapId: string): Promise<MapBundle> {
      inputReadId(mapId, 'mapId')
      const { bundle, files } = await assetsReadSnapshot(ctx, async snapshotCtx => {
        const document = await database.graph(snapshotCtx.session).read(mapId)
        if (!document || document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_IS_NOT_AVAILABLE)
        const workspace = await control.requireRole(snapshotCtx, document.workspaceId, 'viewer')
        const map = bundlesReadMapDocument(document)
        const files = await assetsReadBundleFiles(snapshotCtx, document.workspaceId, map.nodes)
        const bundle: MapBundle = { format: 'chongming-map', version: 3, id: randomUUID(), exportedAt: new Date().toISOString(),
          map, agents: bundlesReadAgents(workspace.agents), assets: [] }
        return { bundle, files }
      })
      return assetsAttachBundle(bundle, files)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async exportWorkspace(ctx: RequestContext, workspaceId: string): Promise<WorkspaceBundle> {
      inputReadId(workspaceId, 'workspaceId')
      const { bundle, files } = await assetsReadSnapshot(ctx, async snapshotCtx => {
        const workspace = await control.requireRole(snapshotCtx, workspaceId, 'owner')
        const rows = (await graphs.list({ workspaceId, deletedAt: null }, snapshotCtx.session)).sort((a, b) => a._id.localeCompare(b._id))
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
        const files = await assetsReadBundleFiles(snapshotCtx, workspaceId, maps.flatMap(map => map.nodes))
        const bundle: WorkspaceBundle = { format: 'chongming-workspace', version: 3, id: randomUUID(), exportedAt: new Date().toISOString(),
          workspace: { name: workspace.name, description: workspace.description, agents: bundlesReadAgents(workspace.agents) }, maps, assets: [] }
        return { bundle, files }
      })
      return assetsAttachBundle(bundle, files)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
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
      const bundle = bundlesReadWorkspace(parsed)
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
          await control.requireRole(ctx, staging, 'owner')
          const receipt = await assetsReadReceipt(ctx, key, hash)
          if (receipt) {
            await control.requireRole(ctx, receipt.workspaceId, 'viewer')
            return { data: receipt.data as ImportResult, replayed: true }
          }
          await assetsReadDocument(ctx, bundleAsset._id)
          await control.createWorkspace(ctx, prepared.workspace, prepared.agents)
          for (const file of files) await metadata.insert(file, ctx.session)
          const store = database.graph(ctx.session)
          for (const document of prepared.maps) {
            if (!await store.create(document)) throw new GraphError(409, 'IMPORT_CONFLICT', RuntimeMessage.IMPORTED_MAP_ID_ALREADY_EXISTS)
          }
          const data: ImportResult = { workspaceId: prepared.workspace.id, mapIds: prepared.maps.map(map => map.id), assetIds: files.map(file => file._id) }
          await receipts.insert({ _id: key, userId: ctx.actor.userId, hash, workspaceId: prepared.workspace.id, data }, ctx.session)
          return { data, replayed: false }
        })
        if (result.replayed) for (const file of files) await blobs.remove(file.blobId).catch(() => {})
        return result
      } catch (error) {
        // Before publication no file can be referenced. An uncertain commit must retain its immutable blobs.
        if (!publishing || assetsIsRollback(error)) await Promise.all(files.map(file => blobs.remove(file.blobId).catch(() => {})))
        throw error
      }
    },
    /** Optional maintenance after logical deletion; never runs inside a user transaction. */
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async cleanupDeleted(): Promise<number> {
      let count = 0
      for (const document of await metadata.list({ state: 'deleted' })) if (await blobs.remove(document.blobId)) count++
      return count
    },
  }
}
export type AssetsService = ReturnType<typeof assetsCreateService>
