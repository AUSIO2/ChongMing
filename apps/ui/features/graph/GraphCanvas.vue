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
const layout = computed(() => graphReadCanvasLayout(props.snapshot))
const contentWidth = computed(() => layout.value.width)
const contentHeight = computed(() => layout.value.height)
const markerId = `arrow-${crypto.randomUUID()}`
const { svgStyle, scalePercent, zoomIn, zoomOut, resetView, fitToView, fitLayoutRect, focusLayoutRect, onPointerDown, onPointerMove, onPointerUp } = useCanvasPanZoom({ containerRef, svgRef, contentWidth, contentHeight })

const focusedId = ref<string | null>(null)
const focused = computed(() => layout.value.nodes.find(node => node.id === focusedId.value))
const projected = computed(() => focused.value?.synthetic ? focused.value : null)
const stages = [{ label: '解析', input: 'source', kinds: ['source', 'parseAgent', 'news'] },
  { label: '拆分', input: 'news', kinds: ['news', 'splitAgent', 'claim'] },
  { label: '核查', input: 'claim', kinds: ['claim', 'verifyAgent', 'opinion', 'verification'] }]
// 用途：处理界面相关工作，并把结果交给调用方。
function canvasSelect(item: CanvasNode | null) { focusedId.value = item?.id ?? null; emit('select', item?.selectId ?? null) }
// 用途：处理界面相关工作，并把结果交给调用方。
function canvasFocusStage(stage: typeof stages[number]) {
  const nodes = layout.value.nodes
  const root = nodes.find(node => node.id === props.selectedId && node.kind === stage.input)
    ?? nodes.find(node => node.kind === stage.input && !node.synthetic)
  if (!root) return
  const ids = new Set([root.id])
  for (const node of nodes) if (node.parentId && ids.has(node.parentId) && stage.kinds.includes(node.kind)) ids.add(node.id)
  const branch = nodes.filter(node => ids.has(node.id))
  const left = Math.min(...branch.map(node => node.x)) - 12, top = Math.min(...branch.map(node => node.y)) - 30
  fitLayoutRect(left, top, Math.max(...branch.map(node => node.x + node.width)) - left + 12,
    Math.max(...branch.map(node => node.y + node.height)) - top + 20)
}
// 用途：处理界面相关工作，并把结果交给调用方。
async function canvasResetMap() {
  focusedId.value = props.selectedId
  await nextTick()
  resetView()
  const first = layout.value.nodes.find(node => node.id === props.selectedId) ?? layout.value.nodes.find(node => !node.parentId)
  if (first) focusLayoutRect(first.x, first.y, first.width, first.height)
}
watch(() => props.snapshot.mapId, canvasResetMap)
watch(() => props.snapshot.nodes.length, (count, previous) => { if (!previous && count) void canvasResetMap() })
watch(() => props.selectedId, async id => {
  if (focused.value?.selectId !== id) focusedId.value = id
  await nextTick()
  if (focused.value) focusLayoutRect(focused.value.x, focused.value.y, focused.value.width, focused.value.height)
})
onMounted(canvasResetMap)

// 用途：读取状态，并把结构化结果交给调用方。
function canvasReadStatus(item: CanvasNode): string {
  const activity = props.activities?.find(activity => activity.runId === props.snapshot.run?.id && activity.nodeId === item.selectId
    && (!item.synthetic || item.id === 'view:' + item.kind + ':' + activity.operationId + ':' + (activity.actor.role === 'worker' ? activity.actor.slotId : activity.actor.role === 'router' ? 'route' : activity.actor.role)))
  if (activity && !props.snapshot.run?.paused) return ACTIVITY_LABELS[activity.status]
  if (item.synthetic) return item.status
  const id = item.id, node = item.node
  if (node.validity === 'stale') return '需要复核'
  const operation = props.snapshot.run?.operations.find(operation => operation.targetId === id)
  if (operation) return `${props.snapshot.run!.paused && ['running', 'waiting'].includes(operation.status) ? '已暂停 · ' : ''}${graphReadOperationProgress(operation)}`
  if (node.data.kind === 'verification') return `${node.data.opinions.length} 个角度的意见`
  if (node.data.kind === 'claim') {
    const sources = props.snapshot.edges.filter(edge => edge.kind === 'mentions' && edge.to === id).length
    return sources ? `${sources} 篇关联新闻` : '可独立核查的事实'
  }
  return node.data.kind === 'news' ? '保留正文与上下文' : '可供事实引用'
}
// 用途：处理界面相关工作，并把结果交给调用方。
function canvasSelectKeyboard(event: KeyboardEvent, id: string): void {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); canvasSelect(layout.value.nodes.find(node => node.id === id) ?? null); return }
  if (event.key === 'Escape') { event.preventDefault(); canvasSelect(null); return }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const next = graphReadCanvasNeighbor(layout.value, id, event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown')
  if (next) {
    canvasSelect(layout.value.nodes.find(node => node.id === next) ?? null)
    const element = svgRef.value?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(next)}"]`)
    element?.focus()
  }
}
</script>

<template>
  <section ref="containerRef" class="graph-canvas" aria-label="事实关系图"
    @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
    <div class="graph-toolbar zoom-controls" @pointerdown.stop>
      <div class="graph-caption"><strong>阶段树</strong><span>{{ snapshot.nodes.length }} 个节点 · {{ snapshot.edges.length }} 条关联</span></div>
      <div class="zoom-buttons"><button v-for="stage in stages" :key="stage.label" type="button" :disabled="!layout.nodes.some(node => node.kind === stage.input)" @click="canvasFocusStage(stage)">{{ stage.label }}</button>
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
