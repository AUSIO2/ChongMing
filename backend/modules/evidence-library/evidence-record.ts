// 保存证据库内部记录与固定依据快照，并投影不会泄露索引字段的公开条目。
import type { Asset } from '../../../contracts/control'
import type { JsonValue } from '../../../contracts/data-definition'
import { EvidenceMessage, type EvidenceCollectResult, type EvidenceLibraryEntry, type EvidenceRelationEdge, type EvidenceRelationNode, type EvidenceRelationSnapshot } from '../../../contracts/evidence-library'
import type { GraphEdge, GraphNode } from '../../../contracts/graph'
import { storeCreateInputHash } from '../graph/graph-record'
import { GraphError } from '../shared/domain-error'
import { graphReadSourceAnchors } from '../shared/source-anchors'
import { evidenceReadCommand, evidenceReadEnvelope } from './evidence-input'
import { evidenceCreateRelationNodeKey } from './evidence-relations'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export type EvidenceBasisSnapshot =
  | { kind: 'manual'; text: string }
  | { kind: 'node'; nodeSnapshot: GraphNode; definitionDigest: string }
  | { kind: 'asset'; asset: Asset }
  | { kind: 'library'; entry: EvidenceLibraryEntry }

export interface EvidenceEntryDocument extends EvidenceLibraryEntry {
  _id: string
  dedupKey: string
  fingerprint: string
  tokens: string[]
  basisSnapshots: EvidenceBasisSnapshot[]
  assetIds: string[]
  relationSnapshot?: EvidenceRelationSnapshot
}

export interface EvidenceCatalogDocument {
  _id: string
  workspaceId: string
  revision: number
}

export interface EvidenceReceiptDocument {
  _id: string
  workspaceId: string
  userId: string
  requestId: string
  method: 'evidence.collect' | 'evidence.withdraw'
  inputHash: string
  data: EvidenceCollectResult | EvidenceLibraryEntry
}

export interface EvidenceAssetRefDocument {
  _id: string
  workspaceId: string
  entryId: string
  assetId: string
  sha256: string
}

export function evidenceParseEntryDocument(
  /* 持久化端口返回的未知库记录，尚未建立固定内容及索引字段不变量。 */
  value: unknown,
): EvidenceEntryDocument {
  // 校验固定内容、冻结依据与内部字段，并重算摘要阻止损坏记录成为新收录依据。
  const document = readRecord(value)
  const entry = readEntry(document)
  const basisSnapshots: EvidenceBasisSnapshot[] = []
  for (const snapshot of readArray(document.basisSnapshots, 64)) basisSnapshots.push(readBasisSnapshot(snapshot))
  const parsed: EvidenceEntryDocument = { ...entry, _id: readId(document._id),
    dedupKey: readDigest(document.dedupKey), fingerprint: readDigest(document.fingerprint),
    tokens: readStrings(document.tokens, 4096, false), basisSnapshots, assetIds: readStrings(document.assetIds, undefined, true) }
  if (Object.prototype.hasOwnProperty.call(document, 'relationSnapshot')) {
    parsed.relationSnapshot = readRelationSnapshot(document.relationSnapshot, entry)
  }
  if (parsed._id !== parsed.id || basisSnapshots.length !== entry.decision.basisRefs.length) invalidRecord()
  for (const [index, basis] of entry.decision.basisRefs.entries()) {
    const snapshot = basisSnapshots[index]
    if (!snapshot || snapshot.kind !== basis.kind) invalidRecord()
    if (basis.kind === 'manual' && snapshot.kind === 'manual' && basis.text !== snapshot.text) invalidRecord()
    if (basis.kind === 'node' && snapshot.kind === 'node'
      && (basis.ref.nodeId !== snapshot.nodeSnapshot.id || basis.ref.revision !== snapshot.nodeSnapshot.revision)) invalidRecord()
    if (basis.kind === 'asset' && snapshot.kind === 'asset'
      && (basis.assetId !== snapshot.asset.id || basis.sha256 !== snapshot.asset.sha256
        || snapshot.asset.workspaceId !== entry.workspaceId || !parsed.assetIds.includes(snapshot.asset.id))) invalidRecord()
    if (basis.kind === 'library' && snapshot.kind === 'library'
      && (basis.ref.entryId !== snapshot.entry.id || basis.ref.contentDigest !== snapshot.entry.contentDigest
        || snapshot.entry.workspaceId !== entry.workspaceId)) invalidRecord()
  }
  const fixed = { claim: parsed.claim, confidence: parsed.confidence,
    applicability: parsed.applicability, decision: parsed.decision, basisSnapshots: parsed.basisSnapshots }
  const digest = storeCreateInputHash(parsed.relationSnapshot === undefined ? fixed
    : { ...fixed, relationSnapshot: parsed.relationSnapshot })
  if (digest !== parsed.contentDigest) invalidRecord()
  return parsed
}

