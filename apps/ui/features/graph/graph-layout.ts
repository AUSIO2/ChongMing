// 通用数据图展示投影：名称来自精确定义，层级来自真实 successor 关系。
import type { DefinitionCatalog, TransitionDefinition } from '../../../../contracts/data-definition'
import type { GraphNode, GraphOperation, GraphRun, GraphRunPlan, GraphSnapshot } from '../../../../contracts/graph'
import { definitionKey, payloadFindType, payloadReadNodeText as payloadText } from './data-payload'

export type CanvasKind = string
export interface CanvasNode {
  id: string
  node: GraphNode
  kind: CanvasKind
  columnKey: string
  label: string
  text: string
  status: string
  selectId: string
  synthetic: false
  parentId?: string
  x: number
  y: number
  width: number
  height: number
}
export interface CanvasEdge {
  id: string
  from: string
  to: string
  kind: 'successor' | 'reference'
  label?: string
  path: string
  displayFrom: string
  displayTo: string
  cross: boolean
}
export interface CanvasLayout {
  nodes: CanvasNode[]
  edges: CanvasEdge[]
  width: number
  height: number
  columns: Array<{ key: string; kind: CanvasKind; label: string; x: number; count: number }>
}

/**
 * @param node 通用数据实例。
 * @param catalog 当前工作区定义目录。
 */
export function graphReadNodeText(node: GraphNode, catalog?: DefinitionCatalog | null): string {
  return payloadText(node, payloadFindType(catalog, node))
}

/**
 * @param node 通用数据实例。
 * @param catalog 当前工作区定义目录。
 */
export function graphReadNodeType(node: GraphNode, catalog?: DefinitionCatalog | null): string {
  return payloadFindType(catalog, node)?.title ?? node.typeId
}

/**
 * @param node 候选输入实例。
 * @param transition 用户选择的精确转换定义。
 */
export function graphCanProcessNode(node: GraphNode, transition: TransitionDefinition): boolean {
  return transition.ports.input.some(port => port.inputType.id === node.typeId && port.inputType.version === node.typeVersion)
}

/**
 * @param nodes 当前选择；空选择不产生可运行转换。
 * @param catalog 工作区已发布定义目录。
 */
export function graphReadAvailableTransitions(
  nodes: GraphNode[],
  catalog?: DefinitionCatalog | null
): TransitionDefinition[] {
  if (!nodes.length || !catalog) return []
  return catalog.transitions.filter(transition => {
    if (transition.ports.input.length !== 1) return false
    if (transition.ports.context.some(port => port.count.min > 0)) return false
    const port = transition.ports.input[0]
    if (!nodes.every(node => node.typeId === port.inputType.id && node.typeVersion === port.inputType.version)) return false
    if (transition.cardinality === 'N:1' || transition.cardinality === 'N:M') return nodes.length >= port.count.min && nodes.length <= port.count.max
    return nodes.length >= 1
  })
}

/**
 * @param transition 要实例化的精确转换。
 * @param nodeIds 已验证的输入节点身份。
 */
export function graphCreateRunPlan(transition: TransitionDefinition, nodeIds: string[]): GraphRunPlan {
  const input = transition.ports.input[0]
  if (!input) return { steps: [] }
  const grouped = transition.cardinality === 'N:1' || transition.cardinality === 'N:M'
  return { steps: [{
    id: `step-${crypto.randomUUID()}`,
    transitionRef: { id: transition.id, version: transition.version },
    dependsOn: [],
    input: [{ port: input.name, source: { kind: 'scope', nodeIds: [...nodeIds] } }],
    context: transition.ports.context.map(port => ({ port: port.name, source: { kind: 'scope' as const, nodeIds: [] } })),
    grouping: { mode: grouped ? 'all' : 'each' },
    onEmpty: 'fail',
  }] }
}

/**
 * @param operation 冻结执行规格所属 Operation。
 */
