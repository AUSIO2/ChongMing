// 冻结 Claim 的真实结构上下游与声明引用，有限邻域只保存已取得完整快照的端点。
import type { Asset } from '../../../contracts/control'
import type { EvidenceClaimRef, EvidenceRelationEdge, EvidenceRelationNode, EvidenceRelationSnapshot } from '../../../contracts/evidence-library'
import type { GraphEdge, GraphNode } from '../../../contracts/graph'
import { storeCreateInputHash, type GraphDocument } from '../graph/graph-record'
import type { PayloadReferenceValue } from '../shared/data-definition'

const MAX_NODES = 128
const MAX_EDGES = 256
const MAX_DEPTH = 8
const ROLE_PRIORITY: Record<EvidenceRelationNode['role'], number> = {
  claim: 0, basis: 1, upstream: 2, downstream: 3, dependency: 4,
}

export interface EvidenceRelationSource {
  ref: EvidenceClaimRef
  nodeSnapshot: GraphNode
  definitionDigest: string
  nodeReferences: Array<{ path: string; targetId: string }>
  assets: Asset[]
}

interface RelationQueueItem { source: EvidenceRelationSource; depth: number }
interface RelationCandidate { targetId: string; edge: GraphEdge }
export interface EvidenceFrozenRelations { snapshot: EvidenceRelationSnapshot; assets: Asset[] }

export function evidenceCreateRelationNodeKey(
  /* Map、节点及内容版本共同组成的精确身份。 */ ref: EvidenceClaimRef,
): string {
  // 同名节点或不同版本不会共用一个冻结邻域身份。
  return storeCreateInputHash({ mapId: ref.mapId, nodeId: ref.nodeId, revision: ref.revision })
}

export function evidenceReadNodeReferencePaths(
  /* 已考虑引用声明条件且已校验字符串值的实际引用。 */ references: readonly PayloadReferenceValue[],
): Array<{ path: string; targetId: string }> {
  // 复用正文解析已展开的实际路径，不按同一声明反复遍历整个 payload。
  const unique = new Map<string, { path: string; targetId: string }>()
  for (const reference of references) {
    if (reference.definition.target.kind !== 'node') continue
    const relation = { path: reference.path, targetId: reference.value }
    unique.set(`${relation.path}\u0000${relation.targetId}`, relation)
  }
  return [...unique.values()].sort((
    /* 待固定排序的首个实际引用。 */ left,
    /* 待固定排序的第二个实际引用。 */ right,
  ) => /* 顺序仅稳定序列化，不改写引用路径或目标。 */ left.path.localeCompare(right.path) || left.targetId.localeCompare(right.targetId))
}