export function evidenceParseReceiptDocument(
  /* 从收据集合解码、尚未验证幂等身份与返回内容的历史记录。 */
  value: unknown,
): EvidenceReceiptDocument {
  // 验证用户与请求绑定以及该方法原先接受的结果，避免重放返回损坏内容。
  const receipt = readRecord(value)
  const _id = readDigest(receipt._id), workspaceId = readId(receipt.workspaceId)
  const userId = readId(receipt.userId), requestId = readId(receipt.requestId), inputHash = readDigest(receipt.inputHash)
  if (_id !== storeCreateInputHash({ userId, requestId })) invalidRecord()
  if (receipt.method === 'evidence.withdraw') {
    const data = readEntry(receipt.data)
    if (data.workspaceId !== workspaceId || data.status !== 'withdrawn') invalidRecord()
    return { _id, workspaceId, userId, requestId, method: receipt.method, inputHash, data }
  }
  if (receipt.method !== 'evidence.collect') invalidRecord()
  const result = readRecord(receipt.data), entry = readEntry(result.entry)
  if (entry.workspaceId !== workspaceId || typeof result.replayed !== 'boolean' || typeof result.existing !== 'boolean') invalidRecord()
  return { _id, workspaceId, userId, requestId, method: receipt.method, inputHash,
    data: { entry, replayed: result.replayed, existing: result.existing,
      conflictEntryIds: readStrings(result.conflictEntryIds, 32, true) } }
}

export function evidenceParseCatalogDocument(
  /* 目录集合返回的未知版本记录，决定分页游标是否仍然有效。 */
  value: unknown,
): EvidenceCatalogDocument {
  // 拒绝跨身份或无效目录版本，确保游标版本不会由泛型断言隐式接受。
  const catalog = readRecord(value)
  const _id = readId(catalog._id), workspaceId = readId(catalog.workspaceId), revision = readRevision(catalog.revision)
  if (_id !== workspaceId) invalidRecord()
  return { _id, workspaceId, revision }
}

export function evidenceParseAsset(
  /* 资产集合的未知记录；允许附带 blob 等内部字段，状态是否可引用由服务判断。 */
  value: unknown,
): Asset {
  // 校验持久化资产身份、合法状态和完整元数据，并将内部主键投影为公共身份。
  const document = readRecord(value)
  if (document.state !== 'ready' && document.state !== 'deleted') invalidRecord()
  return readAssetView({ ...document, id: readId(document._id) })
}

export function evidenceReadEntryView(
  /* 包含查询索引和冻结材料、已经由库模块建立的内部持久化条目。 */
  document: EvidenceEntryDocument,
): EvidenceLibraryEntry {
  // 只投影公共固定字段及当前管理状态，返回独立副本防止调用方改写库内容。
  return structuredClone({ id: document.id, workspaceId: document.workspaceId, revision: document.revision,
    claim: document.claim, confidence: document.confidence, applicability: document.applicability, decision: document.decision,
    collectedBy: document.collectedBy, collectedAt: document.collectedAt, contentDigest: document.contentDigest,
    status: document.status, statusReason: document.statusReason, replacementEntryId: document.replacementEntryId })
}

