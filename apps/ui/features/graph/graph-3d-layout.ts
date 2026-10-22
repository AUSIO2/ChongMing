// 为真实 Map 和独立证据条目计算稳定的三维节点与连线坐标，不改写业务输入。
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import { graphReadNodeText, graphReadNodeType } from './graph-layout'

export interface Graph3DNode {
  id: string
  typeId: string
  title: string
  summary: string
  stale: boolean
  color: string
  x: number
  y: number
  z: number
}

export interface Graph3DEdge {
  id: string
  from: string
  to: string
  kind: 'successor' | 'reference'
}

export interface Graph3DLayout {
  nodes: Graph3DNode[]
  edges: Graph3DEdge[]
}

/** 展示身份由调用者提供；createdAt 仅决定稳定排序，不要求来自普通 Map。 */
export type GraphSceneNodeInput = Omit<Graph3DNode, 'x' | 'y' | 'z'> & { createdAt: string }

interface SceneNodeState {
  node: GraphSceneNodeInput
  depth: number
  indegree: number
  outgoing: SceneNodeState[]
}

const TYPE_COLORS = new Map<string, string>([
  ['factcheck.source', '#557b91'], ['factcheck.news', '#b67b40'], ['factcheck.claim', '#ac4c57'],
  ['factcheck.evidence', '#468577'], ['factcheck.opinion', '#8066a2'], ['factcheck.verification', '#9b8a39'],
])
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

function graphHash(
  /* 节点所属的稳定数据类型身份，用于分配相同的展示颜色。 */
  value: string,
): number {
  // 计算类型身份的确定性散列，避免重新读取图时改变节点颜色。
  let hash = 2166136261
  for (const character of value) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619)
  return hash >>> 0
}

export function graphRead3DLayout(
  /* 当前已获权 Map 的真实快照，只读取节点与已提交关系。 */
  snapshot: GraphSnapshot,
  /* 可选的精确版本定义，用于读取节点标题与摘要。 */
  catalog?: DefinitionCatalog | null,
): Graph3DLayout {
  // 将真实 Map 的节点内容投影为共用场景输入，保留原有标题、颜色和陈旧状态。
  const nodes = snapshot.nodes.map((/* 来自真实快照的业务节点。 */ node): GraphSceneNodeInput => {
    // 按已注册定义读取展示正文，不改变原节点及其版本。
    return {
      id: node.id,
      typeId: node.typeId,
      title: graphReadNodeType(node, catalog),
      summary: graphReadNodeText(node, catalog),
      stale: node.validity === 'stale',
      color: TYPE_COLORS.get(node.typeId) ?? `hsl(${graphHash(node.typeId) % 360}, 42%, 43%)`,
      createdAt: node.createdAt,
    }
  })
  const edges = snapshot.edges.map((/* 来自真实快照的已提交关系。 */ edge): Graph3DEdge => {
    // 保留关系身份和方向，坐标计算会排除端点缺失的关系。
    return { id: edge.id, from: edge.from, to: edge.to, kind: edge.kind }
  })
  return graphArrangeScene(nodes, edges)
}

export function graphArrangeScene(
  /* 已包含业务展示内容和独立身份的节点；本函数不修改它们。 */
  inputNodes: readonly GraphSceneNodeInput[],
  /* 仅使用调用者提供的真实关系，不由排序或类型推算上下游。 */
  inputEdges: readonly Graph3DEdge[],
): Graph3DLayout {
  // successor 决定横向层级，同层节点沿 Y/Z 螺旋排布；环保留基础层而不无限松弛。
  const originals = [...inputNodes].sort((/* 左侧待排序节点。 */ a, /* 右侧待排序节点。 */ b) =>
    /* 先按收录或创建时间排序，再按稳定展示身份打破同时间平局。 */
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const states: SceneNodeState[] = originals.map((/* 待布局节点。 */ node) =>
    /* 将拓扑入度、基础层和实际后继统一放在节点自有状态中。 */ ({ node, depth: 0, indegree: 0, outgoing: [] }))
  const byId = new Map(states.map((/* 已初始化的完整节点状态。 */ state) =>
    /* 仅在接入真实关系时按身份解析端点。 */ [state.node.id, state]))
  for (const edge of inputEdges) {
    if (edge.kind !== 'successor') continue
    const from = byId.get(edge.from), to = byId.get(edge.to)
    if (!from || !to) continue
    from.outgoing.push(to)
    to.indegree += 1
  }

  const queue = states.filter((/* 待检测的拓扑节点状态。 */ state) =>
    /* 从无前驱节点开始，队列直接持有已初始化状态。 */ state.indegree === 0)
  for (let index = 0; index < queue.length; index++) {
    const from = queue[index]
    for (const to of from.outgoing) {
      to.depth = Math.max(to.depth, from.depth + 1)
      to.indegree -= 1
      if (to.indegree === 0) queue.push(to)
    }
  }

  const groups = new Map<number, GraphSceneNodeInput[]>()
  for (const { node, depth: layer } of states) {
    const group = groups.get(layer) ?? []
    group.push(node)
    groups.set(layer, group)
  }

  const nodes: Graph3DNode[] = []
  const layers = [...groups.entries()].sort((/* 左侧层级分组。 */ a, /* 右侧层级分组。 */ b) =>
    /* 让输出按前驱到后继层级排列。 */ a[0] - b[0])
  for (const [layer, group] of layers) {
    group.sort((/* 同层左侧节点。 */ a, /* 同层右侧节点。 */ b) =>
      /* 同类型节点相邻，并使用稳定身份固定螺旋位置。 */ a.typeId.localeCompare(b.typeId) || a.id.localeCompare(b.id))
    group.forEach((/* 当前层级的展示节点。 */ node, /* 同层螺旋中的序号。 */ index) => {
      // 在当前层分配真实深度坐标，时间字段不进入最终渲染数据。
      const angle = index * GOLDEN_ANGLE + layer * 0.42
      const radius = index === 0 ? 0 : 1.28 * Math.sqrt(index)
      nodes.push({
        id: node.id,
        typeId: node.typeId,
        title: node.title,
        summary: node.summary,
        stale: node.stale,
        color: node.color,
        x: layer * 3.8,
        y: Math.cos(angle) * radius,
        z: Math.sin(angle) * radius,
      })
    })
  }

  return {
    nodes,
    edges: inputEdges.filter((/* 待展示的实际关系。 */ edge) =>
      /* 排除引用未载入节点的关系，防止产生悬空连线。 */ byId.has(edge.from) && byId.has(edge.to))
      .map((/* 端点均已载入的关系。 */ edge) => /* 返回场景拥有的关系副本。 */ ({ ...edge })),
  }
}
