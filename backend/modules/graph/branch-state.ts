// 计算实际 successor 分支、相关内容版本和一次图修改的真实影响范围。
import type { GraphBranchOwnership, GraphBranchScope, GraphBranchSnapshot, GraphChanges, GraphEdge, GraphNode } from '../../../contracts/graph'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { GraphError } from '../shared/domain-error'
import { storeCreateInputHash, type GraphDocument } from './graph-record'
import type { GraphOwnershipRecord } from './graph-record'

export interface GraphMutationImpact {
  nodeIds: string[]
  edgeIds: string[]
}

interface BranchPayloadRelation { key: string; from: string; to: string; path: string }

/**
 * payload reference 不扩大 successor scope，但像 reference edge 一样影响两端的分支版本和写入范围。
 *
 * @param nodes 同一图中带服务端派生引用索引的节点。
 */
function branchReadPayloadRelations(nodes: readonly GraphNode[]): BranchPayloadRelation[] {
  return nodes.flatMap(node => (node.payloadReferences ?? []).map(reference => ({
    key: `${node.id}\u0000${reference.path}\u0000${reference.targetId}`,
    from: node.id,
    to: reference.targetId,
    path: reference.path,
  }))).sort((left, right) => left.key.localeCompare(right.key))
}

/**
 * 排序前先拒绝重复身份，避免同一范围因输入次序或重复项形成不同版本。
 *
 * @param ids 待规范并检查重复的身份。
 * @param label 错误中使用的字段名称。
 */
function branchReadUnique(ids: string[], label: string): string[] {
  if (new Set(ids).size !== ids.length) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_IDS, label))
  return [...ids].sort()
}

/**
 * 沿 successor 正向计算含根闭包；reference 不扩大分支，环通过已访问集合有界收敛。
 *
 * @param document 包含真实节点和 successor/reference 关系的当前图。
 * @param rootIds 用户选择的一个或多个实际分支根。
 */
export function branchReadScope(
  document: Pick<GraphDocument, 'nodes' | 'edges'>,
  rootIds: string[],
): GraphBranchScope {
  const roots = branchReadUnique(rootIds, 'rootIds')
  if (!roots.length) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.BRANCH_ROOTS_MUST_NOT_BE_EMPTY)
  const nodes = new Set(document.nodes.map(node => node.id))
  for (const id of roots) if (!nodes.has(id)) throw new GraphError(404, 'NODE_NOT_FOUND', messageFormat(RuntimeMessage.NODE_NOT_FOUND_VALUE, id))
  const successors = new Map<string, string[]>()
  for (const edge of document.edges) {
    if (edge.kind !== 'successor') continue
    const list = successors.get(edge.from) ?? []
    list.push(edge.to)
    successors.set(edge.from, list)
  }
  const visited = new Set<string>(), pending = [...roots]
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (visited.has(id)) continue
    visited.add(id)
    for (const next of successors.get(id) ?? []) if (!visited.has(next)) pending.push(next)
  }
  const edgeIds = document.edges.filter(edge => edge.kind === 'successor' && visited.has(edge.from) && visited.has(edge.to))
    .map(edge => edge.id).sort()
  return { rootIds: roots, nodeIds: [...visited].sort(), edgeIds }
}

/**
 * 绑定范围成员、内容版本和所有相邻关系；无关分支与执行租约不会改变此版本。
 *
 * @param document 当前图内容；节点和关系版本均进入摘要。
 * @param scope 已在相同图上计算的实际分支范围。
 */
export function branchReadVersion(
  document: Pick<GraphDocument, 'nodes' | 'edges'>,
  scope: GraphBranchScope,
): string {
  const members = new Set(scope.nodeIds)
  const nodes = document.nodes.filter(node => members.has(node.id)).map(node => ({
    id: node.id,
    revision: node.revision,
    typeId: node.typeId,
    typeVersion: node.typeVersion,
  })).sort((left, right) => left.id.localeCompare(right.id))
  const edges = document.edges.filter(edge => members.has(edge.from) || members.has(edge.to)).map(edge => ({
    id: edge.id,
    revision: edge.revision,
    kind: edge.kind,
    from: edge.from,
    to: edge.to,
  })).sort((left, right) => left.id.localeCompare(right.id))
  const payloadReferences = branchReadPayloadRelations(document.nodes).filter(reference => members.has(reference.from) || members.has(reference.to))
  return storeCreateInputHash({ roots: scope.rootIds, members: scope.nodeIds, nodes, edges, payloadReferences })
}

