import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { mongo, type Connection } from 'mongoose'
import type { Asset, ControlCommand, ImportResult, MapBundle, WorkspaceBundle } from '../contracts/control'
import type { GraphNode, GraphNodeData } from '../contracts/graph'
import type { AuthService, RequestContext } from './auth'
import type { ControlService } from './control'
import { ASSET_BYTE_LIMIT, BUNDLE_BYTE_LIMIT, bundlesAssertSize, bundlesCreateImport, bundlesReadAgents, bundlesReadMapDocument, bundlesReadWorkspace } from './bundles'
import { GraphError } from './graph-error'
import { inputReadId, inputReadObject, inputReadRevision, inputReadString } from './input'
import { GRAPH_COLLECTION, storeCreateGraphStore, storeCreateInputHash } from './store'

export interface AssetUploadInput {
  workspaceId: string; filename: string; mediaType: string; size: number; sha256: string; requestId: string
}
type DeleteCommand = Extract<ControlCommand, { method: 'asset.delete' }>
type ImportCommand = Extract<ControlCommand, { method: 'workspace.import' }>
interface AssetDocument extends Omit<Asset, 'id'> {
  _id: string; blobId: mongo.ObjectId; state: 'ready' | 'deleted'
  uploadKey?: string; inputHash?: string; deletedAt?: string
}
interface AssetReceipt {
  _id: string; userId: string; hash: string; workspaceId: string
  data: ImportResult | { assetId: string; deleted: true }
}
function assetsReadHash(value: unknown): string {
  const hash = inputReadString(value, 'sha256').toLowerCase()
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new GraphError(400, 'INVALID_ARGUMENT', 'sha256 must contain 64 hex digits')
  return hash
}
function assetsReadMetadata(input: Omit<AssetUploadInput, 'workspaceId' | 'requestId'>) {
  const filename = inputReadString(input.filename, 'filename').trim()
  if (Buffer.byteLength(filename) > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) throw new GraphError(400, 'INVALID_ARGUMENT', 'filename must be a single safe display name')
  const mediaType = inputReadString(input.mediaType, 'mediaType').trim()
  if (mediaType.length > 255 || /[\x00-\x1f\x7f]/.test(mediaType) || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:;[^\r\n]*)?$/.test(mediaType)) throw new GraphError(400, 'INVALID_ARGUMENT', 'Invalid mediaType')
  const size = inputReadRevision(input.size, 'size')
  if (size > ASSET_BYTE_LIMIT) throw new GraphError(413, 'ASSET_LIMIT', 'Asset exceeds 64 MiB')
  return { filename, mediaType, size, sha256: assetsReadHash(input.sha256) }
}
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
  throw new GraphError(400, 'UNKNOWN_METHOD', 'Unknown asset or bundle command')
}
function assetsReadView(document: AssetDocument): Asset {
  return { id: document._id, workspaceId: document.workspaceId, filename: document.filename, mediaType: document.mediaType,
    size: document.size, sha256: document.sha256, createdAt: document.createdAt }
}
function assetsIsRollback(error: unknown): boolean {
  return error instanceof GraphError && error.status >= 400 && error.status < 500
}
async function* assetsReadChunks(source: AsyncIterable<Uint8Array>, expected: { size: number; sha256: string }) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of source) {
    const bytes = Buffer.from(chunk)
    size += bytes.length
    if (size > ASSET_BYTE_LIMIT || size > expected.size) throw new GraphError(413, 'ASSET_LIMIT', 'Upload exceeds its declared length or 64 MiB')
    hash.update(bytes)
    yield bytes
  }
  if (size !== expected.size) throw new GraphError(422, 'ASSET_INTEGRITY', 'Upload length does not match')
  if (hash.digest('hex') !== expected.sha256) throw new GraphError(422, 'ASSET_INTEGRITY', 'Upload SHA-256 does not match')
}

