import type { MapLayoutNode, MapLayoutSnapshot } from './layout'

export type LayoutNavDir = 'up' | 'down' | 'left' | 'right'

const LAYOUT_NAV_EPS = 1

function layoutCompareNodeRank(a: MapLayoutNode, b: MapLayoutNode): number {
  if (a.y !== b.y) return a.y - b.y
  if (a.depth !== b.depth) return a.depth - b.depth
  return a.node.id.localeCompare(b.node.id)
}

export function layoutReadFirstNodeId(layout: MapLayoutSnapshot): string | null {
  if (layout.nodes.length === 0) return null
  const sorted = [...layout.nodes].sort(layoutCompareNodeRank)
  return sorted[0]!.node.id
}

function layoutReadNode(
  layout: MapLayoutSnapshot,
  nodeId: string,
): MapLayoutNode | null {
  return layout.nodes.find(n => n.node.id === nodeId) ?? null
}

function layoutCompareVertical(
  a: MapLayoutNode,
  b: MapLayoutNode,
  cur: MapLayoutNode,
  ascending: boolean,
): number {
  if (ascending) {
    if (a.y !== b.y) return a.y - b.y
  } else if (a.y !== b.y) {
    return b.y - a.y
  }
  const depthA = Math.abs(a.depth - cur.depth)
  const depthB = Math.abs(b.depth - cur.depth)
  if (depthA !== depthB) return depthA - depthB
  const xA = Math.abs(a.x - cur.x)
  const xB = Math.abs(b.x - cur.x)
  if (xA !== xB) return xA - xB
  return a.node.id.localeCompare(b.node.id)
}

function layoutCompareHorizontal(
  a: MapLayoutNode,
  b: MapLayoutNode,
  cur: MapLayoutNode,
  left: boolean,
): number {
  if (left) {
    if (a.depth !== b.depth) return b.depth - a.depth
  } else if (a.depth !== b.depth) {
    return a.depth - b.depth
  }
  const yA = Math.abs(a.y - cur.y)
  const yB = Math.abs(b.y - cur.y)
  if (yA !== yB) return yA - yB
  return a.node.id.localeCompare(b.node.id)
}

function layoutFilterVertical(
  others: MapLayoutNode[],
  cur: MapLayoutNode,
  down: boolean,
): MapLayoutNode[] {
  const sameDepth = others.filter(n => n.depth === cur.depth)
  const band = down
    ? sameDepth.filter(n => n.y > cur.y + LAYOUT_NAV_EPS)
    : sameDepth.filter(n => n.y < cur.y - LAYOUT_NAV_EPS)
  if (band.length > 0) return band
  return down
    ? others.filter(n => n.y > cur.y + LAYOUT_NAV_EPS)
    : others.filter(n => n.y < cur.y - LAYOUT_NAV_EPS)
}

export function layoutFindNeighbor(
  layout: MapLayoutSnapshot,
  nodeId: string | null,
  dir: LayoutNavDir,
): string | null {
  if (!nodeId) return layoutReadFirstNodeId(layout)

  const cur = layoutReadNode(layout, nodeId)
  if (!cur) return layoutReadFirstNodeId(layout)

  const others = layout.nodes.filter(n => n.node.id !== nodeId)

  let candidates: MapLayoutNode[]
  if (dir === 'up') {
    candidates = layoutFilterVertical(others, cur, false)
    candidates.sort((a, b) => layoutCompareVertical(a, b, cur, false))
  } else if (dir === 'down') {
    candidates = layoutFilterVertical(others, cur, true)
    candidates.sort((a, b) => layoutCompareVertical(a, b, cur, true))
  } else if (dir === 'left') {
    candidates = others.filter(n => n.depth < cur.depth)
    candidates.sort((a, b) => layoutCompareHorizontal(a, b, cur, true))
  } else {
    candidates = others.filter(n => n.depth > cur.depth)
    candidates.sort((a, b) => layoutCompareHorizontal(a, b, cur, false))
  }

  return candidates[0]?.node.id ?? null
}
