// 校验 v4 便携数据包，并在导入前重写资产、节点和当前 Agent 引用。
import { createHash, randomUUID } from 'node:crypto'
import type {
  AgentInput,
  AgentProfile,
  BundleAgent,
  BundleAsset,
  BundleDefinitions,
  BundleMap,
  DefinitionView,
  WorkspaceBundle,
} from '../../../contracts/control'
import type {
  DefinitionCatalog,
  DefinitionPackage,
  DefinitionRef,
  ExecutionAgentDefinition,
  JsonValue,
} from '../../../contracts/data-definition'
import type { GraphAgentProfile, GraphEdge, GraphNode, GraphPayload } from '../../../contracts/graph'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphDocument } from '../graph/graph-record'
import { graphReadPayloadReferenceIndex } from '../shared/data-reference-index'
import { graphInputReadAgentRef, graphInputReadDefinitionRef, graphInputReadPayload } from '../graph/graph-input'
import {
  definitionsDigest,
  definitionsReadPackage,
  definitionsReadPayloadReferences,
  definitionsReadType,
  definitionsValidateCatalog,
  definitionsValidatePayload,
} from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import {
  inputReadArray,
  inputReadId,
  inputReadObject,
  inputReadRevision,
  inputReadString,
} from '../shared/input-validation'
import { controlReadAgent } from '../workspace/workspace-input'

export const ASSET_BYTE_LIMIT = 64 * 1024 * 1024
export const BUNDLE_BYTE_LIMIT = ASSET_BYTE_LIMIT

const LEGACY_TYPE_IDS = ['source', 'news', 'claim', 'evidence', 'opinion', 'verification'] as const

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
 * 除显式 package dependencies 外，同时跟踪后继、节点引用和端口类型，防止旧包遗漏依赖声明时导出不完整。
 *
 * @param packageItem 需要找出实际类型/转换依赖的定义包。
 */
function bundlesReadPackageDefinitionRefs(packageItem: DefinitionPackage): DefinitionRef[] {
  return [
    ...packageItem.dataTypes.flatMap(type => [...type.successorTypes,
      ...type.references.flatMap(reference => reference.target.kind === 'node' ? reference.target.types : [])]),
    ...packageItem.transitions.flatMap(transition => [
      ...transition.ports.input.map(port => port.inputType), ...transition.ports.context.map(port => port.inputType),
      ...transition.ports.output.map(port => port.outputType),
    ]),
  ]
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
function bundlesReadAgent(value: unknown): BundleAgent {
  const item = inputReadObject(value, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model', 'promptPath', 'kind',
    'promptVars', 'defaultPriority', 'claimCategory', 'role', 'bindings', 'revision'], 'agent')
  const revision = inputReadRevision(item.revision, 'agent.revision')
  const agent = controlReadAgent(Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'revision')))
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
function bundlesReadNode(value: unknown, catalog: DefinitionCatalog): GraphNode {
  const item = inputReadObject(value, ['id', 'revision', 'typeId', 'typeVersion', 'payload', 'createdAt', 'updatedAt', 'importedFrom', 'validity', 'producer'], 'node')
  const input = {
    id: inputReadId(item.id, 'node id'), typeId: inputReadString(item.typeId, 'node.typeId'),
    typeVersion: inputReadRevision(item.typeVersion, 'node.typeVersion'), payload: graphInputReadPayload(item.payload, 'node.payload'),
  }
  if (input.typeVersion < 1) bundlesInvalid('Node typeVersion must name an immutable published version')
  const node: GraphNode = { ...input, payload: definitionsValidatePayload(catalog, { id: input.typeId, version: input.typeVersion }, input.payload) as GraphPayload,
    revision: inputReadRevision(item.revision, 'node revision'), createdAt: bundlesReadTime(item.createdAt), updatedAt: bundlesReadTime(item.updatedAt) }
  if (item.validity !== undefined) {
    if (item.validity !== 'current' && item.validity !== 'stale') throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_VALIDITY_MARKER)
    node.validity = item.validity
  }
  if (item.importedFrom !== undefined) node.importedFrom = bundlesReadImportedFrom(item.importedFrom)
  if (item.producer !== undefined) node.producer = bundlesReadProducer(item.producer)
  return node
}

