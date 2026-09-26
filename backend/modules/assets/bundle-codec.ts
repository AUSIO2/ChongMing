import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { createHash, randomUUID } from 'node:crypto'
import type { AgentInput, AgentProfile, BundleAsset, BundleMap, WorkspaceBundle } from '../../../contracts/control'
import type { GraphEdge, GraphNode } from '../../../contracts/graph'
import { controlReadAgent } from '../workspace/workspace-input'
import { GraphError } from '../shared/domain-error'
import { graphInputReadNodeData } from '../graph/graph-input'
import { inputReadArray, inputReadId, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'
import type { GraphDocument } from '../graph/graph-record'

export const ASSET_BYTE_LIMIT = 64 * 1024 * 1024
export const BUNDLE_BYTE_LIMIT = ASSET_BYTE_LIMIT

// 用途：校验大小输入，发现不符合约束时立即报错。
export function bundlesAssertSize(value: unknown): void {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > BUNDLE_BYTE_LIMIT) throw new GraphError(413, 'BUNDLE_LIMIT', RuntimeMessage.THE_COMPLETE_BASE64_BUNDLE_EXCEEDS_64_MIB)
}
// 用途：读取数组，并把结构化结果交给调用方。
function bundlesReadArray(value: unknown, max: number, label: string): unknown[] {
  const items = inputReadArray(value, label)
  if (items.length > max) throw new GraphError(413, 'BUNDLE_LIMIT', messageFormat(RuntimeMessage.VALUE_HAS_TOO_MANY_ENTRIES, label))
  return items
}
// 用途：读取文本，并把结构化结果交给调用方。
function bundlesReadText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GraphError(422, 'BUNDLE_INVALID', messageFormat(RuntimeMessage.VALUE_MUST_BE_TEXT, label))
  return value
}
// 用途：读取时间，并把结构化结果交给调用方。
function bundlesReadTime(value: unknown): string {
  const text = inputReadString(value, 'timestamp')
  if (!Number.isFinite(Date.parse(text))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_TIMESTAMP)
  return new Date(text).toISOString()
}
// 用途：校验标识输入，发现不符合约束时立即报错。
function bundlesValidateIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new GraphError(422, 'BUNDLE_INVALID', messageFormat(RuntimeMessage.DUPLICATE_VALUE, label))
}
// 用途：读取节点，并把结构化结果交给调用方。
function bundlesReadNode(value: unknown): GraphNode {
  const item = inputReadObject(value, ['id', 'revision', 'data', 'createdAt', 'updatedAt', 'importedFrom', 'validity'], 'node')
  const node: GraphNode = {
    id: inputReadId(item.id, 'node id'), revision: inputReadRevision(item.revision, 'node revision'),
    data: graphInputReadNodeData(item.data, 'node.data'), createdAt: bundlesReadTime(item.createdAt), updatedAt: bundlesReadTime(item.updatedAt),
  }
  if (item.validity !== undefined) {
    if (item.validity !== 'current' && item.validity !== 'stale') throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_VALIDITY_MARKER)
    node.validity = item.validity
  }
  if (item.importedFrom !== undefined) {
    const source = inputReadObject(item.importedFrom, ['bundleId', 'nodeId', 'revision'], 'importedFrom')
    node.importedFrom = { bundleId: inputReadId(source.bundleId, 'bundleId'), nodeId: inputReadId(source.nodeId, 'nodeId'), revision: inputReadRevision(source.revision, 'revision') }
  }
  return node
}
// 用途：读取数据图，并把结构化结果交给调用方。
function bundlesReadMap(value: unknown): BundleMap {
  const item = inputReadObject(value, ['id', 'name', 'nodes', 'edges'], 'map')
  const nodes = bundlesReadArray(item.nodes, 10000, 'nodes').map(bundlesReadNode)
  bundlesValidateIds(nodes.map(node => node.id), 'node id')
  const nodeMap = new Map(nodes.map(node => [node.id, node]))
  const edges = bundlesReadArray(item.edges, 20000, 'edges').map(value => {
    const edge = inputReadObject(value, ['id', 'revision', 'kind', 'from', 'to', 'createdAt', 'updatedAt'], 'edge')
    if (edge.kind !== 'derived-from' && edge.kind !== 'mentions' && edge.kind !== 'verifies' && edge.kind !== 'related-to') throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_EDGE_KIND)
    const from = inputReadId(edge.from, 'edge.from'), to = inputReadId(edge.to, 'edge.to')
    const source = nodeMap.get(from), target = nodeMap.get(to)
    if (!source || !target || from === to) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.EDGE_ENDPOINTS_MUST_EXIST_IN_THE_SAME_MAP)
    if ((edge.kind === 'mentions' && (source.data.kind !== 'news' || target.data.kind !== 'claim'))
      || (edge.kind === 'verifies' && (source.data.kind !== 'verification' || target.data.kind !== 'claim'))
      || (edge.kind === 'derived-from' && !((source.data.kind === 'news' && target.data.kind === 'source')
        || (source.data.kind === 'claim' && target.data.kind === 'news')))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_EDGE_ENDPOINT_KINDS)
    return { id: inputReadId(edge.id, 'edge id'), revision: inputReadRevision(edge.revision, 'edge revision'),
      kind: edge.kind, from, to, createdAt: bundlesReadTime(edge.createdAt), updatedAt: bundlesReadTime(edge.updatedAt) } satisfies GraphEdge
  })
  bundlesValidateIds(edges.map(edge => edge.id), 'edge id')
  return { id: inputReadId(item.id, 'map id'), name: inputReadString(item.name, 'map name'), nodes, edges }
}
// 用途：读取资产，并把结构化结果交给调用方。
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

