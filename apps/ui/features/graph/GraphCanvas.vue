<!-- 通用数据画布：按精确定义展示节点，按 successor/reference 关系布局。 -->
<script setup lang="ts">
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useCanvasPanZoom } from '../../composables/useCanvasPanZoom'
import { type CanvasNode, graphReadCanvasLayout, graphReadCanvasNeighbor } from './graph-layout'

const props = withDefaults(defineProps<{ snapshot: GraphSnapshot; catalog?: DefinitionCatalog | null; nodeStatus?: ReadonlyMap<string, string>; selectedId: string | null; active?: boolean }>(), { active: true })
const emit = defineEmits<{ select: [id: string | null]; open: [identity: { workspaceId: string; mapId: string; nodeId: string }] }>()
const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const layout = computed(() => graphReadCanvasLayout(props.snapshot, props.catalog))
const contentWidth = computed(() => layout.value.width)
const contentHeight = computed(() => layout.value.height)
const markerId = `arrow-${crypto.randomUUID()}`
const active = computed(() => props.active)
const { svgStyle, scalePercent, zoomIn, zoomOut, resetView, fitToView, focusLayoutRect, onPointerDown, onPointerMove, onPointerUp } = useCanvasPanZoom({
  containerRef, svgRef, contentWidth, contentHeight, active,
})
const pendingReset = ref(true)
const pendingFocusId = ref<string | null>(null)

/**
 * @param item 被选择的真实数据节点。
 */
function canvasSelect(item: CanvasNode | null): void {
  if ((item?.id ?? null) === props.selectedId) return
  emit('select', item?.id ?? null)
}
function canvasOpen(item: CanvasNode): void {
  if (!props.snapshot.nodes.some(node => node.id === item.id)) return
  emit('open', { workspaceId: props.snapshot.workspaceId, mapId: props.snapshot.mapId, nodeId: item.id })
}
async function focusSelectedNode(): Promise<void> {
  await nextTick()
  const selector = props.selectedId ? `[data-node-id="${CSS.escape(props.selectedId)}"]` : null
  const target = selector ? svgRef.value?.querySelector<SVGGElement>(selector) : null
  ;(target ?? containerRef.value)?.focus({ preventScroll: true })
}
defineExpose({ focusSelectedNode })
async function canvasResetMap(): Promise<void> {
  pendingReset.value = true
  await nextTick()
  if (!canvasCanMeasure()) return
  resetView()
  const first = layout.value.nodes.find(node => node.id === props.selectedId) ?? layout.value.nodes.find(node => !node.parentId)
  if (first) focusLayoutRect(first.x, first.y, first.width, first.height)
  pendingReset.value = false
}
function canvasCanMeasure(): boolean {
  const rect = containerRef.value?.getBoundingClientRect()
  return props.active && !!rect && rect.width > 0 && rect.height > 0
}
async function canvasApplyPending(): Promise<void> {
  await nextTick()
  if (!canvasCanMeasure()) return
  if (pendingReset.value) { await canvasResetMap(); return }
  const target = layout.value.nodes.find(node => node.id === pendingFocusId.value)
  if (target) focusLayoutRect(target.x, target.y, target.width, target.height)
  pendingFocusId.value = null
}
watch(() => props.snapshot.mapId, canvasResetMap)
watch(() => props.snapshot.nodes.length, (count, previous) => { if (!previous && count) void canvasResetMap() })
watch(() => props.selectedId, async id => {
  pendingFocusId.value = id
  if (props.active) await canvasApplyPending()
})
watch(() => props.active, active => { if (active) void canvasApplyPending() })
onMounted(canvasResetMap)

/**
 * @param item 数据卡片。
 */
function canvasReadStatus(/* 当前图中已定位的真实节点卡片。 */ item: CanvasNode): string {
  // 与三维图消费同一份选中Run状态，不从所有运行里find首项冒充当前活动。
  const status = props.nodeStatus?.get(item.id)
  if (status) return status
  const successors = props.snapshot.edges.filter((/* 当前图真实连线。 */ edge) => /* 只统计本节点实际后继。 */ edge.kind === 'successor' && edge.from === item.id).length
  const references = props.snapshot.edges.filter((/* 当前图真实连线。 */ edge) => /* 引用不改变运行归属。 */ edge.kind === 'reference' && (edge.from === item.id || edge.to === item.id)).length
  return [successors ? `${successors} 个后继` : '', references ? `${references} 个引用` : ''].filter(Boolean).join(' · ') || `版本 ${item.node.revision}`
}
function canvasSelectKeyboard(event: KeyboardEvent, id: string): void {
  const item = layout.value.nodes.find(node => node.id === id) ?? null
  if (event.key === 'Enter' && item) { event.preventDefault(); canvasOpen(item); return }
  if (event.key === ' ') { event.preventDefault(); canvasSelect(item); return }
  if (event.key === 'Escape') { event.preventDefault(); canvasSelect(null); return }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const next = graphReadCanvasNeighbor(layout.value, id, event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown')
  if (!next) return
  canvasSelect(layout.value.nodes.find(node => node.id === next) ?? null)
  svgRef.value?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(next)}"]`)?.focus({ preventScroll: true })
}
</script>