/**
 * 范围和摘要必须从同一份图快照计算，避免把旧成员集合与新内容版本拼在一起。
 *
 * @param document 需要生成同一时点范围、版本和公开快照序号的当前图。
 * @param rootIds 调用方明确选择、共同构成一个授权范围的根。
 */
export function branchReadSnapshot(
  document: Pick<GraphDocument, 'nodes' | 'edges' | 'revision'>,
  rootIds: string[],
): GraphBranchSnapshot {
  const scope = branchReadScope(document, rootIds)
  const revisions = new Map(document.nodes.map(node => [node.id, node.revision]))
  return { scope, version: branchReadVersion(document, scope), mapRevision: document.revision,
    rootRevisions: Object.fromEntries(scope.rootIds.map(id => [id, revisions.get(id)!])) }
}

/**
 * 以边身份索引当前或修改后的关系，用于同时处理换端点和删除。
 *
 * @param edges 待建立身份索引的关系集合。
 */
function branchReadEdges(edges: GraphEdge[]): Map<string, GraphEdge> {
  return new Map(edges.map(edge => [edge.id, edge]))
}

/**
 * 模拟身份和端点变化以计算影响；payload/schema 等完整合法性仍由图服务验证。
 *
 * @param nodes 修改前的真实节点集合。
 * @param edges 修改前的真实关系集合。
 * @param changes 只需读取身份和端点的局部图修改。
 */
function branchApplyForImpact(
  nodes: GraphNode[],
  edges: GraphEdge[],
  changes: GraphChanges,
): { nodeIds: Set<string>; edges: Map<string, GraphEdge> } {
  const nodeIds = new Set(nodes.map(node => node.id))
  const nextEdges = branchReadEdges(edges)
  for (const id of changes.nodes?.remove ?? []) {
    nodeIds.delete(id)
    for (const [edgeId, edge] of nextEdges) if (edge.from === id || edge.to === id) nextEdges.delete(edgeId)
  }
  for (const node of changes.nodes?.put ?? []) nodeIds.add(node.id)
  for (const id of changes.edges?.remove ?? []) nextEdges.delete(id)
  for (const input of changes.edges?.put ?? []) {
    const previous = nextEdges.get(input.id)
    nextEdges.set(input.id, {
      ...input,
      revision: (previous?.revision ?? -1) + 1,
      createdAt: previous?.createdAt ?? '',
      updatedAt: '',
    })
  }
  return { nodeIds, edges: nextEdges }
}

/**
 * 汇总显式节点、旧/新边端点及删节点级联关系，供授权检查使用。
 *
 * @param document 修改前的当前图。
 * @param changes 客户端提交的局部节点和关系变更。
 */
export function branchReadImpact(
  document: Pick<GraphDocument, 'nodes' | 'edges'>,
  changes: GraphChanges,
): GraphMutationImpact {
  const impactedNodes = new Set<string>(), impactedEdges = new Set<string>()
  const oldEdges = branchReadEdges(document.edges)
  for (const node of changes.nodes?.put ?? []) impactedNodes.add(node.id)
  for (const id of changes.nodes?.remove ?? []) {
    impactedNodes.add(id)
    for (const edge of document.edges) if (edge.from === id || edge.to === id) {
      impactedEdges.add(edge.id); impactedNodes.add(edge.from); impactedNodes.add(edge.to)
    }
  }
  for (const id of changes.edges?.remove ?? []) {
    impactedEdges.add(id)
    const edge = oldEdges.get(id)
    if (edge) { impactedNodes.add(edge.from); impactedNodes.add(edge.to) }
  }
  for (const input of changes.edges?.put ?? []) {
    impactedEdges.add(input.id)
    impactedNodes.add(input.from); impactedNodes.add(input.to)
    const previous = oldEdges.get(input.id)
    if (previous) { impactedNodes.add(previous.from); impactedNodes.add(previous.to) }
  }
  const after = branchApplyForImpact(document.nodes, document.edges, changes)
  for (const id of impactedEdges) {
    const edge = after.edges.get(id)
    if (edge) { impactedNodes.add(edge.from); impactedNodes.add(edge.to) }
  }
  return { nodeIds: [...impactedNodes].sort(), edgeIds: [...impactedEdges].sort() }
}

