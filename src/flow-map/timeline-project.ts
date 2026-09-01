import { MAP_COLUMN_LABEL, layoutReadNodeColumn } from './columns'
import { layoutReadSnapshot } from './layout'
import type { MapTimeline } from './timeline'
import type { MapNode, MapSnapshot } from './types'
import type { DataFrameIndex, FrameIndex } from './timeline-frame'
import { frameReadDataIndex } from './timeline-frame'

export interface TimelineLine {
  rootId: string
  leafId: string
  label: string
  layoutY: number
  xStart: FrameIndex
  xEnd: FrameIndex
  effectiveFrame: FrameIndex
  frames: Partial<Record<FrameIndex, string[]>>
}

function timelineFormatRootLabel(node: MapNode, nodes: MapNode[], index: number): string {
  const col = layoutReadNodeColumn(node, nodes)
  const typeLabel = MAP_COLUMN_LABEL[col] ?? node.kind
  return `${typeLabel}${index}`
}

function collectSubtree(snapshot: MapSnapshot, rootId: string): Set<string> {
  const ids = new Set([rootId])
  let changed = true
  while (changed) {
    changed = false
    for (const node of snapshot.nodes) {
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id)
        changed = true
      }
    }
  }
  return ids
}

export function timelineProjectLines(snapshot: MapSnapshot): TimelineLine[] {
  const layout = layoutReadSnapshot(snapshot)
  const byId = new Map(layout.nodes.map(n => [n.node.id, n]))
  const nodeById = new Map(snapshot.nodes.map(n => [n.id, n]))

  const rootIds = layout.nodes
    .filter(n => !n.node.parentId)
    .sort((a, b) => a.y - b.y)
    .map(n => n.node.id)

  const typeCounters = new Map<number, number>()

  return rootIds.map(rootId => {
    const subtree = collectSubtree(snapshot, rootId)
    const rootLayout = byId.get(rootId)!
    const rootNode = nodeById.get(rootId)!
    const rootCol = layoutReadNodeColumn(rootNode, snapshot.nodes)
    const seq = (typeCounters.get(rootCol) ?? 0) + 1
    typeCounters.set(rootCol, seq)

    const leaves = [...subtree].filter(
      id => !snapshot.nodes.some(n => n.parentId === id && subtree.has(n.id)),
    )

    let leafId = rootId
    let maxDepth = rootLayout.depth
    for (const lid of leaves) {
      const ln = byId.get(lid)
      if (!ln) continue
      if (ln.depth > maxDepth || (ln.depth === maxDepth && lid < leafId)) {
        maxDepth = ln.depth
        leafId = lid
      }
    }
    if (!Number.isFinite(maxDepth)) {
      maxDepth = rootLayout.depth
    }

    const frames: Partial<Record<FrameIndex, string[]>> = {}
    let effectiveFrame = rootLayout.depth as FrameIndex
    for (const id of subtree) {
      const ln = byId.get(id)
      if (!ln) continue
      const f = ln.depth as FrameIndex
      if (!frames[f]) frames[f] = []
      frames[f]!.push(id)
      if (ln.depth > effectiveFrame) effectiveFrame = ln.depth as FrameIndex
    }

    return {
      rootId,
      leafId,
      label: timelineFormatRootLabel(rootNode, snapshot.nodes, seq),
      layoutY: rootLayout.y,
      xStart: rootLayout.depth as FrameIndex,
      xEnd: effectiveFrame,
      effectiveFrame,
      frames,
    }
  })
}

export function timelineReadGlobalStart(lines: TimelineLine[]): FrameIndex {
  if (lines.length === 0) return 0
  return Math.min(...lines.map(l => l.xStart)) as FrameIndex
}

export function timelineReadGlobalFrame(lines: TimelineLine[]): FrameIndex {
  if (lines.length === 0) return 0
  return Math.max(...lines.map(l => l.effectiveFrame)) as FrameIndex
}

export function timelineReadDataEnd(timeline: MapTimeline): DataFrameIndex {
  return frameReadDataIndex(timeline.endX)
}
