// 编辑基线只保存一份服务端证明及其配对快照；后续仅比较事实，不计算或改写服务端 version。
import type { GraphBranchScope, GraphBranchSnapshot } from '../../../../contracts/graph-branch'
import type { GraphSnapshot } from '../../../../contracts/graph-api'

export interface BranchBaseline {
  readonly snapshot: GraphSnapshot
  readonly branch: GraphBranchSnapshot
  // 本地保守事实投影，只用于相等判断，不可作为写入 expectedVersion。
  readonly content: string
}

export function branchCreateBaseline(
  /* 与证明同次读取或提交的真实完整快照，调用方不再修改它。 */ snapshot: GraphSnapshot,
  /* 服务端发布的单根证明，opaque version 必须保持原值。 */ branch: GraphBranchSnapshot,
  /* 当前所选图内节点，限制配对结果不能落到其他选择上。 */ selectedId: string,
): BranchBaseline | null {
  // 验证同次内容版本、根版本和真实 successor 闭包，只有配对成功才建立编辑基线。
  if (branch.mapRevision !== snapshot.revision || branch.scope.rootIds.length !== 1
    || branch.scope.rootIds[0] !== selectedId) return null
  const node = snapshot.nodes.find((/* 配对快照中的实际节点。 */ item) => /* 必须仍存在原选择。 */ item.id === selectedId)
  if (!node || branch.rootRevisions[selectedId] !== node.revision) return null
  const members = new Set<string>(), successors = new Map<string, string[]>()
  for (const edge of snapshot.edges) {
    if (edge.kind === 'successor') {
      const targets = successors.get(edge.from) ?? []
      targets.push(edge.to)
      successors.set(edge.from, targets)
    }
  }
  const pending = [selectedId], nodeIds = new Set(snapshot.nodes.map((/* 当前真实图节点。 */ item) => /* 只保存其图内身份。 */ item.id))
  for (let index = 0; index < pending.length; index++) {
    const id = pending[index]
    if (members.has(id)) continue
    if (!nodeIds.has(id)) return null
    members.add(id)
    pending.push(...(successors.get(id) ?? []))
  }
  const edges = snapshot.edges.filter((/* 完整快照中的关系。 */ edge) => /* reference 不扩大结构闭包。 */
    edge.kind === 'successor' && members.has(edge.from) && members.has(edge.to))
  if (!branchSameIds(branch.scope.nodeIds, [...members]) || !branchSameIds(branch.scope.edgeIds,
    edges.map((/* 闭包内部的真实结构边。 */ edge) => /* 保留稳定边身份用于证明校验。 */ edge.id))) return null
  return { snapshot, branch, content: branchReadContent(snapshot, branch.scope) }
}

export function branchBaselineMatchesSnapshot(
  /* 先前已经验证配对的唯一基线，原 proof/mapRevision 不随全图更新改写。 */ baseline: BranchBaseline,
  /* 新到达的同图完整快照，可能只有其他独立分支变化。 */ snapshot: GraphSnapshot,
  /* 此时仍由界面选择的根；选择不同不能复用旧基线。 */ selectedId: string,
): boolean {
  // 内容事实不变时保留原服务端证明，避免把全图 revision 变成永久编辑门禁。
  return baseline.snapshot.mapId === snapshot.mapId && baseline.snapshot.workspaceId === snapshot.workspaceId
    && baseline.branch.scope.rootIds[0] === selectedId
    && baseline.content === branchReadContent(snapshot, baseline.branch.scope)
}

function branchSameIds(
  /* 服务端证明中的身份集合，重复身份视为不一致。 */ actual: readonly string[],
  /* 从真实图事实计算的闭包集合。 */ expected: readonly string[],
): boolean {
  // 比较集合内容而不修改调用方数组，拒绝重复与缺失成员。
  const expectedIds = new Set(expected)
  return actual.length === expected.length && new Set(actual).size === actual.length
    && actual.every((/* 待验证的证明成员。 */ id) => /* 图中必须具有相同身份。 */ expectedIds.has(id))
}

function branchReadContent(
  /* 当前真实图快照，只读取不改写节点、边与派生引用。 */ snapshot: GraphSnapshot,
  /* 已验证基线的 successor 闭包；新增结构出边也会进入邻边比较。 */ scope: GraphBranchScope,
): string {
  // 完整成员/邻边保守比较，另包含跨入出 payload 引用；图名、其他根正文及运行状态不参与。
  const members = new Set(scope.nodeIds)
  const nodes = snapshot.nodes.filter((/* 新快照中的真实节点。 */ node) => /* 只读取原闭包成员。 */ members.has(node.id))
    .sort((/* 左侧真实节点。 */ left, /* 右侧真实节点。 */ right) => /* 不受快照数组顺序影响。 */ left.id.localeCompare(right.id))
  const edges = snapshot.edges.filter((/* 新快照中的真实边。 */ edge) => /* 所有入出邻边均影响当前分支事实。 */ members.has(edge.from) || members.has(edge.to))
    .sort((/* 左侧真实关系。 */ left, /* 右侧真实关系。 */ right) => /* 不受关系数组顺序影响。 */ left.id.localeCompare(right.id))
  const references = snapshot.nodes.flatMap((/* 可能位于闭包内外的引用来源节点。 */ node) =>
    /* 外部节点新增指向闭包的引用也要使旧基线失效。 */ (node.payloadReferences ?? []).filter(
      (/* 服务端派生的真实 payload 引用。 */ reference) => /* 任一端属于闭包就纳入比较。 */ members.has(node.id) || members.has(reference.targetId),
    ).map((/* 已筛选的入出引用关系。 */ reference) => /* 正文不作为外部引用的额外依赖。 */ ({ from: node.id, path: reference.path, to: reference.targetId })))
    .sort((/* 左侧引用事实。 */ left, /* 右侧引用事实。 */ right) => /* 稳定排序不会重新计算服务端 version。 */
      left.from.localeCompare(right.from) || left.path.localeCompare(right.path) || left.to.localeCompare(right.to))
  return JSON.stringify({ nodes, edges, references })
}
