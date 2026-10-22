// 在授权事务中完成 Claim 收录、精确重复判定及撤回，在一致快照中读取库内容。
import { randomUUID } from 'node:crypto'

import type { Asset } from '../../../contracts/control'
import type { DataTypeDefinition, DefinitionCatalog } from '../../../contracts/data-definition'
import { EvidenceMessage, type EvidenceApplicability, type EvidenceBasisRef, type EvidenceClaimRef, type EvidenceCollectResult, type EvidenceFrozenClaim, type EvidenceLibraryEntry, type EvidenceLibraryRef, type EvidencePage, type EvidenceQuery, type EvidenceRelationsView, type EvidenceSearchParams, type EvidenceUse, type EvidenceUsesPage } from '../../../contracts/evidence-library'
import type { GraphNode } from '../../../contracts/graph'
import type { EvidenceQueryPosition, EvidenceQueryStore, EvidenceUsagePosition } from '../../ports/evidence-query'
import type { Persistence, StorageSession } from '../../ports/persistence'
import { storeCreateInputHash, type GraphDocument } from '../graph/graph-record'
import type { RequestContext } from '../identity/identity-service'
import { definitionsDigest, definitionsParsePayload, definitionsValidatePayload } from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import type { ControlService } from '../workspace/workspace-service'
import { evidenceReadCommand, evidenceReadEnvelope, type EvidenceCommandEnvelope, type EvidenceParsedCommand } from './evidence-input'
import { evidenceParseAsset, evidenceParseCatalogDocument, evidenceParseEntryDocument, evidenceParseReceiptDocument, evidenceReadEntryView, type EvidenceAssetRefDocument, type EvidenceBasisSnapshot, type EvidenceCatalogDocument, type EvidenceEntryDocument, type EvidenceReceiptDocument } from './evidence-record'
import { evidenceTokenize } from './evidence-tokenize'
import { evidenceCaptureRelations, evidenceReadNodeReferencePaths, type EvidenceRelationSource } from './evidence-relations'
import { evidenceCreateUsageService } from './evidence-usage'
import { evidenceParseUseDocument, evidenceReadUseView } from './evidence-usage-record'

interface AssetDocument extends Omit<Asset, 'id'> { _id: string; state: 'ready' | 'deleted' }
interface FrozenNode { nodeSnapshot: GraphNode; definition: DataTypeDefinition; assets: Asset[]; nodeReferences: Array<{ path: string; targetId: string }> }
interface FrozenBasis { snapshots: EvidenceBasisSnapshot[]; assets: Asset[]; nodes: Array<{ source: EvidenceRelationSource; basisIndex: number }> }
interface EvidenceCursor { workspaceId: string; filterHash: string; libraryRevision: number; after: EvidenceQueryPosition }
type CollectCommand = Extract<EvidenceParsedCommand, { method: 'evidence.collect' }>
type WithdrawCommand = Extract<EvidenceParsedCommand, { method: 'evidence.withdraw' }>
type WriteResult = EvidenceCollectResult | EvidenceLibraryEntry
type ReadResult = EvidenceLibraryEntry | EvidencePage | EvidenceRelationsView | EvidenceUsesPage | EvidenceUse
interface UsageCursor { workspaceId: string; entryId: string; filterHash: string; usageRevision: number; after: EvidenceUsagePosition }

export interface EvidenceService {
  // 初始化收据、附件引用及 Mongo 专用查询索引，不执行任何用户数据迁移。
  initialize(): Promise<void>
  /** 校验 viewer 权限并在同一快照中读取固定条目或有界搜索结果。 */
  read(
    /* 包含已认证身份、可选读事务的请求上下文。 */ ctx: RequestContext,
    /* 已由公共边界解析的证据库读查询。 */ input: EvidenceQuery,
  ): Promise<ReadResult>
  /** 在已授权Run启动事务中固定最多32份active Claim材料及精确定义；每步1MiB，失败不写用户数据。 */
  freezeClaims(
    /* 已取得目标工作区写权限的启动事务。 */ ctx: RequestContext,
    /* 目标Map实际归属工作区。 */ workspaceId: string,
    /* 用户本步骤明确选择的库身份，不自动补全。 */ refs: readonly EvidenceLibraryRef[],
    /* 同次Run将冻结的不可变工作区定义目录。 */ catalog: DefinitionCatalog,
  ): Promise<EvidenceFrozenClaim[]>
  /** 在真实图CAS成功后沿用同一外层事务同步显式使用，提交失败会连同图与使用一起回滚。 */
  syncGraphUses(
    /* 已通过图权限/执行栅栏的活动事务。 */ session: StorageSession,
    /* 图提交前的真实内容。 */ before: GraphDocument,
    /* 同次正式提交后的真实节点与运行上下文。 */ after: GraphDocument,
    /* 当前授权动作来源，manual不继承旧producer的Work身份。 */ mode: 'manual' | 'work',
  ): Promise<void>
  /** 在已授权写事务中先确认用户/requestId 收据，再校验新输入、来源及固定依据并原子保存。 */
  dispatch(
    /* 必须由身份服务 transact 创建的已认证活动写事务。 */ ctx: RequestContext,
    /* 尚未解析固定字段的完整命令；事务失败会回滚条目、目录、收据和附件引用。 */ input: unknown,
  ): Promise<{ data: WriteResult; replayed: boolean }>
  /** 在资产删除的同一授权事务中检查永久冻结引用；撤回不会释放历史材料。 */
  assertAssetUnreferenced(
    /* 已取得对应工作区写栅栏的资产删除事务。 */ ctx: RequestContext,
    /* 准备逻辑删除的资产身份。 */ assetId: string,
  ): Promise<void>
}

