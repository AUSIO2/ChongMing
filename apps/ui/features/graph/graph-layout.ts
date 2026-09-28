// 图展示投影：生成阶段树坐标和连线，提供节点文案、进度与方向导航。
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

export function graphReadNodeText(/* 图中的只读真实节点，按数据类型选择正文、标签或结论理由。 */ node: GraphNode): string {
  // 按节点类型提取画布正文；来源优先使用标签，核查结论使用理由。
  const data = node.data
  if (data.kind === 'source') return data.label || (data.locator.kind === 'url' ? data.locator.url : '已上传的来源文件')
  return data.kind === 'verification' ? data.reason : data.content
}

export function graphReadScore(/* 协议中的离散核查评分：0、0.5 或 1。 */ score: 0 | 0.5 | 1): string {
  // 将核查评分映射为可信、不可信或不确定的显示标签。
  return score === 1 ? '可信' : score === 0 ? '不可信' : '不确定'
}

export function graphCanProcessNode(
  /* 待判断的真实节点，只读取其数据类型。 */ node: GraphNode,
  /* 用户选择的处理终点，限定新闻、事实或完整核查阶段。 */ until: GraphRun['until']
): boolean {
  // 按目标阶段判断来源、新闻或事实节点能否作为处理起点。
  return node.data.kind === 'source' || (node.data.kind === 'news' && until !== 'news') || (node.data.kind === 'claim' && until === 'verified')
}

export const GRAPH_OPERATION_LABELS: Record<GraphOperation['kind'], string> = { parse: '解析来源', split: '拆分事实', verify: '核查事实' }

export function graphReadOperationProgress(/* 服务端快照中的只读 Operation，提供状态、路由和已接纳报告。 */ operation: GraphOperation): string {
  // 将 Operation 状态、路由和当前版本报告数转换为面向用户的进度说明。
  if (operation.status === 'completed') return `${GRAPH_OPERATION_LABELS[operation.kind]}已完成`
  if (operation.status === 'failed') return `${GRAPH_OPERATION_LABELS[operation.kind]}未完成`
  if (operation.status === 'cancelled') return '已取消'
  if (operation.status === 'waiting') return operation.review?.kind === 'route' ? '等待确认处理角度' : '等待保存处理结果'
  if (operation.kind === 'parse') return '正在解析来源内容'
  const route = operation.route
  if (!route) return operation.kind === 'split' ? '正在规划拆分角度' : '正在规划核查角度'
  const reports = operation.kind === 'split' ? operation.splitReports : operation.reports
  const received = route.slots.filter(/* 当前路由中的槽位，用其身份统计本版本的报告。 */ slot =>
    /* 只统计当前路由版本中已收到报告的槽位。 */
    reports.some(/* 已接纳报告，需要与槽位身份及当前路由版本匹配。 */ report =>
      /* 匹配槽位标识和当前路由版本，排除旧路由报告。 */
      report.slotId === slot.id && report.routeRevision === route.revision)).length
  return received === route.slots.length ? '意见已收齐，等待汇总结果' : `已收集 ${received} / ${route.slots.length} 份意见`
}

export function graphReadRunProgress(/* 当前图的只读 Run；null 表示尚无运行。 */ run: GraphRun | null): string {
  // 汇总运行完成数、暂停或终止状态以及待审事项数，生成运行进度文案。
  if (!run) return '尚未开始处理'
  const completed = run.operations.filter(/* 运行中的 Operation，读取终态统计已完成数。 */ operation => /* 统计已完成的 Operation。 */ operation.status === 'completed').length
  const progress = `${completed} / ${run.operations.length} 项已完成`
  if (run.status === 'completed') return `处理已完成 · ${progress}`
  if (run.status === 'failed') return `处理未完成 · ${progress}`
  if (run.status === 'cancelled') return `处理已取消 · ${progress}`
  if (run.paused) return `已暂停 · ${progress}`
  if (run.operations.length === 1) return graphReadOperationProgress(run.operations[0])
  const pending = run.operations.filter(/* 运行中的 Operation，读取审核状态统计待审数。 */ operation => /* 统计仍有待处理审核的 Operation。 */ operation.review?.state === 'pending').length
  return `${progress}${pending ? ` · ${pending} 项待审核` : ''}`
}

