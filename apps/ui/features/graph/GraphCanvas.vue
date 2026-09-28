<!-- 图画布：绘制阶段树，显示执行状态，支持节点选择、分支聚焦与键盘导航。 -->
<script setup lang="ts">
import { ACTIVITY_LABELS, type GraphActivity } from '../../../../contracts/activity'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { GraphSnapshot } from '../../../../contracts/graph'
import { useCanvasPanZoom } from '../../composables/useCanvasPanZoom'
import { CANVAS_KIND_LABELS, type CanvasNode, graphReadCanvasLayout, graphReadCanvasNeighbor, graphReadOperationProgress, graphReadScore } from './graph-layout'

const props = defineProps<{ snapshot: GraphSnapshot; activities?: GraphActivity[]; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string | null] }>()
const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const layout = computed(() => /* 根据当前快照计算阶段树节点坐标和连线路径。 */ graphReadCanvasLayout(props.snapshot))
const contentWidth = computed(() => /* 提供布局宽度供缩放与适应视图计算。 */ layout.value.width)
const contentHeight = computed(() => /* 提供布局高度供缩放与适应视图计算。 */ layout.value.height)
const markerId = `arrow-${crypto.randomUUID()}`
const { svgStyle, scalePercent, zoomIn, zoomOut, resetView, fitToView, fitLayoutRect, focusLayoutRect, onPointerDown, onPointerMove, onPointerUp } = useCanvasPanZoom({ containerRef, svgRef, contentWidth, contentHeight })

const focusedId = ref<string | null>(null)
const focused = computed(() =>
  /* 从画布节点中查找当前键盘或鼠标焦点。 */
  layout.value.nodes.find(/* 当前布局中的只读节点，按画布身份匹配焦点。 */ node =>
    /* 匹配当前聚焦的画布节点标识。 */
    node.id === focusedId.value))
const projected = computed(() => /* 仅为合成的阶段投影提供分支详情内容。 */ focused.value?.synthetic ? focused.value : null)
const stages = [{ label: '解析', input: 'source', kinds: ['source', 'parseAgent', 'news'] },
  { label: '拆分', input: 'news', kinds: ['news', 'splitAgent', 'claim'] },
  { label: '核查', input: 'claim', kinds: ['claim', 'verifyAgent', 'opinion', 'verification'] }]
function canvasSelect(/* 被点击或键盘选中的画布投影；null 表示清空选择，selectId 对应真实节点。 */ item: CanvasNode | null) {
  // 更新画布焦点，并向父组件发送对应真实节点的选择。
  focusedId.value = item?.id ?? null; emit('select', item?.selectId ?? null)
}
function canvasFocusStage(/* 工具栏提供的阶段定义，包含输入类型和允许聚焦的后继类型。 */ stage: typeof stages[number]) {
  // 选取指定处理阶段的根分支，计算包含后继的边界并缩放至可见区域。
  const nodes = layout.value.nodes
  const root = nodes.find(/* 布局候选节点，用所选真实身份及阶段输入类型筛选。 */ node => /* 优先使用当前所选且类型符合阶段输入的节点。 */ node.id === props.selectedId && node.kind === stage.input)
    ?? nodes.find(/* 布局候选节点，用阶段类型和非合成标记选择后备根。 */ node => /* 在没有合适选择时寻找该阶段的真实输入节点。 */ node.kind === stage.input && !node.synthetic)
  if (!root) return
  const ids = new Set([root.id])
  for (const node of nodes) if (node.parentId && ids.has(node.parentId) && stage.kinds.includes(node.kind)) ids.add(node.id)
  const branch = nodes.filter(/* 布局节点，只保留已纳入当前阶段分支的身份。 */ node => /* 筛选属于此次阶段分支的节点。 */ ids.has(node.id))
  const left = Math.min(...branch.map(/* 当前分支节点，读取其布局左边界。 */ node =>
    /* 提取分支节点左边界以确定整体横向范围。 */
    node.x)) - 12, top = Math.min(...branch.map(/* 当前分支节点，读取其布局上边界。 */ node =>
    /* 提取分支节点上边界以确定整体纵向范围。 */
    node.y)) - 30
  fitLayoutRect(left, top, Math.max(...branch.map(/* 当前分支节点，用横坐标和宽度计算右边界。 */ node => /* 计算分支节点右边界以确定聚焦区域宽度。 */ node.x + node.width)) - left + 12,
    Math.max(...branch.map(/* 当前分支节点，用纵坐标和高度计算下边界。 */ node => /* 计算分支节点下边界以确定聚焦区域高度。 */ node.y + node.height)) - top + 20)
}
async function canvasResetMap() {
  // 切图或首次出现节点时重置缩放，并把当前选择或第一个根节点移入视野。
  focusedId.value = props.selectedId
  await nextTick()
  resetView()
  const first = layout.value.nodes.find(/* 布局中的节点，用于寻找当前真实选择对应的投影。 */ node =>
    /* 查找当前选择对应的画布节点。 */
    node.id === props.selectedId) ?? layout.value.nodes.find(/* 布局中的节点，用无父节点标记寻找后备根。 */ node =>
    /* 没有选择时寻找首个布局根节点。 */
    !node.parentId)
  if (first) focusLayoutRect(first.x, first.y, first.width, first.height)
}
watch(() => /* 观察图标识变化以触发画布复位。 */ props.snapshot.mapId, canvasResetMap)
watch(() => /* 观察图节点数以识别从空图到有内容的变化。 */ props.snapshot.nodes.length, (
  /* Vue 提供的新节点数量，用于识别空图首次出现内容。 */ count,
  /* 上次观测的节点数量，用于只在从空到有的变化时重置视图。 */ previous
) => {
  // 首次出现节点时重新定位画布。
  if (!previous && count) void canvasResetMap()
})
watch(() => /* 观察父组件的真实节点选择变化。 */ props.selectedId, async /* 父组件的新真实节点选择，null 表示取消选择。 */ id => {
  // 同步画布焦点，并在 DOM 更新后将相应节点移入可见区域。
  if (focused.value?.selectId !== id) focusedId.value = id
  await nextTick()
  if (focused.value) focusLayoutRect(focused.value.x, focused.value.y, focused.value.width, focused.value.height)
})
onMounted(canvasResetMap)

