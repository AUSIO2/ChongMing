import type { GraphNode, GraphRun, GraphSnapshot } from '../../../contracts/graph'

export const GRAPH_KIND_LABELS: Record<GraphNode['data']['kind'], string> = {
  source: '来源', news: '新闻', evidence: '证据', claim: '事实', verification: '核查结论',
}
export interface CanvasNode { node: GraphNode; x: number; y: number; width: number; height: number }
export interface CanvasEdge { id: string; from: string; to: string; kind: string; path: string }
export interface CanvasLayout {
  nodes: CanvasNode[]; edges: CanvasEdge[]; width: number; height: number
  columns: Array<{ kind: GraphNode['data']['kind']; x: number; count: number }>
}

export function graphReadNodeText(node: GraphNode): string {
  const data = node.data
  if (data.kind === 'source') return data.label || (data.locator.kind === 'url' ? data.locator.url : '已上传的来源文件')
  return data.kind === 'verification' ? data.reason : data.content
}

export function graphReadScore(score: 0 | 0.5 | 1): string { return score === 1 ? '可信' : score === 0 ? '不可信' : '不确定' }

export function graphReadRunProgress(run: GraphRun | null): string {
  if (!run) return '尚未开始核查'
  if (run.status === 'completed') return '核查已完成'
  if (run.status === 'failed') return '核查未完成'
  if (run.status === 'cancelled') return '核查已取消'
  if (run.status === 'waiting') return run.operation.review?.kind === 'route' ? '等待确认核查角度' : '等待保存核查结论'
  const route = run.operation.route
  if (!route) return '正在规划核查角度'
  const received = route.slots.filter(slot => run.operation.reports.some(report => report.slotId === slot.id && report.routeRevision === route.revision)).length
  return received === route.slots.length ? '意见已收齐，等待汇总结论' : `已收集 ${received} / ${route.slots.length} 份意见`
}

/** Every data node gets one position; relationships never manufacture a single parent. */
export function graphReadCanvasLayout(snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'>): CanvasLayout {
  const kinds = (['source', 'news', 'evidence', 'claim', 'verification'] as const).filter(kind => snapshot.nodes.some(node => node.data.kind === kind))
  const nodes: CanvasNode[] = []
  const columns: CanvasLayout['columns'] = []
  const width = 232, height = 140, gap = 74, pad = 40
  for (const [column, kind] of kinds.entries()) {
    const group = snapshot.nodes.filter(node => node.data.kind === kind)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const x = pad + column * (width + gap)
    columns.push({ kind, x, count: group.length })
    group.forEach((node, row) => nodes.push({ node, x, y: 78 + row * (height + 38), width, height }))
  }
  const byId = new Map(nodes.map(node => [node.node.id, node]))
  const realEdges = [...snapshot.edges].sort((a, b) => a.id.localeCompare(b.id))
  const edges: CanvasEdge[] = []
  function graphReadPortOffset(id: string, edgeId: string, side: 'from' | 'to'): number {
    const peers = realEdges.filter(edge => edge[side] === id)
    return (peers.findIndex(edge => edge.id === edgeId) - (peers.length - 1) / 2) * Math.min(10, height / (peers.length + 1))
  }
  for (const edge of realEdges) {
    const from = byId.get(edge.from), to = byId.get(edge.to)
    if (!from || !to) continue
    const forward = to.x > from.x
    const sameColumn = from.x === to.x
    const x1 = from.x + (forward || sameColumn ? width : 0)
    const x2 = to.x + (forward ? 0 : width)
    const y1 = from.y + height / 2 + graphReadPortOffset(edge.from, edge.id, 'from')
    const y2 = to.y + height / 2 + graphReadPortOffset(edge.to, edge.id, 'to')
    const bend = Math.max(36, Math.abs(x2 - x1) / 2)
    const c1 = sameColumn ? x1 + 45 : x1 + (forward ? bend : -bend)
    const c2 = sameColumn ? x2 + 45 : x2 + (forward ? -bend : bend)
    edges.push({ ...edge, path: `M ${x1} ${y1} C ${c1} ${y1}, ${c2} ${y2}, ${x2} ${y2}` })
  }
  return { nodes, edges, columns, width: Math.max(520, pad * 2 + kinds.length * (width + gap) - gap + 46),
    height: Math.max(330, ...nodes.map(node => node.y + node.height + pad)) }
}

export function graphReadCanvasNeighbor(layout: CanvasLayout, id: string, direction: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): string | null {
  const current = layout.nodes.find(node => node.node.id === id)
  if (!current) return null
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight'
  const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1
  const candidates = layout.nodes.filter(node => node !== current).map(node => {
    const along = (horizontal ? node.x - current.x : node.y - current.y) * sign
    const across = Math.abs(horizontal ? node.y - current.y : node.x - current.x)
    return { id: node.node.id, along, distance: along + across * 2 }
  }).filter(node => node.along > 0).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
  return candidates[0]?.id ?? null
}
