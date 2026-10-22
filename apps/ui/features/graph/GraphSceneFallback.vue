<!-- 共用场景的 SVG 降级画布：使用相同展示身份和实际关系，不制造普通 Map 快照。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useCanvasPanZoom } from '../../composables/useCanvasPanZoom'
import type { Graph3DLayout } from './graph-3d-layout'

const props = withDefaults(defineProps<{
  layout: Graph3DLayout
  sceneKey: string
  selectedId: string | null
  active?: boolean
  label?: string
  emptyLabel?: string
}>(), {
  active: true,
  label: '数据关系图',
  emptyLabel: '当前场景没有节点。',
})
const emit = defineEmits<{ select: [id: string | null]; open: [id: string] }>()

// 本实例拥有降级画布的焦点、视口和尺寸观察；关闭时结束观察与待执行视图更新。
const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const projected = computed(() => {
  // 将真实三维坐标等距投影为二维，保留 Z 深度对节点位置的影响。
  const positions = props.layout.nodes.map((/* 三维场景的真实展示节点。 */ node) =>
    /* 计算不依赖业务对象的二维节点中心。 */ ({ node, x: node.x * 110 + node.z * 70, y: -node.y * 90 + node.z * 30 }))
  const left = Math.min(0, ...positions.map((/* 待计算边界的节点位置。 */ item) => /* 为左侧节点圆形预留空间。 */ item.x - 30))
  const top = Math.min(0, ...positions.map((/* 待计算边界的节点位置。 */ item) => /* 为顶部节点圆形预留空间。 */ item.y - 30))
  const nodes = positions.map((/* 尚未平移到正坐标的节点。 */ item) =>
    /* 为画布工具栏和节点标题保留统一内边距。 */ ({ ...item, x: item.x - left + 45, y: item.y - top + 85 }))
  const positionsById = new Map(nodes.map((/* 已平移的节点。 */ item) => /* 按独立展示身份建立连线端点索引。 */ [item.node.id, item]))
  const edges = props.layout.edges.flatMap((/* 三维场景中调用者提供的实际关系。 */ edge) => {
    // 仅绘制两端均已载入的实际连线，不补造关系。
    const from = positionsById.get(edge.from)
    const to = positionsById.get(edge.to)
    return from && to ? [{ ...edge, x1: from.x, y1: from.y, x2: to.x, y2: to.y }] : []
  })
  return {
    nodes,
    edges,
    width: Math.max(520, ...nodes.map((/* 已平移的节点。 */ item) => /* 为节点正文保留右侧可见空间。 */ item.x + 235)),
    height: Math.max(330, ...nodes.map((/* 已平移的节点。 */ item) => /* 为节点正文和底部操作提示保留空间。 */ item.y + 110)),
  }
})
const contentWidth = computed(() => /* 读取投影后画布的布局宽度。 */ projected.value.width)
const contentHeight = computed(() => /* 读取投影后画布的布局高度。 */ projected.value.height)
const active = computed(() => /* 将当前场景的可见状态交给共用平移缩放逻辑。 */ props.active)
const markerId = `scene-arrow-${crypto.randomUUID()}`
const {
  svgStyle, scalePercent, zoomIn, zoomOut, resetView, fitToView, focusLayoutRect,
  onPointerDown, onPointerMove, onPointerUp,
} = useCanvasPanZoom({ containerRef, svgRef, contentWidth, contentHeight, active })
let resizeObserver: ResizeObserver | null = null
let mounted = false
let pendingFit = true

function selectNode(
  /* 用户指向的实际展示身份，null 表示点击画布空白。 */
  id: string | null,
): void {
  // 仅在场景可见且选择改变时发送选择意图。
  if (props.active && id !== props.selectedId) emit('select', id)
}

function openNode(
  /* 当前集合中用户希望阅读的展示身份。 */
  id: string,
): void {
  // 打开前确认节点仍在当前集合中，具体单页由调用者决定。
  if (props.active && props.layout.nodes.some((/* 待比较的真实展示节点。 */ node) =>
    /* 防止旧焦点打开已经离开的节点。 */ node.id === id)) emit('open', id)
}

function selectByKeyboard(
  /* 降级场景收到的键盘事件。 */
  event: KeyboardEvent,
  /* 发出事件的展示节点身份；场景容器使用当前选择。 */
  id: string | null,
): void {
  // 保留 Enter 打开、空格选择、Escape 清空和方向键循环导航。
  if (!props.active) return
  if (event.key === 'Enter' && id !== null) {
    event.preventDefault()
    openNode(id)
    return
  }
  if (event.key === ' ') {
    event.preventDefault()
    selectNode(id)
    return
  }
  if (event.key === 'Escape') {
    event.preventDefault()
    selectNode(null)
    return
  }
  const nodes = props.layout.nodes
  if (!event.key.startsWith('Arrow') || !nodes.length) return
  event.preventDefault()
  const current = nodes.findIndex((/* 场景中的展示节点。 */ node) => /* 定位键盘导航起点。 */ node.id === id)
  const delta = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
  const next = nodes[(current + delta + nodes.length) % nodes.length]
  selectNode(next.id)
  focusNode(next.id)
}