function canvasReadStatus(/* 要生成状态文案的画布节点，可能是合成分支或真实数据节点。 */ item: CanvasNode): string {
  // 优先显示当前活动，其次展示合成分支、运行状态或节点关联摘要。
  const activity = props.activities?.find(/* 会话提供的只读活动摘要，用运行、节点和执行者身份匹配当前卡片。 */ activity =>
    /* 匹配当前运行、真实节点和合成 Agent 分支对应的活动。 */
    activity.runId === props.snapshot.run?.id && activity.nodeId === item.selectId
    && (!item.synthetic || item.id === 'view:' + item.kind + ':' + activity.operationId + ':' + (activity.actor.role === 'worker' ? activity.actor.slotId : activity.actor.role === 'router' ? 'route' : activity.actor.role)))
  if (activity && !props.snapshot.run?.paused) return ACTIVITY_LABELS[activity.status]
  if (item.synthetic) return item.status
  const id = item.id, node = item.node
  if (node.validity === 'stale') return '需要复核'
  const operation = props.snapshot.run?.operations.find(/* 当前运行中的只读 Operation，用目标节点身份匹配。 */ operation => /* 查找以当前真实节点为目标的 Operation。 */ operation.targetId === id)
  if (operation) return `${props.snapshot.run!.paused && ['running', 'waiting'].includes(operation.status) ? '已暂停 · ' : ''}${graphReadOperationProgress(operation)}`
  if (node.data.kind === 'verification') return `${node.data.opinions.length} 个角度的意见`
  if (node.data.kind === 'claim') {
    const sources = props.snapshot.edges.filter(/* 图中的真实关系，筛选指向当前事实的新闻引用。 */ edge => /* 统计指向当前事实的新闻引用关系。 */ edge.kind === 'mentions' && edge.to === id).length
    return sources ? `${sources} 篇关联新闻` : '可独立核查的事实'
  }
  return node.data.kind === 'news' ? '保留正文与上下文' : '可供事实引用'
}
function canvasSelectKeyboard(
  /* SVG 节点派发的键盘事件，识别确认、取消和方向键并阻止默认导航。 */ event: KeyboardEvent,
  /* 接收键盘事件的画布节点身份，作为导航起点。 */ id: string
): void {
  // 处理选择、取消与方向键导航，并同步 SVG 节点焦点。
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); canvasSelect(layout.value.nodes.find(/* 布局中的候选节点，用当前键盘起点身份匹配。 */ node =>
    /* 查找键盘确认操作对应的画布节点。 */
    node.id === id) ?? null); return }
  if (event.key === 'Escape') { event.preventDefault(); canvasSelect(null); return }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const next = graphReadCanvasNeighbor(layout.value, id, event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown')
  if (next) {
    canvasSelect(layout.value.nodes.find(/* 布局中的候选节点，用方向导航算出的目标身份匹配。 */ node => /* 查找方向导航选出的下一个画布节点。 */ node.id === next) ?? null)
    const element = svgRef.value?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(next)}"]`)
    element?.focus()
  }
}
</script>