export async function evidenceCaptureRelations(
  /* 已冻结并验证的主 Claim，永远保留为唯一根。 */ root: EvidenceRelationSource,
  /* 用户明确选择的节点依据及原依据位置，先于扩展邻域保留。 */ basisNodes: readonly { source: EvidenceRelationSource; basisIndex: number }[],
  /* 与新条目 collectedAt 完全相同的收录时间。 */ capturedAt: string,
  /* 同一收录事务中读取并验证工作区归属的来源 Map。 */ readMap: (mapId: string) => Promise<GraphDocument>,
  /* 同一事务中按精确版本校验 schema 和直接资产的节点冻结步骤。 */ freezeSource: (ref: EvidenceClaimRef) => Promise<EvidenceRelationSource>,
): Promise<EvidenceFrozenRelations> {
  // 优先固定根与选定依据，再沿真实 successor 和引用逐类遍历；所有边均绑定已保存端点。
  const nodes = new Map<string, EvidenceRelationNode>()
  const sources = new Map<string, EvidenceRelationSource>()
  const edges = new Map<string, EvidenceRelationEdge>()
  const assets = new Map<string, Asset>()
  const maps = new Map<string, GraphDocument>()
  let truncated = false

  function saveSource(
    /* 已校验精确内容与直接附件的来源节点。 */ source: EvidenceRelationSource,
    /* 当前遍历给出的角色；已有节点只提升到更明确角色。 */ role: EvidenceRelationNode['role'],
  ): string | null {
    // 不合并不同 Map 或版本；容量不足时停止新节点并保留明确截断标记。
    const key = evidenceCreateRelationNodeKey(source.ref)
    const existing = nodes.get(key)
    if (existing) {
      if (ROLE_PRIORITY[role] < ROLE_PRIORITY[existing.role]) existing.role = role
      return key
    }
    if (nodes.size >= MAX_NODES) { truncated = true; return null }
    nodes.set(key, { key, ref: structuredClone(source.ref), nodeSnapshot: structuredClone(source.nodeSnapshot),
      definitionDigest: source.definitionDigest, role })
    sources.set(key, source)
    for (const asset of source.assets) assets.set(asset.id, asset)
    return key
  }

  function saveEdge(
    /* 两端已经进入 nodes 的完整图、payload 或显式依据关系。 */ edge: EvidenceRelationEdge,
  ): boolean {
    // 边身份去重独立于节点去重，平行实际图边仍按各自 edgeId 保存。
    if (edges.has(edge.key)) return true
    if (edges.size >= MAX_EDGES) { truncated = true; return false }
    edges.set(edge.key, structuredClone(edge))
    return true
  }

  async function sourceMap(
    /* 来源节点明确声明所属的 Map，禁止按同名 nodeId 搜索其他 Map。 */ mapId: string,
  ): Promise<GraphDocument> {
    // 同一事务中一张图只取得一次完整快照，引用依赖仍沿其自身 Map 解释。
    const existing = maps.get(mapId)
    if (existing) return existing
    const map = await readMap(mapId)
    maps.set(mapId, map)
    return map
  }

  async function targetSource(
    /* 已取得本次事务快照的明确来源 Map。 */ map: GraphDocument,
    /* 图边或 payload 声明的实际目标节点身份。 */ nodeId: string,
    /* 目标节点在此遍历中的角色。 */ role: EvidenceRelationNode['role'],
  ): Promise<EvidenceRelationSource | null> {
    // 仅冻结真实存在的节点；缺失目标不能被伪装成已完整捕获的关系。
    const node = map.nodes.find((/* 同 Map 的真实节点。 */ candidate) => /* 精确匹配引用目标。 */ candidate.id === nodeId)
    if (!node) { truncated = true; return null }
    const ref = { mapId: map.id, nodeId: node.id, revision: node.revision }
    const key = evidenceCreateRelationNodeKey(ref)
    const existing = sources.get(key)
    if (existing) { saveSource(existing, role); return existing }
    if (nodes.size >= MAX_NODES) { truncated = true; return null }
    const source = await freezeSource(ref)
    return saveSource(source, role) === null ? null : source
  }

  async function walkSuccessors(
    /* true 沿 successor 入边固定上游，false 沿出边固定核查下游。 */ upstream: boolean,
  ): Promise<void> {
    // 两类结构路径各自从 Claim 起算深度，reference 永不成为结构上/下游。
    const queue: RelationQueueItem[] = [{ source: root, depth: 0 }]
    const visited = new Set<string>()
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index]
      const currentKey = evidenceCreateRelationNodeKey(item.source.ref)
      if (visited.has(currentKey)) continue
      visited.add(currentKey)
      const map = await sourceMap(item.source.ref.mapId)
      const candidates: RelationCandidate[] = []
      for (const edge of map.edges) {
        if (edge.kind !== 'successor') continue
        if (upstream && edge.to === item.source.ref.nodeId) candidates.push({ targetId: edge.from, edge })
        if (!upstream && edge.from === item.source.ref.nodeId) candidates.push({ targetId: edge.to, edge })
      }
      for (const candidate of candidates) {
        const key = graphEdgeKey(map.id, candidate.edge)
        if (edges.has(key)) continue
        if (edges.size >= MAX_EDGES) { truncated = true; continue }
        if (item.depth >= MAX_DEPTH) { truncated = true; continue }
        const source = await targetSource(map, candidate.targetId, upstream ? 'upstream' : 'downstream')
        if (!source) continue
        const targetKey = evidenceCreateRelationNodeKey(source.ref)
        saveEdge({ key, kind: 'graph', mapId: map.id, edge: candidate.edge,
          from: upstream ? targetKey : currentKey, to: upstream ? currentKey : targetKey })
        if (!visited.has(targetKey)) queue.push({ source, depth: item.depth + 1 })
      }
    }
  }

  async function walkDependencies(): Promise<void> {
    // 根、结构节点与显式依据各自展开声明引用；环终止，引用只赋予 dependency 角色。
    const queue: RelationQueueItem[] = [...sources.values()].map((
      /* 已优先保留的根、依据或结构节点。 */ source,
    ) => /* 依赖深度从每个实际结构/依据节点重新起算。 */ ({ source, depth: 0 }))
    const visited = new Set<string>()
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index]
      const currentKey = evidenceCreateRelationNodeKey(item.source.ref)
      if (visited.has(currentKey)) continue
      visited.add(currentKey)
      const map = await sourceMap(item.source.ref.mapId)
      const references = map.edges.filter((
        /* 同 Map 中的实际图边。 */ edge,
      ) => /* 只沿当前节点 reference 出边取得依赖。 */ edge.kind === 'reference' && edge.from === item.source.ref.nodeId)
      const candidates = [
        ...references.map((/* 已明确为实际 reference 的原边。 */ edge) =>
          /* GraphEdge 自身有完整身份，不能转成 payload 关系。 */ ({ targetId: edge.to, edge })),
        ...item.source.nodeReferences.map((/* 已展开实际路径的声明引用。 */ reference) =>
          /* 保存路径和目标，保留它与实际图边的区别。 */ ({ targetId: reference.targetId, path: reference.path })),
      ]
      for (const candidate of candidates) {
        const targetNode = map.nodes.find((/* 同 Map 的真实目标。 */ node) => /* nodeId 从声明或实际边读取。 */ node.id === candidate.targetId)
        if (!targetNode) { truncated = true; continue }
        const targetRef = { mapId: map.id, nodeId: targetNode.id, revision: targetNode.revision }
        const targetKey = evidenceCreateRelationNodeKey(targetRef)
        const key = 'edge' in candidate ? graphEdgeKey(map.id, candidate.edge)
          : storeCreateInputHash({ kind: 'payload', from: currentKey, to: targetKey, mapId: map.id, path: candidate.path })
        if (edges.has(key)) continue
        if (edges.size >= MAX_EDGES) { truncated = true; continue }
        if (item.depth >= MAX_DEPTH && !sources.has(targetKey)) { truncated = true; continue }
        const source = await targetSource(map, candidate.targetId, 'dependency')
        if (!source) continue
        const relation: EvidenceRelationEdge = 'edge' in candidate
          ? { key, kind: 'graph', from: currentKey, to: targetKey, mapId: map.id, edge: candidate.edge }
          : { key, kind: 'payload', from: currentKey, to: targetKey, mapId: map.id, path: candidate.path }
        saveEdge(relation)
        if (!visited.has(targetKey) && item.depth < MAX_DEPTH) queue.push({ source, depth: item.depth + 1 })
      }
    }
  }

  const rootKey = evidenceCreateRelationNodeKey(root.ref)
  saveSource(root, 'claim')
  for (const basis of basisNodes) {
    const key = saveSource(basis.source, 'basis')
    if (key === null) continue
    saveEdge({ key: storeCreateInputHash({ kind: 'basis', from: key, to: rootKey, basisIndex: basis.basisIndex }),
      kind: 'basis', from: key, to: rootKey, basisIndex: basis.basisIndex })
  }
  await walkSuccessors(true)
  await walkSuccessors(false)
  await walkDependencies()
  return { snapshot: { version: 1, capturedAt, rootKey, nodes: [...nodes.values()], edges: [...edges.values()], truncated },
    assets: [...assets.values()] }
}

function graphEdgeKey(
  /* 实际图边所在的 Map 身份。 */ mapId: string,
  /* 完整实际边，其 id 与 revision 共同绑定固定版本。 */ edge: GraphEdge,
): string {
  // 平行边和不同 Map 的同名边不共享固定关系身份。
  return storeCreateInputHash({ kind: 'graph', mapId, edgeId: edge.id, revision: edge.revision })
}
