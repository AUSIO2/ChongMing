// 通用数据图展示投影：名称来自精确定义，层级来自真实 successor 关系。
import type { DefinitionCatalog, TransitionDefinition } from '../../../../contracts/data-definition'
import type { GraphNode } from '../../../../contracts/graph'
import type { GraphOperation, GraphRun, GraphRunStep } from '../../../../contracts/graph-run'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import { definitionKey, payloadFindType, payloadReadNodeText as payloadText } from './data-payload'
import { uiReadStage } from '../../presentation/ui-labels'

export type CanvasKind = string
export interface CanvasNode {
  id: string
  node: GraphNode
  kind: CanvasKind
  columnKey: string
  label: string
  text: string
  status: string
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
 * @param nodes 入口保存节点种子；空选择不产生可配置转换。
 * @param catalog 工作区已发布定义目录。
 */
export function graphReadAvailableTransitions(
  /* 入口明确选择的保存节点，仅作为某一个输入端口的初始化种子。 */ nodes: GraphNode[],
  /* 当前工作区真实发布的精确转换目录。 */ catalog?: DefinitionCatalog | null,
): TransitionDefinition[] {
  // 入口只要求节点能共同匹配一个输入，缺少其它端口、上下文或数量仍可打开统一表单配置。
  if (!nodes.length || !catalog) return []
  return catalog.transitions.filter((/* 当前已发布的一份精确转换。 */ transition) =>
    /* 所有种子须共同匹配同一个结构输入，不把上下文或多个输入类型拼成虚假初始绑定。 */ transition.ports.input.some(
      (/* 该转换允许的一项结构输入。 */ port) => /* 完整数量与其它端口留最终builder核对。 */ nodes.every(
        (/* 本入口明确选中的保存节点。 */ node) => /* 身份与版本同时符合该输入端口。 */ node.typeId === port.inputType.id && node.typeVersion === port.inputType.version,
      ),
    ))
}

/**
 * @param transition 要实例化的精确转换。
 * @param nodeIds 已验证的输入节点身份。
 */
export function graphCreateRunPlan(
  /* 界面已筛选为恰好一个输入端口的精确转换。 */ transition: TransitionDefinition,
  /* 用户确认的输入节点身份，复制后写入本次计划。 */ nodeIds: string[],
): { steps: [GraphRunStep] } {
  // 为已选转换构造恰好一个步骤，不产生没有执行含义的空计划。
  const input = transition.ports.input[0]
  const grouped = transition.cardinality === 'N:1' || transition.cardinality === 'N:M'
  return { steps: [{
    id: `step-${crypto.randomUUID()}`,
    transitionRef: { id: transition.id, version: transition.version },
    dependsOn: [],
    input: [{ port: input.name, source: { kind: 'scope', nodeIds: [...nodeIds] } }],
    context: transition.ports.context.map((/* 转换允许的一个可选上下文端口。 */ port) =>
      /* 空绑定保留端口声明，选材不会混入本图节点范围。 */
      ({ port: port.name, source: { kind: 'scope', nodeIds: [] } })),
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
  return expected > 1 ? `${uiReadStage(current.stageId)} · ${accepted} / ${expected} 项完成` : `正在执行 ${uiReadStage(current.stageId)}`
}

/**
 * @param run 当前图的 Run。
 */
export function graphReadRunProgress(/* 当前选中的完整运行或没有运行。 */ run: GraphRun | null): string {
  // 多步骤摘要使用保存步骤状态，已实例化处理项不能冒充整个DAG的分母。
  if (!run) return '尚未开始处理'
  const completed = run.operations.filter((/* 本Run实际保存的一项处理。 */ operation) => /* 已完成或跳过的处理项已经结束。 */ operation.status === 'completed' || operation.status === 'skipped').length
  const states = run.plan.steps.map((/* 保存计划的一项步骤。 */ step) => /* 只取同一稳定身份的权威状态。 */ run.steps.find((/* 已保存状态。 */ state) => /* 缺失状态不会被计为完成。 */ state.stepId === step.id))
  const completedSteps = states.filter((/* 当前计划对应的状态或缺记录。 */ state) => /* 只统计真实完成，不把跳过伪装成功。 */ state?.status === 'completed').length
  const skippedSteps = states.filter((/* 当前计划对应的状态或缺记录。 */ state) => /* 跳过单独显示。 */ state?.status === 'skipped').length
  const progress = run.plan.steps.length > 1
    ? `${completedSteps} / ${run.plan.steps.length} 步骤已完成 · 跳过 ${skippedSteps} · 已实例化 ${completed} / ${run.operations.length} 项已完成`
    : `${completed} / ${run.operations.length} 项已完成`
  if (run.status === 'completed') return `处理已完成 · ${progress}`
  if (run.status === 'failed') return `处理未完成 · ${progress}`
  if (run.status === 'cancelled') return `处理已取消 · ${progress}`
  if (run.paused) return `已暂停 · ${progress}`
  if (run.plan.steps.length <= 1 && run.operations.length === 1) return graphReadOperationProgress(run.operations[0])
  const pending = run.operations.filter((/* 本Run保存的一项处理。 */ operation) => /* 复用记录中的旧审核不算当前等待。 */ operation.status === 'waiting' && !operation.reusedFromOperationId && operation.review?.state === 'pending').length
  return `${progress}${pending ? ` · ${pending} 项待审核` : ''}`
}

function graphReadDepths(
  /* 已按创建时间排序的本图节点，本函数为每个节点建立独占层级状态。 */ nodes: GraphNode[],
  /* 待布局的真实关系；未载入端点不参与层级计算。 */ snapshot: Pick<GraphSnapshot, 'edges'>,
): Array<{ node: GraphNode; depth: number }> {
  // 端点只在建立关系时解析一次，后续松弛直接修改完整节点状态。
  const states = nodes.map((/* 本次布局中的真实节点。 */ node) =>
    /* 每个节点明确从基础层开始计算。 */ ({ node, depth: 0 }))
  const byId = new Map(states.map((/* 已初始化的节点层级状态。 */ state) =>
    /* 按图内身份解析真实关系端点。 */ [state.node.id, state]))
  const edges = snapshot.edges.flatMap((/* 可能参与层级的真实关系。 */ edge) => {
    // 引用不扩张层级；只保留两个端点都已经载入的后继。
    if (edge.kind !== 'successor') return []
    const from = byId.get(edge.from), to = byId.get(edge.to)
    return from && to ? [{ from, to }] : []
  })
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false
    for (const edge of edges) {
      const next = Math.min(nodes.length, edge.from.depth + 1)
      if (next > edge.to.depth) {
        edge.to.depth = next
        changed = true
      }
    }
    if (!changed) break
  }
  return states
}

/**
 * @param snapshot 图快照；运行定义用于保证历史类型仍有稳定名称。
 * @param catalog 工作区当前定义目录；运行冻结目录优先补齐历史精确版本。
 */
export function graphReadCanvasLayout(
  /* 当前图的节点、关系及可选历史运行，用于完整投影现有业务事实。 */ snapshot: Pick<GraphSnapshot, 'nodes' | 'edges'> & { runs?: GraphRun[] },
  /* 当前精确版本目录；历史运行仅补齐目录中没有的旧版本。 */ catalog?: DefinitionCatalog | null,
): CanvasLayout {
  // 按后继层级和精确类型建立列，再安排节点和真实连线，不改写原图。
  const width = 204, height = 112, gap = 62, rowGap = 30, pad = 40
  const frozen = snapshot.runs?.[snapshot.runs.length - 1]?.definitions
  const frozenTypes = snapshot.runs?.flatMap((/* 图中已冻结的历史或当前运行。 */ run) =>
    /* 汇总运行保留的精确类型定义。 */ run.definitions.dataTypes) ?? []
  const combinedCatalog: DefinitionCatalog | null = frozen ? {
    ...frozen,
    dataTypes: [...new Map([...frozenTypes, ...(catalog?.dataTypes ?? [])].map((/* 当前或冻结的精确类型版本。 */ type) =>
      /* 同版本由当前工作区目录覆盖，历史版本仍保留。 */ [definitionKey(type), type])).values()],
  } : catalog ?? null
  const originals = [...snapshot.nodes].sort((/* 左侧图节点。 */ a, /* 右侧图节点。 */ b) =>
    /* 创建时间相同时按稳定身份决定初始顺序。 */ a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  if (!originals.length) return { nodes: [], edges: [], columns: [], width: 520, height: 330 }
  const depths = graphReadDepths(originals, snapshot)
  const columnMeta = new Map<string, { key: string; kind: string; label: string; depth: number; count: number; x: number }>()
  const placements = depths.map((/* 已经完成层级计算的节点状态。 */ { node, depth }) => {
    // 节点直接持有所属列，后续读取列坐标无需再次查找或补默认值。
    const kind = definitionKey({ id: node.typeId, version: node.typeVersion })
    const key = `${depth}:${kind}`
    const prior = columnMeta.get(key)
    const column = prior ?? { key, kind, label: graphReadNodeType(node, combinedCatalog), depth, count: 1, x: 0 }
    if (prior) prior.count++
    else columnMeta.set(key, column)
    return { node, kind, column }
  })
  const columns = [...columnMeta.values()].sort((/* 左侧列。 */ a, /* 右侧列。 */ b) =>
    /* 先按前驱到后继层级，再按标签和类型稳定排序。 */ a.depth - b.depth || a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind))
  columns.forEach((/* 待定位的列。 */ column, /* 列的横向顺序。 */ index) => {
    // 根据确定顺序分配列横坐标。
    column.x = pad + index * (width + gap)
  })
  const operations = snapshot.runs?.flatMap((/* 当前图中的运行。 */ run) => /* 同次布局只展开一次冻结步骤集合。 */ run.operations)
  const nodes: CanvasNode[] = placements.map((/* 节点及其已确认的类型列。 */ { node, kind, column }) => {
    // 将同一列引用中的坐标写入节点展示项，业务内容仍来自原节点。
    const operation = operations?.find((/* 一个可能消费当前节点的步骤。 */ item) =>
        /* 仅关联仍执行或等待审核的输入步骤。 */
        item.group.inputRefs.some((/* 该步骤冻结的输入引用。 */ ref) =>
          /* 按节点身份关联活动步骤。 */ ref.id === node.id)
        && ['running', 'waiting'].includes(item.status))
    return {
      id: node.id, node, kind, columnKey: column.key, label: graphReadNodeType(node, combinedCatalog), text: graphReadNodeText(node, combinedCatalog),
      status: operation ? graphReadOperationProgress(operation) : node.validity === 'stale' ? '需要重新处理' : '',
      x: column.x,
      y: 0, width, height,
    }
  })
  const byId = new Map(nodes.map((/* 已建立的画布节点。 */ node) => /* 为真实连线及可选父节点建立索引。 */ [node.id, node]))
  const incoming = new Map<string, CanvasNode>()
  for (const edge of snapshot.edges.filter((/* 图中已提交的关系。 */ edge) =>
    /* 只有真实后继决定主父节点。 */ edge.kind === 'successor').sort((/* 左侧后继边。 */ a, /* 右侧后继边。 */ b) =>
    /* 多个前驱按关系身份固定主父节点。 */ a.id.localeCompare(b.id))) {
    const parent = byId.get(edge.from), child = byId.get(edge.to)
    if (!parent || !child || incoming.has(child.id)) continue
    incoming.set(child.id, parent)
    child.parentId = parent.id
  }
  const rows = nodes.map((/* 已建立的节点展示项。 */ node) =>
    /* 缺少父对象只表示真实根节点，已有父对象直接携带其行位置。 */ ({ node, parent: incoming.get(node.id) }))
  for (const column of columns) {
    const list = rows.filter((/* 节点及其真实可选前驱。 */ item) => /* 只排列当前列的成员。 */ item.node.columnKey === column.key)
      .sort((/* 左侧节点。 */ a, /* 右侧节点。 */ b) => {
        // 有父节点时按其行位置聚拢，没有前驱的根节点共享基础排序位置。
        const ay = a.parent ? a.parent.y : 0
        const by = b.parent ? b.parent.y : 0
        return ay - by || a.node.id.localeCompare(b.node.id)
      })
    list.forEach((/* 当前列的节点与前驱状态。 */ { node }, /* 当前列内的行顺序。 */ index) => {
      // 保留每列固定行高及间隔。
      node.y = 96 + index * (height + rowGap)
    })
  }
  const edges: CanvasEdge[] = [...snapshot.edges].sort((/* 左侧真实关系。 */ a, /* 右侧真实关系。 */ b) =>
    /* 固定连线输出次序。 */ a.id.localeCompare(b.id)).flatMap((/* 当前需要投影的关系。 */ edge) => {
    // 只为两个端点都已载入的关系计算曲线。
    const from = byId.get(edge.from), to = byId.get(edge.to)
    if (!from || !to) return []
    const forward = to.x > from.x
    const x1 = from.x + (forward || to.x === from.x ? width : 0), x2 = to.x + (forward ? 0 : width)
    const y1 = from.y + height / 2, y2 = to.y + height / 2
    const bend = Math.max(36, Math.abs(x2 - x1) / 2)
    return [{ ...edge, cross: edge.kind === 'reference' || to.parentId !== from.id,
      path: `M ${x1} ${y1} C ${x1 + (forward ? bend : -bend)} ${y1}, ${x2 + (forward ? -bend : bend)} ${y2}, ${x2} ${y2}` }]
  })
  return {
    nodes: nodes.sort((/* 左侧画布节点。 */ a, /* 右侧画布节点。 */ b) =>
      /* 按最终横纵坐标固定展示与键盘顺序。 */ a.x - b.x || a.y - b.y || a.id.localeCompare(b.id)), edges,
    columns: columns.map((/* 已完成定位与计数的类型列。 */ { key, kind, label, x, count }) =>
      /* 不向界面暴露计算用的层级状态。 */ ({ key, kind, label, x, count })),
    width: Math.max(520, ...nodes.map((/* 已定位的节点。 */ node) => /* 包含节点宽度及右内边距。 */ node.x + node.width + pad)),
    height: Math.max(330, ...nodes.map((/* 已定位的节点。 */ node) => /* 包含节点高度及下内边距。 */ node.y + node.height + pad)),
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
