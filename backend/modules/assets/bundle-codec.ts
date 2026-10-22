// 校验 v4 便携数据包，并在导入前重写资产、节点和当前 Agent 引用。
import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentInput,
  AgentProfile,
  BundleAgent,
  BundleAsset,
  BundleDefinitions,
  BundleMap,
  WorkspaceBundle,
} from '../../../contracts/control'
import type {
  DefinitionCatalog,
  DefinitionPackage,
  DefinitionRef,
  ExecutionAgentDefinition,
  JsonValue,
} from '../../../contracts/data-definition'
import type { GraphAgentProfile } from '../../../contracts/graph-agent'
import type { GraphEdge, GraphNode, GraphPayload } from '../../../contracts/graph'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphDocument } from '../graph/graph-record'
import { graphParseNodePayload, type ParsedGraphNode } from '../shared/data-reference-index'
import { graphInputReadAgentRef, graphInputReadDefinitionRef, graphInputReadPayload } from '../graph/graph-input'
import { graphReadSourceAnchors, graphValidateSourceAnchors } from '../shared/source-anchors'
import {
  definitionsDigest,
  definitionsReadPackage,
  definitionsReadType,
  definitionsValidateCatalog,
} from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import {
  inputReadArray,
  inputReadId,
  inputReadObject,
  inputReadRevision,
  inputReadString,
} from '../shared/input-validation'
import { controlReadAgent, controlReadAgentFields } from '../workspace/workspace-input'

export const ASSET_BYTE_LIMIT = 64 * 1024 * 1024
export const BUNDLE_BYTE_LIMIT = ASSET_BYTE_LIMIT

interface ParsedBundleAsset {
  readonly asset: BundleAsset
  // 读包时已经核对长度、规范Base64与SHA-256的独占字节，直接交付本次导入写入。
  readonly bytes: Buffer
}

interface ParsedBundleMap {
  readonly map: BundleMap
  readonly nodes: readonly ParsedGraphNode[]
}

export interface ParsedWorkspaceBundle {
  readonly bundle: WorkspaceBundle
  readonly maps: readonly ParsedBundleMap[]
  readonly assets: readonly ParsedBundleAsset[]
}

/**
 * 数据包结构、引用闭包和摘要错误都在这个边界拒绝。
 *
 * @param reason 可向导入用户报告且不回显包内私密内容的原因。
 */
function bundlesInvalid(reason: string): never {
  throw new GraphError(422, 'BUNDLE_INVALID', reason)
}

/**
 * 按 UTF-8 序列化后的完整 JSON 大小检查数据包上限，计入附件的 Base64 膨胀。
 *
 * @param value 需要按完整 JSON 序列化大小检查上限的数据包输入。
 */
export function bundlesAssertSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > BUNDLE_BYTE_LIMIT) throw new GraphError(413, 'BUNDLE_LIMIT', RuntimeMessage.THE_COMPLETE_BASE64_BUNDLE_EXCEEDS_64_MIB)
}

/**
 * @param value 尚未确认数组类型和条目数量的包内字段。
 * @param max 该数组允许包含的最大条目数。
 * @param label 写入包错误信息的数组字段路径。
 */
function bundlesReadArray(value: unknown, max: number, label: string): unknown[] {
  const items = inputReadArray(value, label)
  if (items.length > max) throw new GraphError(413, 'BUNDLE_LIMIT', messageFormat(RuntimeMessage.VALUE_HAS_TOO_MANY_ENTRIES, label))
  return items
}

/**
 * @param value 数据包中允许为空但必须为字符串的字段值。
 * @param label 写入包错误信息的文本字段路径。
 */
function bundlesReadText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GraphError(422, 'BUNDLE_INVALID', messageFormat(RuntimeMessage.VALUE_MUST_BE_TEXT, label))
  return value
}

/**
 * @param value 数据包中尚未验证和规范化的时间值。
 */
function bundlesReadTime(value: unknown): string {
  const text = inputReadString(value, 'timestamp')
  if (!Number.isFinite(Date.parse(text))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_TIMESTAMP)
  return new Date(text).toISOString()
}

/**
 * @param ids 必须在同类对象中互不重复的身份或路径列表。
 * @param label 写入包错误信息的对象类型名称。
 */
function bundlesValidateIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new GraphError(422, 'BUNDLE_INVALID', messageFormat(RuntimeMessage.DUPLICATE_VALUE, label))
}

/**
 * @param ref 需要用作闭包索引键的精确定义引用。
 */
function bundlesRefKey(ref: DefinitionRef): string {
  return `${ref.id}\u0000${ref.version}`
}

/**
 * @param value 尚未验证的字符串数组。
 * @param label 错误中的字段路径。
 */
function bundlesReadStrings(value: unknown, label: string): string[] {
  return bundlesReadArray(value, 512, label).map((item, index) => inputReadString(item, `${label}[${index}]`))
}

/**
 * 把 revision 与现有 AgentInput 边界分开校验，导入后配置会在新工作区从版本零开始。
 *
 * @param value v4 包中一个可编辑 Agent 及其原工作区版本。
 */
function bundlesReadAgent(
  /* v4包内尚未核对可编辑字段和原版本的Agent记录。 */ value: unknown,
): BundleAgent {
  // 包入口一次核对白名单，再复用配置字段规则并保留原精确revision。
  const item = inputReadObject(value, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model', 'promptPath', 'kind',
    'promptVars', 'defaultPriority', 'claimCategory', 'role', 'bindings', 'revision'], 'agent')
  const revision = inputReadRevision(item.revision, 'agent.revision')
  const agent = controlReadAgentFields(item)
  return { ...agent, revision }
}

