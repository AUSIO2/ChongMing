<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import type { GraphSnapshot } from '../../../contracts/graph'
import { useCanvasPanZoom } from '../../composables/useCanvasPanZoom'
import { GRAPH_KIND_LABELS, graphReadCanvasLayout, graphReadCanvasNeighbor, graphReadNodeText, graphReadRunProgress, graphReadScore } from './graph-layout'

const props = defineProps<{ snapshot: GraphSnapshot; selectedId: string | null }>()
const emit = defineEmits<{ select: [id: string | null] }>()
const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const layout = computed(() => graphReadCanvasLayout(props.snapshot))
const contentWidth = computed(() => layout.value.width)
const contentHeight = computed(() => layout.value.height)
const markerId = `arrow-${crypto.randomUUID()}`
const { svgStyle, scalePercent, zoomIn, zoomOut, resetView, fitToView, focusLayoutRect, onPointerDown, onPointerMove, onPointerUp } = useCanvasPanZoom({ containerRef, svgRef, contentWidth, contentHeight })

watch(() => `${props.snapshot.mapId}:${props.snapshot.nodes.map(node => node.id).sort().join(',')}`, async () => {
  await nextTick()
  fitToView()
})
watch(() => props.selectedId, async id => {
  await nextTick()
  const selected = layout.value.nodes.find(node => node.node.id === id)
  if (selected) focusLayoutRect(selected.x, selected.y, selected.width, selected.height)
})
onMounted(() => { fitToView() })

function canvasReadStatus(id: string): string {
  const node = props.snapshot.nodes.find(node => node.id === id)!
  if (node.validity === 'stale') return '需要复核'
  if (props.snapshot.run?.operation.targetId === id) return graphReadRunProgress(props.snapshot.run)
  if (node.data.kind === 'verification') return `${node.data.opinions.length} 个角度的意见`
  if (node.data.kind === 'claim') {
    const sources = props.snapshot.edges.filter(edge => edge.kind === 'mentions' && edge.to === id).length
    return sources ? `${sources} 篇关联新闻` : '可独立核查的事实'
  }
  return node.data.kind === 'news' ? '保留正文与上下文' : '可供事实引用'
}
function canvasSelectKeyboard(event: KeyboardEvent, id: string): void {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); emit('select', id); return }
  if (event.key === 'Escape') { event.preventDefault(); emit('select', null); return }
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  const next = graphReadCanvasNeighbor(layout.value, id, event.key as 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown')
  if (next) {
    emit('select', next)
    const element = svgRef.value?.querySelector<SVGGElement>(`[data-node-id="${CSS.escape(next)}"]`)
    element?.focus()
  }
}
</script>

