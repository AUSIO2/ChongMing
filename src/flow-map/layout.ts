import type { MapEdge, MapNode, MapSnapshot, MapNodeKind } from './types'
import { layoutReadNodeColumn } from './columns'

/**
 * 布局：列号由 MAP_COLUMN 决定 x；同 parent 子树递归分行决定 y。
 */

const PAD_X = 80
const PAD_Y = 60
const GAP_X = 240
const GAP_Y = 100

export const MAP_NODE_WIDTH = 200
export const MAP_NODE_HEIGHT = 80

const NODE_SIZE: Record<MapNodeKind, { width: number; height: number }> = {
  source: { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT },
  parseAgent: { width: MAP_NODE_WIDTH, height: MAP_NODE_HEIGHT },
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
  /** 列号（MAP_COLUMN），用于调试 / CSS */
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

export function layoutReadSnapshot(snapshot: MapSnapshot): MapLayoutSnapshot {
  const { nodes, edges } = snapshot
  const childrenByParent = layoutGroupChildren(nodes)
  const roots = nodes.filter(n => !n.parentId)
  const layoutByNodeId = new Map<string, MapLayoutNode>()

  let cursorRow = 0

  function place(nodeId: string, startRow: number): number {
    const node = nodes.find(n => n.id === nodeId)
    if (!node) return startRow

    const kids = childrenByParent.get(nodeId) ?? []
    const col = layoutReadNodeColumn(node, nodes)

    if (kids.length === 0) {
      const row = startRow
      const size = NODE_SIZE[node.kind]
      layoutByNodeId.set(nodeId, {
        node,
        x: PAD_X + col * GAP_X,
        y: PAD_Y + row * GAP_Y,
        width: size.width,
        height: size.height,
        depth: col,
      })
      return startRow + 1
    }

    let nextRow = startRow
    const endRows: number[] = []
    for (const k of kids) {
      endRows.push(place(k.id, nextRow))
      nextRow = endRows[endRows.length - 1]
    }
    const lastRow = endRows[endRows.length - 1] - 1
    const midRow = (startRow + lastRow) / 2
    const size = NODE_SIZE[node.kind]
    layoutByNodeId.set(nodeId, {
      node,
      x: PAD_X + col * GAP_X,
      y: PAD_Y + midRow * GAP_Y,
      width: size.width,
      height: size.height,
      depth: col,
    })
    return endRows[endRows.length - 1]
  }

  for (const root of roots) {
    if (layoutByNodeId.has(root.id)) continue
    cursorRow = place(root.id, cursorRow)
  }

  for (const n of nodes) {
    if (layoutByNodeId.has(n.id)) continue
    const col = layoutReadNodeColumn(n, nodes)
    const size = NODE_SIZE[n.kind]
    layoutByNodeId.set(n.id, {
      node: n,
      x: PAD_X + col * GAP_X,
      y: PAD_Y + cursorRow * GAP_Y,
      width: size.width,
      height: size.height,
      depth: col,
    })
    cursorRow++
  }

  const laidOutNodes = [...layoutByNodeId.values()]
  const laidOutEdges: MapLayoutEdge[] = edges.map(e => layoutEdge(e, layoutByNodeId))
  const maxRight = laidOutNodes.reduce((m, n) => Math.max(m, n.x + n.width), 0)
  const maxBottom = laidOutNodes.reduce((m, n) => Math.max(m, n.y + n.height), 0)

  return {
    nodes: laidOutNodes,
    edges: laidOutEdges,
    width: maxRight + PAD_X,
    height: maxBottom + PAD_Y,
  }
}

function layoutGroupChildren(nodes: MapNode[]): Map<string, MapNode[]> {
  const map = new Map<string, MapNode[]>()
  for (const n of nodes) {
    if (!n.parentId) continue
    const arr = map.get(n.parentId) ?? []
    arr.push(n)
    map.set(n.parentId, arr)
  }
  return map
}

function layoutEdge(edge: MapEdge, byId: Map<string, MapLayoutNode>): MapLayoutEdge {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  const x1 = from ? from.x + from.width : 0
  const y1 = from ? from.y + from.height / 2 : 0
  const x2 = to ? to.x : 0
  const y2 = to ? to.y + to.height / 2 : 0
  return { id: edge.id, from: edge.from, to: edge.to, x1, y1, x2, y2 }
}
