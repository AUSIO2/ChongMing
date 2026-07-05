import type { MapEdge, MapNode, MapSnapshot, MapNodeKind } from './types'

/**
 * 布局仅依赖节点拓扑（parentId + edges），无 split/verify 分支。
 */

const PAD_X = 80
const PAD_Y = 60
const GAP_X = 240
const GAP_Y = 100

/** 各类节点统一外框尺寸 */
export const MAP_NODE_WIDTH = 200
export const MAP_NODE_HEIGHT = 80

const NODE_SIZE: Record<MapNodeKind, { width: number; height: number }> = {
  news: { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT },
  subAgent: { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT },
  claim: { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT },
  opinion: { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT },
}

export interface MapLayoutNode {
  node: MapNode
  x: number
  y: number
  width: number
  height: number
  /** 距离 news root 的深度，仅用于调试/CSS 分层。 */
  depth: number
}

export interface MapLayoutEdge {
  id: string
  from: string
  to: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface MapLayoutSnapshot {
  nodes: MapLayoutNode[]
  edges: MapLayoutEdge[]
  width: number
  height: number
}

/**
 * BFS 从 NEWS_ROOT_ID 出发计算每个节点的深度：
 *   x = PAD_X + depth * GAP_X
 * 同一 parent 下的子节点纵向分行；父节点自身在 y 方向居中于其子行。
 */
export function layoutReadSnapshot(snapshot: MapSnapshot): MapLayoutSnapshot {
  const { nodes, edges } = snapshot

  const childrenByParent = groupChildren(nodes)

  // 拓扑根：所有 parentId 为空的节点。news 节点通常在这里。
  const roots = nodes.filter(n => !n.parentId)

  const layoutByNodeId = new Map<string, MapLayoutNode>()

  // 递归计算：先给自己占一行，再递归子树；父的 y 取子树 y 的中值
  let cursorRow = 0
  const rowY: number[] = []

  function place(nodeId: string, depth: number): { firstRow: number; lastRow: number } {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return { firstRow: cursorRow, lastRow: cursorRow }

    const kids = childrenByParent.get(nodeId) ?? []

    if (kids.length === 0) {
      const row = cursorRow++
      rowY[row] = PAD_Y + row * GAP_Y
      const size = NODE_SIZE[node.kind]
      layoutByNodeId.set(nodeId, {
        node,
        x: PAD_X + depth * GAP_X,
        y: rowY[row],
        width: size.width,
        height: size.height,
        depth,
      })
      return { firstRow: row, lastRow: row }
    }

    const childRows: Array<{ firstRow: number; lastRow: number }> = []
    for (const k of kids) {
      childRows.push(place(k.id, depth + 1))
    }
    const firstRow = childRows[0].firstRow
    const lastRow = childRows[childRows.length - 1].lastRow
    const midY = (rowY[firstRow] + rowY[lastRow]) / 2

    const size = NODE_SIZE[node.kind]
    layoutByNodeId.set(nodeId, {
      node,
      x: PAD_X + depth * GAP_X,
      y: midY,
      width: size.width,
      height: size.height,
      depth,
    })
    return { firstRow, lastRow }
  }

  for (const root of roots) {
    if (layoutByNodeId.has(root.id)) continue
    place(root.id, 0)
  }

  // 兜底：任何没被 root 覆盖的节点（如孤立测试用）直接以最新一行放置在 depth=0
  for (const n of nodes) {
    if (!layoutByNodeId.has(n.id)) {
      const row = cursorRow++
      rowY[row] = PAD_Y + row * GAP_Y
      const size = NODE_SIZE[n.kind]
      layoutByNodeId.set(n.id, {
        node: n,
        x: PAD_X,
        y: rowY[row],
        width: size.width,
        height: size.height,
        depth: 0,
      })
    }
  }

  const laidOutNodes = [...layoutByNodeId.values()]

  const laidOutEdges: MapLayoutEdge[] = edges.map(e => edgeLayout(e, layoutByNodeId))

  const maxRight = laidOutNodes.reduce((m, n) => Math.max(m, n.x + n.width), 0)
  const maxBottom = laidOutNodes.reduce((m, n) => Math.max(m, n.y + n.height), 0)

  return {
    nodes: laidOutNodes,
    edges: laidOutEdges,
    width: maxRight + PAD_X,
    height: maxBottom + PAD_Y,
  }
}

function groupChildren(nodes: MapNode[]): Map<string, MapNode[]> {
  const map = new Map<string, MapNode[]>()
  for (const n of nodes) {
    // 仅按显式 parentId 建树；根节点（无 parentId）不参与，避免 NEWS_ROOT_ID 自环
    if (!n.parentId) continue
    const arr = map.get(n.parentId) ?? []
    arr.push(n)
    map.set(n.parentId, arr)
  }
  return map
}

function edgeLayout(edge: MapEdge, byId: Map<string, MapLayoutNode>): MapLayoutEdge {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  const x1 = from ? from.x + from.width : 0
  const y1 = from ? from.y + from.height / 2 : 0
  const x2 = to ? to.x : 0
  const y2 = to ? to.y + to.height / 2 : 0
  return { id: edge.id, from: edge.from, to: edge.to, x1, y1, x2, y2 }
}
