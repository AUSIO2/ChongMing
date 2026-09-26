import type { GraphNode, GraphOperation, GraphRun, GraphSnapshot } from '../../../../contracts/graph'

export const GRAPH_KIND_LABELS: Record<GraphNode['data']['kind'], string> = {
  source: '来源', news: '新闻', evidence: '证据', claim: '事实', verification: '核查结论',
}
export type CanvasKind = GraphNode['data']['kind'] | 'parseAgent' | 'splitAgent' | 'verifyAgent' | 'opinion'
export const CANVAS_KIND_LABELS: Record<CanvasKind, string> = { ...GRAPH_KIND_LABELS, parseAgent: '解析', splitAgent: '拆分', verifyAgent: '核查', opinion: '意见' }
export interface CanvasNode { id: string; node: GraphNode; kind: CanvasKind; label: string; text: string; status: string; selectId: string; synthetic: boolean; score?: 0 | 0.5 | 1; parentId?: string; x: number; y: number; width: number; height: number }

export interface CanvasEdge { id: string; from: string; to: string; kind: string; path: string; displayFrom: string; displayTo: string; cross: boolean }
export interface CanvasLayout {
  nodes: CanvasNode[]; edges: CanvasEdge[]; width: number; height: number
  columns: Array<{ kind: CanvasKind; x: number; count: number }>
}

// 用途：读取节点文本，并把结构化结果交给调用方。
export function graphReadNodeText(node: GraphNode): string {
  const data = node.data
  if (data.kind === 'source') return data.label || (data.locator.kind === 'url' ? data.locator.url : '已上传的来源文件')
  return data.kind === 'verification' ? data.reason : data.content
}

// 用途：读取数据图，并把结构化结果交给调用方。
export function graphReadScore(score: 0 | 0.5 | 1): string { return score === 1 ? '可信' : score === 0 ? '不可信' : '不确定' }

// 用途：判断当前操作是否可以作用于数据图。
export function graphCanProcessNode(node: GraphNode, until: GraphRun['until']): boolean {
  return node.data.kind === 'source' || (node.data.kind === 'news' && until !== 'news') || (node.data.kind === 'claim' && until === 'verified')
}

export const GRAPH_OPERATION_LABELS: Record<GraphOperation['kind'], string> = { parse: '解析来源', split: '拆分事实', verify: '核查事实' }

// 用途：读取操作进度，并把结构化结果交给调用方。
export function graphReadOperationProgress(operation: GraphOperation): string {
  if (operation.status === 'completed') return `${GRAPH_OPERATION_LABELS[operation.kind]}已完成`
  if (operation.status === 'failed') return `${GRAPH_OPERATION_LABELS[operation.kind]}未完成`
  if (operation.status === 'cancelled') return '已取消'
  if (operation.status === 'waiting') return operation.review?.kind === 'route' ? '等待确认处理角度' : '等待保存处理结果'
  if (operation.kind === 'parse') return '正在解析来源内容'
  const route = operation.route
  if (!route) return operation.kind === 'split' ? '正在规划拆分角度' : '正在规划核查角度'
  const reports = operation.kind === 'split' ? operation.splitReports : operation.reports
  const received = route.slots.filter(slot => reports.some(report => report.slotId === slot.id && report.routeRevision === route.revision)).length
  return received === route.slots.length ? '意见已收齐，等待汇总结果' : `已收集 ${received} / ${route.slots.length} 份意见`
}

// 用途：读取运行状态进度，并把结构化结果交给调用方。
export function graphReadRunProgress(run: GraphRun | null): string {
  if (!run) return '尚未开始处理'
  const completed = run.operations.filter(operation => operation.status === 'completed').length
  const progress = `${completed} / ${run.operations.length} 项已完成`
  if (run.status === 'completed') return `处理已完成 · ${progress}`
  if (run.status === 'failed') return `处理未完成 · ${progress}`
  if (run.status === 'cancelled') return `处理已取消 · ${progress}`
  if (run.paused) return `已暂停 · ${progress}`
  if (run.operations.length === 1) return graphReadOperationProgress(run.operations[0])
  const pending = run.operations.filter(operation => operation.review?.state === 'pending').length
  return `${progress}${pending ? ` · ${pending} 项待审核` : ''}`
}