function focusNode(
  /* 已在当前场景中确定的节点身份。 */
  id: string,
): void {
  // 将键盘焦点恢复到实际节点，并在超出视口时进行最少平移。
  const target = svgRef.value?.querySelector<SVGGElement>(`[data-scene-node-id="${CSS.escape(id)}"]`)
  target?.focus({ preventScroll: true })
  const position = projected.value.nodes.find((/* 投影后待定位的节点。 */ item) =>
    /* 找到当前展示身份的投影位置。 */ item.node.id === id)
  if (position) focusLayoutRect(position.x - 22, position.y - 25, 235, 100)
}

async function focusSelectedNode(): Promise<void> {
  // 单页返回后恢复选中节点的焦点和可见位置，无选中项时聚焦整个场景。
  await nextTick()
  if (!mounted || !props.active) return
  if (props.selectedId !== null) focusNode(props.selectedId)
  else containerRef.value?.focus({ preventScroll: true })
}
defineExpose({ focusSelectedNode })

async function applyPendingView(): Promise<void> {
  // 等待 DOM 与容器尺寸恢复后适应新场景，零尺寸时保留待适应标记。
  await nextTick()
  if (!mounted || !props.active || !pendingFit) return
  const rect = containerRef.value?.getBoundingClientRect()
  if (!rect || rect.width <= 0 || rect.height <= 0) return
  fitToView()
  pendingFit = false
}

watch(() => /* 读取场景身份和节点总数，辨别切换与首次填充。 */ [props.sceneKey, props.layout.nodes.length] as const,
  async (/* 新场景身份和节点数。 */ current, /* 上次展示的场景身份和节点数。 */ previous) => {
    // 切换场景或从空图首次添加时适应内容，正常分页追加保留用户视口。
    if (current[0] !== previous[0] || previous[1] === 0 || (previous[1] <= 1 && current[1] > previous[1])) pendingFit = true
    await applyPendingView()
  })
watch(() => /* 读取当前场景的可见状态。 */ props.active, async (/* 切换后的可见状态。 */ isActive) => {
  // 场景从单页返回时执行尚未完成的视口适应。
  if (isActive) await applyPendingView()
})

onMounted(async () => {
  // 挂载后观察容器尺寸变化，避免首次隐藏或尚未布局时丢失适应操作。
  mounted = true
  if (containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      // 尺寸已可测量时完成待适应操作；无网络和持久化副作用。
      if (!pendingFit || !props.active) return
      const rect = containerRef.value?.getBoundingClientRect()
      if (!rect || rect.width <= 0 || rect.height <= 0) return
      fitToView()
      pendingFit = false
    })
    resizeObserver.observe(containerRef.value)
  }
  await applyPendingView()
})
onBeforeUnmount(() => {
  // 结束本组件拥有的尺寸观察，使迟到的 nextTick 不再更新视口。
  mounted = false
  resizeObserver?.disconnect()
  resizeObserver = null
})
</script>