/**
 * 只要共享任意真实数据节点就视为冲突；共享视觉投影或类型定义不构成冲突。
 *
 * @param left 一侧实际闭包。
 * @param right 另一侧实际闭包。
 */
export function branchScopesOverlap(left: GraphBranchScope, right: GraphBranchScope): boolean {
  const nodes = new Set(left.nodeIds)
  return right.nodeIds.some(id => nodes.has(id))
}

/**
 * 过期 editor 不再阻塞；Run 占有无期限。根失效的异常记录不授予任何写权。
 *
 * @param document 当前图和持久占有根。
 * @param now 存储端当前毫秒时间。
 */
export function branchReadOwnerships(
  document: Pick<GraphDocument, 'nodes' | 'edges' | 'branchOwnerships'>,
  now: number,
): GraphBranchOwnership[] {
  const result: GraphBranchOwnership[] = []
  for (const ownership of Object.values(document.branchOwnerships ?? {})) {
    if (ownership.kind === 'control') continue
    if (ownership.kind === 'editor' && (ownership.expiresAt === null || Date.parse(ownership.expiresAt) <= now)) continue
    try { result.push({ ...structuredClone(ownership), scope: branchReadScope(document, ownership.rootIds) }) }
    catch { /* 根被删除但未完成原子释放的损坏记录不对外授予权限。 */ }
  }
  return result
}

/**
 * @param document 修改前或修改后的完整图。
 * @param requested 准备领取或扩充的实际范围。
 * @param now 存储端当前时间。
 * @param excludedLeaseId 当前授权自身，拓扑提交时不与自己冲突。
 */
export function branchFindOwnershipConflict(
  document: Pick<GraphDocument, 'nodes' | 'edges' | 'branchOwnerships'>,
  requested: GraphBranchScope,
  now: number,
  excludedLeaseId?: string,
): GraphBranchOwnership | undefined {
  return branchReadOwnerships(document, now).find(ownership => ownership.leaseId !== excludedLeaseId && branchScopesOverlap(requested, ownership.scope))
}

/**
 * @param ownerships 当前持久占有字典。
 * @param now 存储端当前时间。
 */
export function branchPruneOwnerships(
  ownerships: Record<string, GraphOwnershipRecord> | undefined,
  now: number,
): Record<string, GraphOwnershipRecord> {
  return Object.fromEntries(Object.entries(ownerships ?? {}).filter(([, ownership]) => ownership.kind === 'run'
    || ownership.expiresAt !== null && Date.parse(ownership.expiresAt) > now).map(([id, ownership]) => [id, structuredClone(ownership)]))
}

/**
 * 修改及其级联副作用必须完全落在授权范围，不能只校验客户端显式节点列表。
 *
 * @param authorized 当前授权覆盖的实际闭包。
 * @param impact 本次修改的真实影响节点和关系。
 */
export function branchValidateImpact(
  authorized: GraphBranchScope,
  impact: GraphMutationImpact,
): void {
  const nodes = new Set(authorized.nodeIds)
  if (impact.nodeIds.some(id => !nodes.has(id))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.GRAPH_CHANGE_AFFECTS_DATA_OUTSIDE_THE_ACQUIRED_BRANCH)
  }
}

/**
 * 既有端点必须已在 before scope；新节点只能通过 successor 进入 after scope。删除全部根后分支消失。
 *
 * @param before 修改前、其版本已经与客户端 proof 匹配的图。
 * @param after 已按 schema、关系和环不变式构造的修改后图。
 * @param changes 本次局部修改，用于识别直接端点及新节点。
 * @param authorized 修改前由 proof 根计算出的完整结构范围。
 */