<template>
  <!-- 先展示工具栏，再绘制真实节点和合成阶段投影；详情面板显示当前分支内容。 -->
  <section ref="containerRef" class="graph-canvas" aria-label="事实关系图"
    @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
    <div class="graph-toolbar zoom-controls" @pointerdown.stop>
      <div class="graph-caption"><strong>阶段树</strong><span>{{ snapshot.nodes.length }} 个节点 · {{ snapshot.edges.length }} 条关联</span></div>
      <div class="zoom-buttons"><button v-for="stage in stages" :key="stage.label" type="button" :disabled="!layout.nodes.some(/* 当前布局节点，用阶段输入类型检查工具栏入口是否可用。 */ node => /* 判断当前图是否包含该阶段的输入节点。 */ node.kind === stage.input)" @click="canvasFocusStage(stage)">{{ stage.label }}</button>
        <button type="button" aria-label="缩小图画布" title="缩小" @click="zoomOut">−</button>
        <button type="button" aria-label="重置缩放" title="重置为 100%" @click="resetView">{{ scalePercent }}</button>
        <button type="button" aria-label="放大图画布" title="放大" @click="zoomIn">+</button>
        <button type="button" @click="fitToView">适应</button>
      </div>
    </div>
    <div v-if="!snapshot.nodes.length" class="graph-empty">
      <span class="empty-glyph" aria-hidden="true">◌</span>
      <h2>从来源、新闻或事实开始</h2>
      <p>添加资料，选择处理范围，连续完成解析、拆分与核查。</p>
    </div>
    <svg v-else ref="svgRef" class="graph-svg" :width="layout.width" :height="layout.height"
      :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="svgStyle" role="group" aria-label="可选择的数据节点与来源关系"
      @click.self="canvasSelect(null)">
      <defs><marker :id="markerId" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3.5 L0,7 Z" /></marker></defs>
      <g v-for="column in layout.columns" :key="column.kind" class="column-heading">
        <text :x="column.x" y="57">{{ CANVAS_KIND_LABELS[column.kind] }} <tspan>{{ column.count }}</tspan></text>
      </g>
      <path v-for="edge in layout.edges" :key="edge.id" :d="edge.path" class="graph-edge"
        :class="{ highlighted: edge.displayFrom === focusedId || edge.displayTo === focusedId || edge.from === selectedId || edge.to === selectedId, related: edge.cross }"
        :marker-end="`url(#${markerId})`">
        <title>{{ edge.kind === 'branch' ? '阶段处理分支' : edge.kind === 'derived-from' ? '产物源自此输入' : edge.kind === 'mentions' ? '新闻陈述事实' : edge.kind === 'verifies' ? '结论核查此事实' : '相关数据' }}</title>
      </path>
      <g v-for="item in layout.nodes" :key="item.id" class="fm-node" :class="[item.kind, { selected: item.id === focusedId, projected: item.synthetic, stale: !item.synthetic && item.node.validity === 'stale' }]"
        :transform="`translate(${item.x}, ${item.y})`" tabindex="0" role="button" :aria-pressed="item.id === focusedId"
        :aria-label="`${CANVAS_KIND_LABELS[item.kind]}：${item.label} ${item.text}`" :data-node-id="item.id" :data-owner-id="item.selectId"
        @click.stop="canvasSelect(item)" @keydown="canvasSelectKeyboard($event, item.id)">
        <rect class="node-card" :width="item.width" :height="item.height" rx="6" />
        <rect class="node-accent" width="3" :height="item.height - 24" x="0" y="12" rx="1.5" />
        <text class="node-kind" x="14" y="23">{{ CANVAS_KIND_LABELS[item.kind] }}</text>
        <text v-if="item.score !== undefined" class="node-score" :class="`score-${String(item.score!).replace('.', '_')}`" :x="item.width - 14" y="23" text-anchor="end">{{ graphReadScore(item.score!) }}</text>
        <foreignObject x="14" y="34" :width="item.width - 28" height="48">
          <div xmlns="http://www.w3.org/1999/xhtml" class="node-body">{{ item.synthetic && ['parseAgent', 'splitAgent', 'verifyAgent'].includes(item.kind) ? item.label + '\n' + item.text : item.text }}</div>
        </foreignObject>
        <text class="node-status" x="14" :y="item.height - 13">{{ canvasReadStatus(item) }}</text>
      </g>
    </svg>
    <aside v-if="projected" class="projection-details zoom-controls" @pointerdown.stop>
      <button type="button" aria-label="关闭分支详情" @click="focusedId = selectedId">×</button>
      <strong>{{ CANVAS_KIND_LABELS[projected.kind] }} · {{ projected.label }}</strong><small>{{ canvasReadStatus(projected) }}</small>
      <p>{{ projected.text }}</p><span>此卡片展示处理分支；右侧对应其关联数据。</span>
    </aside>
    <p class="canvas-help">滚动平移 · Ctrl / ⌘ + 滚动缩放 · 方向键切换节点 · 虚线表示共享或关联</p>
  </section>