<template>
  <section ref="containerRef" class="graph-canvas" aria-label="事实关系图"
    @pointerdown="onPointerDown" @pointermove="onPointerMove" @pointerup="onPointerUp" @pointercancel="onPointerUp">
    <div class="graph-toolbar zoom-controls" @pointerdown.stop>
      <div class="graph-caption"><strong>数据关系</strong><span>{{ snapshot.nodes.length }} 个节点 · {{ snapshot.edges.length }} 条关联</span></div>
      <div class="zoom-buttons">
        <button type="button" aria-label="缩小图画布" title="缩小" @click="zoomOut">−</button>
        <button type="button" aria-label="重置缩放" title="重置为 100%" @click="resetView">{{ scalePercent }}</button>
        <button type="button" aria-label="放大图画布" title="放大" @click="zoomIn">+</button>
        <button type="button" @click="fitToView">适应</button>
      </div>
    </div>
    <div v-if="!snapshot.nodes.length" class="graph-empty">
      <span class="empty-glyph" aria-hidden="true">◌</span>
      <h2>从一条事实开始</h2>
      <p>新建新闻或事实，连接来源，再选择事实开始核查。</p>
    </div>
    <svg v-else ref="svgRef" class="graph-svg" :width="layout.width" :height="layout.height"
      :viewBox="`0 0 ${layout.width} ${layout.height}`" :style="svgStyle" role="group" aria-label="可选择的数据节点与来源关系"
      @click.self="emit('select', null)">
      <defs><marker :id="markerId" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L7,3.5 L0,7 Z" /></marker></defs>
      <g v-for="column in layout.columns" :key="column.kind" class="column-heading">
        <text :x="column.x" y="57">{{ GRAPH_KIND_LABELS[column.kind] }} <tspan>{{ column.count }}</tspan></text>
      </g>
      <path v-for="edge in layout.edges" :key="edge.id" :d="edge.path" class="graph-edge"
        :class="{ highlighted: edge.from === selectedId || edge.to === selectedId, related: edge.kind === 'related-to' }"
        :marker-end="`url(#${markerId})`">
        <title>{{ edge.kind === 'mentions' ? '新闻陈述事实' : edge.kind === 'verifies' ? '结论核查此事实' : '相关数据' }}</title>
      </path>
      <g v-for="item in layout.nodes" :key="item.node.id" class="fm-node" :class="[item.node.data.kind, { selected: item.node.id === selectedId, stale: item.node.validity === 'stale' }]"
        :transform="`translate(${item.x}, ${item.y})`" tabindex="0" role="button" :aria-pressed="item.node.id === selectedId"
        :aria-label="`${GRAPH_KIND_LABELS[item.node.data.kind]}：${graphReadNodeText(item.node)}`" :data-node-id="item.node.id"
        @click.stop="emit('select', item.node.id)" @keydown="canvasSelectKeyboard($event, item.node.id)">
        <rect class="node-card" :width="item.width" :height="item.height" rx="6" />
        <rect class="node-accent" width="3" :height="item.height - 24" x="0" y="12" rx="1.5" />
        <text class="node-kind" x="14" y="23">{{ GRAPH_KIND_LABELS[item.node.data.kind] }}</text>
        <text v-if="item.node.data.kind === 'verification'" class="node-score" :class="`score-${String(item.node.data.score).replace('.', '_')}`" :x="item.width - 14" y="23" text-anchor="end">{{ graphReadScore(item.node.data.score) }}</text>
        <foreignObject x="14" y="34" :width="item.width - 28" height="76">
          <div xmlns="http://www.w3.org/1999/xhtml" class="node-body">{{ graphReadNodeText(item.node) }}</div>
        </foreignObject>
        <text class="node-status" x="14" :y="item.height - 13">{{ canvasReadStatus(item.node.id) }}</text>
      </g>
    </svg>
    <p class="canvas-help">滚动平移 · Ctrl / ⌘ + 滚动缩放 · 方向键切换节点</p>
  </section>
</template>

<style scoped>
.graph-canvas { position: relative; flex: 1; width: 100%; height: 100%; min-height: 280px; overflow: hidden; background-color: var(--bg-viewport); background-image: radial-gradient(var(--border-subtle) .7px, transparent .7px); background-size: 18px 18px; }
.graph-toolbar { position: absolute; z-index: 2; top: 10px; left: 12px; right: 12px; display: flex; align-items: center; justify-content: space-between; gap: 10px; pointer-events: none; }
.graph-caption { display: flex; align-items: baseline; gap: 10px; color: var(--text-muted); padding: 5px 8px; background: var(--bg-viewport); }
.graph-caption strong { color: var(--text); font-size: 12px; }
.zoom-buttons { display: flex; gap: 3px; pointer-events: auto; }
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
.node-body { display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; font: 14px/1.35 var(--content-font); color: var(--text); overflow-wrap: anywhere; white-space: pre-wrap; }
.node-status { font: 10px var(--ui-font); fill: var(--text-muted); }
.canvas-help { position: absolute; left: 14px; bottom: 10px; color: var(--text-muted); background: var(--bg-viewport); padding: 3px 5px; pointer-events: none; }
.graph-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--text-muted); padding: 25px; text-align: center; }
.graph-empty h2 { font-size: 17px; color: var(--text); font-weight: 500; }.empty-glyph { font-size: 46px; color: var(--accent); }.graph-empty p { line-height: 1.7; }
@media (max-width: 800px) { .graph-caption span, .canvas-help { display: none; } }
</style>