/**
 * 快照只包含执行所需公共字段，不使用可编辑 AgentInput 的管理字段。
 *
 * @param value 定义闭包所依赖的精确 Agent 快照。
 */
function bundlesReadExecutionAgent(value: unknown): ExecutionAgentDefinition {
  const item = inputReadObject(value, ['ref', 'profile'], 'definition agent')
  const ref = graphInputReadAgentRef(item.ref, 'definition agent.ref')
  const profile = inputReadObject(item.profile, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model',
    'promptVars', 'defaultPriority', 'claimCategory'], 'definition agent.profile')
  const id = inputReadString(profile.id, 'definition agent.profile.id')
  if (id !== ref.id) bundlesInvalid('Definition Agent profile identity does not match its exact reference')
  const defaultPriority = profile.defaultPriority
  if (defaultPriority !== undefined && defaultPriority !== 'high' && defaultPriority !== 'medium' && defaultPriority !== 'low') bundlesInvalid('Definition Agent has an invalid default priority')
  const claimCategory = profile.claimCategory
  if (claimCategory !== undefined && claimCategory !== null && claimCategory !== 'data' && claimCategory !== 'quote' && claimCategory !== 'causal') bundlesInvalid('Definition Agent has an invalid claim category')
  return { ref, profile: {
    id, name: inputReadString(profile.name, 'definition agent.profile.name'),
    description: bundlesReadText(profile.description, 'definition agent.profile.description'),
    content: bundlesReadText(profile.content, 'definition agent.profile.content'),
    tools: bundlesReadStrings(profile.tools, 'definition agent.profile.tools'),
    provider: inputReadString(profile.provider, 'definition agent.profile.provider'),
    model: inputReadString(profile.model, 'definition agent.profile.model'),
    ...(profile.promptVars === undefined ? {} : { promptVars: bundlesReadStrings(profile.promptVars, 'definition agent.profile.promptVars') }),
    ...(defaultPriority === undefined ? {} : { defaultPriority }),
    ...(claimCategory === undefined ? {} : { claimCategory }),
  } }
}

/**
 * 当前可编辑版本必须显式固化模型提供方，不允许用 null 让包内隐藏快照决定执行内容。
 *
 * @param agent 包中可编辑 Agent 的执行字段。
 * @param snapshot 同一精确引用的定义快照。
 */
function bundlesReadEditableExecutionProfile(agent: BundleAgent, snapshot: ExecutionAgentDefinition): GraphAgentProfile {
  if (agent.provider === null || agent.model === null) bundlesInvalid('Current Bundle Agent must explicitly match its execution snapshot provider and model')
  const profile: GraphAgentProfile = { id: agent.id, name: agent.name, description: agent.description, content: agent.content,
    tools: [...agent.tools], provider: agent.provider, model: agent.model, promptVars: [...agent.promptVars],
    defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory }
  if (definitionsDigest(profile) !== definitionsDigest(snapshot.profile)) bundlesInvalid('Current Bundle Agent does not match its exact execution snapshot')
  return profile
}

/**
 * 只对精确 id/revision 相同者要求全 profile 一致；同 id 的其他版本是独立历史快照。
 *
 * @param agents 包中将在新工作区恢复的可编辑 Agent。
 * @param snapshots 定义闭包依赖的精确执行快照。
 */
function bundlesValidateAgentSnapshots(agents: readonly BundleAgent[], snapshots: readonly ExecutionAgentDefinition[]): void {
  const index = new Map(snapshots.map(snapshot => [bundlesRefKey(snapshot.ref), snapshot]))
  for (const agent of agents) {
    const snapshot = index.get(bundlesRefKey({ id: agent.id, version: agent.revision }))
    if (snapshot) bundlesReadEditableExecutionProfile(agent, snapshot)
  }
}

/**
 * 先通过定义模块复核包体和跨包引用，再核对每个不可变包的摘要。
 *
 * @param value v4 包中尚未验证的定义闭包。
 */
function bundlesReadDefinitions(value: unknown): { definitions: BundleDefinitions; catalog: DefinitionCatalog } {
  const item = inputReadObject(value, ['packages', 'agents', 'digests'], 'definitions')
  const packages = bundlesReadArray(item.packages, 512, 'definitions.packages').map(definitionsReadPackage)
  const agents = bundlesReadArray(item.agents, 2048, 'definitions.agents').map(bundlesReadExecutionAgent)
  bundlesValidateIds(packages.map(bundlesRefKey), 'definition package')
  bundlesValidateIds(agents.map(agent => bundlesRefKey(agent.ref)), 'definition agent')
  const digests = bundlesReadArray(item.digests, 512, 'definitions.digests').map((value, index) => {
    const digest = inputReadObject(value, ['ref', 'digest'], `definitions.digests[${index}]`)
    const text = inputReadString(digest.digest, `definitions.digests[${index}].digest`).toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(text)) bundlesInvalid('Definition package digest must be a SHA-256 value')
    return { ref: graphInputReadDefinitionRef(digest.ref, `definitions.digests[${index}].ref`), digest: text }
  })
  bundlesValidateIds(digests.map(item => bundlesRefKey(item.ref)), 'definition digest')
  if (digests.length !== packages.length) bundlesInvalid('Definition digest list does not match the package closure')
  const digestMap = new Map(digests.map(digest => [bundlesRefKey(digest.ref), digest.digest]))
  for (const packageItem of packages) if (digestMap.get(bundlesRefKey(packageItem)) !== definitionsDigest(packageItem)) {
    bundlesInvalid('Definition package digest does not match its content')
  }
  const catalog = definitionsValidateCatalog(packages, agents, 0)
  return { definitions: { packages, agents, digests }, catalog }
}