/**
 * @param value 数据包中尚未校验节点、关系和端点的图记录。
 * @param catalog 包内已校验的精确定义闭包。
 */
function bundlesReadMap(value: unknown, catalog: DefinitionCatalog): BundleMap {
  const item = inputReadObject(value, ['id', 'name', 'nodes', 'edges'], 'map')
  const nodes = bundlesReadArray(item.nodes, 10000, 'nodes').map(node => bundlesReadNode(node, catalog))
  bundlesValidateIds(nodes.map(node => node.id), 'node id')
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const edges = bundlesReadArray(item.edges, 20000, 'edges').map(value => {
    const edge = inputReadObject(value, ['id', 'revision', 'kind', 'from', 'to', 'label', 'createdAt', 'updatedAt'], 'edge')
    if (edge.kind !== 'successor' && edge.kind !== 'reference') throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_EDGE_KIND)
    const from = inputReadId(edge.from, 'edge.from'), to = inputReadId(edge.to, 'edge.to')
    const source = nodeMap.get(from), target = nodeMap.get(to)
    if (!source || !target || from === to) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.EDGE_ENDPOINTS_MUST_EXIST_IN_THE_SAME_MAP)
    if (edge.kind === 'successor' && !definitionsReadType(catalog, { id: source.typeId, version: source.typeVersion }).successorTypes
      .some(ref => ref.id === target.typeId && ref.version === target.typeVersion)) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_EDGE_ENDPOINT_KINDS)
    return { id: inputReadId(edge.id, 'edge id'), revision: inputReadRevision(edge.revision, 'edge revision'), kind: edge.kind, from, to,
      ...(edge.label === undefined ? {} : { label: inputReadString(edge.label, 'edge.label') }),
      createdAt: bundlesReadTime(edge.createdAt), updatedAt: bundlesReadTime(edge.updatedAt) } satisfies GraphEdge
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
  return { id: inputReadId(item.id, 'map id'), name: inputReadString(item.name, 'map name'), nodes, edges }
}

/**
 * @param value 数据包中尚未解码并核对摘要的附件记录。
 */
function bundlesReadAsset(value: unknown): BundleAsset {
  const item = inputReadObject(value, ['id', 'filename', 'mediaType', 'size', 'sha256', 'contentBase64'], 'asset')
  const size = inputReadRevision(item.size, 'asset size')
  if (size > ASSET_BYTE_LIMIT) throw new GraphError(413, 'ASSET_LIMIT', RuntimeMessage.ASSET_EXCEEDS_64_MIB)
  const contentBase64 = bundlesReadText(item.contentBase64, 'base64')
  if (contentBase64.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(contentBase64)) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_CANONICAL_BASE64)
  const content = Buffer.from(contentBase64, 'base64')
  const sha256 = inputReadString(item.sha256, 'sha256').toLowerCase()
  if (content.length !== size || !/^[a-f0-9]{64}$/.test(sha256) || createHash('sha256').update(content).digest('hex') !== sha256
    || content.toString('base64') !== contentBase64) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.ASSET_LENGTH_OR_CHECKSUM_DOES_NOT_MATCH)
  return { id: inputReadId(item.id, 'asset id'), filename: inputReadString(item.filename, 'filename'),
    mediaType: inputReadString(item.mediaType, 'mediaType'), size, sha256, contentBase64 }
}

/**
 * @param value 已通过 schema 的 JSON 值。
 * @param pointer 确定且不含通配符的 JSON Pointer。
 */
function bundlesReadPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = value
  for (const part of pointer.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = current[part]
  }
  return current
}

/**
 * 节点引用必须留在同一张图且类型精确匹配；资产引用必须指向包内唯一附件。
 *
 * @param maps 已解析的 v4 图。
 * @param catalog 定义引用解析所需目录。
 * @param assets 包内附件。
 */