function readEntry(
  /* 需要建立公共固定内容、管理状态及来源身份不变量的未知条目。 */
  value: unknown,
): EvidenceLibraryEntry {
  // 复用新收录输入规则校验固定字段，再核对节点快照与来源引用完全一致。
  const entry = readRecord(value), claim = readRecord(entry.claim), decision = readRecord(entry.decision)
  const id = readId(entry.id), workspaceId = readId(entry.workspaceId)
  let parsed: Extract<ReturnType<typeof evidenceReadCommand>, { method: 'evidence.collect' }>
  try {
    parsed = evidenceReadCommand(evidenceReadEnvelope({ method: 'evidence.collect', requestId: id, params: { workspaceId,
      claim: claim.origin, confidence: entry.confidence, applicability: entry.applicability,
      reason: decision.reason, basisRefs: decision.basisRefs } }))
  } catch { invalidRecord() }
  const nodeSnapshot = evidenceParseNodeSnapshot(claim.nodeSnapshot), type = readRecord(claim.type)
  const typeId = readText(type.id), version = readRevision(type.version, 1)
  if (typeId !== 'factcheck.claim' || nodeSnapshot.typeId !== typeId || nodeSnapshot.typeVersion !== version
    || nodeSnapshot.id !== parsed.params.claim.nodeId || nodeSnapshot.revision !== parsed.params.claim.revision
    || typeof nodeSnapshot.payload.content !== 'string' || !nodeSnapshot.payload.content.trim()) invalidRecord()
  const status = entry.status
  if (status !== 'active' && status !== 'withdrawn' && status !== 'superseded') invalidRecord()
  const statusReason = entry.statusReason === null ? null : readText(entry.statusReason)
  const replacementEntryId = entry.replacementEntryId === null ? null : readId(entry.replacementEntryId)
  if (status === 'active' && (statusReason !== null || replacementEntryId !== null)
    || status !== 'active' && statusReason === null || status === 'withdrawn' && replacementEntryId !== null
    || status === 'superseded' && (replacementEntryId === null || replacementEntryId === id)) invalidRecord()
  return { id, workspaceId, revision: readRevision(entry.revision),
    claim: { origin: parsed.params.claim, type: { id: typeId, version },
      definitionDigest: readDigest(claim.definitionDigest), nodeSnapshot },
    confidence: parsed.params.confidence, applicability: parsed.params.applicability,
    decision: { reason: parsed.params.reason, basisRefs: parsed.params.basisRefs },
    collectedBy: readId(entry.collectedBy), collectedAt: readTimestamp(entry.collectedAt),
    contentDigest: readDigest(entry.contentDigest), status, statusReason, replacementEntryId }
}

function readBasisSnapshot(
  /* 与显式依据引用顺序对应、尚未验证冻结内容的单份历史材料。 */
  value: unknown,
): EvidenceBasisSnapshot {
  // 按材料种类建立固定快照，拒绝未知种类和不完整的节点、资产或库条目。
  const snapshot = readRecord(value)
  if (snapshot.kind === 'manual') return { kind: snapshot.kind, text: readText(snapshot.text) }
  if (snapshot.kind === 'node') return { kind: snapshot.kind, nodeSnapshot: evidenceParseNodeSnapshot(snapshot.nodeSnapshot),
    definitionDigest: readDigest(snapshot.definitionDigest) }
  if (snapshot.kind === 'asset') return { kind: snapshot.kind, asset: readAssetView(snapshot.asset) }
  if (snapshot.kind === 'library') return { kind: snapshot.kind, entry: readEntry(snapshot.entry) }
  return invalidRecord()
}