/**
 * @param value 节点上可选的历史包溯源标签。
 */
function bundlesReadImportedFrom(value: unknown): GraphNode['importedFrom'] {
  const source = inputReadObject(value, ['bundleId', 'nodeId', 'revision'], 'importedFrom')
  return { bundleId: inputReadId(source.bundleId, 'bundleId'), nodeId: inputReadId(source.nodeId, 'nodeId'), revision: inputReadRevision(source.revision, 'revision') }
}

/**
 * @param value 包中可选的只读 Agent 产出来源。
 */
function bundlesReadProducer(value: unknown): NonNullable<GraphNode['producer']> {
  const item = inputReadObject(value, ['operationId', 'transitionRef', 'stageId', 'workId', 'agentRef', 'agentName'], 'producer')
  return {
    operationId: inputReadString(item.operationId, 'producer.operationId'),
    transitionRef: graphInputReadDefinitionRef(item.transitionRef, 'producer.transitionRef'),
    stageId: inputReadString(item.stageId, 'producer.stageId'), workId: inputReadString(item.workId, 'producer.workId'),
    agentRef: graphInputReadAgentRef(item.agentRef, 'producer.agentRef'), agentName: inputReadString(item.agentName, 'producer.agentName'),
  }
}

/**
 * @param value 数据包中尚未按精确类型校验的通用节点记录。
 * @param catalog 包含该类型不可变 schema 的定义目录。
 */
function bundlesReadNode(
  /* 数据包交付、尚未通过节点合同校验的未知值。 */ value: unknown,
  /* 包内精确且不可变的类型定义目录。 */ catalog: DefinitionCatalog,
): ParsedGraphNode {
  // 解析便携节点及已有创建来源；导入动作不会改写原人工创建用户。
  const item = inputReadObject(value, ['id', 'revision', 'typeId', 'typeVersion', 'payload', 'createdAt', 'updatedAt', 'importedFrom', 'validity', 'producer', 'manualOrigin'], 'node')
  const input = {
    id: inputReadId(item.id, 'node id'), typeId: inputReadString(item.typeId, 'node.typeId'),
    typeVersion: inputReadRevision(item.typeVersion, 'node.typeVersion'), payload: graphInputReadPayload(item.payload, 'node.payload'),
  }
  if (input.typeVersion < 1) bundlesInvalid('Node typeVersion must name an immutable published version')
  const parsed = graphParseNodePayload(catalog, { id: input.typeId, version: input.typeVersion }, input.payload)
  const node: GraphNode = { ...input, payload: parsed.payload,
    revision: inputReadRevision(item.revision, 'node revision'), createdAt: bundlesReadTime(item.createdAt), updatedAt: bundlesReadTime(item.updatedAt) }
  if (item.validity !== undefined) {
    if (item.validity !== 'current' && item.validity !== 'stale') throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_VALIDITY_MARKER)
    node.validity = item.validity
  }
  if (item.importedFrom !== undefined) node.importedFrom = bundlesReadImportedFrom(item.importedFrom)
  if (item.manualOrigin !== undefined) {
    const manualOrigin = inputReadObject(item.manualOrigin, ['userId'], 'node.manualOrigin')
    node.manualOrigin = { userId: inputReadString(manualOrigin.userId, 'node.manualOrigin.userId') }
  }
  if (item.producer !== undefined) node.producer = bundlesReadProducer(item.producer)
  return { node, references: parsed.references }
}

/**
 * @param value 数据包中尚未校验节点、关系和端点的图记录。
 * @param catalog 包内已校验的精确定义闭包。
 */
function bundlesReadMap(
  /* 文件中尚未解析节点、关系及图身份的一张便携图。 */ value: unknown,
  /* 与本数据包精确匹配的已验定义目录。 */ catalog: DefinitionCatalog,
): ParsedBundleMap {
  // 一次解析节点及真实引用，随后关系和引用约束共享这份结果。
  const item = inputReadObject(value, ['id', 'name', 'nodes', 'edges'], 'map')
  const parsedNodes = bundlesReadArray(item.nodes, 10000, 'nodes').map((/* 一份尚未解析的便携节点。 */ node) =>
    /* 保留同次建立的完整节点及引用配对。 */ bundlesReadNode(node, catalog))
  const nodes = parsedNodes.map((/* 已完成正文与元数据检查的节点状态。 */ parsed) => /* 便携图只保存协议 DTO 字段。 */ parsed.node)
  bundlesValidateIds(nodes.map(node => node.id), 'node id')
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const edges = bundlesReadArray(item.edges, 20000, 'edges').map(value => {
    const edge = inputReadObject(value, ['id', 'revision', 'kind', 'from', 'to', 'label', 'sourceAnchors', 'createdAt', 'updatedAt'], 'edge')
    if (edge.kind !== 'successor' && edge.kind !== 'reference') throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_EDGE_KIND)
    const from = inputReadId(edge.from, 'edge.from'), to = inputReadId(edge.to, 'edge.to')
    const source = nodeMap.get(from), target = nodeMap.get(to)
    if (!source || !target || from === to) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.EDGE_ENDPOINTS_MUST_EXIST_IN_THE_SAME_MAP)
    if (edge.kind === 'successor' && !definitionsReadType(catalog, { id: source.typeId, version: source.typeVersion }).successorTypes
      .some(ref => ref.id === target.typeId && ref.version === target.typeVersion)) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_EDGE_ENDPOINT_KINDS)
    const relation = { id: inputReadId(edge.id, 'edge id'), revision: inputReadRevision(edge.revision, 'edge revision'), kind: edge.kind, from, to,
      ...(edge.label === undefined ? {} : { label: inputReadString(edge.label, 'edge.label') }),
      ...(edge.sourceAnchors === undefined ? {} : { sourceAnchors: graphReadSourceAnchors(edge.sourceAnchors) }),
      createdAt: bundlesReadTime(edge.createdAt), updatedAt: bundlesReadTime(edge.updatedAt) } satisfies GraphEdge
    graphValidateSourceAnchors(relation, source, true)
    return relation
  })
  bundlesValidateIds(edges.map(edge => edge.id), 'edge id')
  const outgoing = new Map<string, string[]>()
  for (const edge of edges) if (edge.kind === 'successor') outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
  const visiting = new Set<string>(), visited = new Set<string>()
  /**
   * 与 graph-service 保持同一 DAG 不变式，reference 不参与环检查。
   *
   * @param id 当前检查的节点身份。
   */
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.SUCCESSOR_RELATIONS_MUST_NOT_CONTAIN_A_CYCLE)
    if (visited.has(id)) return
    visiting.add(id)
    for (const child of outgoing.get(id) ?? []) visit(child)
    visiting.delete(id); visited.add(id)
  }
  for (const id of nodeMap.keys()) visit(id)
  return { map: { id: inputReadId(item.id, 'map id'), name: inputReadString(item.name, 'map name'), nodes, edges }, nodes: parsedNodes }
}