<template>
  <section ref="containerRef" class="graph-canvas" aria-label="数据关系图"
    tabindex="-1"
    @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
    <div class="graph-toolbar zoom-controls" @pointerdown.stop>
      <div class="graph-caption"><strong>数据图</strong><span>{{ snapshot.nodes.length }} 个节点 · {{ snapshot.edges.length }} 条关系</span></div>
      <div class="zoom-buttons">
        <button type="button" aria-label="缩小图画布" @click="zoomOut">−</button>
        <button type="button" aria-label="重置缩放" @click="resetView">{{ scalePercent }}</button>
        <button type="button" aria-label="放大图画布" @click="zoomIn">+</button>
        <button type="button" @click="fitToView">适应</button>
      </div>
    </div>
    <div v-if="!snapshot.nodes.length" class="graph-empty">
      <span class="empty-glyph" aria-hidden="true">◌</span><h2>添加第一份数据</h2><p>从已注册的数据类型开始，后续转换会形成可追溯关系。</p>
    </div>
    <svg v-else ref="svgRef" class="graph-svg" :width="layout.width" :height="layout.height"
      :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="svgStyle" role="group" aria-label="可选择的数据节点与关系" @click.self="canvasSelect(null)">
      <defs><marker :id="markerId" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3.5 L0,7 Z" /></marker></defs>
      <g v-for="column in layout.columns" :key="column.key" class="column-heading"><text :x="column.x" y="57">{{ column.label }} <tspan>{{ column.count }}</tspan></text></g>
      <path v-for="edge in layout.edges" :key="edge.id" :d="edge.path" class="graph-edge"
        :class="{ highlighted: edge.from === selectedId || edge.to === selectedId, related: edge.kind === 'reference' || edge.cross }" :marker-end="`url(#${markerId})`">
        <title>{{ edge.label || (edge.kind === 'successor' ? '后继数据' : '数据引用') }}</title>
      </path>
      <g v-for="item in layout.nodes" :key="item.id" class="fm-node" :class="{ selected: item.id === selectedId, stale: item.node.validity === 'stale' }"
        :transform="`translate(${item.x}, ${item.y})`" tabindex="0" role="button" :aria-pressed="item.id === selectedId"
        :aria-label="`${item.label}：${item.text}`" :data-node-id="item.id" @click.stop="canvasSelect(item)" @dblclick.stop="canvasOpen(item)" @keydown="canvasSelectKeyboard($event, item.id)">
        <rect class="node-card" :width="item.width" :height="item.height" rx="6" /><rect class="node-accent" width="3" :height="item.height - 24" x="0" y="12" rx="1.5" />
        <text class="node-kind" x="14" y="23">{{ item.label }}</text>
        <foreignObject x="14" y="34" :width="item.width - 28" height="48"><div xmlns="http://www.w3.org/1999/xhtml" class="node-body">{{ item.text }}</div></foreignObject>
        <text class="node-status" x="14" :y="item.height - 13">{{ canvasReadStatus(item) }}</text>
      </g>
    </svg>
    <p class="canvas-help">滚动平移 · 按住控制键或命令键滚动缩放 · 方向键切换节点 · 虚线表示引用或共享后继</p>
  </section>
</template>

<style scoped>
.graph-canvas{position:relative;flex:1;width:100%;height:100%;min-height:280px;overflow:hidden;background-color:var(--bg-viewport);background-image:radial-gradient(var(--border-subtle) .7px,transparent .7px);background-size:18px 18px}.graph-toolbar{position:absolute;z-index:2;top:10px;left:12px;right:12px;display:flex;align-items:center;justify-content:space-between;gap:10px;pointer-events:none}.graph-caption{display:flex;flex:none;align-items:baseline;gap:10px;color:var(--text-muted);padding:5px 8px;background:var(--bg-viewport);white-space:nowrap}.graph-caption strong{color:var(--text);font-size:12px}.zoom-buttons{display:flex;flex:none;gap:3px;pointer-events:auto}.zoom-buttons button{min-height:26px;background:var(--flow-node-bg);white-space:nowrap}.graph-svg{display:block;overflow:visible;touch-action:none}.column-heading{font:600 12px var(--ui-font);fill:var(--text-muted)}.column-heading tspan{font-weight:400;fill:var(--text-dim)}.graph-edge{fill:none;stroke:var(--flow-edge-muted);stroke-width:1.4;opacity:.56}.graph-edge.related{stroke-dasharray:5 4}.graph-edge.highlighted{stroke:var(--accent);stroke-width:2;opacity:1}marker path{fill:var(--flow-edge-muted)}.fm-node{cursor:pointer;outline:none}.node-card{fill:var(--flow-node-bg);stroke:var(--flow-node-stroke);stroke-width:1}.node-accent{fill:var(--accent)}.fm-node:hover .node-card,.fm-node:focus-visible .node-card{stroke:var(--accent);stroke-width:2}.fm-node.selected .node-card{stroke:var(--accent);stroke-width:2.5;fill:var(--flow-node-active-bg)}.fm-node.stale .node-card{stroke-dasharray:5 3}.node-kind{font:600 11px var(--ui-font);fill:var(--text-muted)}.node-body{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;font:14px/1.35 var(--content-font);color:var(--text);overflow-wrap:anywhere;white-space:pre-wrap}.node-status{font:10px var(--ui-font);fill:var(--text-muted)}.canvas-help{position:absolute;left:14px;bottom:10px;color:var(--text-muted);background:var(--bg-viewport);padding:3px 5px;pointer-events:none}.graph-empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text-muted);padding:25px;text-align:center}.graph-empty h2{font-size:17px;color:var(--text);font-weight:500}.empty-glyph{font-size:46px;color:var(--accent)}.graph-empty p{line-height:1.7}@media(max-width:900px){.graph-caption,.canvas-help{display:none}.graph-toolbar{justify-content:flex-end}}@media(min-width:901px) and (max-width:1100px){.graph-caption span{display:none}}
</style>
