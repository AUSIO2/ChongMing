// 校验可携带附件的数据包，并在导入前重映射身份、关系和历史来源。
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

export function bundlesAssertSize(/* 需要按完整 JSON 序列化大小检查上限的数据包输入。 */ value: unknown): void {
  // 按 UTF-8 序列化后的完整 JSON 大小检查数据包上限，计入附件的 Base64 膨胀。
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > BUNDLE_BYTE_LIMIT) throw new GraphError(413, 'BUNDLE_LIMIT', RuntimeMessage.THE_COMPLETE_BASE64_BUNDLE_EXCEEDS_64_MIB)
}
function bundlesReadArray(/* 尚未确认数组类型和条目数量的包内字段。 */ value: unknown, /* 该数组允许包含的最大条目数。 */ max: number, /* 写入包错误信息的数组字段路径。 */ label: string): unknown[] {
  // 要求数组并限制条目总数，避免单个数据包导入过量对象。
  const items = inputReadArray(value, label)
  if (items.length > max) throw new GraphError(413, 'BUNDLE_LIMIT', messageFormat(RuntimeMessage.VALUE_HAS_TOO_MANY_ENTRIES, label))
  return items
}
function bundlesReadText(/* 数据包中允许为空但必须为字符串的字段值。 */ value: unknown, /* 写入包错误信息的文本字段路径。 */ label: string): string {
  // 接受可为空的包内文本，同时拒绝非文本类型。
  if (typeof value !== 'string') throw new GraphError(422, 'BUNDLE_INVALID', messageFormat(RuntimeMessage.VALUE_MUST_BE_TEXT, label))
  return value
}
function bundlesReadTime(/* 数据包中尚未验证和规范化的时间值。 */ value: unknown): string {
  // 验证可解析的时间字符串，并统一为 ISO 时间。
  const text = inputReadString(value, 'timestamp')
  if (!Number.isFinite(Date.parse(text))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.INVALID_TIMESTAMP)
  return new Date(text).toISOString()
}
function bundlesValidateIds(/* 必须在同类对象中互不重复的身份或路径列表。 */ ids: string[], /* 写入包错误信息的对象类型名称。 */ label: string): void {
  // 拒绝包内同类对象的重复身份或路径，使引用解析保持唯一。
  if (new Set(ids).size !== ids.length) throw new GraphError(422, 'BUNDLE_INVALID', messageFormat(RuntimeMessage.DUPLICATE_VALUE, label))
}
function bundlesReadNode(/* 数据包中尚未解析的节点记录。 */ value: unknown): GraphNode {
  // 解析节点内容、版本和时间，并验证可选的失效标记与导入来源。
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
function bundlesReadMap(/* 数据包中尚未校验节点、关系和端点的图记录。 */ value: unknown): BundleMap {
  // 校验图内节点与边的数量、唯一身份和端点类型，拒绝悬空、自指及错配关系。
  const item = inputReadObject(value, ['id', 'name', 'nodes', 'edges'], 'map')
  const nodes = bundlesReadArray(item.nodes, 10000, 'nodes').map(bundlesReadNode)
  bundlesValidateIds(nodes.map(/* 当前提取身份以检查重复的已解析节点。 */ node => /* 收集节点身份用于检测重复节点。 */ node.id), 'node id')
  const nodeMap = new Map(nodes.map(/* 当前加入端点查找表的已解析节点。 */ node => /* 建立端点查找表，以验证每条边引用本图内的节点。 */ [node.id, node]))
  const edges = bundlesReadArray(item.edges, 20000, 'edges').map(/* 关系数组中当前尚未验证的边记录。 */ value => {
    // 解析一条关系，要求端点存在且满足该关系的节点类型约束。
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
  bundlesValidateIds(edges.map(/* 当前提取身份以检查重复的已解析关系。 */ edge => /* 收集边身份以拒绝重复关系记录。 */ edge.id), 'edge id')
  return { id: inputReadId(item.id, 'map id'), name: inputReadString(item.name, 'map name'), nodes, edges }
}
function bundlesReadAsset(/* 数据包中尚未解码并核对摘要的附件记录。 */ value: unknown): BundleAsset {
  // 解码附件并核对规范 Base64、声明字节数及 SHA-256，返回可安全导入的附件。
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

export function bundlesReadWorkspace(/* 尚未区分单图或工作区格式的 v3 数据包输入。 */ value: unknown): WorkspaceBundle {
  // 将 v3 单图包和工作区包统一为工作区包，校验对象唯一性及附件引用的完整性。
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
  bundlesValidateIds(maps.map(/* 当前提取身份以检查多图包重复项的图。 */ map => /* 检查多图包是否重复声明同一张图。 */ map.id), 'map id')
  bundlesValidateIds(workspace.agents.map(/* 当前提取身份以检查重复配置的 Agent。 */ agent => /* 检查导入 Agent 的身份是否重复。 */ agent.id), 'agent id')
  bundlesValidateIds(workspace.agents.map(/* 当前提取提示词路径以检查配置冲突的 Agent。 */ agent => /* 检查导入 Agent 的提示词路径是否冲突。 */ agent.promptPath), 'agent promptPath')
  bundlesValidateIds(assets.map(/* 当前提取身份以检查重复项的附件。 */ asset => /* 检查附件身份是否重复。 */ asset.id), 'asset id')
  const assetMap = new Map(assets.map(/* 当前加入引用查找表的已验证附件。 */ asset => /* 建立附件索引，用于核对节点引用及媒体类型。 */ [asset.id, asset]))
  const referenced = new Set<string>()
  for (const map of maps) for (const node of map.nodes) {
    if ((node.data.kind === 'source' || node.data.kind === 'evidence') && node.data.locator.kind === 'asset') {
      const asset = assetMap.get(node.data.locator.assetId)
      if (!asset || asset.mediaType !== node.data.locator.mediaType) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.ASSET_REFERENCE_IS_MISSING_OR_HAS_ANOTHER_MEDIA_TYPE)
      referenced.add(asset.id)
    }
  }
  if (assets.some(/* 当前检查是否未被任何节点引用的附件。 */ asset => /* 发现未被任何节点引用的附件时拒绝整个包，避免携带游离内容。 */ !referenced.has(asset.id))) throw new GraphError(422, 'BUNDLE_INVALID', RuntimeMessage.BUNDLE_CONTAINS_AN_UNREFERENCED_ASSET)
  return { format: 'chongming-workspace', version: 3, id, exportedAt, workspace, maps, assets }
}

export function bundlesReadAgents(/* 需要去除内部版本和管理字段的 Agent 配置列表。 */ agents: AgentProfile[]): AgentInput[] {
  // 用公开字段白名单导出 Agent 配置，排除内部版本和管理元数据。
  return agents.map(/* 当前按公开字段白名单投影的 Agent 配置。 */ agent => /* 复制可导出的配置字段并再次通过公开输入校验。 */ controlReadAgent({
    id: agent.id, name: agent.name, description: agent.description, content: agent.content, tools: agent.tools,
    promptPath: agent.promptPath, kind: agent.kind, provider: agent.provider, model: agent.model, promptVars: agent.promptVars,
    defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
  }))
}
export function bundlesReadMapDocument(/* 需要投影为便携图并排除运行内部状态的图文档。 */ document: GraphDocument): BundleMap {
  // 只导出图名称、节点和边，排除执行租约、运行历史及请求收据。
  return bundlesReadMap({ id: document.id, name: document.name, nodes: document.nodes, edges: document.edges })
}

export function bundlesCreateImport(/* 已经过 v3 包校验、准备重映射身份的工作区包。 */ bundle: WorkspaceBundle, /* 新导入工作区预先分配的稳定身份。 */ workspaceId: string, /* 用户指定的新工作区名称；null 表示沿用包内名称。 */ overrideName: string | null) {
  // 为导入对象分配新身份，重写引用并保留溯源；导入的核查结论标记为过时。
  const now = new Date().toISOString()
  const agentIds = new Map(bundle.workspace.agents.map(/* 当前分配新工作区 Agent 身份的包内配置。 */ agent => /* 为每个随包 Agent 生成新的工作区内身份。 */ [agent.id, randomUUID()]))
  const assetIds = new Map(bundle.assets.map(/* 当前分配新资产身份的包内附件。 */ asset => /* 为每个包内附件生成新的资产身份。 */ [asset.id, randomUUID()]))
  const agents = bundle.workspace.agents.map(/* 当前替换为新 Agent 身份的包内配置。 */ agent => /* 保留 Agent 配置正文并替换为新分配的身份。 */ ({ ...agent, id: agentIds.get(agent.id)! }))
  const maps = bundle.maps.map(/* 当前转换为新持久化文档的便携图。 */ map => {
    // 将一张便携图转换为新工作区的独立持久化文档，不继承可执行状态。
    const nodeIds = new Map(map.nodes.map(/* 当前预分配新节点身份的包内节点。 */ node => /* 为本图每个原节点预分配新身份，以保持所有关系引用一致。 */ [node.id, randomUUID()]))
    const slotIds = new Map<string, string>()
    const id = (/* 原身份到新身份的当前映射表。 */ mapping: Map<string, string>, /* 需要查找或惰性分配新身份的原标识。 */ original: string) => {
      // 按原标识惰性建立并复用槽位映射，保证多份意见引用同一旧槽位时一致。
      if (!mapping.has(original)) mapping.set(original, randomUUID())
      return mapping.get(original)!
    }
    const nodes = map.nodes.map(/* 当前复制数据、重写引用并记录溯源的原节点。 */ original => {
      // 复制节点数据并替换资产引用，记录原包节点来源，同时使旧核查结论失效。
      const data = structuredClone(original.data)
      if ((data.kind === 'source' || data.kind === 'evidence') && data.locator.kind === 'asset') data.locator.assetId = assetIds.get(data.locator.assetId)!
      if (data.kind === 'verification') {
        // 意见保留为不可执行的历史记录；只重映射随包导入的 Agent，其他身份继续作为历史标签。
        data.opinions = data.opinions.map(/* 包内历史核查意见；槽位重新映射，Agent 身份仅在其配置随包导入时替换。 */ opinion => /* 重映射槽位及随包 Agent 身份，保留未随包导入的历史 Agent 标签。 */ ({ ...opinion,
          slotId: id(slotIds, opinion.slotId), agentId: agentIds.get(opinion.agentId) ?? opinion.agentId }))
      }
      return { id: nodeIds.get(original.id)!, revision: original.revision, data, createdAt: original.createdAt, updatedAt: now,
        importedFrom: { bundleId: bundle.id, nodeId: original.id, revision: original.revision },
        ...(data.kind === 'verification' ? { validity: 'stale' as const } : original.validity ? { validity: original.validity } : {}),
      } satisfies GraphNode
    })
    const edges = map.edges.map(/* 当前生成新关系身份并重写端点的包内关系。 */ edge => /* 为关系生成新身份，并将两端替换为本图导入后的节点。 */ ({ ...edge, id: randomUUID(), from: nodeIds.get(edge.from)!, to: nodeIds.get(edge.to)!, updatedAt: now }))
    const document: GraphDocument = { id: randomUUID(), workspaceId, revision: 0, name: map.name,
      nodes, edges, run: null, runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    if (Buffer.byteLength(JSON.stringify(document)) > 8 * 1024 * 1024) throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.IMPORTED_MAP_EXCEEDS_8_MIB)
    return document
  })
  return { workspace: { id: workspaceId, name: overrideName ?? bundle.workspace.name, description: bundle.workspace.description, agentSource: 'empty' as const },
    agents, maps, assets: bundle.assets.map(/* 当前与新身份配对、交给资产服务写入的包内附件。 */ asset => /* 把已校验附件与新分配身份一起交给资产服务写入。 */ ({ original: asset, id: assetIds.get(asset.id)! })) }
}