export function graphReadOperationLabel(operation: GraphOperation): string {
  return operation.executionSpec.transition.title
}

/**
 * @param operation 当前 Operation 的阶段与审核状态。
 */
export function graphReadOperationProgress(operation: GraphOperation): string {
  const label = graphReadOperationLabel(operation)
  if (operation.status === 'completed') return `${label}已完成`
  if (operation.status === 'failed') return `${label}未完成`
  if (operation.status === 'cancelled') return '已取消'
  if (operation.status === 'skipped') return '已跳过'
  if (operation.status === 'waiting') return operation.review?.kind === 'plan' ? '等待确认执行计划' : '等待确认处理结果'
  const current = operation.stages.find(stage => !stage.closed)
  if (!current) return `正在完成 ${label}`
  const accepted = current.results.length
  const expected = current.expectedWorkIds.length
  return expected > 1 ? `${current.stageId} · ${accepted} / ${expected} 项完成` : `正在执行 ${current.stageId}`
}

/**
 * @param run 当前图的 Run。
 */
export function graphReadRunProgress(run: GraphRun | null): string {
  if (!run) return '尚未开始处理'
  const completed = run.operations.filter(operation => operation.status === 'completed' || operation.status === 'skipped').length
  const progress = `${completed} / ${run.operations.length} 项已完成`
  if (run.status === 'completed') return `处理已完成 · ${progress}`
  if (run.status === 'failed') return `处理未完成 · ${progress}`
  if (run.status === 'cancelled') return `处理已取消 · ${progress}`
  if (run.paused) return `已暂停 · ${progress}`
  if (run.operations.length === 1) return graphReadOperationProgress(run.operations[0])
  const pending = run.operations.filter(operation => operation.review?.state === 'pending').length
  return `${progress}${pending ? ` · ${pending} 项待审核` : ''}`
}

function graphReadDepths(nodes: GraphNode[], snapshot: Pick<GraphSnapshot, 'edges'>): Map<string, number> {
  const ids = new Set(nodes.map(node => node.id))
  const depths = new Map(nodes.map(node => [node.id, 0]))
  const edges = snapshot.edges.filter(edge => edge.kind === 'successor' && ids.has(edge.from) && ids.has(edge.to))
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    for (const edge of edges) {
      const next = Math.min(nodes.length, (depths.get(edge.from) ?? 0) + 1)
      if (next > (depths.get(edge.to) ?? 0)) { depths.set(edge.to, next); changed = true }
    }
    if (!changed) break
  }
  return depths
}

/**
 * @param snapshot 图快照；运行定义用于保证历史类型仍有稳定名称。
 * @param catalog 工作区当前定义目录；运行冻结目录优先补齐历史精确版本。
 */