export function assetsCreateService(connection: Connection, auth: AuthService, control: ControlService) {
  if (!connection.db) throw new Error('Assets require an open Mongo connection')
  const bucket = new mongo.GridFSBucket(connection.db, { bucketName: 'asset_blobs' })
  const metadata = connection.collection<AssetDocument>('control_assets')
  const receipts = connection.collection<AssetReceipt>('asset_receipts')
  const graphs = connection.collection<{ _id: string; workspaceId: string; deletedAt?: unknown; nodes: GraphNode[] }>(GRAPH_COLLECTION)

  async function assetsReadDocument(ctx: RequestContext, assetId: string): Promise<AssetDocument> {
    inputReadId(assetId, 'assetId')
    const document = await metadata.findOne({ _id: assetId }, { session: ctx.session ?? undefined })
    if (!document) throw new GraphError(404, 'ASSET_NOT_FOUND', 'Asset is not available')
    await control.requireRole(ctx, document.workspaceId, 'viewer')
    if (document.state !== 'ready') throw new GraphError(404, 'ASSET_NOT_FOUND', 'Asset is not available')
    return document
  }
  async function assetsWriteBlob(source: AsyncIterable<Uint8Array>, meta: { filename: string; size: number; sha256: string }): Promise<mongo.ObjectId> {
    const upload = bucket.openUploadStream(meta.filename)
    try {
      await pipeline(Readable.from(assetsReadChunks(source, meta)), upload)
      return upload.id
    } catch (error) {
      await upload.abort().catch(() => {})
      throw error
    }
  }
  async function assetsReadBytes(document: AssetDocument): Promise<Buffer> {
    const chunks: Buffer[] = []
    for await (const chunk of assetsReadChunks(bucket.openDownloadStream(document.blobId), document)) chunks.push(chunk)
    return Buffer.concat(chunks)
  }
  async function assetsReadReceipt(ctx: RequestContext, key: string, hash: string): Promise<AssetReceipt | null> {
    const prior = await receipts.findOne({ _id: key }, { session: ctx.session ?? undefined })
    if (prior && prior.hash !== hash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', 'requestId has different input')
    return prior
  }
  function assetsRequireTransaction(ctx: RequestContext): void {
    if (!ctx.mutation || !ctx.session?.inTransaction()) throw new Error('Asset mutation requires the authenticated transaction')
  }
  async function assetsReadSnapshot<T>(ctx: RequestContext, callback: (context: RequestContext) => Promise<T>): Promise<T> {
    if (ctx.session) return callback(ctx)
    const session = await connection.startSession()
    try {
      return await session.withTransaction(() => callback({ ...ctx, session, mutation: false }), {
        readConcern: { level: 'snapshot' }, readPreference: 'primary',
      })
    } finally { await session.endSession() }
  }
  async function assetsReadBundleFiles(ctx: RequestContext, workspaceId: string, nodes: GraphNode[]): Promise<AssetDocument[]> {
    const ids = [...new Set(nodes.flatMap(node => (node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset' ? [node.data.locator.assetId] : []))]
    const rows = ids.length ? await metadata.find({ _id: { $in: ids }, workspaceId, state: 'ready' }, { session: ctx.session ?? undefined }).toArray() : []
    if (rows.length !== ids.length) throw new GraphError(422, 'ASSET_REFERENCE', 'A referenced asset is not available')
    for (const node of nodes) if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') {
      const locator = node.data.locator
      if (rows.find(asset => asset._id === locator.assetId)?.mediaType !== locator.mediaType) throw new GraphError(422, 'ASSET_REFERENCE', 'Asset media type does not match its reference')
    }
    return rows
  }
  async function assetsAttachBundle<T extends MapBundle | WorkspaceBundle>(bundle: T, files: AssetDocument[]): Promise<T> {
    let estimated = Buffer.byteLength(JSON.stringify(bundle))
    for (const file of files) estimated += Math.ceil(file.size / 3) * 4 + Buffer.byteLength(JSON.stringify(assetsReadView(file))) + 64
    if (estimated > BUNDLE_BYTE_LIMIT) throw new GraphError(413, 'BUNDLE_LIMIT', 'The complete base64 bundle exceeds 64 MiB')
    for (const file of files) {
      const bytes = await assetsReadBytes(file)
      bundle.assets.push({ id: file._id, filename: file.filename, mediaType: file.mediaType, size: file.size, sha256: file.sha256, contentBase64: bytes.toString('base64') })
    }
    bundlesAssertSize(bundle)
    return bundle
  }

  return {
    async initialize(): Promise<void> {
      await Promise.all([
        metadata.createIndex({ uploadKey: 1 }, { unique: true, sparse: true }),
        metadata.createIndex({ workspaceId: 1, state: 1 }),
        receipts.createIndex({ userId: 1, workspaceId: 1 }),
      ])
    },
    async upload(token: string, value: AssetUploadInput, source: AsyncIterable<Uint8Array>): Promise<{ data: Asset; replayed: boolean }> {
      const workspaceId = inputReadId(value.workspaceId, 'workspaceId'), requestId = inputReadId(value.requestId, 'requestId')
      const meta = assetsReadMetadata(value)
      const initial = await auth.read(token)
      await control.requireRole(initial, workspaceId, 'editor')
      const uploadKey = storeCreateInputHash({ userId: initial.actor.userId, workspaceId, requestId })
      const inputHash = storeCreateInputHash({ workspaceId, ...meta })
      const prior = await metadata.findOne({ uploadKey })
      if (prior?.inputHash !== undefined && prior.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', 'Upload requestId has different input')
      if (prior?.state === 'deleted') throw new GraphError(410, 'ASSET_GONE', 'The uploaded asset was deleted')
      const candidateId = randomUUID()
      let blobId: mongo.ObjectId | undefined
      if (prior) {
        // Replay still validates bytes: a forged digest header must not bypass length/integrity checks.
        for await (const _chunk of assetsReadChunks(source, meta)) { /* consume without storing another copy */ }
      } else blobId = await assetsWriteBlob(source, meta)
      let result: { data: Asset; replayed: boolean }
      try { result = await auth.transact(token, async ctx => {
        await control.requireRole(ctx, workspaceId, 'editor')
        const existing = await metadata.findOne({ uploadKey }, { session: ctx.session ?? undefined })
        if (existing) {
          if (existing.inputHash !== inputHash) throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', 'Upload requestId has different input')
          if (existing.state !== 'ready') throw new GraphError(410, 'ASSET_GONE', 'The uploaded asset was deleted')
          return { data: assetsReadView(existing), replayed: true }
        }
        if (!blobId) throw new GraphError(409, 'ASSET_GONE', 'Original upload no longer exists')
        const document: AssetDocument = { _id: candidateId, workspaceId, ...meta, blobId, state: 'ready',
          createdAt: new Date().toISOString(), uploadKey, inputHash }
        await metadata.insertOne(document, { session: ctx.session ?? undefined })
        return { data: assetsReadView(document), replayed: false }
      }) } catch (error) {
        if (blobId && assetsIsRollback(error)) await bucket.delete(blobId).catch(() => {})
        throw error
      }
      if (blobId && result.data.id !== candidateId) await bucket.delete(blobId).catch(() => {})
      // On an uncertain transaction outcome, retain the private blob: deleting it could corrupt a committed Asset.
      return result
    },
    async read(ctx: RequestContext, assetId: string): Promise<Asset> { return assetsReadView(await assetsReadDocument(ctx, assetId)) },
    async content(ctx: RequestContext, assetId: string): Promise<{ asset: Asset; stream: Readable }> {
      const document = await assetsReadDocument(ctx, assetId)
      return { asset: assetsReadView(document), stream: bucket.openDownloadStream(document.blobId) }
    },
    async assertReferences(ctx: RequestContext, workspaceId: string, nodes: Array<{ data: GraphNodeData }>): Promise<void> {
      await control.requireRole(ctx, workspaceId, 'editor')
      for (const node of nodes) if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') {
        const asset = await metadata.findOne({ _id: node.data.locator.assetId, workspaceId, state: 'ready' }, { session: ctx.session ?? undefined })
        if (!asset || asset.mediaType !== node.data.locator.mediaType) throw new GraphError(422, 'ASSET_REFERENCE', 'Reference requires a ready asset in the same Workspace with matching media type')
      }
    },
    async delete(ctx: RequestContext, input: DeleteCommand): Promise<{ data: { assetId: string; deleted: true }; replayed: boolean }> {
      assetsRequireTransaction(ctx)
      const command = assetsReadCommand(input) as DeleteCommand
      const document = await metadata.findOne({ _id: command.params.assetId }, { session: ctx.session ?? undefined })
      if (!document) throw new GraphError(404, 'ASSET_NOT_FOUND', 'Asset is not available')
      await control.requireRole(ctx, document.workspaceId, 'owner')
      const hash = storeCreateInputHash(command.params)
      const key = storeCreateInputHash({ userId: ctx.actor.userId, method: command.method, assetId: document._id, requestId: command.requestId })
      if (await assetsReadReceipt(ctx, key, hash)) return { data: { assetId: document._id, deleted: true }, replayed: true }
      if (document.state !== 'ready') throw new GraphError(410, 'ASSET_GONE', 'Asset was deleted')
      if (document.sha256 !== command.params.expectedSha256) throw new GraphError(409, 'ASSET_CONFLICT', 'Asset digest does not match')
      const referenced = await graphs.findOne({ workspaceId: document.workspaceId, deletedAt: { $exists: false },
        nodes: { $elemMatch: { 'data.kind': { $in: ['source', 'evidence'] }, 'data.locator.kind': 'asset', 'data.locator.assetId': document._id } },
      }, { session: ctx.session ?? undefined, projection: { _id: 1 } })
      if (referenced) throw new GraphError(409, 'ASSET_IN_USE', 'Asset is referenced by a Map')
      await metadata.updateOne({ _id: document._id, state: 'ready' }, { $set: { state: 'deleted', deletedAt: new Date().toISOString() } }, { session: ctx.session ?? undefined })
      const data = { assetId: document._id, deleted: true as const }
      await receipts.insertOne({ _id: key, userId: ctx.actor.userId, hash, workspaceId: document.workspaceId, data }, { session: ctx.session ?? undefined })
      return { data, replayed: false }
    },
    async exportMap(ctx: RequestContext, mapId: string): Promise<MapBundle> {
      inputReadId(mapId, 'mapId')
      const { bundle, files } = await assetsReadSnapshot(ctx, async snapshotCtx => {
        const document = await storeCreateGraphStore(connection, snapshotCtx.session).read(mapId)
        if (!document || document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', 'Map is not available')
        const workspace = await control.requireRole(snapshotCtx, document.workspaceId, 'viewer')
        const map = bundlesReadMapDocument(document)
        const files = await assetsReadBundleFiles(snapshotCtx, document.workspaceId, map.nodes)
        const bundle: MapBundle = { format: 'chongming-map', version: 3, id: randomUUID(), exportedAt: new Date().toISOString(),
          map, agents: bundlesReadAgents(workspace.agents), assets: [] }
        return { bundle, files }
      })
      return assetsAttachBundle(bundle, files)
    },
    async exportWorkspace(ctx: RequestContext, workspaceId: string): Promise<WorkspaceBundle> {
      inputReadId(workspaceId, 'workspaceId')
      const { bundle, files } = await assetsReadSnapshot(ctx, async snapshotCtx => {
        const workspace = await control.requireRole(snapshotCtx, workspaceId, 'owner')
        const rows = await graphs.find({ workspaceId, deletedAt: { $exists: false } }, { session: snapshotCtx.session ?? undefined, projection: { _id: 1 } }).limit(101).sort({ _id: 1 }).toArray()
        if (rows.length > 100) throw new GraphError(413, 'BUNDLE_LIMIT', 'A bundle supports at most 100 Maps')
        const store = storeCreateGraphStore(connection, snapshotCtx.session)
        const maps = []
        let size = 0
        for (const row of rows) {
          const document = await store.read(row._id)
          if (!document || document.deletedAt) throw new GraphError(409, 'EXPORT_CONFLICT', 'Map changed while exporting')
          const map = bundlesReadMapDocument(document)
          size += Buffer.byteLength(JSON.stringify(map))
          if (size > BUNDLE_BYTE_LIMIT) throw new GraphError(413, 'BUNDLE_LIMIT', 'Bundle exceeds 64 MiB')
          maps.push(map)
        }
        const files = await assetsReadBundleFiles(snapshotCtx, workspaceId, maps.flatMap(map => map.nodes))
        const bundle: WorkspaceBundle = { format: 'chongming-workspace', version: 3, id: randomUUID(), exportedAt: new Date().toISOString(),
          workspace: { name: workspace.name, description: workspace.description, agents: bundlesReadAgents(workspace.agents) }, maps, assets: [] }
        return { bundle, files }
      })
      return assetsAttachBundle(bundle, files)
    },
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
      if (bundleAsset.workspaceId !== staging) throw new GraphError(400, 'BUNDLE_SCOPE_MISMATCH', 'Bundle asset belongs to another staging Workspace')
      const bytes = await assetsReadBytes(bundleAsset)
      let parsed: unknown
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { throw new GraphError(422, 'BUNDLE_INVALID', 'Bundle is not valid UTF-8 JSON') }
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
          for (const file of files) await metadata.insertOne(file, { session: ctx.session ?? undefined })
          const store = storeCreateGraphStore(connection, ctx.session)
          for (const document of prepared.maps) {
            if (!await store.create(document)) throw new GraphError(409, 'IMPORT_CONFLICT', 'Imported Map id already exists')
          }
          const data: ImportResult = { workspaceId: prepared.workspace.id, mapIds: prepared.maps.map(map => map.id), assetIds: files.map(file => file._id) }
          await receipts.insertOne({ _id: key, userId: ctx.actor.userId, hash, workspaceId: prepared.workspace.id, data }, { session: ctx.session ?? undefined })
          return { data, replayed: false }
        })
        if (result.replayed) for (const file of files) await bucket.delete(file.blobId).catch(() => {})
        return result
      } catch (error) {
        // Before publication no file can be referenced. An uncertain commit must retain its immutable blobs.
        if (!publishing || assetsIsRollback(error)) await Promise.all(files.map(file => bucket.delete(file.blobId).catch(() => {})))
        throw error
      }
    },
    /** Optional maintenance after logical deletion; never runs inside a user transaction. */
    async cleanupDeleted(): Promise<number> {
      let count = 0
      for await (const document of metadata.find({ state: 'deleted' })) {
        try { await bucket.delete(document.blobId); count++ } catch (error) {
          if (!(error instanceof mongo.MongoRuntimeError) || !error.message.startsWith('File not found for id ')) throw error
        }
      }
      return count
    },
  }
}
export type AssetsService = ReturnType<typeof assetsCreateService>