/**
 * @param value 数据包中尚未解码并核对摘要的附件记录。
 */
function bundlesReadAsset(
  /* 数据包中尚未解码并核对摘要的附件记录。 */ value: unknown,
): ParsedBundleAsset {
  // 一次验证附件元数据和实际字节，保持便携DTO与本次导入的已验字节配对。
  const item = inputReadObject(value, ['id', 'filename', 'mediaType', 'size', 'sha256', 'contentBase64'], 'asset')
  const size = inputReadRevision(item.size, 'asset size')
  if (size > ASSET_BYTE_LIMIT) throw new GraphError(413, 'ASSET_LIMIT', RuntimeMessage.ASSET_EXCEEDS_64_MIB)
  const contentBase64 = bundlesReadText(item.contentBase64, 'base64')
  if (contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(contentBase64)) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_CANONICAL_BASE64)
  const content = Buffer.from(contentBase64, 'base64')
  const sha256 = inputReadString(item.sha256, 'sha256').toLowerCase()
  if (content.length !== size || !/^[a-f0-9]{64}$/.test(sha256) || createHash('sha256').update(content).digest('hex') !== sha256
    || content.toString('base64') !== contentBase64) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.ASSET_LENGTH_OR_CHECKSUM_DOES_NOT_MATCH)
  return { asset: { id: inputReadId(item.id, 'asset id'), filename: inputReadString(item.filename, 'filename'),
    mediaType: inputReadString(item.mediaType, 'mediaType'), size, sha256, contentBase64 }, bytes: content }
}

/**
 * 节点引用必须留在同一张图且类型精确匹配；资产引用必须指向包内唯一附件。
 *
 * @param maps 已解析的 v4 图。
 * @param assets 包内附件。
 */
function bundlesValidateReferences(
  /* 读包入口已经配对的图、节点及真实引用。 */ maps: readonly ParsedBundleMap[],
  /* 同一包中已校验字节与摘要的完整附件。 */ assets: BundleAsset[],
): void {
  // 检查真实目标与资产归属，沿用读包的引用，不重新验证旧正文。
  const assetMap = new Map(assets.map((/* 本包已验证长度和摘要的一份附件。 */ asset) => /* 按唯一原身份解析实际资产引用。 */ [asset.id, asset])), referencedAssets = new Set<string>()
  for (const { map, nodes } of maps) {
    const nodeMap = new Map(map.nodes.map((/* 本张便携图已验正文的一份节点。 */ node) => /* 禁止跨图按同名身份解析节点引用。 */ [node.id, node]))
    for (const { references } of nodes) for (const reference of references) {
      if (reference.definition.target.kind === 'node') {
        const target = nodeMap.get(reference.value)
        if (!target || !reference.definition.target.types.some((/* 节点引用声明允许的一个精确类型。 */ ref) => /* 实际目标类型及版本都必须匹配。 */ ref.id === target.typeId && ref.version === target.typeVersion)) {
          bundlesInvalid('Node payload reference is missing from its Map or has another type')
        }
      } else {
        const asset = assetMap.get(reference.value)
        const parent = reference.parent
        const expectedMediaType = parent && typeof parent === 'object' && !Array.isArray(parent) && typeof parent.mediaType === 'string' ? parent.mediaType : undefined
        if (!asset || (expectedMediaType !== undefined && asset.mediaType !== expectedMediaType)) {
          throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.ASSET_REFERENCE_IS_MISSING_OR_HAS_ANOTHER_MEDIA_TYPE)
        }
        referencedAssets.add(asset.id)
      }
    }
  }
  if (assets.some((/* 包中携带的一份已验附件。 */ asset) => /* 拒绝不属于真实引用闭包的额外附件。 */ !referencedAssets.has(asset.id))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.BUNDLE_CONTAINS_AN_UNREFERENCED_ASSET)
}

/**
 * 从节点所属包开始沿 package dependencies 求精确闭包，拒绝缺失或夹带无关定义。
 *
 * @param definitions 包声明的定义内容。
 * @param catalog 由该内容构建的目录。
 * @param maps 实际使用类型的节点。
 * @param agents 包中可编辑 Agent，其显式转换绑定也是定义根。
 */