export function evidenceCreateService(
  /* 提供事务、来源图和通用记录访问的持久化端口。 */
  database: Persistence,
  /* 拥有现行工作区授权栅栏和精确定义目录的管理服务。 */
  control: ControlService,
  /* 创建此服务时已经装配的 Mongo 有界查询端口。 */
  query: EvidenceQueryStore,
): EvidenceService {
  // 统一拥有收录生命周期与收据顺序，来源和库记录始终使用调用方的同一会话。
  const entries = database.records<EvidenceEntryDocument>('evidence_entries')
  const receipts = database.records<EvidenceReceiptDocument>('evidence_receipts')
  const catalogs = database.records<EvidenceCatalogDocument>('evidence_catalogs')
  const assetRefs = database.records<EvidenceAssetRefDocument>('evidence_asset_refs')
  const assets = database.records<AssetDocument>('control_assets')
  const usage = evidenceCreateUsageService(database, readEntry)

  async function readEntry(
    /* 与来源权限及图提交共用的可选存储会话。 */ session: StorageSession | null | undefined,
    /* 已经取得权限的目标工作区。 */ workspaceId: string,
    /* 需要读取当前管理状态及固定内容的条目身份。 */ entryId: string,
  ): Promise<EvidenceEntryDocument> {
    // 按身份读取历史条目，允许撤回状态，但拒绝跨工作区引用。
    const stored = await entries.get(entryId, session)
    if (!stored) throw new GraphError(404, 'EVIDENCE_NOT_FOUND', EvidenceMessage.NOT_FOUND)
    const entry = evidenceParseEntryDocument(stored)
    if (entry.workspaceId !== workspaceId) throw new GraphError(422, 'EVIDENCE_WORKSPACE_MISMATCH', EvidenceMessage.WORKSPACE_MISMATCH)
    return entry
  }

  async function readAsset(
    /* 冻结材料所在的活动事务。 */ ctx: RequestContext,
    /* 本次收录授权的工作区身份。 */ workspaceId: string,
    /* 已解析的资产 UUID。 */ assetId: string,
    /* 显式资产依据声明的摘要；节点定位器引用可省略。 */ expectedSha256?: string,
  ): Promise<Asset> {
    // 验证资产仍就绪、范围相同和摘要一致，冻结公开元数据而不读取可变来源。
    const document = await assets.get(assetId, ctx.session)
    if (!document) throw new GraphError(422, 'EVIDENCE_BASIS_INVALID', EvidenceMessage.BASIS_INVALID)
    const asset = evidenceParseAsset(document)
    if (document.state !== 'ready') throw new GraphError(422, 'EVIDENCE_BASIS_INVALID', EvidenceMessage.BASIS_INVALID)
    if (asset.workspaceId !== workspaceId) throw new GraphError(422, 'EVIDENCE_WORKSPACE_MISMATCH', EvidenceMessage.WORKSPACE_MISMATCH)
    if (expectedSha256 !== undefined && asset.sha256 !== expectedSha256) throw new GraphError(422, 'EVIDENCE_BASIS_INVALID', EvidenceMessage.BASIS_INVALID)
    return asset
  }

  async function freezeNode(
    /* 所有来源图、定义和资产都必须沿用的收录事务。 */ ctx: RequestContext,
    /* 不允许来源越过的工作区边界。 */ workspaceId: string,
    /* 指向一个精确节点内容版本的来源引用。 */ ref: EvidenceClaimRef,
    /* 已在同一事务中读取并完整验证的定义目录。 */ catalog: DefinitionCatalog,
    /* true 表示主要收录来源必须是注册的 factcheck Claim。 */ requireClaim: boolean,
    /* 当前收录事务已经取得的来源 Map 快照，避免每个邻域节点重复读取。 */ sourceMaps: Map<string, GraphDocument>,
  ): Promise<FrozenNode> {
    // 校验精确来源版本及注册 schema，保存独立节点快照并保护其声明的附件引用。
    const map = await readSourceMap(ctx, workspaceId, ref.mapId, sourceMaps)
    const node = map.nodes.find(
      /* 来源图中的一个已保存通用节点。 */ candidate => /* 同时在精确 Map 内匹配节点身份。 */ candidate.id === ref.nodeId,
    )
    if (!node) throw new GraphError(404, 'EVIDENCE_SOURCE_NOT_FOUND', EvidenceMessage.SOURCE_NOT_FOUND)
    if (node.revision !== ref.revision) throw new GraphError(409, 'EVIDENCE_SOURCE_VERSION_CONFLICT', EvidenceMessage.SOURCE_VERSION_CONFLICT, node.revision)
    if (requireClaim && node.typeId !== 'factcheck.claim') throw new GraphError(422, 'EVIDENCE_CLAIM_TYPE_INVALID', EvidenceMessage.CLAIM_TYPE_INVALID)
    const { payload, ...nodeFields } = node
    let parsed: ReturnType<typeof definitionsParsePayload> & { payload: GraphNode['payload'] }
    try {
      parsed = definitionsParsePayload(catalog, { id: node.typeId, version: node.typeVersion }, payload)
    } catch (error) {
      if (!(error instanceof GraphError)) throw error
      throw new GraphError(422, requireClaim ? 'EVIDENCE_CLAIM_TYPE_INVALID' : 'EVIDENCE_BASIS_INVALID', requireClaim ? EvidenceMessage.CLAIM_TYPE_INVALID : EvidenceMessage.BASIS_INVALID)
    }
    const frozenAssets: Asset[] = []
    for (const reference of parsed.references) {
      if (reference.definition.target.kind !== 'asset') continue
      frozenAssets.push(await readAsset(ctx, workspaceId, reference.value))
    }
    return { nodeSnapshot: { ...structuredClone(nodeFields), payload: parsed.payload }, definition: parsed.definition, assets: frozenAssets,
      nodeReferences: evidenceReadNodeReferencePaths(parsed.references) }
  }

  async function readSourceMap(
    /* 与新条目写入共享的收录事务。 */ ctx: RequestContext,
    /* 不允许来源材料越过的工作区身份。 */ workspaceId: string,
    /* 来源或显式依据明确指定的 Map。 */ mapId: string,
    /* 只属于本次收录事务的已验证图缓存。 */ sourceMaps: Map<string, GraphDocument>,
  ): Promise<GraphDocument> {
    // 一张来源图只读取一次并验证范围，引用绝不按同名节点搜索其他图。
    const existing = sourceMaps.get(mapId)
    if (existing) return existing
    const map = await database.graph(ctx.session).read(mapId)
    if (!map || map.deletedAt) throw new GraphError(404, 'EVIDENCE_SOURCE_NOT_FOUND', EvidenceMessage.SOURCE_NOT_FOUND)
    if (map.workspaceId !== workspaceId) throw new GraphError(422, 'EVIDENCE_WORKSPACE_MISMATCH', EvidenceMessage.WORKSPACE_MISMATCH)
    sourceMaps.set(mapId, map)
    return map
  }

  function relationSource(
    /* 已固定 Map、节点及版本的来源身份。 */ ref: EvidenceClaimRef,
    /* 已在同一事务中验证正文、定义与直接资产的节点。 */ frozen: FrozenNode,
  ): EvidenceRelationSource {
    // 让有限遍历只接收已冻结节点及其实际声明引用，不自行解释业务 schema。
    return { ref, nodeSnapshot: frozen.nodeSnapshot, definitionDigest: definitionsDigest(frozen.definition),
      nodeReferences: frozen.nodeReferences, assets: frozen.assets }
  }

  async function freezeBasis(
    /* 来源和库依据读取共享的授权事务。 */ ctx: RequestContext,
    /* 本次条目的固定工作区身份。 */ workspaceId: string,
    /* 已解析且保留原顺序的判断依据引用。 */ basisRefs: readonly EvidenceBasisRef[],
    /* 与来源节点一致的注册定义目录。 */ catalog: DefinitionCatalog,
    /* 与根 Claim 共用的本次事务来源图缓存。 */ sourceMaps: Map<string, GraphDocument>,
  ): Promise<FrozenBasis> {
    // 将每份材料验证后保存固定内容，库引用只接受当前可供新引用的条目。
    const snapshots: EvidenceBasisSnapshot[] = [], frozenAssets: Asset[] = []
    const nodes: FrozenBasis['nodes'] = []
    for (const [basisIndex, basis] of basisRefs.entries()) {
      if (basis.kind === 'manual') snapshots.push({ kind: basis.kind, text: basis.text })
      else if (basis.kind === 'node') {
        const frozen = await freezeNode(ctx, workspaceId, basis.ref, catalog, false, sourceMaps)
        snapshots.push({ kind: basis.kind, nodeSnapshot: frozen.nodeSnapshot, definitionDigest: definitionsDigest(frozen.definition) })
        frozenAssets.push(...frozen.assets)
        nodes.push({ source: relationSource(basis.ref, frozen), basisIndex })
      } else if (basis.kind === 'asset') {
        const asset = await readAsset(ctx, workspaceId, basis.assetId, basis.sha256)
        snapshots.push({ kind: basis.kind, asset })
        frozenAssets.push(asset)
      } else {
        const entry = await readEntry(ctx.session, workspaceId, basis.ref.entryId)
        if (entry.contentDigest !== basis.ref.contentDigest) throw new GraphError(422, 'EVIDENCE_DIGEST_MISMATCH', EvidenceMessage.DIGEST_MISMATCH)
        if (entry.status !== 'active') throw new GraphError(409, 'EVIDENCE_INACTIVE', EvidenceMessage.INACTIVE)
        snapshots.push({ kind: basis.kind, entry: evidenceReadEntryView(entry) })
        for (const assetId of entry.assetIds) frozenAssets.push(await readAsset(ctx, workspaceId, assetId))
      }
    }
    return { snapshots, assets: frozenAssets, nodes }
  }

  async function advanceCatalog(
    /* 本次条目或管理状态写入必须参与的授权事务。 */ ctx: RequestContext,
    /* 目录版本属于的工作区身份。 */ workspaceId: string,
  ): Promise<void> {
    // 只在新增条目或管理状态变化时推进库目录版本，让旧分页游标明确过期。
    const stored = await catalogs.get(workspaceId, ctx.session)
    if (!stored) await catalogs.insert({ _id: workspaceId, workspaceId, revision: 1 }, ctx.session)
    else {
      const current = evidenceParseCatalogDocument(stored)
      await catalogs.replace({ ...current, revision: current.revision + 1 }, ctx.session)
    }
  }

  async function collect(
    /* 已通过 editor 权限及幂等检查的写事务。 */ ctx: RequestContext,
    /* 已完成固定判断和范围解析的新收录命令。 */ command: CollectCommand,
  ): Promise<EvidenceCollectResult> {
    // 先冻结来源与判断材料，再按完整业务身份去重；相反判断仅返回冲突身份。
    const params = command.params
    const catalog = await control.definitions(ctx, params.workspaceId)
    const sourceMaps = new Map<string, GraphDocument>()
    const claim = await freezeNode(ctx, params.workspaceId, params.claim, catalog, true, sourceMaps)
    const basis = await freezeBasis(ctx, params.workspaceId, params.basisRefs, catalog, sourceMaps)
    const fixed = { claim: { origin: params.claim, type: { id: claim.nodeSnapshot.typeId, version: claim.nodeSnapshot.typeVersion },
      definitionDigest: definitionsDigest(claim.definition), nodeSnapshot: claim.nodeSnapshot }, confidence: params.confidence,
      applicability: params.applicability, decision: { reason: params.reason, basisRefs: params.basisRefs } }
    if (Buffer.byteLength(JSON.stringify({ fixed, basis: basis.snapshots })) > 1_048_576) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
    const scopeIdentity = createScopeIdentity(params.applicability)
    const dedupKey = storeCreateInputHash({ workspaceId: params.workspaceId, origin: params.claim, applicability: scopeIdentity,
      confidence: params.confidence, basisDigest: storeCreateInputHash({ reason: params.reason, refs: params.basisRefs, snapshots: basis.snapshots }) })
    const storedPrior = await entries.first({ workspaceId: params.workspaceId, dedupKey }, ctx.session)
    const prior = storedPrior ? evidenceParseEntryDocument(storedPrior) : null
    const content = claim.nodeSnapshot.payload.content
    if (typeof content !== 'string' || !content.trim()) throw new GraphError(422, 'EVIDENCE_CLAIM_TYPE_INVALID', EvidenceMessage.CLAIM_TYPE_INVALID)
    const fingerprint = storeCreateInputHash({ content: content.normalize('NFC').replace(/\s+/g, ' ').trim(), applicability: scopeIdentity })
    const conflictEntryIds = await query.conflicts(params.workspaceId, fingerprint, params.confidence === 0 ? 1 : 0, ctx.session)
    if (prior) return { entry: evidenceReadEntryView(prior), replayed: false, existing: true, conflictEntryIds }
    const id = randomUUID(), collectedAt = new Date(await database.now()).toISOString()
    const relations = await evidenceCaptureRelations(relationSource(params.claim, claim), basis.nodes, collectedAt,
      async (/* 遍历明确指定且属于同一工作区的来源 Map。 */ mapId) => {
        // 取得本次收录事务已校验的完整来源快照。
        return readSourceMap(ctx, params.workspaceId, mapId, sourceMaps)
      },
      async (/* 实际边或声明引用指向的同 Map 精确节点版本。 */ ref) => {
        // 捕获每个邻域节点前仍完整验证 schema 与直接资产引用。
        return relationSource(ref, await freezeNode(ctx, params.workspaceId, ref, catalog, false, sourceMaps))
      })
    if (Buffer.byteLength(JSON.stringify({ fixed, basis: basis.snapshots, relationSnapshot: relations.snapshot })) > 1_048_576) {
      throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
    }
    const frozenAssets = new Map<string, Asset>()
    for (const asset of [...claim.assets, ...basis.assets, ...relations.assets]) frozenAssets.set(asset.id, asset)
    const document: EvidenceEntryDocument = { _id: id, id, workspaceId: params.workspaceId, revision: 0, ...structuredClone(fixed),
      collectedBy: ctx.actor.userId, collectedAt, contentDigest: storeCreateInputHash({ ...fixed, basisSnapshots: basis.snapshots,
        relationSnapshot: relations.snapshot }),
      status: 'active', statusReason: null, replacementEntryId: null, dedupKey, fingerprint, tokens: evidenceTokenize(content),
      basisSnapshots: structuredClone(basis.snapshots), assetIds: [...frozenAssets.keys()], relationSnapshot: relations.snapshot }
    await entries.insert(document, ctx.session)
    for (const asset of frozenAssets.values()) {
      await assetRefs.insert({ _id: storeCreateInputHash({ entryId: id, assetId: asset.id }), workspaceId: params.workspaceId,
        entryId: id, assetId: asset.id, sha256: asset.sha256 }, ctx.session)
    }
    await advanceCatalog(ctx, params.workspaceId)
    return { entry: evidenceReadEntryView(document), replayed: false, existing: false, conflictEntryIds }
  }

  async function withdraw(
    /* 已通过 editor 权限及幂等检查的管理事务。 */ ctx: RequestContext,
    /* 只允许修改管理状态及理由的已解析命令。 */ command: WithdrawCommand,
  ): Promise<EvidenceLibraryEntry> {
    // 按预期管理版本保存撤回事实，固定内容和永久材料引用继续保留。
    const entry = await readEntry(ctx.session, command.params.workspaceId, command.params.entryId)
    if (entry.revision !== command.params.expectedRevision) throw new GraphError(409, 'EVIDENCE_REVISION_CONFLICT', EvidenceMessage.REVISION_CONFLICT, entry.revision)
    if (entry.status !== 'active') throw new GraphError(409, 'EVIDENCE_INACTIVE', EvidenceMessage.INACTIVE)
    const document: EvidenceEntryDocument = { ...entry, revision: entry.revision + 1, status: 'withdrawn', statusReason: command.params.reason }
    await entries.replace(document, ctx.session)
    await advanceCatalog(ctx, command.params.workspaceId)
    return evidenceReadEntryView(document)
  }

  async function readSnapshot(
    /* 已绑定一致存储快照的只读身份上下文。 */ ctx: RequestContext,
    /* 解析完成且包含固定条目、关系或有界搜索的查询。 */ input: EvidenceQuery,
  ): Promise<ReadResult> {
    // 授权、库版本和实际查询共享一个快照，防止页结果与游标版本来自不同提交。
    await control.requireRole(ctx, input.params.workspaceId, 'viewer')
    if (input.method === 'evidence.get') return evidenceReadEntryView(await readEntry(ctx.session, input.params.workspaceId, input.params.entryId))
    if (input.method === 'evidence.relations') {
      const entry = await readEntry(ctx.session, input.params.workspaceId, input.params.entryId)
      return { workspaceId: entry.workspaceId, entryId: entry.id, contentDigest: entry.contentDigest,
        snapshot: entry.relationSnapshot === undefined ? null : structuredClone(entry.relationSnapshot) }
    }
    if (input.method === 'evidence.use.get') {
      await readEntry(ctx.session, input.params.workspaceId, input.params.entryId)
      const stored = await query.use(input.params.workspaceId, input.params.entryId, input.params.usageId, ctx.session)
      if (!stored) throw new GraphError(404, 'EVIDENCE_NOT_FOUND', EvidenceMessage.NOT_FOUND)
      const use = evidenceParseUseDocument(stored)
      if (use.workspaceId !== input.params.workspaceId || use.ref.entryId !== input.params.entryId) {
        throw new GraphError(404, 'EVIDENCE_NOT_FOUND', EvidenceMessage.NOT_FOUND)
      }
      return evidenceReadUseView(use)
    }
    if (input.method === 'evidence.uses') {
      const params = input.params
      await readEntry(ctx.session, params.workspaceId, params.entryId)
      const usageRevision = await usage.readRevision(ctx.session, params.workspaceId, params.entryId)
      const filterHash = storeCreateInputHash({ includeHistory: params.includeHistory ?? false, limit: params.limit ?? 25 })
      const after = readUsageCursor(params, filterHash, usageRevision)
      const page = await query.uses({ workspaceId: params.workspaceId, entryId: params.entryId,
        includeHistory: params.includeHistory ?? false, limit: params.limit ?? 25, after }, ctx.session)
      const cursor: UsageCursor | null = page.hasMore && page.after ? { workspaceId: params.workspaceId,
        entryId: params.entryId, filterHash, usageRevision, after: page.after } : null
      return { workspaceId: params.workspaceId, entryId: params.entryId, items: page.items,
        nextCursor: cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null, usageRevision }
    }
    const params = input.params
    const storedCatalog = await catalogs.get(params.workspaceId, ctx.session)
    const libraryRevision = storedCatalog ? evidenceParseCatalogDocument(storedCatalog).revision : 0
    const queryTokens = evidenceTokenize(params.query ?? '')
    const matchNone = (params.query?.trim().length ?? 0) > 0 && queryTokens.length === 0
    const filterHash = storeCreateInputHash({ queryTokens, matchNone, confidence: params.confidence ?? null, subject: params.subject ?? null,
      event: params.event ?? null, includeInactive: params.includeInactive ?? false, limit: params.limit ?? 25 })
    const after = readCursor(params, filterHash, libraryRevision)
    const page = await query.search({ workspaceId: params.workspaceId, queryTokens, matchNone, confidence: params.confidence,
      subject: params.subject, event: params.event, includeInactive: params.includeInactive ?? false, after, limit: params.limit ?? 25 }, ctx.session)
    const cursor: EvidenceCursor | null = page.hasMore && page.after ? { workspaceId: params.workspaceId, filterHash, libraryRevision, after: page.after } : null
    return { items: page.items, nextCursor: cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null, libraryRevision }
  }

  return {
    async initialize(): Promise<void> {
      // 为已装配的证据库建立查询、幂等收据及永久材料引用索引。
      await query.initialize()
      await receipts.index(['userId', 'requestId'], { unique: true })
      await receipts.index(['workspaceId'])
      await assetRefs.index(['assetId', 'workspaceId'])
      await assetRefs.index(['entryId', 'assetId'], { unique: true })
    },
    async read(
      /* 已认证、可以沿用现有会话的请求上下文。 */ ctx: RequestContext,
      /* 已由边界解析、需要在一致快照中执行的读查询。 */ input: EvidenceQuery,
    ): Promise<ReadResult> {
      // 为无会话读取建立一致快照，读操作不取得管理写栅栏。
      if (ctx.session) return readSnapshot({ ...ctx, mutation: false }, input)
      return database.transaction(async (
        /* 此次权限、目录与分页结果共同读取的存储会话。 */ session,
      ) => {
        // 让第一页目录版本和实际结果绑定同一个已提交数据库快照。
        return readSnapshot({ ...ctx, session, mutation: false }, input)
      })
    },
    async freezeClaims(
      /* 已经取得目标图工作区写权限的Run启动事务。 */ ctx: RequestContext,
      /* 本次有限计划所在工作区。 */ workspaceId: string,
      /* 本步骤用户明确选择的精确库引用。 */ refs: readonly EvidenceLibraryRef[],
      /* 本次Run启动冻结的工作区定义目录。 */ catalog: DefinitionCatalog,
    ): Promise<EvidenceFrozenClaim[]> {
      // 不读取当前来源Map；只固定active库内容及与原定义摘要一致的精确Claim定义。
      if (!ctx.mutation || !ctx.session?.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', EvidenceMessage.TRANSACTION_REQUIRED)
      await control.requireRole(ctx, workspaceId, 'editor')
      if (refs.length > 32) throw new GraphError(422, 'EVIDENCE_SELECTION_LIMIT', EvidenceMessage.SELECTION_LIMIT)
      if (new Set(refs.map((/* 本步骤的一份精确材料身份。 */ ref) => /* 同一条目不能用不同摘要重复选择。 */ ref.entryId)).size !== refs.length) {
        throw new GraphError(422, 'INVALID_ARGUMENT', EvidenceMessage.INPUT_INVALID)
      }
      const claims: EvidenceFrozenClaim[] = []
      const selected = [...refs].sort((/* 待稳定排序的首个选择。 */ left, /* 第二个选择。 */ right) =>
        /* UI选择顺序不改变固定集合与Operation规格。 */ left.entryId.localeCompare(right.entryId))
      for (const ref of selected) {
        const entry = await readEntry(ctx.session, workspaceId, ref.entryId)
        if (entry.contentDigest !== ref.contentDigest) throw new GraphError(422, 'EVIDENCE_DIGEST_MISMATCH', EvidenceMessage.DIGEST_MISMATCH)
        if (entry.status !== 'active') throw new GraphError(409, 'EVIDENCE_INACTIVE', EvidenceMessage.INACTIVE)
        const definition = catalog.dataTypes.find((/* Run实际冻结的注册类型。 */ type) =>
          /* 库来源必须对应相同精确Claim版本。 */ type.id === entry.claim.type.id && type.version === entry.claim.type.version)
        if (!definition || definition.id !== 'factcheck.claim' || definitionsDigest(definition) !== entry.claim.definitionDigest) {
          throw new GraphError(422, 'EVIDENCE_CLAIM_TYPE_INVALID', EvidenceMessage.CLAIM_TYPE_INVALID)
        }
        try { definitionsValidatePayload(catalog, entry.claim.type, entry.claim.nodeSnapshot.payload) }
        catch (error) {
          if (!(error instanceof GraphError)) throw error
          throw new GraphError(422, 'EVIDENCE_CLAIM_TYPE_INVALID', EvidenceMessage.CLAIM_TYPE_INVALID)
        }
        const snapshot = { ref: structuredClone(ref), entry: evidenceReadEntryView(entry), definition: structuredClone(definition) }
        claims.push({ ...snapshot, snapshotDigest: definitionsDigest(snapshot) })
      }
      if (Buffer.byteLength(JSON.stringify(claims)) > 1_048_576) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
      return claims
    },
    async syncGraphUses(
      /* 已取得图写权限且CAS成功的真实外层事务。 */ session: StorageSession,
      /* 正式图提交前的快照。 */ before: GraphDocument,
      /* 真实提交后的图文档。 */ after: GraphDocument,
      /* 本次变更实际来源。 */ mode: 'manual' | 'work',
    ): Promise<void> {
      // 使用记录和已经成功的图 CAS 共用当前外层事务。
      await usage.syncGraphUses(session, before, after, mode)
    },
    async dispatch(
      /* 身份服务建立的已授权写事务。 */ ctx: RequestContext,
      /* 需要按收据优先顺序解析和执行的完整外部命令。 */ input: unknown,
    ): Promise<{ data: WriteResult; replayed: boolean }> {
      // 工作区写栅栏串行化同库并发，然后先检查收据，再验证新来源与提交所有库记录。
      if (!ctx.mutation || !ctx.session?.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', EvidenceMessage.TRANSACTION_REQUIRED)
      const envelope = evidenceReadEnvelope(input)
      await control.requireRole(ctx, envelope.params.workspaceId, 'editor')
      const key = storeCreateInputHash({ userId: ctx.actor.userId, requestId: envelope.requestId })
      const inputHash = hashInput(envelope)
      const storedReceipt = await receipts.get(key, ctx.session)
      if (storedReceipt) {
        const receipt = evidenceParseReceiptDocument(storedReceipt)
        if (receipt.inputHash !== inputHash || receipt.method !== envelope.method || receipt.workspaceId !== envelope.params.workspaceId) {
          throw new GraphError(409, 'IDEMPOTENCY_CONFLICT', EvidenceMessage.IDEMPOTENCY_CONFLICT)
        }
        const data = structuredClone(receipt.data)
        if ('entry' in data) data.replayed = true
        return { data, replayed: true }
      }
      const command = evidenceReadCommand(envelope)
      const data = command.method === 'evidence.collect' ? await collect(ctx, command) : await withdraw(ctx, command)
      await receipts.insert({ _id: key, workspaceId: envelope.params.workspaceId, userId: ctx.actor.userId,
        requestId: envelope.requestId, method: envelope.method, inputHash, data: structuredClone(data) }, ctx.session)
      return { data, replayed: false }
    },
    async assertAssetUnreferenced(
      /* 与逻辑删除同一工作区写授权事务。 */ ctx: RequestContext,
      /* 即将删除且已经校验权限的资产 UUID。 */ assetId: string,
    ): Promise<void> {
      // 任何历史收录引用都会阻止删除资产；同工作区栅栏与并发收录共同仲裁。
      if (!ctx.mutation || !ctx.session?.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', EvidenceMessage.TRANSACTION_REQUIRED)
      if (await assetRefs.first({ assetId }, ctx.session)) throw new GraphError(409, 'ASSET_REFERENCED', EvidenceMessage.ASSET_REFERENCED)
    },
  }
}

function hashInput(
  /* 幂等身份已解析、固定字段仍保持边界原样的命令信封。 */ envelope: EvidenceCommandEnvelope,
): string {
  // 用所有命令字段绑定收据；非法循环值作为输入错误，不泄露序列化异常。
  try { return storeCreateInputHash({ method: envelope.method, params: envelope.params }) }
  catch { throw new GraphError(400, 'INVALID_ARGUMENT', EvidenceMessage.INPUT_INVALID) }
}

function createScopeIdentity(
  /* 已验证但必须原样保存到条目的适用范围。 */ applicability: EvidenceApplicability,
): EvidenceApplicability {
  // 仅为判重统一等价时区及条件顺序，不回写范围原文或将未知时间解释为永久有效。
  return { ...applicability, conditions: [...applicability.conditions].sort(), time: applicability.time === null ? null
    : { from: new Date(applicability.time.from).toISOString(), to: new Date(applicability.time.to).toISOString() } }
}

function readCursor(
  /* 包含可选不可信游标的已解析搜索条件。 */ params: EvidenceSearchParams,
  /* 本次查询所有筛选和页大小的规范摘要。 */ filterHash: string,
  /* 与实际搜索共用快照的目录版本。 */ libraryRevision: number,
): EvidenceQueryPosition | undefined {
  // 将翻页位置绑定工作区、筛选与库版本，拒绝跨查询使用和变化后的继续分页。
  if (!params.cursor) return undefined
  let value: unknown
  try { value = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) } catch { invalidCursor() }
  if (!isRecord(value) || value.workspaceId !== params.workspaceId || value.filterHash !== filterHash || typeof value.libraryRevision !== 'number'
    || !Number.isSafeInteger(value.libraryRevision) || value.libraryRevision < 0 || !isRecord(value.after)
    || typeof value.after.collectedAt !== 'string' || !Number.isFinite(Date.parse(value.after.collectedAt))
    || typeof value.after.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.after.id)) invalidCursor()
  if (value.libraryRevision !== libraryRevision) throw new GraphError(409, 'EVIDENCE_CURSOR_EXPIRED', EvidenceMessage.CURSOR_EXPIRED)
  return { collectedAt: value.after.collectedAt, id: value.after.id }
}

function isRecord(
  /* 解码游标中尚未验证对象形状的值。 */ value: unknown,
): value is Record<string, unknown> {
  // 在读取游标字段前区分普通 JSON 对象与数组或空值。
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readUsageCursor(
  /* 当前库条目的使用筛选，含可选外部游标。 */ params: Extract<EvidenceQuery, { method: 'evidence.uses' }>['params'],
  /* 历史开关和页大小共同组成的规范查询摘要。 */ filterHash: string,
  /* 同次只读快照中取得的独立使用目录版本。 */ usageRevision: number,
): EvidenceUsagePosition | undefined {
  // 分页身份绑定工作区、条目、筛选和使用版本；库撤回本身不推进使用目录。
  if (!params.cursor) return undefined
  let value: unknown
  try { value = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) } catch { invalidCursor() }
  if (!isRecord(value) || value.workspaceId !== params.workspaceId || value.entryId !== params.entryId || value.filterHash !== filterHash
    || typeof value.usageRevision !== 'number' || !Number.isSafeInteger(value.usageRevision) || value.usageRevision < 0
    || !isRecord(value.after) || typeof value.after.startedAt !== 'string' || !Number.isFinite(Date.parse(value.after.startedAt))
    || typeof value.after.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.after.id)) invalidCursor()
  if (value.usageRevision !== usageRevision) throw new GraphError(409, 'EVIDENCE_CURSOR_EXPIRED', EvidenceMessage.CURSOR_EXPIRED)
  return { startedAt: value.after.startedAt, id: value.after.id }
}

function invalidCursor(): never {
  // 统一报告无法解析或不属于本次查询的游标。
  throw new GraphError(422, 'EVIDENCE_CURSOR_INVALID', EvidenceMessage.CURSOR_INVALID)
}