function bundlesValidateReferences(maps: BundleMap[], catalog: DefinitionCatalog, assets: BundleAsset[]): void {
  const assetMap = new Map(assets.map(asset => [asset.id, asset])), referencedAssets = new Set<string>()
  for (const map of maps) {
    const nodeMap = new Map(map.nodes.map(node => [node.id, node]))
    for (const node of map.nodes) for (const reference of definitionsReadPayloadReferences(catalog,
      { id: node.typeId, version: node.typeVersion }, node.payload)) {
      if (reference.definition.target.kind === 'node') {
        const target = nodeMap.get(reference.value)
        if (!target || !reference.definition.target.types.some(ref => ref.id === target.typeId && ref.version === target.typeVersion)) {
          bundlesInvalid('Node payload reference is missing from its Map or has another type')
        }
      } else {
        const asset = assetMap.get(reference.value)
        const parent = bundlesReadPointer(node.payload, reference.definition.path.replace(/\/[^/]+$/, ''))
        const expectedMediaType = parent && typeof parent === 'object' && !Array.isArray(parent) && typeof parent.mediaType === 'string' ? parent.mediaType : undefined
        if (!asset || (expectedMediaType !== undefined && asset.mediaType !== expectedMediaType)) {
          throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.ASSET_REFERENCE_IS_MISSING_OR_HAS_ANOTHER_MEDIA_TYPE)
        }
        referencedAssets.add(asset.id)
      }
    }
  }
  if (assets.some(asset => !referencedAssets.has(asset.id))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.BUNDLE_CONTAINS_AN_UNREFERENCED_ASSET)
}

/**
 * 从节点所属包开始沿 package dependencies 求精确闭包，拒绝缺失或夹带无关定义。
 *
 * @param definitions 包声明的定义内容。
 * @param catalog 由该内容构建的目录。
 * @param maps 实际使用类型的节点。
 * @param agents 包中可编辑 Agent，其显式转换绑定也是定义根。
 */
function bundlesValidateDefinitionClosure(definitions: BundleDefinitions, catalog: DefinitionCatalog, maps: BundleMap[],
  agents: readonly Pick<BundleAgent, 'bindings'>[]): void {
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
    for (const ref of bundlesReadPackageDefinitionRefs(packageItem)) {
      const owner = catalog.index.find(item => item.kind === 'dataType' && item.ref.id === ref.id && item.ref.version === ref.version)
      if (!owner) bundlesInvalid(`Referenced definition is missing: ${ref.id}@${ref.version}`)
      queue.push(owner.packageRef)
    }
  }
  if (expected.size !== packages.size || [...packages.keys()].some(key => !expected.has(key))) bundlesInvalid('Definitions are not the exact package closure used by the exported nodes')
  const expectedAgents = new Set([...expected].flatMap(key => packages.get(key)!.dependencies.agents.map(bundlesRefKey)))
  const actualAgents = new Set(definitions.agents.map(agent => bundlesRefKey(agent.ref)))
  if (expectedAgents.size !== actualAgents.size || [...actualAgents].some(key => !expectedAgents.has(key))) bundlesInvalid('Definition Agents are not the exact dependency closure')
  for (const node of maps.flatMap(map => map.nodes)) if (node.producer && !actualAgents.has(bundlesRefKey(node.producer.agentRef))) {
    bundlesInvalid('Node producer Agent is missing from the exact dependency closure')
  }
}

/**
 * v4 是唯一直接导入协议；v3 必须先经 bundlesConvertV3 显式转换。
 *
 * @param value 尚未区分单图或工作区格式的 v4 数据包输入。
 */