</template>

<style scoped>
/* 区分节点类型、选中状态、过期结果和共享连线，并固定缩放与详情控件。 */
.graph-canvas { position: relative; flex: 1; width: 100%; height: 100%; min-height: 280px; overflow: hidden; background-color: var(--bg-viewport); background-image: radial-gradient(var(--border-subtle) .7px, transparent .7px); background-size: 18px 18px; }
.graph-toolbar { flex-wrap: wrap; position: absolute; z-index: 2; top: 10px; left: 12px; right: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; pointer-events: none; }
.graph-caption { display: flex; align-items: baseline; gap: 10px; color: var(--text-muted); padding: 5px 8px; background: var(--bg-viewport); }
.graph-caption strong { color: var(--text); font-size: 12px; }
.zoom-buttons { display: flex; flex-wrap: wrap; gap: 3px; pointer-events: auto; }
.zoom-buttons button { min-height: 26px; background: var(--flow-node-bg); }
.graph-svg { display: block; overflow: visible; touch-action: none; }
.column-heading { font: 600 12px var(--ui-font); fill: var(--text-muted); }
.column-heading tspan { font-weight: 400; fill: var(--text-dim); }
.graph-edge { fill: none; stroke: var(--flow-edge-muted); stroke-width: 1.4; opacity: .56; }
.graph-edge.related { stroke-dasharray: 5 4; }
.graph-edge.highlighted { stroke: var(--accent); stroke-width: 2; opacity: 1; }
marker path { fill: var(--flow-edge-muted); }
.fm-node { cursor: pointer; outline: none; }
.node-card { fill: var(--flow-node-bg); stroke: var(--flow-node-stroke); stroke-width: 1; }
.node-accent { fill: var(--border); }
.claim .node-accent { fill: #8b70a8; }
.verification .node-accent { fill: var(--success); }
.news .node-accent { fill: #698aa3; }
.fm-node:hover .node-card, .fm-node:focus-visible .node-card { stroke: var(--accent); stroke-width: 2; }
.fm-node.selected .node-card { stroke: var(--accent); stroke-width: 2.5; fill: var(--flow-node-active-bg); }
.fm-node.stale .node-card { stroke-dasharray: 5 3; }
.node-kind { font: 600 11px var(--ui-font); fill: var(--text-muted); }
.node-score { font: 600 12px var(--ui-font); }
.score-1 { fill: var(--success); }.score-0_5 { fill: var(--warning); }.score-0 { fill: var(--danger); }
.parseAgent .node-accent, .splitAgent .node-accent, .verifyAgent .node-accent { fill: var(--accent); }
.projected .node-card { stroke-dasharray: 4 2; }
.opinion .node-accent { fill: var(--warning); }
.projection-details { position: absolute; right: 12px; bottom: 32px; width: min(310px, calc(100% - 24px)); max-height: 45%; overflow: auto; background: var(--bg-panel); border: 1px solid var(--border); padding: 12px; box-sizing: border-box; display: grid; gap: 8px; z-index: 3; }
.projection-details button { justify-self: end; }
.projection-details p { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.5; }
.projection-details small, .projection-details span { color: var(--text-muted); font-size: 11px; }
.node-body { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font: 14px/1.35 var(--content-font); color: var(--text); overflow-wrap: anywhere; white-space: pre-wrap; }
.node-status { font: 10px var(--ui-font); fill: var(--text-muted); }
.canvas-help { position: absolute; left: 14px; bottom: 10px; color: var(--text-muted); background: var(--bg-viewport); padding: 3px 5px; pointer-events: none; }
.graph-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); padding: 25px; text-align: center; }
.graph-empty h2 { font-size: 17px; color: var(--text); font-weight: 500; }.empty-glyph { font-size: 46px; color: var(--accent); }.graph-empty p { line-height: 1.7; }
@media (max-width: 800px) { .graph-caption span, .canvas-help { display: none; } }
</style>