function readRelationSnapshot(
  /* 新收录保存的未知关系字段；字段缺失由上层保留旧摘要，显式 null 属于损坏。 */ value: unknown,
  /* 已验证固定 Claim 身份和收录时间的公共条目。 */ entry: EvidenceLibraryEntry,
): EvidenceRelationSnapshot {
  // 校验邻域容量、精确根、完整端点和依据位置，读取不补抓当前来源图。
  const snapshot = readRecord(value)
  if (snapshot.version !== 1 || typeof snapshot.truncated !== 'boolean') invalidRecord()
  const capturedAt = readTimestamp(snapshot.capturedAt), rootKey = readDigest(snapshot.rootKey)
  if (capturedAt !== entry.collectedAt) invalidRecord()
  const nodes: EvidenceRelationNode[] = []
  const nodesByKey = new Map<string, EvidenceRelationNode>()
  for (const value of readArray(snapshot.nodes, 128)) {
    const node = readRecord(value), ref = readRecord(node.ref)
    const parsedRef = { mapId: readId(ref.mapId), nodeId: readId(ref.nodeId), revision: readRevision(ref.revision) }
    const key = readDigest(node.key), nodeSnapshot = evidenceParseNodeSnapshot(node.nodeSnapshot)
    const role = node.role
    if (role !== 'claim' && role !== 'upstream' && role !== 'downstream' && role !== 'basis' && role !== 'dependency') invalidRecord()
    if (key !== evidenceCreateRelationNodeKey(parsedRef) || nodesByKey.has(key)
      || parsedRef.nodeId !== nodeSnapshot.id || parsedRef.revision !== nodeSnapshot.revision) invalidRecord()
    const parsedNode: EvidenceRelationNode = { key, ref: parsedRef, nodeSnapshot, definitionDigest: readDigest(node.definitionDigest), role }
    nodes.push(parsedNode)
    nodesByKey.set(key, parsedNode)
  }
  const root = nodesByKey.get(rootKey)
  if (!root || root.role !== 'claim' || rootKey !== evidenceCreateRelationNodeKey(entry.claim.origin)
    || root.definitionDigest !== entry.claim.definitionDigest
    || storeCreateInputHash(root.nodeSnapshot) !== storeCreateInputHash(entry.claim.nodeSnapshot)
    || nodes.filter((/* 已校验的固定邻域节点。 */ node) => /* 根 Claim 角色必须唯一。 */ node.role === 'claim').length !== 1) invalidRecord()
  const edges: EvidenceRelationEdge[] = []
  const edgeKeys = new Set<string>()
  for (const value of readArray(snapshot.edges, 256)) {
    const relation = readRecord(value), key = readDigest(relation.key)
    const from = readDigest(relation.from), to = readDigest(relation.to)
    const fromNode = nodesByKey.get(from), toNode = nodesByKey.get(to)
    if (edgeKeys.has(key) || !fromNode || !toNode) invalidRecord()
    edgeKeys.add(key)
    if (relation.kind === 'graph') {
      const mapId = readId(relation.mapId), edge = readEdge(relation.edge)
      if (fromNode.ref.mapId !== mapId || toNode.ref.mapId !== mapId
        || fromNode.ref.nodeId !== edge.from || toNode.ref.nodeId !== edge.to
        || key !== storeCreateInputHash({ kind: relation.kind, mapId, edgeId: edge.id, revision: edge.revision })) invalidRecord()
      if (edge.sourceAnchors?.some((/* 已验证形状的实际来源锚点。 */ anchor) =>
        /* 旧锚点可以留存，但不能来自尚不存在的未来来源版本。 */ anchor.sourceRevision > fromNode.ref.revision)) invalidRecord()
      edges.push({ key, kind: relation.kind, from, to, mapId, edge })
    } else if (relation.kind === 'payload') {
      const mapId = readId(relation.mapId), path = readText(relation.path)
      if (!/^\/(?:[^~]|~[01])*$/.test(path) || fromNode.ref.mapId !== mapId || toNode.ref.mapId !== mapId
        || key !== storeCreateInputHash({ kind: relation.kind, from, to, mapId, path })
        || readNodePointer(fromNode.nodeSnapshot, path) !== toNode.ref.nodeId) invalidRecord()
      edges.push({ key, kind: relation.kind, from, to, mapId, path })
    } else if (relation.kind === 'basis') {
      const basisIndex = readRevision(relation.basisIndex), basis = entry.decision.basisRefs[basisIndex]
      if (!basis || basis.kind !== 'node' || to !== rootKey
        || from !== evidenceCreateRelationNodeKey(basis.ref)
        || key !== storeCreateInputHash({ kind: relation.kind, from, to, basisIndex })) invalidRecord()
      edges.push({ key, kind: relation.kind, from, to, basisIndex })
    } else invalidRecord()
  }
  for (const [basisIndex, basis] of entry.decision.basisRefs.entries()) {
    if (basis.kind !== 'node') continue
    const key = evidenceCreateRelationNodeKey(basis.ref)
    if (!nodesByKey.has(key) || !edges.some((/* 已验证的固定关系。 */ edge) =>
      /* 显式 node 依据必须保留原位置和它连接根的真实选择关系。 */ edge.kind === 'basis' && edge.basisIndex === basisIndex && edge.from === key)) invalidRecord()
  }
  return { version: 1, capturedAt, rootKey, nodes, edges, truncated: snapshot.truncated }
}