export function branchValidateMutation(
  before: Pick<GraphDocument, 'nodes' | 'edges' | 'revision'>,
  after: Pick<GraphDocument, 'nodes' | 'edges' | 'revision'>,
  changes: GraphChanges,
  authorized: GraphBranchScope,
): GraphBranchSnapshot | undefined {
  const beforeIds = new Set(before.nodes.map(node => node.id))
  const afterIds = new Set(after.nodes.map(node => node.id))
  const allowedBefore = new Set(authorized.nodeIds)
  if (changes.name !== undefined && allowedBefore.size !== beforeIds.size) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.GRAPH_METADATA_CHANGE_REQUIRES_A_SCOPE_COVERING_EVERY_NODE)
  }
  const impact = branchReadImpact(before, changes), impactedNodes = new Set(impact.nodeIds)
  const oldReferences = new Map(branchReadPayloadRelations(before.nodes).map(item => [item.key, item]))
  const newReferences = new Map(branchReadPayloadRelations(after.nodes).map(item => [item.key, item]))
  for (const [key, reference] of [...oldReferences, ...newReferences]) {
    if (oldReferences.has(key) && newReferences.has(key)) continue
    impactedNodes.add(reference.from); impactedNodes.add(reference.to)
  }
  if ([...impactedNodes].some(id => beforeIds.has(id) && !allowedBefore.has(id))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.GRAPH_CHANGE_AFFECTS_DATA_OUTSIDE_THE_ACQUIRED_BRANCH)
  }
  const survivingRoots = authorized.rootIds.filter(id => afterIds.has(id))
  if (survivingRoots.length && survivingRoots.length !== authorized.rootIds.length) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.A_MULTI_ROOT_BRANCH_CANNOT_DELETE_ONLY_SOME_ROOTS)
  }
  if (!survivingRoots.length) {
    if ((changes.nodes?.put ?? []).some(node => !beforeIds.has(node.id))) {
      throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.NEW_DATA_MUST_BE_REACHABLE_FROM_THE_AUTHORIZED_BRANCH)
    }
    return undefined
  }
  const next = branchReadSnapshot(after, survivingRoots)
  const allowedAfter = new Set(next.scope.nodeIds)
  if ((changes.nodes?.put ?? []).some(node => !beforeIds.has(node.id) && !allowedAfter.has(node.id))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.NEW_DATA_MUST_BE_REACHABLE_FROM_THE_AUTHORIZED_BRANCH)
  }
  return next
}

/**
 * 新根快捷路径不能更新旧节点、接触旧边或借 reference 把不相关数据塞进同一提交。
 *
 * @param before 新根创建前的图，节点身份必须从未在当前图中存在。
 * @param after 已完成普通图不变式校验的创建后图。
 * @param rootIds null 版本提交声明的独立新根。
 * @param changes 只允许创建一棵完全由新节点组成的 successor 森林。
 */
export function branchValidateNewRoots(
  before: Pick<GraphDocument, 'nodes' | 'edges' | 'revision'>,
  after: Pick<GraphDocument, 'nodes' | 'edges' | 'revision'>,
  rootIds: string[],
  changes: GraphChanges,
): GraphBranchSnapshot {
  const oldIds = new Set(before.nodes.map(node => node.id))
  const puts = changes.nodes?.put ?? [], newIds = new Set(puts.map(node => node.id))
  if (!rootIds.length || rootIds.some(id => oldIds.has(id) || !newIds.has(id))
    || puts.some(node => oldIds.has(node.id)) || (changes.nodes?.remove?.length ?? 0) > 0
    || (changes.edges?.remove?.length ?? 0) > 0 || changes.name !== undefined
    || (changes.edges?.put ?? []).some(edge => !newIds.has(edge.from) || !newIds.has(edge.to))
    || branchReadPayloadRelations(after.nodes).some(reference => newIds.has(reference.from) && !newIds.has(reference.to))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.NULL_BRANCH_VERSION_ONLY_CREATES_AN_INDEPENDENT_NEW_BRANCH)
  }
  const snapshot = branchReadSnapshot(after, rootIds)
  if (snapshot.scope.nodeIds.length !== newIds.size || snapshot.scope.nodeIds.some(id => !newIds.has(id))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.NEW_DATA_MUST_BE_REACHABLE_FROM_THE_AUTHORIZED_BRANCH)
  }
  return snapshot
}