/** Parse both portable v3 formats; a single Map imports into a new Workspace. */
// 用途：读取工作区，并把结构化结果交给调用方。
export function bundlesReadWorkspace(value: unknown): WorkspaceBundle {
  bundlesAssertSize(value)
  const item = inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'map', 'agents', 'assets'], 'bundle')
  if (item.version !== 3 || (item.format !== 'chongming-workspace' && item.format !== 'chongming-map')) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.ONLY_V3_CHONGMING_BUNDLES_ARE_SUPPORTED)
  const id = inputReadId(item.id, 'bundle id'), exportedAt = bundlesReadTime(item.exportedAt)
  let workspace: WorkspaceBundle['workspace']
  let maps: BundleMap[]
  if (item.format === 'chongming-workspace') {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'workspace', 'maps', 'assets'], 'workspace bundle')
    const info = inputReadObject(item.workspace, ['name', 'description', 'agents'], 'workspace')
    workspace = { name: inputReadString(info.name, 'workspace name'), description: bundlesReadText(info.description, 'description'),
      agents: bundlesReadArray(info.agents, 512, 'agents').map(controlReadAgent) }
    maps = bundlesReadArray(item.maps, 100, 'maps').map(bundlesReadMap)
  } else {
    inputReadObject(value, ['format', 'version', 'id', 'exportedAt', 'map', 'agents', 'assets'], 'map bundle')
    maps = [bundlesReadMap(item.map)]
    workspace = { name: maps[0].name, description: '', agents: bundlesReadArray(item.agents, 512, 'agents').map(controlReadAgent) }
  }
  const assets = bundlesReadArray(item.assets, 1024, 'assets').map(bundlesReadAsset)
  bundlesValidateIds(maps.map(map => map.id), 'map id')
  bundlesValidateIds(workspace.agents.map(agent => agent.id), 'agent id')
  bundlesValidateIds(workspace.agents.map(agent => agent.promptPath), 'agent promptPath')
  bundlesValidateIds(assets.map(asset => asset.id), 'asset id')
  const assetMap = new Map(assets.map(asset => [asset.id, asset]))
  const referenced = new Set<string>()
  for (const map of maps) for (const node of map.nodes) {
    if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') {
      const asset = assetMap.get(node.data.locator.assetId)
      if (!asset || asset.mediaType !== node.data.locator.mediaType) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.ASSET_REFERENCE_IS_MISSING_OR_HAS_ANOTHER_MEDIA_TYPE)
      referenced.add(asset.id)
    }
  }
  if (assets.some(asset => !referenced.has(asset.id))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.BUNDLE_CONTAINS_AN_UNREFERENCED_ASSET)
  return { format: 'chongming-workspace', version: 3, id, exportedAt, workspace, maps, assets }
}