export function graphReadCanvasLayout(
  snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'> & { runs?: GraphRun[] },
  catalog?: DefinitionCatalog | null
): CanvasLayout {
  const width = 204, height = 112, gap = 62, rowGap = 30, pad = 40
  const frozen = snapshot.runs?.[snapshot.runs.length - 1]?.definitions
  const frozenTypes = snapshot.runs?.flatMap(run => run.definitions.dataTypes) ?? []
  const combinedCatalog: DefinitionCatalog | null = frozen ? {
    ...frozen,
    dataTypes: [...new Map([...frozenTypes, ...(catalog?.dataTypes ?? [])].map(type => [definitionKey(type), type])).values()],
  } : catalog ?? null
  const originals = [...snapshot.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  if (!originals.length) return { nodes: [], edges: [], columns: [], width: 520, height: 330 }
  const actual = new Map(originals.map(node => [node.id, node]))
  const depths = graphReadDepths(originals, snapshot)
  const columnMeta = new Map<string, { key: string; kind: string; label: string; depth: number; count: number; x: number }>()
  for (const node of originals) {
    const kind = definitionKey({ id: node.typeId, version: node.typeVersion })
    const depth = depths.get(node.id) ?? 0
    const key = `${depth}:${kind}`
    const prior = columnMeta.get(key)
    if (prior) prior.count++
    else columnMeta.set(key, { key, kind, label: graphReadNodeType(node, combinedCatalog), depth, count: 1, x: 0 })
  }
  const columns = [...columnMeta.values()].sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind))
  columns.forEach((column, index) => { column.x = pad + index * (width + gap) })
  const incoming = new Map<string, string[]>()
  for (const edge of snapshot.edges.filter(edge => edge.kind === 'successor').sort((a, b) => a.id.localeCompare(b.id))) {
    if (!actual.has(edge.from) || !actual.has(edge.to)) continue
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from])
  }
  const nodes: CanvasNode[] = originals.map(node => {
    const kind = definitionKey({ id: node.typeId, version: node.typeVersion })
    const columnKey = `${depths.get(node.id) ?? 0}:${kind}`
    const operation = snapshot.runs?.flatMap(run => run.operations).find(item => item.group.inputRefs.some(ref => ref.id === node.id)
      && ['running', 'waiting'].includes(item.status))
    return {
      id: node.id, node, kind, columnKey, label: graphReadNodeType(node, combinedCatalog), text: graphReadNodeText(node, combinedCatalog),
      status: operation ? graphReadOperationProgress(operation) : node.validity === 'stale' ? '需要重新处理' : '',
      selectId: node.id, synthetic: false, parentId: incoming.get(node.id)?.[0], x: columns.find(column => column.key === columnKey)!.x,
      y: 0, width, height,
    }
  })
  const byId = new Map(nodes.map(node => [node.id, node]))
  for (const column of columns) {
    const list = nodes.filter(node => node.columnKey === column.key).sort((a, b) => {
      const ay = a.parentId ? byId.get(a.parentId)?.y ?? 0 : 0
      const by = b.parentId ? byId.get(b.parentId)?.y ?? 0 : 0
      return ay - by || a.id.localeCompare(b.id)
    })
    list.forEach((node, index) => { node.y = 96 + index * (height + rowGap) })
  }
  const edges: CanvasEdge[] = snapshot.edges.filter(edge => actual.has(edge.from) && actual.has(edge.to)).sort((a, b) => a.id.localeCompare(b.id)).map(edge => {
    const from = byId.get(edge.from)!, to = byId.get(edge.to)!
    const forward = to.x > from.x
    const x1 = from.x + (forward || to.x === from.x ? width : 0), x2 = to.x + (forward ? 0 : width)
    const y1 = from.y + height / 2, y2 = to.y + height / 2
    const bend = Math.max(36, Math.abs(x2 - x1) / 2)
    return { ...edge, displayFrom: edge.from, displayTo: edge.to, cross: edge.kind === 'reference' || to.parentId !== from.id,
      path: `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 + (forward ? -bend : bend)} ${y2}, ${x2} ${y2}` }
  })
  return {
    nodes: nodes.sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id)), edges,
    columns: columns.map(({ key, kind, label, x, count }) => ({ key, kind, label, x, count })),
    width: Math.max(520, ...nodes.map(node => node.x + node.width + pad)),
    height: Math.max(330, ...nodes.map(node => node.y + node.height + pad)),
  }
}

/**
 * @param layout 已完成布局。
 * @param id 当前焦点节点。
 * @param direction 方向键。
 */
export function graphReadCanvasNeighbor(
  layout: CanvasLayout,
  id: string,
  direction: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
): string | null {
  const current = layout.nodes.find(node => node.id === id)
  if (!current) return null
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight'
  const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1
  return layout.nodes.filter(node => node !== current).map(node => {
    const along = (horizontal ? node.x - current.x : node.y - current.y) * sign
    const across = Math.abs(horizontal ? node.y - current.y : node.x - current.x)
    return { id: node.id, along, distance: along + across * 2 }
  }).filter(node => node.along > 0).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))[0]?.id ?? null
}