function bundlesValidateDefinitionClosure(
  /* 已解析且经过跨包引用校验的便携定义集合。 */ definitions: BundleDefinitions,
  /* 与包体一致、已验证每条跨包引用均声明依赖的目录。 */ catalog: DefinitionCatalog,
  /* 决定精确闭包根的便携图。 */ maps: BundleMap[],
  /* 将显式转换绑定纳入闭包根的可编辑 Agent。 */ agents: readonly Pick<BundleAgent, 'bindings'>[],
): void {
  // 从节点和 Agent 绑定出发，只沿已经验证完整的显式依赖核对精确闭包。
  const packages = new Map(definitions.packages.map(item => [bundlesRefKey(item), item])), expected = new Set<string>(), queue: DefinitionRef[] = []
  for (const node of maps.flatMap(map => map.nodes)) {
    const entry = catalog.index.find(item => item.kind === 'dataType' && item.ref.id === node.typeId && item.ref.version === node.typeVersion)
    if (!entry) bundlesInvalid('Node type is not owned by a definition package')
    queue.push(entry.packageRef)
    if (node.producer) {
      const producer = catalog.index.find(item => item.kind === 'transition' && item.ref.id === node.producer!.transitionRef.id
        && item.ref.version === node.producer!.transitionRef.version)
      if (!producer) bundlesInvalid('Node producer transition is not owned by a definition package')
      queue.push(producer.packageRef)
    }
  }
  for (const binding of agents.flatMap(agent => agent.bindings ?? [])) {
    const owner = catalog.index.find(item => item.kind === 'transition' && item.ref.id === binding.transition.id && item.ref.version === binding.transition.version)
    if (!owner) bundlesInvalid('Agent binding transition is not owned by a definition package')
    queue.push(owner.packageRef)
  }
  while (queue.length) {
    const ref = queue.shift()!, key = bundlesRefKey(ref)
    if (expected.has(key)) continue
    const packageItem = packages.get(key)
    if (!packageItem) bundlesInvalid('Definition package dependency is missing')
    expected.add(key); queue.push(...packageItem.dependencies.packages)
  }
  if (expected.size !== packages.size || [...packages.keys()].some(key => !expected.has(key))) bundlesInvalid('Definitions are not the exact package closure used by the exported nodes')
  const expectedAgents = new Set([...expected].flatMap(key => packages.get(key)!.dependencies.agents.map(bundlesRefKey)))
  const actualAgents = new Set(definitions.agents.map(agent => bundlesRefKey(agent.ref)))
  if (expectedAgents.size !== actualAgents.size || [...actualAgents].some(key => !expectedAgents.has(key))) bundlesInvalid('Definition Agents are not the exact dependency closure')
  for (const node of maps.flatMap(map => map.nodes)) if (node.producer && !actualAgents.has(bundlesRefKey(node.producer.agentRef))) {
    bundlesInvalid('Node producer Agent is missing from the exact dependency closure')
  }
}

export function bundlesReadWorkspace(
  /* 尚未区分单图或工作区格式的 v4 数据包输入。 */
  value: unknown,
): ParsedWorkspaceBundle {
  // 只接受 v4 数据包，并在写入前验证定义闭包、快照和引用。
  bundlesAssertSize(value)
  const item = inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'map', 'agents', 'definitions', 'assets'], 'bundle')
  if (item.version !== 4 || (item.format !== 'chongming-workspace' && item.format !== 'chongming-map')) {
    bundlesInvalid(RuntimeMessage.ONLY_V4_CHONGMING_BUNDLES_ARE_SUPPORTED)
  }
  const id = inputReadId(item.id, 'bundle id')
  const exportedAt = bundlesReadTime(item.exportedAt)
  const parsedDefinitions = bundlesReadDefinitions(item.definitions)
  let workspace: WorkspaceBundle['workspace']
  let parsedMaps: ParsedBundleMap[]
  if (item.format === 'chongming-workspace') {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'definitions', 'assets'], 'workspace bundle')
    const info = inputReadObject(item.workspace, ['name', 'description', 'agents'], 'workspace')
    workspace = {
      name: inputReadString(info.name, 'workspace name'),
      description: bundlesReadText(info.description, 'description'),
      agents: bundlesReadArray(info.agents, 512, 'agents').map(bundlesReadAgent),
    }
    parsedMaps = bundlesReadArray(item.maps, 100, 'maps').map(
      /* 待用已验证定义目录校验的包内图。 */
      map => /* 将每张图解析为只有数据和关系的便携结构。 */ bundlesReadMap(map, parsedDefinitions.catalog),
    )
  } else {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'map', 'agents', 'definitions', 'assets'], 'map bundle')
    const map = bundlesReadMap(item.map, parsedDefinitions.catalog)
    parsedMaps = [map]
    workspace = {
      name: map.map.name,
      description: '',
      agents: bundlesReadArray(item.agents, 512, 'agents').map(bundlesReadAgent),
    }
  }
  const maps = parsedMaps.map((/* 已验图及其配对引用。 */ parsed) => /* 对外 DTO 不携带内部解析状态。 */ parsed.map)
  const parsedAssets = bundlesReadArray(item.assets, 1024, 'assets').map(bundlesReadAsset)
  const assets = parsedAssets.map((/* 已验附件DTO与实际字节。 */ parsed) => /* 便携包仅保存可序列化字段。 */ parsed.asset)
  bundlesValidateIds(maps.map(
    /* 已解析的单张便携图。 */
    map => /* 提取包内唯一图身份。 */ map.id,
  ), 'map id')
  bundlesValidateIds(workspace.agents.map(
    /* 已解析的可编辑 Agent。 */
    agent => /* 提取工作区内唯一 Agent 身份。 */ agent.id,
  ), 'agent id')
  bundlesValidateIds(workspace.agents.map(
    /* 已解析的可编辑 Agent。 */
    agent => /* 提取工作区内不可重复的提示词路径。 */ agent.promptPath,
  ), 'agent promptPath')
  bundlesValidateIds(assets.map(
    /* 已校验字节和摘要的附件。 */
    asset => /* 提取包内唯一资产身份。 */ asset.id,
  ), 'asset id')
  bundlesValidateAgentSnapshots(workspace.agents, parsedDefinitions.definitions.agents)
  bundlesValidateDefinitionClosure(parsedDefinitions.definitions, parsedDefinitions.catalog, maps, workspace.agents)
  bundlesValidateReferences(parsedMaps, assets)
  return { bundle: { format: 'chongming-workspace', version: 4, id, exportedAt, workspace, maps,
    definitions: parsedDefinitions.definitions, assets }, maps: parsedMaps, assets: parsedAssets }
}