/** Strip internal profile metadata using an explicit public-field allowlist. */
// 用途：读取Agent列表，并把结构化结果交给调用方。
export function bundlesReadAgents(agents: AgentProfile[]): AgentInput[] {
  return agents.map(agent => controlReadAgent({
    id: agent.id, name: agent.name, description: agent.description, content: agent.content, tools: agent.tools,
    promptPath: agent.promptPath, kind: agent.kind, provider: agent.provider, model: agent.model, promptVars: agent.promptVars,
    defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
  }))
}
// 用途：读取数据图文档，并把结构化结果交给调用方。
export function bundlesReadMapDocument(document: GraphDocument): BundleMap {
  return bundlesReadMap({ id: document.id, name: document.name, nodes: document.nodes, edges: document.edges })
}

// 用途：创建当前模块，供后续流程使用。
export function bundlesCreateImport(bundle: WorkspaceBundle, workspaceId: string, overrideName: string | null) {
  const now = new Date().toISOString()
  const agentIds = new Map(bundle.workspace.agents.map(agent => [agent.id, randomUUID()]))
  const assetIds = new Map(bundle.assets.map(asset => [asset.id, randomUUID()]))
  const agents = bundle.workspace.agents.map(agent => ({ ...agent, id: agentIds.get(agent.id)! }))
  const maps = bundle.maps.map(map => {
    const nodeIds = new Map(map.nodes.map(node => [node.id, randomUUID()]))
    const slotIds = new Map<string, string>()
    const id = (mapping: Map<string, string>, original: string) => {
      if (!mapping.has(original)) mapping.set(original, randomUUID())
      return mapping.get(original)!
    }
    const nodes = map.nodes.map(original => {
      const data = structuredClone(original.data)
      if ((data.kind === 'source' || data.kind === 'evidence') && data.locator.kind === 'asset') data.locator.assetId = assetIds.get(data.locator.assetId)!
      if (data.kind === 'verification') {
        // Reports remain non-executable historical labels; only bundled Agent identities are remapped.
        data.opinions = data.opinions.map(opinion => ({ ...opinion,
          slotId: id(slotIds, opinion.slotId), agentId: agentIds.get(opinion.agentId) ?? opinion.agentId }))
      }
      return { id: nodeIds.get(original.id)!, revision: original.revision, data, createdAt: original.createdAt, updatedAt: now,
        importedFrom: { bundleId: bundle.id, nodeId: original.id, revision: original.revision },
        ...(data.kind === 'verification' ? { validity: 'stale' as const } : original.validity ? { validity: original.validity } : {}),
      } satisfies GraphNode
    })
    const edges = map.edges.map(edge => ({ ...edge, id: randomUUID(), from: nodeIds.get(edge.from)!, to: nodeIds.get(edge.to)!, updatedAt: now }))
    const document: GraphDocument = { id: randomUUID(), workspaceId, revision: 0, name: map.name,
      nodes, edges, run: null, runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    if (Buffer.byteLength(JSON.stringify(document)) > 8 * 1024 * 1024) throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.IMPORTED_MAP_EXCEEDS_8_MIB)
    return document
  })
  return { workspace: { id: workspaceId, name: overrideName ?? bundle.workspace.name, description: bundle.workspace.description, agentSource: 'empty' as const },
    agents, maps, assets: bundle.assets.map(asset => ({ original: asset, id: assetIds.get(asset.id)! })) }
}