export function bundlesReadWorkspace(value: unknown): WorkspaceBundle {
  bundlesAssertSize(value)
  const item = inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'map', 'agents', 'definitions', 'assets'], 'bundle')
  if (item.version !== 4 || (item.format !== 'chongming-workspace' && item.format !== 'chongming-map')) bundlesInvalid('Only v4 ChongMing bundles can be imported directly')
  const id = inputReadId(item.id, 'bundle id'), exportedAt = bundlesReadTime(item.exportedAt)
  const parsedDefinitions = bundlesReadDefinitions(item.definitions)
  let workspace: WorkspaceBundle['workspace'], maps: BundleMap[]
  if (item.format === 'chongming-workspace') {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'definitions', 'assets'], 'workspace bundle')
    const info = inputReadObject(item.workspace, ['name', 'description', 'agents'], 'workspace')
    workspace = { name: inputReadString(info.name, 'workspace name'), description: bundlesReadText(info.description, 'description'),
      agents: bundlesReadArray(info.agents, 512, 'agents').map(bundlesReadAgent) }
    maps = bundlesReadArray(item.maps, 100, 'maps').map(map => bundlesReadMap(map, parsedDefinitions.catalog))
  } else {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'map', 'agents', 'definitions', 'assets'], 'map bundle')
    maps = [bundlesReadMap(item.map, parsedDefinitions.catalog)]
    workspace = { name: maps[0].name, description: '', agents: bundlesReadArray(item.agents, 512, 'agents').map(bundlesReadAgent) }
  }
  const assets = bundlesReadArray(item.assets, 1024, 'assets').map(bundlesReadAsset)
  bundlesValidateIds(maps.map(map => map.id), 'map id')
  bundlesValidateIds(workspace.agents.map(agent => agent.id), 'agent id')
  bundlesValidateIds(workspace.agents.map(agent => agent.promptPath), 'agent promptPath')
  bundlesValidateIds(assets.map(asset => asset.id), 'asset id')
  bundlesValidateAgentSnapshots(workspace.agents, parsedDefinitions.definitions.agents)
  bundlesValidateDefinitionClosure(parsedDefinitions.definitions, parsedDefinitions.catalog, maps, workspace.agents)
  bundlesValidateReferences(maps, parsedDefinitions.catalog, assets)
  return { format: 'chongming-workspace', version: 4, id, exportedAt, workspace, maps,
    definitions: parsedDefinitions.definitions, assets }
}

interface LegacyReport {
  id: string; slotId: string; agentId: string; agentName: string; angle: string; tools: string[]
  routeRevision: number; score: 0 | 0.5 | 1; reason: string; createdAt: string
}

/**
 * @param value v3 结论中嵌入的历史意见。
 */
function bundlesReadLegacyReport(value: unknown): LegacyReport {
  const item = inputReadObject(value, ['id', 'slotId', 'agentId', 'agentName', 'angle', 'tools', 'routeRevision', 'score', 'reason', 'createdAt'], 'opinion')
  if (item.score !== 0 && item.score !== 0.5 && item.score !== 1) bundlesInvalid('Legacy opinion has an invalid score')
  return { id: inputReadString(item.id, 'opinion.id'), slotId: inputReadString(item.slotId, 'opinion.slotId'),
    agentId: inputReadString(item.agentId, 'opinion.agentId'), agentName: inputReadString(item.agentName, 'opinion.agentName'),
    angle: bundlesReadText(item.angle, 'opinion.angle'), tools: bundlesReadStrings(item.tools, 'opinion.tools'),
    routeRevision: inputReadRevision(item.routeRevision, 'opinion.routeRevision'), score: item.score,
    reason: inputReadString(item.reason, 'opinion.reason'), createdAt: bundlesReadTime(item.createdAt) }
}

/**
 * @param value 用于检测同一旧报告身份矛盾内容的 JSON 值。
 */
function bundlesCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(bundlesCanonical).join(',')}]`
  return `{${Object.keys(value as Record<string, unknown>).sort().map(key => `${JSON.stringify(key)}:${bundlesCanonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}

/**
 * 转换包只承载解释旧节点所需的数据类型，不伪造原工作区的可执行转换或 Agent 绑定。
 *
 * @param catalog 显式 v3 转换所依据的已发布事实核查目录。
 */
function bundlesCreateLegacyDefinitions(catalog: DefinitionCatalog): BundleDefinitions {
  const dataTypes = LEGACY_TYPE_IDS.map(id => definitionsReadType(catalog, { id: `factcheck.${id}`, version: 1 }))
  const packageItem: DefinitionPackage = { id: 'factcheck.portable-v3', version: 1, title: 'Fact-checking v3 portable migration',
    description: 'Data-only definitions created by the explicit v3 bundle conversion.',
    schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes, transitions: [], dependencies: { packages: [], agents: [] } }
  definitionsValidateCatalog([packageItem], [])
  return { packages: [packageItem], agents: [], digests: [{ ref: { id: packageItem.id, version: packageItem.version }, digest: definitionsDigest(packageItem) }] }
}

/**
 * @param value 尚未转换的 v3 图。
 * @param catalog 用来校验转换结果的数据类型目录。
 */
function bundlesConvertLegacyMap(value: unknown, catalog: DefinitionCatalog): BundleMap {
  const item = inputReadObject(value, ['id', 'name', 'nodes', 'edges'], 'legacy map')
  const rawNodes = bundlesReadArray(item.nodes, 10000, 'nodes').map(value => {
    const node = inputReadObject(value, ['id', 'revision', 'data', 'createdAt', 'updatedAt', 'importedFrom', 'validity', 'producer'], 'legacy node')
    const data = inputReadObject(node.data, ['kind', 'content', 'context', 'category', 'score', 'reason', 'reportIds', 'opinions', 'locator', 'label', 'capturedAt'], 'legacy node.data')
    if (!LEGACY_TYPE_IDS.includes(data.kind as typeof LEGACY_TYPE_IDS[number]) || data.kind === 'opinion') bundlesInvalid('Legacy node has an unsupported kind')
    return { source: node, data, id: inputReadId(node.id, 'legacy node.id'), revision: inputReadRevision(node.revision, 'legacy node.revision'),
      createdAt: bundlesReadTime(node.createdAt), updatedAt: bundlesReadTime(node.updatedAt) }
  })
  bundlesValidateIds(rawNodes.map(node => node.id), 'legacy node id')
  const reportValues = new Map<string, LegacyReport>(), reportIds = new Map<string, string>()
  for (const node of rawNodes) if (node.data.kind === 'verification') {
    for (const value of bundlesReadArray(node.data.opinions, 128, 'legacy opinions')) {
      const report = bundlesReadLegacyReport(value), prior = reportValues.get(report.id)
      if (prior && bundlesCanonical(prior) !== bundlesCanonical(report)) bundlesInvalid(`Legacy report ${report.id} has conflicting copies`)
      reportValues.set(report.id, report)
      if (!reportIds.has(report.id)) reportIds.set(report.id, randomUUID())
    }
  }
  const nodes: GraphNode[] = rawNodes.map(node => {
    let payload: GraphPayload
    if (node.data.kind === 'verification') {
      const selected = [...new Set(bundlesReadStrings(node.data.reportIds, 'legacy verification.reportIds'))]
      for (const id of selected) if (!reportValues.has(id)) bundlesInvalid(`Legacy verification refers to missing report ${id}`)
      if (node.data.score !== 0 && node.data.score !== 0.5 && node.data.score !== 1) bundlesInvalid('Legacy verification has an invalid score')
      payload = { score: node.data.score, reason: inputReadString(node.data.reason, 'legacy verification.reason'), opinionIds: selected.map(id => reportIds.get(id)!) }
    } else {
      const copy = structuredClone(node.data) as Record<string, unknown>
      delete copy.kind
      payload = graphInputReadPayload(copy, 'legacy node.payload')
    }
    const typeId = `factcheck.${node.data.kind}`
    return { id: node.id, revision: node.revision, typeId, typeVersion: 1,
      payload: definitionsValidatePayload(catalog, { id: typeId, version: 1 }, payload) as GraphPayload,
      createdAt: node.createdAt, updatedAt: node.updatedAt,
      ...(node.source.importedFrom === undefined ? {} : { importedFrom: bundlesReadImportedFrom(node.source.importedFrom) }),
      ...(node.source.validity === undefined ? {} : { validity: node.source.validity as 'current' | 'stale' }),
    }
  })
  for (const report of reportValues.values()) {
    const legacy = { reportId: report.id, slotId: report.slotId, routeRevision: report.routeRevision, agentId: report.agentId,
      agentName: report.agentName, angle: report.angle, tools: report.tools, createdAt: report.createdAt }
    const payload = { score: report.score, reason: report.reason, evidenceIds: [], legacy }
    nodes.push({ id: reportIds.get(report.id)!, revision: 0, typeId: 'factcheck.opinion', typeVersion: 1,
      payload: definitionsValidatePayload(catalog, { id: 'factcheck.opinion', version: 1 }, payload) as GraphPayload,
      createdAt: report.createdAt, updatedAt: report.createdAt })
  }
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const rawEdges = bundlesReadArray(item.edges, 20000, 'legacy edges').map(value => {
    const edge = inputReadObject(value, ['id', 'revision', 'kind', 'from', 'to', 'createdAt', 'updatedAt'], 'legacy edge')
    if (edge.kind !== 'derived-from' && edge.kind !== 'mentions' && edge.kind !== 'verifies' && edge.kind !== 'related-to') bundlesInvalid('Legacy edge has an unsupported kind')
    const from = inputReadId(edge.from, 'legacy edge.from'), to = inputReadId(edge.to, 'legacy edge.to')
    if (!nodeMap.has(from) || !nodeMap.has(to) || from === to) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.EDGE_ENDPOINTS_MUST_EXIST_IN_THE_SAME_MAP)
    return { id: inputReadId(edge.id, 'legacy edge.id'), revision: inputReadRevision(edge.revision, 'legacy edge.revision'),
      kind: edge.kind, from, to, createdAt: bundlesReadTime(edge.createdAt), updatedAt: bundlesReadTime(edge.updatedAt) }
  })
  bundlesValidateIds(rawEdges.map(edge => edge.id), 'legacy edge id')
  const edges: GraphEdge[] = rawEdges.map(edge => ({ id: edge.id, revision: edge.revision,
    kind: edge.kind === 'related-to' || edge.kind === 'verifies' ? 'reference' : 'successor',
    from: edge.kind === 'derived-from' ? edge.to : edge.from, to: edge.kind === 'derived-from' ? edge.from : edge.to,
    label: `legacy:${edge.kind}`, createdAt: edge.createdAt, updatedAt: edge.updatedAt }))
  for (const verification of rawNodes.filter(node => node.data.kind === 'verification')) {
    const selected = [...new Set(bundlesReadStrings(verification.data.reportIds, 'legacy verification.reportIds'))]
    const claims = rawEdges.filter(edge => edge.kind === 'verifies' && edge.from === verification.id).map(edge => edge.to)
    for (const reportId of selected) {
      const opinionId = reportIds.get(reportId)!, report = reportValues.get(reportId)!
      edges.push({ id: randomUUID(), revision: 0, kind: 'successor', from: opinionId, to: verification.id,
        label: 'legacy:opinion-verification', createdAt: report.createdAt, updatedAt: verification.updatedAt })
      for (const claimId of claims) edges.push({ id: randomUUID(), revision: 0, kind: 'successor', from: claimId, to: opinionId,
        label: 'legacy:claim-opinion', createdAt: report.createdAt, updatedAt: verification.updatedAt })
    }
  }
  return bundlesReadMap({ id: inputReadId(item.id, 'legacy map.id'), name: inputReadString(item.name, 'legacy map.name'), nodes, edges }, catalog)
}

/**
 * 把 v3 业务 kind 和嵌入意见一次性转成 v4；旧包不被当作 v4 宽松解析。
 *
 * @param value 尚未转换的旧数据包。
 * @param definitions 显式选定的事实核查定义目录。
 */
export function bundlesConvertV3(value: unknown, definitions: DefinitionCatalog): WorkspaceBundle {
  bundlesAssertSize(value)
  const item = inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'map', 'agents', 'assets'], 'legacy bundle')
  if (item.version !== 3 || (item.format !== 'chongming-workspace' && item.format !== 'chongming-map')) bundlesInvalid('Expected an explicit v3 ChongMing bundle conversion input')
  const legacyDefinitions = bundlesCreateLegacyDefinitions(definitions)
  const catalog = definitionsValidateCatalog(legacyDefinitions.packages, legacyDefinitions.agents)
  let workspace: WorkspaceBundle['workspace'], maps: BundleMap[]
  if (item.format === 'chongming-workspace') {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'assets'], 'legacy workspace bundle')
    const info = inputReadObject(item.workspace, ['name', 'description', 'agents'], 'legacy workspace')
    workspace = { name: inputReadString(info.name, 'workspace name'), description: bundlesReadText(info.description, 'description'),
      agents: bundlesReadArray(info.agents, 512, 'agents').map(value => ({ ...controlReadAgent(value), revision: 0 })) }
    maps = bundlesReadArray(item.maps, 100, 'maps').map(map => bundlesConvertLegacyMap(map, catalog))
  } else {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'map', 'agents', 'assets'], 'legacy map bundle')
    maps = [bundlesConvertLegacyMap(item.map, catalog)]
    workspace = { name: maps[0].name, description: '', agents: bundlesReadArray(item.agents, 512, 'agents').map(value => ({ ...controlReadAgent(value), revision: 0 })) }
  }
  const converted: WorkspaceBundle = { format: 'chongming-workspace', version: 4, id: inputReadId(item.id, 'bundle id'),
    exportedAt: bundlesReadTime(item.exportedAt), workspace, maps, definitions: legacyDefinitions,
    assets: bundlesReadArray(item.assets, 1024, 'assets').map(bundlesReadAsset) }
  return bundlesReadWorkspace(converted)
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
 * 只投影名称、数据实例和关系，Run、租约、审核候选与收据均不在包协议中。
 *
 * @param document 需要投影为便携图并排除运行内部状态的图文档。
 */
export function bundlesReadMapDocument(document: GraphDocument): BundleMap {
  return { id: document.id, name: document.name, nodes: document.nodes.map(({ payloadReferences: _references, ...node }) => structuredClone(node)),
    edges: structuredClone(document.edges) }
}

/**
 * 从节点的精确类型反查所属包，并递归补齐包依赖及 Agent 依赖。
 *
 * @param workspaceId 已授权的工作区身份。
 * @param nodes 实际要导出的节点。
 * @param catalog 工作区定义目录。
 * @param readPackage 按精确引用读取不可变包体的授权回调。
 * @param availableAgents 可见的当前与历史 Agent 执行快照。
 * @param editableAgents 导出包保留的可编辑 Agent，其转换绑定必须同时可解析。
 */
export async function bundlesReadDefinitionClosure(
  workspaceId: string,
  nodes: readonly GraphNode[],
  catalog: DefinitionCatalog,
  readPackage: (workspaceId: string, ref: DefinitionRef) => Promise<DefinitionView>,
  availableAgents: readonly ExecutionAgentDefinition[],
  editableAgents: readonly Pick<BundleAgent, 'bindings'>[] = [],
): Promise<BundleDefinitions> {
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
  while (queue.length) {
    const ref = queue.shift()!, key = bundlesRefKey(ref)
    if (packages.has(key)) continue
    const view = await readPackage(workspaceId, ref)
    if (!view.package) bundlesInvalid(`Definition package is missing: ${ref.id}@${ref.version}`)
    const packageItem = definitionsReadPackage(view.package)
    const expected = catalog.packages.find(item => bundlesRefKey(item.ref) === key)?.digest
    if (!expected || definitionsDigest(packageItem) !== expected) bundlesInvalid(`Definition package digest changed: ${ref.id}@${ref.version}`)
    packages.set(key, packageItem); queue.push(...packageItem.dependencies.packages)
    for (const dependency of bundlesReadPackageDefinitionRefs(packageItem)) {
      const owner = catalog.index.find(item => item.kind === 'dataType' && item.ref.id === dependency.id && item.ref.version === dependency.version)
      if (!owner) bundlesInvalid(`Referenced definition is missing: ${dependency.id}@${dependency.version}`)
      queue.push(owner.packageRef)
    }
  }
  const agentMap = new Map(availableAgents.map(agent => [bundlesRefKey(agent.ref), agent])), agents: ExecutionAgentDefinition[] = []
  const agentKeys = new Set([...packages.values()].flatMap(packageItem => packageItem.dependencies.agents.map(bundlesRefKey)))
  for (const key of agentKeys) {
    const agent = agentMap.get(key)
    if (!agent) bundlesInvalid('Definition Agent dependency is unavailable')
    agents.push(structuredClone(agent))
  }
  const result: BundleDefinitions = { packages: [...packages.values()], agents,
    digests: [...packages.values()].map(packageItem => ({ ref: { id: packageItem.id, version: packageItem.version }, digest: definitionsDigest(packageItem) })) }
  bundlesValidateDefinitionClosure(result, definitionsValidateCatalog(result.packages, result.agents), [{ id: randomUUID(), name: '', nodes: [...nodes], edges: [] }], editableAgents)
  return result
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
 * @param node 导入前的原节点。
 * @param catalog 精确定义目录。
 * @param nodeIds 本图节点身份映射。
 * @param assetIds 整包资产身份映射。
 */
function bundlesRewritePayload(node: GraphNode, catalog: DefinitionCatalog,
  nodeIds: Map<string, string>, assetIds: Map<string, string>): GraphPayload {
  const payload = structuredClone(node.payload)
  const active = definitionsReadPayloadReferences(catalog, { id: node.typeId, version: node.typeVersion }, payload)
  const definitions = new Map(active.map(reference => [`${reference.definition.path}\u0000${reference.definition.target.kind}`, reference.definition]))
  for (const reference of definitions.values()) {
    const ids = reference.target.kind === 'asset' ? assetIds : nodeIds
    bundlesRewriteAt(payload, reference.path.slice(1).split('/').map(item => item.replace(/~1/g, '/').replace(/~0/g, '~')), value => {
      const replacement = ids.get(value)
      if (!replacement) bundlesInvalid(`${reference.target.kind} reference cannot be remapped during import`)
      return replacement
    })
  }
  definitionsValidatePayload(catalog, { id: node.typeId, version: node.typeVersion }, payload)
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
 * @param bundle 已通过 v4 包校验、准备重映射身份的工作区包。
 * @param workspaceId 新导入工作区预先分配的稳定身份。
 * @param overrideName 用户指定的新工作区名称；null 表示沿用包内名称。
 */
export function bundlesCreateImport(bundle: WorkspaceBundle, workspaceId: string, overrideName: string | null) {
  const now = new Date().toISOString()
  const agentIds = new Map(bundle.workspace.agents.map(agent => [agent.id, randomUUID()])), assetIds = new Map(bundle.assets.map(asset => [asset.id, randomUUID()]))
  const agents: AgentInput[] = bundle.workspace.agents.map(({ revision: _revision, ...agent }) => ({ ...agent, id: agentIds.get(agent.id)! }))
  const agentRefs = new Map<string, DefinitionRef>()
  for (const agent of bundle.workspace.agents) agentRefs.set(bundlesRefKey({ id: agent.id, version: agent.revision }), { id: agentIds.get(agent.id)!, version: 0 })
  const definitionAgents = bundle.definitions.agents.map(agent => {
    const ref = agentRefs.get(bundlesRefKey(agent.ref)) ?? agent.ref
    return { ref: structuredClone(ref), profile: { ...structuredClone(agent.profile), id: ref.id } }
  })
  const packages = bundle.definitions.packages.map(packageItem => bundlesRemapPackageAgents(packageItem, agentRefs))
  const catalog = definitionsValidateCatalog(packages, definitionAgents)
  const maps = bundle.maps.map(map => {
    const nodeIds = new Map(map.nodes.map(node => [node.id, randomUUID()]))
    const nodes = map.nodes.map(original => {
      const payload = bundlesRewritePayload(original, catalog, nodeIds, assetIds)
      return {
        id: nodeIds.get(original.id)!, revision: original.revision, typeId: original.typeId, typeVersion: original.typeVersion,
        payload, payloadReferences: graphReadPayloadReferenceIndex(catalog, { id: original.typeId, version: original.typeVersion }, payload),
        createdAt: original.createdAt, updatedAt: now,
        importedFrom: { bundleId: bundle.id, nodeId: original.id, revision: original.revision },
        ...(original.validity ? { validity: original.validity } : {}),
        ...(original.producer ? { producer: { ...structuredClone(original.producer),
          agentRef: structuredClone(agentRefs.get(bundlesRefKey(original.producer.agentRef)) ?? original.producer.agentRef) } } : {}),
      } satisfies GraphNode
    })
    const edges = map.edges.map(edge => ({ ...edge, id: randomUUID(), from: nodeIds.get(edge.from)!, to: nodeIds.get(edge.to)!, updatedAt: now }))
    const document: GraphDocument = { id: randomUUID(), workspaceId, revision: 0, name: map.name,
      nodes, edges, retiredNodeIds: [], retiredEdgeIds: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    if (Buffer.byteLength(JSON.stringify(document)) > 8 * 1024 * 1024) throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.IMPORTED_MAP_EXCEEDS_8_MIB)
    return document
  })
  return { workspace: { id: workspaceId, name: overrideName ?? bundle.workspace.name, description: bundle.workspace.description, agentSource: 'empty' as const },
    agents, definitions: { packages, agents: definitionAgents }, maps,
    assets: bundle.assets.map(asset => ({ original: asset, id: assetIds.get(asset.id)! })) }
}