/**
 * @param agents 需要去除内部管理字段并保留精确源版本的 Agent 配置列表。
 * @param snapshots 定义闭包中已解析共享默认值的 Agent 快照。
 */
export function bundlesReadAgents(agents: AgentProfile[],
  snapshots: readonly ExecutionAgentDefinition[] = []): BundleAgent[] {
  const index = new Map(snapshots.map(snapshot => [bundlesRefKey(snapshot.ref), snapshot]))
  return agents.map(agent => {
    const snapshot = index.get(bundlesRefKey({ id: agent.id, version: agent.revision }))
    const bundled = { ...controlReadAgent({ id: agent.id, name: agent.name, description: agent.description, content: agent.content,
    tools: agent.tools, promptPath: agent.promptPath, kind: agent.kind,
    provider: agent.provider ?? snapshot?.profile.provider ?? null, model: agent.model ?? snapshot?.profile.model ?? null,
    promptVars: agent.promptVars, defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
    ...(agent.role === undefined ? {} : { role: agent.role }), ...(agent.bindings === undefined ? {} : { bindings: agent.bindings }) }), revision: agent.revision }
    if (snapshot) bundlesReadEditableExecutionProfile(bundled, snapshot)
    return bundled
  })
}

/**
 * 为Map和workspace共同投影v4便携图；非空库引用明确拒绝，空元信息省略，原图不会被修改。
 *
 * @param document 需要投影为便携图并排除运行内部状态的图文档。
 */
export function bundlesReadMapDocument(
  /* 已读取并授权的原图文档，仅投影而不删除或改写其引用。 */ document: GraphDocument,
): BundleMap {
  // 当前v4未携带库条目和引用闭包，不生成旧导入器无法恢复且会丢失出处的包。
  if (document.nodes.some((/* 本次需要导出的原节点。 */ node) => /* 非空库使用必须等待完整数据交换协议。 */
    (node.libraryClaimRefs?.length ?? 0) > 0)) {
    throw new GraphError(422, 'EVIDENCE_EXCHANGE_UNSUPPORTED', RuntimeMessage.EVIDENCE_EXCHANGE_UNSUPPORTED)
  }
  return { id: document.id, name: document.name, nodes: document.nodes.map((
    /* 原节点的派生索引与空库元信息均不属于v4便携字段。 */ { payloadReferences: _references, libraryClaimRefs: _libraryRefs, ...node },
  ) => /* 便携节点独立复制，不改变当前Map的来源和管理信息。 */ structuredClone(node)),
    edges: structuredClone(document.edges) }
}

/**
 * 从节点的精确类型反查所属包，并递归补齐包依赖及 Agent 依赖。
 *
 * @param nodes 实际要导出的节点。
 * @param catalog 工作区定义目录。
 * @param availablePackages 同一授权快照取得、已通过目录校验的不可变包体。
 * @param availableAgents 可见的当前与历史 Agent 执行快照。
 * @param editableAgents 导出包保留的可编辑 Agent，其转换绑定必须同时可解析。
 */