function readEdge(
  /* 关系中保存的完整 GraphEdge，尚未验证实际身份、版本与可选锚点。 */ value: unknown,
): GraphEdge {
  // 保留原边标签和历史来源锚点，不把 payload/basis 伪造为实际图边。
  const edge = readRecord(value)
  if (edge.kind !== 'successor' && edge.kind !== 'reference') invalidRecord()
  const result: GraphEdge = { id: readId(edge.id), kind: edge.kind, from: readId(edge.from), to: readId(edge.to),
    revision: readRevision(edge.revision), createdAt: readTimestamp(edge.createdAt), updatedAt: readTimestamp(edge.updatedAt) }
  if (result.from === result.to) invalidRecord()
  if (edge.label !== undefined) {
    if (typeof edge.label !== 'string') invalidRecord()
    result.label = edge.label
  }
  if (edge.sourceAnchors !== undefined) {
    if (edge.kind !== 'successor') invalidRecord()
    try { result.sourceAnchors = graphReadSourceAnchors(edge.sourceAnchors) }
    catch { invalidRecord() }
  }
  return result
}

function readNodePointer(
  /* 已保存且 JSON 内容已验证的引用起点节点。 */ node: GraphNode,
  /* 已验证语法且已展开通配符的实际 JSON Pointer。 */ path: string,
): JsonValue | undefined {
  // 按路径检查实际值，防止关系记录声称 payload 中不存在的引用。
  let value: JsonValue | undefined = node.payload
  for (const encoded of path.slice(1).split('/')) {
    const token = encoded.replace(/~1/g, '/').replace(/~0/g, '~')
    if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, token)) return undefined
    if (Array.isArray(value)) {
      // 数组指针只读规范下标，不把 length 或 01 等别名解释为元素。
      if (!/^(0|[1-9]\d*)$/.test(token)) return undefined
      value = value[Number(token)]
    } else value = value[token]
  }
  return value
}

export function evidenceParseNodeSnapshot(
  /* 图来源保存的未知节点快照，包含完整 JSON payload 和可选生产者信息。 */
  value: unknown,
): GraphNode {
  // 校验所有影响节点身份、内容版本与历史解释的字段，保留合法 payload 原值。
  const node = readRecord(value), payload = readRecord(node.payload)
  assertJsonValue(payload)
  const result: GraphNode = { id: readId(node.id), revision: readRevision(node.revision),
    typeId: readText(node.typeId), typeVersion: readRevision(node.typeVersion, 1), payload,
    createdAt: readTimestamp(node.createdAt), updatedAt: readTimestamp(node.updatedAt) }
  if (node.manualOrigin !== undefined) {
    const manualOrigin = readRecord(node.manualOrigin)
    result.manualOrigin = { userId: readText(manualOrigin.userId) }
  }
  if (node.libraryClaimRefs !== undefined) {
    result.libraryClaimRefs = []
    const ids = new Set<string>()
    for (const value of readArray(node.libraryClaimRefs, 32)) {
      const reference = readRecord(value), entryId = readId(reference.entryId)
      if (ids.has(entryId)) invalidRecord()
      ids.add(entryId)
      result.libraryClaimRefs.push({ entryId, contentDigest: readDigest(reference.contentDigest), reason: readText(reference.reason) })
    }
  }
  if (node.payloadReferences !== undefined) {
    result.payloadReferences = []
    for (const value of readArray(node.payloadReferences)) {
      const reference = readRecord(value)
      result.payloadReferences.push({ path: readText(reference.path), targetId: readId(reference.targetId) })
    }
  }
  if (node.importedFrom !== undefined) {
    const imported = readRecord(node.importedFrom)
    result.importedFrom = { bundleId: readText(imported.bundleId), nodeId: readId(imported.nodeId), revision: readRevision(imported.revision) }
  }
  if (node.validity !== undefined) {
    if (node.validity !== 'current' && node.validity !== 'stale') invalidRecord()
    result.validity = node.validity
  }
  if (node.producer !== undefined) {
    const producer = readRecord(node.producer), transition = readRecord(producer.transitionRef), agent = readRecord(producer.agentRef)
    result.producer = { operationId: readText(producer.operationId), transitionRef: { id: readText(transition.id), version: readRevision(transition.version, 1) },
      stageId: readText(producer.stageId), workId: readText(producer.workId),
      agentRef: { id: readText(agent.id), version: readRevision(agent.version) }, agentName: readText(producer.agentName) }
  }
  return result
}