export function graphReadCanvasLayout(
  /* 只读图快照投影，含真实节点、边与可选 Run；坐标只写入新建画布对象。 */ snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'> & { run?: GraphRun | null }
): CanvasLayout {
  // 将真实节点、运行分支和候选产物投影到阶段列，选择布局父节点并递归安排坐标，生成保留全部有效关系的画布连线。
  const order: CanvasKind[] = ['source', 'parseAgent', 'news', 'splitAgent', 'claim', 'verifyAgent', 'opinion', 'verification', 'evidence']
  const width = 204, height = 112, gap = 62, rowGap = 30, pad = 40
  const byId = new Map<string, CanvasNode>()
  // 阶段投影只属于本次布局；共享真实节点仍只保留一个画布位置，点击通过 selectId 回到原节点。
  const parents = new Map<string, Array<{ id: string; priority: number }>>()
  const links: Array<{ id: string; from: string; to: string; kind: string; displayFrom: string; displayTo: string }> = []
  const originals = [...snapshot.nodes].sort((/* 排序中的左侧真实节点，先比较创建时间再比较身份。 */ a, /* 排序中的右侧真实节点，用相同键稳定排序。 */ b) =>
    /* 按创建时间和标识稳定排序，使输入节点顺序变化不影响布局。 */
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  const actual = new Map(originals.map(/* 已排序的真实节点，按其身份建立只读索引。 */ node => /* 以真实节点标识建立索引，供投影恢复来源和已保存产物。 */ [node.id, node]))
  const operations = snapshot.run?.operations ?? []
  const graphHasInput = (/* 待验证关系的真实产物节点身份。 */ outputId: string, /* 该产物预期来自的真实输入节点身份。 */ inputId: string) =>
    /* 判断产物与输入之间是否存在可用于显示生成分支的真实关系。 */
    snapshot.edges.some(/* 图中的真实关系，用类型和两端身份判断是否为生成关联。 */ edge =>
      /* 匹配产物指向输入的派生边，或新闻指向事实的引用边。 */
      (edge.kind === 'derived-from' && edge.from === outputId && edge.to === inputId)
      || (edge.kind === 'mentions' && edge.from === inputId && edge.to === outputId))
  function graphCreateView(
    /* 本次布局内的投影身份；同一身份只建立一个画布节点。 */ id: string,
    /* 投影归属的真实只读节点，决定点击后的 selectId。 */ node: GraphNode,
    /* 画布阶段类型，决定列位置和显示样式。 */ kind: CanvasKind,
    /* 节点类型或 Agent 的展示名称。 */ label: string,
    /* 卡片正文或处理角度，不作为 HTML 解析。 */ text: string,
    /* 可选的状态文案，默认空字符串。 */ status = '',
    /* 可选的离散核查评分，省略表示此卡片不显示评分。 */ score?: 0 | 0.5 | 1
  ): CanvasNode {
    // 复用已有视图标识或建立画布节点，将合成投影的点击目标绑定到所属真实节点。
    const prior = byId.get(id)
    if (prior) return prior
    const item: CanvasNode = { id, node, kind, label, text, status, selectId: node.id, synthetic: id !== node.id, score, x: 0, y: 0, width, height }
    byId.set(id, item)
    return item
  }
  function graphAddParent(
    /* 待登记父关系的子画布身份。 */ child: string,
    /* 候选父画布身份，不得与子身份相同。 */ parent: string,
    /* 父关系排序优先级，值越小越优先；默认 1，明确生成者使用 0。 */ priority = 1
  ) {
    // 为子视图登记不重复的候选布局父节点及优先级，忽略自指关系。
    if (child === parent) return
    const list = parents.get(child) ?? []
    if (!list.some(/* 子视图已经登记的父候选，用身份去重。 */ item => /* 检查相同父节点是否已登记，避免重复候选。 */ item.id === parent)) list.push({ id: parent, priority })
    parents.set(child, list)
  }
  function graphAddBranch(
    /* 合成连线的起点画布身份，同时作为候选父节点。 */ from: string,
    /* 合成连线的终点画布身份，同时作为候选子节点。 */ to: string,
    /* 该分支作为布局父关系的优先级，默认 1。 */ priority = 1
  ) {
    // 添加不重复的合成分支连线，并将其起点登记为终点的候选布局父节点。
    const id = 'branch:' + from + '>' + to
    if (!links.some(/* 已经收集的连线，用合成分支身份避免重复添加。 */ link =>
      /* 检查同一对视图之间是否已存在合成分支。 */
      link.id === id)) links.push({ id, from, to, kind: 'branch', displayFrom: from, displayTo: to })
    graphAddParent(to, from, priority)
  }
  function graphCreateAgent(
    /* Agent 处理的真实输入节点，既是分支父节点也是点击目标。 */ owner: GraphNode,
    /* 解析、拆分或核查 Agent 的画布阶段类型。 */ kind: 'parseAgent' | 'splitAgent' | 'verifyAgent',
    /* 在该 Agent 阶段内稳定区分操作和槽位的键，用于合成投影身份。 */ key: string,
    /* Agent 的展示名称，来自冻结配置或已保存产物。 */ name: string,
    /* 该 Agent 的处理角度或任务说明，显示在投影正文中。 */ angle: string,
    /* 当前处理状态文案，供投影卡片展示。 */ status: string
  ) {
    // 创建解析、拆分或核查 Agent 的只读投影，并连接到它处理的真实输入节点。
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
  function graphCreateOpinions(
    /* 这些核查意见所属的真实事实节点。 */ owner: GraphNode,
    /* 操作或已保存结论身份，作为本组意见的投影命名空间。 */ key: string,
    /* 已接纳的只读核查报告集合，不修改原报告。 */ reports: import('../../../../contracts/graph').GraphReport[],
    /* 可选的已保存结论身份；提供时意见点击选择该结论，省略时仍选择原事实。 */ resultId?: string
  ) {
    // 将核查报告展开为 Agent 和意见分支，绑定点击目标，并记录已保存结论的意见来源。
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
    const relation = snapshot.edges.find(/* 当前图中的真实关系，用于查找结论核查的事实。 */ edge => /* 查找当前核查结论指向被核查事实的关系。 */ edge.kind === 'verifies' && edge.from === node.id)
    const owner = relation ? actual.get(relation.to) : undefined
    if (!owner) continue
    const operation = operations.find(/* 当前运行中的 Operation，用结果节点身份追溯结论归属。 */ operation => /* 查找生成该已保存结论的当前运行 Operation。 */ operation.resultNodeId === node.id)
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
      if (operation.status !== 'completed' && operation.contentDraft?.kind === 'parse') operation.contentDraft.news.forEach((
        /* 解析草稿中尚未保存的一条新闻候选，只读取其正文。 */ news,
        /* 新闻候选在本次草稿中的零基序号，用于稳定投影身份。 */ index
      ) => {
        // 将尚未保存的解析新闻草稿显示为 Agent 下的候选新闻分支。
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
      const report = operation.kind === 'split' ? operation.splitReports.find(/* 拆分阶段已接纳报告，用槽位身份匹配当前角度。 */ report =>
        /* 查找当前拆分槽位已经提交的报告。 */
        report.slotId === slot.id) : operation.reports.find(/* 核查阶段已接纳报告，用槽位身份匹配当前角度。 */ report =>
        /* 查找当前核查槽位已经提交的报告。 */
        report.slotId === slot.id)
      const agent = graphCreateAgent(owner, kind, operation.id + ':' + slot.id,
        configuration?.agents.find(/* 运行冻结配置中的 Agent，用槽位配置身份查找名称。 */ agent => /* 从运行时配置中取得当前槽位的 Agent 名称。 */ agent.id === slot.agentId)?.name ?? report?.agentName ?? slot.angle,
        slot.angle + (slot.hint ? '\n' + slot.hint : ''), report ? '已提交' : paused ? '已暂停' : operation.route.approved ? '等待提交结果' : '等待确认路由')
      if (operation.kind === 'split') {
        const splitReport = operation.splitReports.find(/* 拆分阶段的报告，用槽位身份取得对应候选集合。 */ report => /* 取出当前拆分槽位的报告，以展开其中的候选事实。 */ report.slotId === slot.id)
        splitReport?.claims.forEach((/* 拆分报告中的只读事实候选，保存前显示为合成投影。 */ claim, /* 事实候选在该报告中的零基序号，连接汇总选择与已保存产物。 */ index) => {
          // 将已保存事实挂到生成它的 Agent，或为未保存事实创建带采用状态的候选投影。
          const saved = operation.outputRefs.find(/* Operation 的产物引用，用报告身份和项索引查找已保存事实。 */ ref =>
            /* 匹配报告中的这一项事实，并确认对应产物仍是图中的真实节点。 */
            ref.reportId === splitReport.id && ref.index === index && actual.has(ref.id))
          if (saved) {
            if (graphHasInput(saved.id, owner.id)) { producerParents.set(saved.id, agent); graphAddParent(saved.id, agent, 0) }
            return
          }
          const selected = operation.contentDraft?.kind === 'split' ? operation.contentDraft.selected.some(/* 拆分汇总的选择项，用报告身份和项索引判断候选是否采用。 */ item =>
            /* 判断这项候选事实是否已被汇总草稿选中。 */
            item.reportId === splitReport.id && item.index === index) : null
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

  for (const edge of [...snapshot.edges].sort((
    /* 真实关系排序中的左侧边，仅按身份比较。 */ a,
    /* 真实关系排序中的右侧边，作为稳定排序比较对象。 */ b
  ) => /* 按边标识稳定排列真实关系，使父节点选择和并行连线偏移可重复。 */ a.id.localeCompare(b.id))) {
    if (!actual.has(edge.from) || !actual.has(edge.to)) continue
    let from = edge.from, to = edge.to
    if (edge.kind === 'derived-from' || edge.kind === 'verifies') { from = edge.to; to = edge.from }
    if (edge.kind === 'verifies') {
      const incoming = resultParents.get(to) ?? []
      if (incoming.length) { from = incoming[0]; incoming.slice(1).forEach(/* 首个之外的意见投影身份，需要补充到结论的汇入连线。 */ parent => /* 为结论补充其余意见来源的汇入分支。 */ graphAddBranch(parent, to)) }
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
  const kinds = order.filter(/* 预定义阶段顺序中的一个类型，仅保留实际存在的阶段。 */ kind =>
    /* 仅为存在画布节点的处理阶段建立列。 */
    [...byId.values()].some(/* 本次构造的画布节点，用其阶段类型判断列是否存在。 */ node =>
      /* 检测当前处理阶段是否至少有一个画布节点。 */
      node.kind === kind))
  const columns = kinds.map((/* 已经确认非空的阶段类型，作为新列的类别。 */ kind, /* 非空阶段列的零基位置，用于计算横坐标。 */ index) =>
    /* 按阶段顺序计算列横坐标，并统计该列的画布节点数。 */
    ({ kind, x: pad + index * (width + gap), count: [...byId.values()].filter(/* 本次构造的画布节点，用阶段类型统计该列数量。 */ node =>
      /* 筛选属于当前阶段列的画布节点以统计数量。 */
      node.kind === kind).length }))
  for (const node of byId.values()) node.x = columns.find(/* 已经计算的阶段列，只读取类型和横坐标。 */ column => /* 查找节点所属阶段的列坐标。 */ column.kind === node.kind)!.x
  for (const [child, candidates] of parents) {
    const node = byId.get(child)
    if (!node) continue
    // 父子横坐标严格递增可保证布局树无环；共享节点只选一个布局父节点，全部真实关系仍保留在 links 中。
    const valid = candidates.filter(/* 子节点的一个父候选，仅接受已存在且严格位于左侧的画布节点。 */ parent => /* 仅允许已存在且位于左侧阶段的节点作为布局父节点。 */ byId.has(parent.id) && byId.get(parent.id)!.x < node.x)
      .sort((
        /* 父候选排序中的左项，先比较优先级再比较身份。 */ a,
        /* 父候选排序中的右项，用相同规则确保选择稳定。 */ b
      ) => /* 先按来源优先级、再按标识选择稳定的布局父节点。 */ a.priority - b.priority || a.id.localeCompare(b.id))
    node.parentId = valid[0]?.id
  }
  const children = new Map<string, CanvasNode[]>()
  for (const node of byId.values()) if (node.parentId) children.set(node.parentId, [...(children.get(node.parentId) ?? []), node])
  const compare = (
    /* 树根或兄弟节点排序中的左项，只读取横坐标和身份。 */ a: CanvasNode,
    /* 树根或兄弟节点排序中的右项，用阶段位置和身份比较。 */ b: CanvasNode
  ) => /* 按阶段横坐标和标识稳定排列树根及同一父节点下的分支。 */ a.x - b.x || a.id.localeCompare(b.id)
  for (const list of children.values()) list.sort(compare)
  function graphPlaceTree(
    /* 本次布局拥有的可变画布节点，递归过程会写入它及后继的纵坐标。 */ node: CanvasNode,
    /* 为该子树保留的起始行号，可含根间距小数；返回值为下一可用行。 */ start: number
  ): number {
    // 递归为子树分配连续行，叶节点占一行，父节点居中于子树行区间，并返回下一空行。
    const descendants = children.get(node.id) ?? []
    if (!descendants.length) { node.y = 96 + start * (height + rowGap); return start + 1 }
    let end = start
    for (const child of descendants) end = graphPlaceTree(child, end)
    node.y = 96 + (start + end - 1) / 2 * (height + rowGap)
    return end
  }
  let row = 0
  const roots = [...byId.values()].filter(/* 本次构造的画布节点，通过缺少父身份识别独立根。 */ node => /* 选出没有布局父节点的根视图，分别安排独立子树。 */ !node.parentId).sort(compare)
  for (const root of roots) row = graphPlaceTree(root, row) + 0.6
  // 树布局完成后，将汇总结论移到所有意见来源的纵向中点，呈现多分支汇入。
  for (const [id, ids] of resultParents) {
    const node = byId.get(id), incoming = ids.map(/* 汇总结论记录的意见来源画布身份。 */ id =>
      /* 取得汇总结论各意见来源的画布节点。 */
      byId.get(id)).filter((/* 通过索引取得的意见节点，可能缺失；类型守卫排除空值。 */ node): node is CanvasNode =>
      /* 排除已不在画布中的意见来源。 */
      !!node)
    if (node && incoming.length) node.y = (Math.min(...incoming.map(/* 已存在的意见来源节点，读取纵坐标求汇入范围上界。 */ node =>
      /* 提取意见纵坐标以确定汇入分支的上边界。 */
      node.y)) + Math.max(...incoming.map(/* 已存在的意见来源节点，读取纵坐标求汇入范围下界。 */ node =>
      /* 提取意见纵坐标以确定汇入分支的下边界。 */
      node.y))) / 2
  }
  const nodes = [...byId.values()].sort((
    /* 最终节点排序中的左项，按列、纵坐标和身份比较。 */ a,
    /* 最终节点排序中的右项，用相同顺序稳定输出。 */ b
  ) => /* 按列、行和标识稳定排列最终画布节点。 */ a.x - b.x || a.y - b.y || a.id.localeCompare(b.id))
  // 共享后继只放置一次，其余输入关系以跨分支连线呈现。
  const edges: CanvasEdge[] = links.map(/* 已收集的真实或合成关系，显示端点指向本次布局的画布节点。 */ link => {
    // 根据显示端点生成贝塞尔连线，偏移同端点的并行关系，并标记非树分支。
    const from = byId.get(link.displayFrom)!, to = byId.get(link.displayTo)!
    const forward = to.x > from.x, same = to.x === from.x
    const x1 = from.x + (forward || same ? width : 0), x2 = to.x + (forward ? 0 : width)
    const peers = links.filter(/* 候选连线，按显示起终点判断是否与当前边并行。 */ item => /* 收集与当前边使用相同显示端点的并行连线。 */ item.displayFrom === link.displayFrom && item.displayTo === link.displayTo)
    const offset = (peers.findIndex(/* 同端点连线集合中的一项，用当前边身份找到偏移序号。 */ item => /* 取得当前边在并行连线中的序号，用于计算对称偏移。 */ item.id === link.id) - (peers.length - 1) / 2) * 6
    const y1 = from.y + height / 2 + offset, y2 = to.y + height / 2 + offset
    const bend = Math.max(36, Math.abs(x2 - x1) / 2)
    return { ...link, cross: (to.parentId !== from.id && to.kind !== 'verification') || link.kind === 'related-to',
      path: `M ${x1} ${y1} C ${same ? x1 + 45 : x1 + (forward ? bend : -bend)} ${y1}, ${same ? x2 + 45 : x2 + (forward ? -bend : bend)} ${y2}, ${x2} ${y2}` }
  })
  return { nodes, edges, columns, width: Math.max(520, ...nodes.map(/* 已完成布局的画布节点，读取右边界计算画布宽度。 */ node => /* 计算节点右边界及留白，用于确定画布总宽度。 */ node.x + node.width + pad)),
    height: Math.max(330, ...nodes.map(/* 已完成布局的画布节点，读取下边界计算画布高度。 */ node => /* 计算节点下边界及留白，用于确定画布总高度。 */ node.y + node.height + pad)) }
}

export function graphReadCanvasNeighbor(
  /* 已完成的只读画布布局，包含键盘导航使用的坐标。 */ layout: CanvasLayout,
  /* 当前键盘焦点的画布身份，找不到时返回 null。 */ id: string,
  /* 用户按下的四向箭头键，决定候选筛选方向。 */ direction: 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown'
): string | null {
  // 按方向寻找画布邻居，优先沿移动轴靠近且横向偏离较小的节点，供方向键导航。
  const current = layout.nodes.find(/* 布局中的候选节点，用当前焦点身份查找起点。 */ node => /* 定位当前键盘导航所在的画布节点。 */ node.id === id)
  if (!current) return null
  const horizontal = direction === 'ArrowLeft' || direction === 'ArrowRight'
  const sign = direction === 'ArrowLeft' || direction === 'ArrowUp' ? -1 : 1
  const candidates = layout.nodes.filter(/* 布局中的节点，首先排除当前焦点本身。 */ node => /* 排除当前节点自身，避免导航停留在原处。 */ node !== current).map(/* 其余画布节点，只读取坐标计算方向距离和横向偏离。 */ node => {
    // 计算候选节点沿移动方向的距离，并对横向偏离加倍计入导航代价。
    const along = (horizontal ? node.x - current.x : node.y - current.y) * sign
    const across = Math.abs(horizontal ? node.y - current.y : node.x - current.x)
    return { id: node.id, along, distance: along + across * 2 }
  }).filter(/* 已计算方向距离的候选，along 为正才位于导航前方。 */ node =>
    /* 仅保留位于指定移动方向前方的候选节点。 */
    node.along > 0).sort((/* 导航候选排序中的左项，先比较移动代价再比较身份。 */ a, /* 导航候选排序中的右项，用相同规则打破距离相同的情况。 */ b) =>
    /* 先选导航代价最小的节点，代价相同则按标识稳定选择。 */
    a.distance - b.distance || a.id.localeCompare(b.id))
  return candidates[0]?.id ?? null
}