export function bundlesReadDefinitionClosure(
  /* 需要携带精确类型与生产者转换的节点。 */ nodes: readonly GraphNode[],
  /* 已保证跨包引用声明完整的工作区定义目录。 */ catalog: DefinitionCatalog,
  /* 与目录及 Agent 同次取得并通过完整校验的包体。 */ availablePackages: readonly DefinitionPackage[],
  /* 可供闭包精确引用的当前与历史执行快照。 */ availableAgents: readonly ExecutionAgentDefinition[],
  /* 其转换绑定同样构成闭包根的可编辑 Agent。 */ editableAgents: readonly Pick<BundleAgent, 'bindings'>[] = [],
): BundleDefinitions {
  // 取得节点和 Agent 绑定所需的完整显式依赖，保持包摘要和执行快照精确匹配。
  const queue: DefinitionRef[] = []
  for (const node of nodes) {
    const owner = catalog.index.find(item => item.kind === 'dataType' && item.ref.id === node.typeId && item.ref.version === node.typeVersion)
    if (!owner) bundlesInvalid(`Definition owner is missing for ${node.typeId}@${node.typeVersion}`)
    queue.push(owner.packageRef)
    if (node.producer) {
      const producer = catalog.index.find(item => item.kind === 'transition' && item.ref.id === node.producer!.transitionRef.id
        && item.ref.version === node.producer!.transitionRef.version)
      if (!producer) bundlesInvalid(`Definition owner is missing for ${node.producer.transitionRef.id}@${node.producer.transitionRef.version}`)
      queue.push(producer.packageRef)
    }
  }
  for (const binding of editableAgents.flatMap(agent => agent.bindings ?? [])) {
    const owner = catalog.index.find(item => item.kind === 'transition' && item.ref.id === binding.transition.id && item.ref.version === binding.transition.version)
    if (!owner) bundlesInvalid(`Definition owner is missing for ${binding.transition.id}@${binding.transition.version}`)
    queue.push(owner.packageRef)
  }
  const packages = new Map<string, DefinitionPackage>()
  const packageByRef = new Map(availablePackages.map((/* 已取得的一个精确包。 */ item) =>
    /* 闭包遍历不再通过公开读取接口重新解析完整工作区。 */ [bundlesRefKey(item), item]))
  while (queue.length) {
    const ref = queue.shift()!, key = bundlesRefKey(ref)
    if (packages.has(key)) continue
    const packageItem = packageByRef.get(key)
    if (!packageItem) bundlesInvalid(`Definition package is missing: ${ref.id}@${ref.version}`)
    const expected = catalog.packages.find(item => bundlesRefKey(item.ref) === key)?.digest
    if (!expected || definitionsDigest(packageItem) !== expected) bundlesInvalid(`Definition package digest changed: ${ref.id}@${ref.version}`)
    packages.set(key, packageItem); queue.push(...packageItem.dependencies.packages)
  }
  const agentMap = new Map(availableAgents.map(agent => [bundlesRefKey(agent.ref), agent])), agents: ExecutionAgentDefinition[] = []
  const agentKeys = new Set([...packages.values()].flatMap(packageItem => packageItem.dependencies.agents.map(bundlesRefKey)))
  for (const key of agentKeys) {
    const agent = agentMap.get(key)
    if (!agent) bundlesInvalid('Definition Agent dependency is unavailable')
    agents.push(structuredClone(agent))
  }
  for (const node of nodes) if (node.producer && !agentKeys.has(bundlesRefKey(node.producer.agentRef))) {
    bundlesInvalid('Node producer Agent is missing from the exact dependency closure')
  }
  return { packages: [...packages.values()], agents,
    digests: [...packages.values()].map((/* 闭包中已经核对摘要的精确包。 */ packageItem) =>
      /* 便携包记录独立的精确身份和完整内容摘要。 */ ({ ref: { id: packageItem.id, version: packageItem.version }, digest: definitionsDigest(packageItem) })) }
}

/**
 * @param value 将被重写的 payload 或其子值。
 * @param parts 剩余 JSON Pointer 段。
 * @param replace 引用身份替换函数。
 */
function bundlesRewriteAt(value: JsonValue, parts: string[], replace: (value: string) => string): void {
  if (!parts.length || value === null || typeof value !== 'object') return
  const [head, ...rest] = parts
  if (head === '*') {
    const children = Array.isArray(value) ? value : Object.values(value)
    if (!rest.length) {
      for (let index = 0; index < children.length; index++) if (typeof children[index] === 'string') {
        if (Array.isArray(value)) value[index] = replace(children[index] as string)
        else {
          const key = Object.keys(value)[index]
          value[key] = replace(children[index] as string)
        }
      }
    } else for (const child of children) bundlesRewriteAt(child, rest, replace)
    return
  }
  if (Array.isArray(value) || !(head in value)) return
  if (!rest.length) {
    if (typeof value[head] === 'string') value[head] = replace(value[head] as string)
  } else bundlesRewriteAt(value[head], rest, replace)
}

/**
 * @param parsed 导入前同次解析的原节点与实际引用。
 * @param nodeIds 本图节点身份映射。
 * @param assetIds 整包资产身份映射。
 */
function bundlesRewritePayload(
  /* 已验旧正文与其实际启用的引用，重写时不修改原状态。 */ parsed: ParsedGraphNode,
  /* 当前图原节点到新节点身份的完整映射。 */ nodeIds: Map<string, string>,
  /* 整包原附件到新附件身份的完整映射。 */ assetIds: Map<string, string>,
): GraphPayload {
  // 只按已解析的旧引用重映射身份，完整新值校验由导入构造步骤执行。
  const payload = structuredClone(parsed.node.payload)
  const definitions = new Map(parsed.references.map((/* 旧正文中实际启用的引用。 */ reference) =>
    /* 同一路径和种类只重写一次，通配路径仍覆盖其所有原成员。 */ [`${reference.definition.path}\u0000${reference.definition.target.kind}`, reference.definition]))
  for (const reference of definitions.values()) {
    const ids = reference.target.kind === 'asset' ? assetIds : nodeIds
    bundlesRewriteAt(payload, reference.path.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~')), value => {
      const replacement = ids.get(value)
      if (!replacement) bundlesInvalid(`${reference.target.kind} reference cannot be remapped during import`)
      return replacement
    })
  }
  return payload
}

/**
 * @param source 需要绑定新工作区 Agent 身份的不可变包副本。
 * @param refs 旧精确引用到新引用的映射。
 */
function bundlesRemapPackageAgents(source: DefinitionPackage, refs: ReadonlyMap<string, DefinitionRef>): DefinitionPackage {
  const packageItem = structuredClone(source)
  const remap = (ref: DefinitionRef) => structuredClone(refs.get(bundlesRefKey(ref)) ?? ref)
  packageItem.dependencies.agents = packageItem.dependencies.agents.map(remap)
  for (const transition of packageItem.transitions) for (const stage of transition.execution.stages) {
    stage.agentRef = remap(stage.agentRef)
    if (stage.plan) stage.plan.agentRefs = stage.plan.agentRefs.map(remap)
  }
  return packageItem
}