function readAssetView(
  /* 冻结快照或已映射主键的资产公共元数据，额外内部字段不会对外返回。 */
  value: unknown,
): Asset {
  // 验证附件元数据的必要类型及内容摘要，保持原文件名和媒体类型。
  const asset = readRecord(value)
  return { id: readId(asset.id), workspaceId: readId(asset.workspaceId), filename: readText(asset.filename),
    mediaType: readText(asset.mediaType), size: readRevision(asset.size), sha256: readDigest(asset.sha256), createdAt: readTimestamp(asset.createdAt) }
}

function readRecord(
  /* 持久化解码后尚未排除空值、数组或非普通对象的值。 */
  value: unknown,
): Record<string, unknown> {
  // 只允许普通字段对象进入记录解析，避免通过属性访问接受数组和运行时对象。
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalidRecord()
  return value as Record<string, unknown>
}

function readArray(
  /* 需要逐项校验的持久化数组字段。 */
  value: unknown,
  /* 可选业务数量上限；省略时仅验证数组形状。 */
  maximum?: number,
): unknown[] {
  // 拒绝缺失数组及超出已接受命令边界的冻结材料集合。
  if (!Array.isArray(value) || maximum !== undefined && value.length > maximum) invalidRecord()
  return value
}

function readStrings(
  /* 尚未校验元素格式和唯一性的内部字符串集合。 */
  value: unknown,
  /* 已定义的集合数量上限；省略时不增加新的业务容量限制。 */
  maximum: number | undefined,
  /* true 表示每一项必须是 UUID，false 表示非空词项。 */
  ids: boolean,
): string[] {
  // 校验字符串集合并拒绝重复身份或词项，保留原始顺序。
  const result: string[] = []
  for (const item of readArray(value, maximum)) result.push(ids ? readId(item) : readText(item))
  if (new Set(result).size !== result.length) invalidRecord()
  return result
}

function readText(
  /* 应具有真实内容的持久化原文或定义名称。 */
  value: unknown,
): string {
  // 验证字符串有实际内容但不裁剪或规范化固定原文。
  if (typeof value !== 'string' || !value.trim()) invalidRecord()
  return value
}

function readId(
  /* 数据库记录中声明的用户、工作区、资产、请求或节点 UUID。 */
  value: unknown,
): string {
  // 用公共身份格式验证历史字段，保留原标识的大小写。
  const id = readText(value)
  if (!UUID.test(id)) invalidRecord()
  return id
}

function readDigest(
  /* 数据库记录中绑定固定内容、幂等输入或附件字节的 SHA-256 摘要。 */
  value: unknown,
): string {
  // 拒绝未采用小写完整十六进制格式的摘要。
  const digest = readText(value)
  if (!/^[a-f0-9]{64}$/.test(digest)) invalidRecord()
  return digest
}

function readRevision(
  /* 管理或来源版本、类型版本以及字节计数的持久化数值。 */
  value: unknown,
  /* 最小合法值，普通版本为零，精确数据类型与转换版本为一。 */
  minimum = 0,
): number {
  // 只接受可精确表示的整数，拒绝负版本和无效类型版本。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalidRecord()
  return value
}

function readTimestamp(
  /* 保存来源快照、收录或资产创建事实的时间原文。 */
  value: unknown,
): string {
  // 验证时间可以解释，不修改已固定的时间字符串。
  const timestamp = readText(value)
  if (!Number.isFinite(Date.parse(timestamp))) invalidRecord()
  return timestamp
}

function assertJsonValue(
  /* 节点 payload 中尚未验证可持久化性的任意值。 */
  value: unknown,
  /* 当前递归深度，与现行定义模块接受的最大深度保持一致。 */
  depth = 0,
): asserts value is JsonValue {
  // 校验有限 JSON 值与容器，深度上限同时拒绝循环对象，不重复拷贝 payload。
  if (depth > 32) invalidRecord()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalidRecord(); return }
  if (Array.isArray(value)) { for (const item of value) assertJsonValue(item, depth + 1); return }
  const object = readRecord(value)
  for (const item of Object.values(object)) assertJsonValue(item, depth + 1)
}

function invalidRecord(): never {
  // 沿用现有不可用错误报告损坏持久化记录，不泄露原始记录或运行时异常。
  throw new GraphError(500, 'EVIDENCE_RECORD_INVALID', EvidenceMessage.RECORD_INVALID)
}