<template>
  <section ref="containerRef" class="scene-fallback" :aria-label="label" tabindex="0"
    @keydown.self="selectByKeyboard($event, selectedId)" @pointerdown="onPointerDown" @pointermove="onPointerMove"
    @pointerup="onPointerUp" @pointercancel="onPointerUp" @click.self="selectNode(null)">
    <div class="scene-toolbar zoom-controls" @pointerdown.stop>
      <strong>{{ label }} <small>{{ layout.nodes.length }} 节点 · {{ layout.edges.length }} 连线</small></strong>
      <div class="zoom-buttons">
        <button type="button" :aria-label="`缩小${label}`" :disabled="!active" @click="zoomOut">−</button>
        <button type="button" :aria-label="`重置${label}缩放`" :disabled="!active" @click="resetView">{{ scalePercent }}</button>
        <button type="button" :aria-label="`放大${label}`" :disabled="!active" @click="zoomIn">＋</button>
        <button type="button" :disabled="!active" @click="fitToView">适应</button>
      </div>
    </div>
    <p v-if="!layout.nodes.length" class="scene-empty">{{ emptyLabel }}</p>
    <svg v-else ref="svgRef" class="scene-svg" :width="projected.width" :height="projected.height"
      :viewBox="`0 0 ${projected.width} ${projected.height}`" :style="svgStyle" role="group" aria-label="可选择的节点和实际关系"
      @click.self="selectNode(null)">
      <defs><marker :id="markerId" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7 Z" /></marker></defs>
      <line v-for="edge in projected.edges" :key="edge.id" :x1="edge.x1" :y1="edge.y1" :x2="edge.x2" :y2="edge.y2"
        class="scene-edge" :class="{ reference: edge.kind === 'reference', selected: edge.from === selectedId || edge.to === selectedId }"
        :marker-end="`url(#${markerId})`"><title>{{ edge.kind === 'successor' ? '后继关系' : '引用关系' }}</title></line>
      <g v-for="item in projected.nodes" :key="item.node.id" class="fm-node" :class="{ selected: item.node.id === selectedId, stale: item.node.stale }"
        :transform="`translate(${item.x}, ${item.y})`" tabindex="0" role="button" :aria-pressed="item.node.id === selectedId"
        :aria-label="`${item.node.title}：${item.node.summary}`" :data-scene-node-id="item.node.id"
        @click.stop="selectNode(item.node.id)" @dblclick.stop="openNode(item.node.id)" @keydown.stop="selectByKeyboard($event, item.node.id)">
        <circle class="node-halo" r="15" /><circle class="node-core" r="9" :fill="item.node.color" :opacity="item.node.stale ? 0.55 : 1" />
        <foreignObject x="32" y="-25" width="185" height="95"><div xmlns="http://www.w3.org/1999/xhtml" class="node-label">
          <strong>{{ item.node.title }}</strong><p>{{ item.node.summary }}</p>
        </div></foreignObject>
      </g>
    </svg>
    <p class="scene-help">拖动平移 · 按住控制键或命令键滚动缩放 · 方向键选择 · 双击打开</p>
  </section>
</template>

<style scoped>
.scene-fallback { position:relative; flex:1; width:100%; height:100%; min-width:0; min-height:0; overflow:hidden; background:var(--bg-viewport); background-image:radial-gradient(var(--border-subtle) .7px,transparent .7px); background-size:18px 18px; outline:none; }
.scene-fallback:focus-visible { outline:2px solid var(--accent); outline-offset:-3px; }
.scene-toolbar { position:absolute; z-index:2; top:14px; left:16px; right:15px; display:flex; justify-content:space-between; align-items:center; gap:12px; pointer-events:none; }
.scene-toolbar strong { display:flex; align-items:baseline; gap:9px; padding:6px 0; border:0; background:transparent; color:var(--text-muted); font-size:11px; font-weight:600; }
.scene-toolbar small { color:var(--text-muted); font-size:10px; font-weight:400; }
.zoom-buttons { display:flex; gap:4px; pointer-events:auto; }
.zoom-buttons button { min-width:31px; min-height:31px; padding:3px 8px; border-radius:var(--radius-control); background:var(--bg-viewport); white-space:nowrap; }
.scene-svg { display:block; overflow:visible; touch-action:none; }
.scene-edge { stroke:var(--flow-edge-muted); stroke-width:1.4; opacity:.6; }
.scene-edge.reference { stroke-dasharray:5 4; }
.scene-edge.selected { stroke:var(--accent); stroke-width:2; opacity:1; }
marker path { fill:var(--flow-edge-muted); }
.fm-node { cursor:pointer; outline:none; }
.node-halo { fill:transparent; stroke:transparent; }
.fm-node:hover .node-halo,.fm-node:focus-visible .node-halo,.fm-node.selected .node-halo { stroke:var(--accent); stroke-width:2; }
.fm-node.stale .node-halo { stroke:var(--text-muted); stroke-dasharray:4 3; }
.node-core { stroke:#fffdf8; stroke-width:2; }
.node-label { padding:7px 9px; border:1px solid var(--border-subtle); border-radius:0; background:var(--bg-viewport); }
.node-label strong { display:block; overflow:hidden; color:var(--text-muted); font:600 11px/1.4 var(--ui-font); text-overflow:ellipsis; white-space:nowrap; }
.node-label p { display:-webkit-box; overflow:hidden; margin:4px 0 0; color:var(--text); font:13px/1.5 var(--content-font); -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow-wrap:anywhere; }
.fm-node.selected .node-label { border-color:var(--accent); }
.scene-empty { position:absolute; top:50%; left:50%; width:min(280px,85%); margin:0; color:var(--text-muted); font:15px/1.8 var(--content-font); text-align:center; transform:translate(-50%,-50%); pointer-events:none; }
.scene-help { position:absolute; right:16px; bottom:12px; color:var(--text-muted); font-size:10px; pointer-events:none; }
@media(max-width:900px) { .scene-toolbar small,.scene-help { display:none; } .scene-toolbar { top:10px; left:10px; right:10px; } }
</style>