/**
 * 先为所有对象分配身份，再根据定义重写 payload 引用；运行态从未进入 BundleMap。
 *
 * @param parsedBundle 已通过 v4 包校验并配对原节点引用的工作区包。
 * @param workspaceId 新导入工作区预先分配的稳定身份。
 * @param overrideName 用户指定的新工作区名称；null 表示沿用包内名称。
 */
export function bundlesCreateImport(
  /* 本次读包入口建立、节点与引用保持配对的完整结果。 */ parsedBundle: ParsedWorkspaceBundle,
  /* 新工作区已分配的稳定身份。 */ workspaceId: string,
  /* 用户显式覆盖的名称；null 沿用原包名称。 */ overrideName: string | null,
): {
  workspace: { id: string; name: string; description: string; agentSource: 'empty' }
  agents: AgentInput[]
  definitions: Pick<BundleDefinitions, 'packages' | 'agents'>
  maps: GraphDocument[]
  assets: Array<{ original: BundleAsset; bytes: Buffer; id: string }>
} {
  // 原包正文仅沿已验引用重写；新身份与新正文仍按重映射后的精确定义完整验证。
  const bundle = parsedBundle.bundle
  const now = new Date().toISOString()
  const agentIds = new Map(bundle.workspace.agents.map((/* 原工作区的可编辑Agent。 */ agent) => /* 为新工作区分配独立Agent身份。 */ [agent.id, randomUUID()])), assetIds = new Map(bundle.assets.map((/* 原包携带的唯一附件。 */ asset) => /* 为新工作区分配独立资产身份。 */ [asset.id, randomUUID()]))
  const agents: AgentInput[] = bundle.workspace.agents.map((/* 去掉原版本、在新工作区从版本零建立的Agent。 */ { revision: _revision, ...agent }) => /* 保留编辑配置并改用已分配的新身份。 */ ({ ...agent, id: agentIds.get(agent.id)! }))
  const agentRefs = new Map<string, DefinitionRef>()
  for (const agent of bundle.workspace.agents) agentRefs.set(bundlesRefKey({ id: agent.id, version: agent.revision }), { id: agentIds.get(agent.id)!, version: 0 })
  const definitionAgents = bundle.definitions.agents.map((/* 原定义闭包中一份精确Agent快照。 */ agent) => {
    // 当前可编辑版本绑定新身份，独立历史快照仍保留原精确引用。
    const ref = agentRefs.get(bundlesRefKey(agent.ref)) ?? agent.ref
    return { ref: structuredClone(ref), profile: { ...structuredClone(agent.profile), id: ref.id } }
  })
  const packages = bundle.definitions.packages.map((/* 需要绑定新工作区当前Agent身份的原包。 */ packageItem) => /* 只重映射已选择的Agent引用，随后重验新目录。 */ bundlesRemapPackageAgents(packageItem, agentRefs))
  const catalog = definitionsValidateCatalog(packages, definitionAgents)
  const maps = parsedBundle.maps.map((/* 已验便携图及原节点引用。 */ { map, nodes: originalNodes }) => {
    // 原身份映射作用于这张图的全部节点，不能跨图解析同名节点。
    const nodeIds = new Map(map.nodes.map((/* 当前便携图中的一个原节点。 */ node) => /* 预先为整张图建立完整的新节点身份映射。 */ [node.id, randomUUID()]))
    const nodes = originalNodes.map((/* 同次读包建立的原节点与真实引用。 */ originalParsed) => {
      // 原引用不再重新解析，身份重写后的正文仍经过完整图协议入口。
      const original = originalParsed.node
      const payload = bundlesRewritePayload(originalParsed, nodeIds, assetIds)
      const parsed = graphParseNodePayload(catalog, { id: original.typeId, version: original.typeVersion }, payload)
      return {
        id: nodeIds.get(original.id)!, revision: original.revision, typeId: original.typeId, typeVersion: original.typeVersion,
        payload: parsed.payload, payloadReferences: parsed.payloadReferences,
        createdAt: original.createdAt, updatedAt: now,
        importedFrom: { bundleId: bundle.id, nodeId: original.id, revision: original.revision },
        ...(original.manualOrigin ? { manualOrigin: { ...original.manualOrigin } } : {}),
        ...(original.validity ? { validity: original.validity } : {}),
        ...(original.producer ? { producer: { ...structuredClone(original.producer),
          agentRef: structuredClone(agentRefs.get(bundlesRefKey(original.producer.agentRef)) ?? original.producer.agentRef) } } : {}),
      } satisfies GraphNode
    })
    const edges = map.edges.map((/* 原图中已验端点和来源锚点的一条关系。 */ edge) => /* 新边身份与端点同步重映射，保留原关系内容版本。 */ ({ ...edge, id: randomUUID(), from: nodeIds.get(edge.from)!, to: nodeIds.get(edge.to)!, updatedAt: now }))
    const document: GraphDocument = { id: randomUUID(), workspaceId, revision: 0, name: map.name,
      nodes, edges, retiredNodeIds: [], retiredEdgeIds: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    if (Buffer.byteLength(JSON.stringify(document)) > 8 * 1024 * 1024) throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.IMPORTED_MAP_EXCEEDS_8_MIB)
    return document
  })
  return { workspace: { id: workspaceId, name: overrideName ?? bundle.workspace.name, description: bundle.workspace.description, agentSource: 'empty' as const },
    agents, definitions: { packages, agents: definitionAgents }, maps,
    assets: parsedBundle.assets.map((/* 完整读包已验证的附件及其独占字节。 */ { asset, bytes }) =>
      /* 导入直接写入已核对字节，不再次解码或计算同一内容摘要。 */ ({ original: asset, bytes, id: assetIds.get(asset.id)! })) }
}