/** Read-only stage projections form a layout forest; shared data keeps its one real identity. */
// 用途：读取数据图，并把结构化结果交给调用方。
export function graphReadCanvasLayout(snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'> & { run?: GraphRun | null }): CanvasLayout {
  const order: CanvasKind[] = ['source', 'parseAgent', 'news', 'splitAgent', 'claim', 'verifyAgent', 'opinion', 'verification', 'evidence']
  const width = 204, height = 112, gap = 62, rowGap = 30, pad = 40
  const byId = new Map<string, CanvasNode>()
  const parents = new Map<string, Array<{ id: string; priority: number }>>()
  const links: Array<{ id: string; from: string; to: string; kind: string; displayFrom: string; displayTo: string }> = []
  const originals = [...snapshot.nodes].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const actual = new Map(originals.map(node => [node.id, node]))
  const operations = snapshot.run?.operations ?? []
  const graphHasInput = (outputId: string, inputId: string) => snapshot.edges.some(edge =>
    (edge.kind === 'derived-from' && edge.from === outputId && edge.to === inputId)
    || (edge.kind === 'mentions' && edge.from === inputId && edge.to === outputId))
  // 用途：创建视图，供后续流程使用。
  function graphCreateView(id: string, node: GraphNode, kind: CanvasKind, label: string, text: string, status = '', score?: 0 | 0.5 | 1): CanvasNode {
    const prior = byId.get(id)
    if (prior) return prior
    const item: CanvasNode = { id, node, kind, label, text, status, selectId: node.id, synthetic: id !== node.id, score, x: 0, y: 0, width, height }
    byId.set(id, item)
    return item
  }
  // 用途：处理数据图相关工作，并把结果交给调用方。
  function graphAddParent(child: string, parent: string, priority = 1) {
    if (child === parent) return
    const list = parents.get(child) ?? []
    if (!list.some(item => item.id === parent)) list.push({ id: parent, priority })
    parents.set(child, list)
  }
  // 用途：处理数据图相关工作，并把结果交给调用方。
  function graphAddBranch(from: string, to: string, priority = 1) {
    const id = 'branch:' + from + '>' + to
    if (!links.some(link => link.id === id)) links.push({ id, from, to, kind: 'branch', displayFrom: from, displayTo: to })
    graphAddParent(to, from, priority)
  }
  // 用途：创建Agent，供后续流程使用。
  function graphCreateAgent(owner: GraphNode, kind: 'parseAgent' | 'splitAgent' | 'verifyAgent', key: string, name: string, angle: string, status: string) {
    const id = 'view:' + kind + ':' + key
    graphCreateView(id, owner, kind, name, angle, status)
    graphAddBranch(owner.id, id)
    return id
  }
  for (const node of originals) graphCreateView(node.id, node, node.data.kind, GRAPH_KIND_LABELS[node.data.kind], graphReadNodeText(node), '', node.data.kind === 'verification' ? node.data.score : undefined)

  const producerParents = new Map<string, string>()
  for (const node of originals) {
    const producer = node.producer, owner = producer ? actual.get(producer.inputId) : undefined
    if (!producer || !owner) continue
    const id = graphCreateAgent(owner, producer.kind === 'parse' ? 'parseAgent' : 'splitAgent', producer.operationId + ':' + (producer.slotId ?? 'parse'),
      producer.agentName, producer.angle ?? (producer.kind === 'parse' ? '解析来源内容' : '提取事实'), '产物已保存')
    producerParents.set(node.id, id)
    graphAddParent(node.id, id, 0)
  }

  const resultParents = new Map<string, string[]>()
  // 用途：创建数据图，供后续流程使用。
  function graphCreateOpinions(owner: GraphNode, key: string, reports: import('../../../../contracts/graph').GraphReport[], resultId?: string) {
    const opinions: string[] = []
    for (const report of reports) {
      const agentId = graphCreateAgent(owner, 'verifyAgent', key + ':' + report.slotId, report.agentName, report.angle, '已提交意见')
      const opinionId = 'view:opinion:' + key + ':' + report.id
      const selectOwner = resultId ? actual.get(resultId) ?? owner : owner
      graphCreateView(opinionId, selectOwner, 'opinion', report.angle, report.reason, resultId ? '已保存意见' : '候选意见', report.score)
      graphAddBranch(agentId, opinionId)
      opinions.push(opinionId)
    }
    if (resultId) resultParents.set(resultId, opinions)
    return opinions
  }
  for (const node of originals) {
    if (node.data.kind !== 'verification') continue
    const relation = snapshot.edges.find(edge => edge.kind === 'verifies' && edge.from === node.id)
    const owner = relation ? actual.get(relation.to) : undefined
    if (!owner) continue
    const operation = operations.find(operation => operation.resultNodeId === node.id)
    const key = operation?.id ?? node.id
    const opinions = graphCreateOpinions(owner, key, node.data.opinions, node.id)
    if (!opinions.length) resultParents.set(node.id, [graphCreateAgent(owner, 'verifyAgent', key + ':summary', '核查处理', '已保存的核查结果', '已完成')])
  }

  for (const operation of operations) {
    const owner = actual.get(operation.targetId)
    if (!owner) continue
    const paused = snapshot.run?.paused && ['running', 'waiting'].includes(operation.status)
    const status = paused ? '已暂停' : graphReadOperationProgress(operation)
    if (operation.kind === 'parse') {
      const agent = graphCreateAgent(owner, 'parseAgent', operation.id + ':parse', snapshot.run!.configuration.parse?.name ?? '来源解析', '读取来源并生成新闻', status)
      for (const output of operation.outputRefs) if (actual.has(output.id) && graphHasInput(output.id, owner.id)) { producerParents.set(output.id, agent); graphAddParent(output.id, agent, 0) }
      if (operation.status !== 'completed' && operation.contentDraft?.kind === 'parse') operation.contentDraft.news.forEach((news, index) => {
        const id = 'view:news:' + operation.id + ':' + index
        graphCreateView(id, owner, 'news', '候选新闻', news.content, '待保存'); graphAddBranch(agent, id)
      })
      continue
    }
    const kind = operation.kind === 'split' ? 'splitAgent' : 'verifyAgent'
    const configuration = operation.kind === 'split' ? snapshot.run!.configuration.split : snapshot.run!.configuration
    if (!operation.route) {
      graphCreateAgent(owner, kind, operation.id + ':route', configuration?.router.name ?? CANVAS_KIND_LABELS[kind], '规划处理分支', status)
      continue
    }
    for (const slot of operation.route.slots) {
      const report = operation.kind === 'split' ? operation.splitReports.find(report => report.slotId === slot.id) : operation.reports.find(report => report.slotId === slot.id)
      const agent = graphCreateAgent(owner, kind, operation.id + ':' + slot.id,
        configuration?.agents.find(agent => agent.id === slot.agentId)?.name ?? report?.agentName ?? slot.angle,
        slot.angle + (slot.hint ? '\n' + slot.hint : ''), report ? '已提交' : paused ? '已暂停' : operation.route.approved ? '等待提交结果' : '等待确认路由')
      if (operation.kind === 'split') {
        const splitReport = operation.splitReports.find(report => report.slotId === slot.id)
        splitReport?.claims.forEach((claim, index) => {
          const saved = operation.outputRefs.find(ref => ref.reportId === splitReport.id && ref.index === index && actual.has(ref.id))
          if (saved) {
            if (graphHasInput(saved.id, owner.id)) { producerParents.set(saved.id, agent); graphAddParent(saved.id, agent, 0) }
            return
          }
          const selected = operation.contentDraft?.kind === 'split' ? operation.contentDraft.selected.some(item => item.reportId === splitReport.id && item.index === index) : null
          const id = 'view:claim:' + splitReport.id + ':' + index
          graphCreateView(id, owner, 'claim', '候选事实', claim.content, selected === false ? '未采用' : selected === true ? '待保存' : '待汇总')
          graphAddBranch(agent, id)
        })
      }
    }
    if (operation.kind === 'verify' && !operation.resultNodeId) {
      const opinions = graphCreateOpinions(owner, operation.id, operation.reports)
      if (operation.draft) {
        const id = 'view:verification:' + operation.id
        graphCreateView(id, owner, 'verification', '待审结论', operation.draft.reason, status, operation.draft.score)
        for (const opinion of opinions) graphAddBranch(opinion, id)
        resultParents.set(id, opinions)
      }
    }
  }

  for (const edge of [...snapshot.edges].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!actual.has(edge.from) || !actual.has(edge.to)) continue
    let from = edge.from, to = edge.to
    if (edge.kind === 'derived-from' || edge.kind === 'verifies') { from = edge.to; to = edge.from }
    if (edge.kind === 'verifies') {
      const incoming = resultParents.get(to) ?? []
      if (incoming.length) { from = incoming[0]; incoming.slice(1).forEach(parent => graphAddBranch(parent, to)) }
    } else if (edge.kind === 'derived-from' || edge.kind === 'mentions') {
      const input = actual.get(from)!, output = actual.get(to)!
      const producer = producerParents.get(to)
      if (producer && byId.get(producer)?.selectId === from) from = producer
      else if (input.data.kind === 'source' && output.data.kind === 'news') from = graphCreateAgent(input, 'parseAgent', input.id + ':known', '来源解析', '已保存的新闻', '产物已保存')
      else if (input.data.kind === 'news' && output.data.kind === 'claim') from = graphCreateAgent(input, 'splitAgent', input.id + ':known', '事实拆分', '已有事实与来源关联', '产物已保存')
    }
    links.push({ ...edge, displayFrom: from, displayTo: to })
    if (edge.kind !== 'related-to') graphAddParent(to, from, producerParents.get(to) === from ? 0 : 1)
  }
  const kinds = order.filter(kind => [...byId.values()].some(node => node.kind === kind))
  const columns = kinds.map((kind, index) => ({ kind, x: pad + index * (width + gap), count: [...byId.values()].filter(node => node.kind === kind).length }))
  for (const node of byId.values()) node.x = columns.find(column => column.kind === node.kind)!.x
  for (const [child, candidates] of parents) {
    const node = byId.get(child)
    if (!node) continue
    const valid = candidates.filter(parent => byId.has(parent.id) && byId.get(parent.id)!.x < node.x)
      .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id))
    node.parentId = valid[0]?.id
  }
  const children = new Map<string, CanvasNode[]>()
  for (const node of byId.values()) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
  const compare = (a: CanvasNode, b: CanvasNode) => a.x - b.x || a.id.localeCompare(b.id)
  for (const list of children.values()) list.sort(compare)
  // 用途：处理数据图相关工作，并把结果交给调用方。
  function graphPlaceTree(node: CanvasNode, start: number): number {
    const descendants = children.get(node.id) ?? []
    if (!descendants.length) { node.y = 96 + start * (height + rowGap); return start + 1 }
    let end = start
    for (const child of descendants) end = graphPlaceTree(child, end)
    node.y = 96 + (start + end - 1) / 2 * (height + rowGap)
    return end
  }
  let row = 0
  const roots = [...byId.values()].filter(node => !node.parentId).sort(compare)
  for (const root of roots) row = graphPlaceTree(root, row) + 0.6
  // Merge results sit at the centre of their opinion fan-in; separate branch blocks stay disjoint.
  for (const [id, ids] of resultParents) {
    const node = byId.get(id), incoming = ids.map(id => byId.get(id)).filter((node): node is CanvasNode => !!node)
    if (node && incoming.length) node.y = (Math.min(...incoming.map(node => node.y)) + Math.max(...incoming.map(node => node.y))) / 2
  }
  const nodes = [...byId.values()].sort((a, b) => a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))
  // A shared descendant has one location; retain all other input links as cross-branches.
  const edges: CanvasEdge[] = links.map(link => {
    const from = byId.get(link.displayFrom)!, to = byId.get(link.displayTo)!
    const forward = to.x > from.x, same = to.x === from.x
    const x1 = from.x + (forward || same ? width : 0), x2 = to.x + (forward ? 0 : width)
    const peers = links.filter(item => item.displayFrom === link.displayFrom && item.displayTo === link.displayTo)
    const offset = (peers.findIndex(item => item.id === link.id) - (peers.length - 1) / 2) * 6
    const y1 = from.y + height / 2 + offset, y2 = to.y + height / 2 + offset
    const bend = Math.max(36, Math.abs(x2 - x1) / 2)
    return { ...link, cross: (to.parentId !== from.id && to.kind !== 'verification') || link.kind === 'related-to',
      path: `M ${x1} ${y1} C ${same ? x1 + 45 : x1 + (forward ? bend : -bend)} ${y1}, ${same ? x2 + 45 : x2 + (forward ? -bend : bend)} ${y2}, ${x2} ${y2}` }
  })
  return { nodes, edges, columns, width: Math.max(520, ...nodes.map(node => node.x + node.width + pad)),
    height: Math.max(330, ...nodes.map(node => node.y + node.height + pad)) }
}

// 用途：读取数据图，并把结构化结果交给调用方。
export function graphReadCanvasNeighbor(layout: CanvasLayout, id: string, direction: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'): string | null {
  const current = layout.nodes.find(node => node.id === id)
  if (!current) return null
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight'
  const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1
  const candidates = layout.nodes.filter(node => node !== current).map(node => {
    const along = (horizontal ? node.x - current.x : node.y - current.y) * sign
    const across = Math.abs(horizontal ? node.y - current.y : node.x - current.x)
    return { id: node.id, along, distance: along + across * 2 }
  }).filter(node => node.along > 0).sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id))
  return candidates[0]?.id ?? null
}
