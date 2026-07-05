<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useFlowMap } from '../../composables/use-flow-map'
import { useCanvasPanZoom } from '../../composables/useCanvasPanZoom'
import { useWorkspaceStore } from '../../stores/workspace'
import type { MapLayoutNode } from '../../flow-map'
import type { MapNode } from '../../flow-map'
import { labelFormatHitl, docIsParamLock, labelFormatSkill, labelFormatSkillTitle, labelFormatNodeKind, labelTruncate } from '../../flow-map'
import { MAP_COLUMN, MAP_COLUMN_LABEL } from '../../flow-map/columns'

const props = defineProps<{ mapId: string | null }>()

const workspace = useWorkspaceStore()
const { store, layout, snapshot, selectedNodeId } = useFlowMap(() => props.mapId)

const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)

type DataRootKind = 'source' | 'news' | 'claim'

const CREATE_ROOT_MENU: { kind: DataRootKind, label: string }[] = [
  { kind: 'source', label: `新建${MAP_COLUMN_LABEL[MAP_COLUMN.source]}` },
  { kind: 'news', label: `新建${MAP_COLUMN_LABEL[MAP_COLUMN.news]}` },
  { kind: 'claim', label: `新建${MAP_COLUMN_LABEL[MAP_COLUMN.claim]}` },
]

const contextMenu = ref<{ visible: boolean, x: number, y: number }>({
  visible: false,
  x: 0,
  y: 0,
})

const contentWidth = computed(() => Math.max(layout.value?.width ?? 600, 600))
const contentHeight = computed(() => Math.max(layout.value?.height ?? 300, 300))

const {
  svgStyle,
  scalePercent,
  zoomIn,
  zoomOut,
  resetView,
  fitToView,
  onPointerDown,
  onPointerMove,
  onPointerUp,
} = useCanvasPanZoom({
  containerRef,
  svgRef,
  contentWidth,
  contentHeight,
})

watch(() => props.mapId, () => {
  resetView()
})

const viewBox = computed(() => `0 0 ${contentWidth.value} ${contentHeight.value}`)

const isActive = (id: string) => snapshot.value?.activeNodeId === id
const isSelected = (id: string) => selectedNodeId.value === id

type RuntimeBadge = {
  text: string
  kind: 'hitl-active' | 'hitl-pending' | 'skill'
  title?: string
}

function nodeBodyText(n: MapNode): string {
  if (n.kind === 'source') return (n.params.label ?? n.params.uri).trim() || '（源）'
  if (n.kind === 'parseAgent') return n.params.agentName
  if (n.kind === 'news') return n.params.content.trim() || '（暂无正文）'
  if (n.kind === 'subAgent') return n.params.agentName
  return n.params.content
}

function nodeDisplayText(n: MapNode): string {
  return labelTruncate(nodeBodyText(n))
}

const NODE_BODY_TOP = 18

function nodeBodyHeight(ln: MapLayoutNode): number {
  return skillBadge(ln.node) ? ln.height - 18 - 28 : ln.height - 18 - 6
}

function nodeKindTag(n: MapNode): string {
  return labelFormatNodeKind(n)
}

function nodeRuntimeBadges(n: MapNode): RuntimeBadge[] {
  const badges: RuntimeBadge[] = []
  const rt = n.runtime
  if (rt?.activeTool) {
    badges.push({
      text: labelFormatHitl(rt.activeTool, 'active'),
      kind: 'hitl-active',
    })
  } else if (rt?.pendingTool) {
    badges.push({
      text: labelFormatHitl(rt.pendingTool, 'pending'),
      kind: 'hitl-pending',
    })
  }
  if (n.kind === 'subAgent' && rt?.activeSkill) {
    badges.push({
      text: labelFormatSkill(rt.activeSkill.name, rt.activeSkill.argsSummary),
      kind: 'skill',
      title: labelFormatSkillTitle(rt.activeSkill.name, rt.activeSkill.argsSummary),
    })
  }
  return badges
}

function hitlBadge(n: MapNode): RuntimeBadge | null {
  return nodeRuntimeBadges(n).find(b => b.kind.startsWith('hitl-')) ?? null
}

function skillBadge(n: MapNode): RuntimeBadge | null {
  return nodeRuntimeBadges(n).find(b => b.kind === 'skill') ?? null
}

function nodeClasses(ln: MapLayoutNode) {
  const n = ln.node
  const snap = snapshot.value
  const cls: Record<string, boolean> = {
    [n.kind]: true,
    active: isActive(n.id),
    selected: isSelected(n.id),
    'has-runtime': !!n.runtime,
    'params-locked': snap ? docIsParamLock(snap, n) : false,
  }
  if (n.kind === 'claim' || n.kind === 'opinion') {
    cls[`phase-${n.dataPhase}`] = true
  }
  if (n.kind === 'claim' && !n.shouldSave) {
    cls['should-not-save'] = true
  }
  if (hitlBadge(n)?.kind === 'hitl-active') cls['tool-active'] = true
  if (hitlBadge(n)?.kind === 'hitl-pending') cls['tool-pending'] = true
  if (skillBadge(n)) cls['skill-active'] = true
  return cls
}

function onSelectNode(id: string) {
  void store.selectNode(id)
}

function onCanvasClick() {
  closeContextMenu()
  void store.selectNode(null)
}

async function ensureMapReady(): Promise<string | null> {
  let mapId = props.mapId ?? workspace.currentMapId
  if (!mapId) {
    await workspace.createMap()
    mapId = workspace.currentMapId
  }
  if (!mapId) return null
  await store.attachMap(mapId)
  return mapId
}

function onCreateRoot(kind: DataRootKind) {
  if (kind === 'source') {
    const input = fileInput.value
    if (!input) return
    if (typeof input.showPicker === 'function') {
      try {
        input.showPicker()
        return
      } catch {
        /* fallback */
      }
    }
    input.click()
    return
  }
  void createDataRoot(kind)
}

async function createDataRoot(kind: 'news' | 'claim') {
  const mapId = await ensureMapReady()
  if (!mapId) return
  if (kind === 'news') {
    await store.addRootNews(mapId)
  } else {
    await store.addRootClaim(mapId)
  }
  await nextTick()
  fitToView()
}

function onContextMenu(ev: MouseEvent) {
  ev.preventDefault()
  contextMenu.value = { visible: true, x: ev.clientX, y: ev.clientY }
}

let dismissMenu: (() => void) | null = null

function closeContextMenu() {
  contextMenu.value.visible = false
  dismissMenu?.()
  dismissMenu = null
}

watch(
  () => contextMenu.value.visible,
  (visible) => {
    dismissMenu?.()
    dismissMenu = null
    if (!visible) return
    const onDismiss = (ev: Event) => {
      if ((ev.target as Element).closest('.canvas-context-menu')) return
      closeContextMenu()
    }
    const onDismissKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeContextMenu()
    }
    dismissMenu = () => {
      document.removeEventListener('pointerdown', onDismiss)
      document.removeEventListener('keydown', onDismissKey)
    }
    requestAnimationFrame(() => {
      document.addEventListener('pointerdown', onDismiss)
      document.addEventListener('keydown', onDismissKey)
    })
  },
)

function onMenuPick(kind: DataRootKind) {
  closeContextMenu()
  onCreateRoot(kind)
}

async function onFileSelected(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const mapId = await ensureMapReady()
  if (!mapId) return
  const path = (file as File & { path?: string }).path ?? file.name
  await store.addSourceChain(path, file.name, mapId)
  await nextTick()
  fitToView()
}
</script>

<template>
  <div
    ref="containerRef"
    class="flow-map-topology"
    @click="onCanvasClick"
    @contextmenu="onContextMenu"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="zoom-controls" @click.stop @pointerdown.stop>
      <button type="button" class="zoom-btn" title="放大" @click="zoomIn">+</button>
      <button type="button" class="zoom-btn" title="缩小" @click="zoomOut">−</button>
      <button type="button" class="zoom-btn zoom-btn-wide" title="适应画布" @click="fitToView">适应</button>
      <button type="button" class="zoom-btn zoom-btn-wide" title="重置为 100%" @click="resetView">{{ scalePercent }}</button>
    </div>

    <Teleport to="body">
      <input
        ref="fileInput"
        type="file"
        accept=".txt,.md,text/plain"
        class="hidden-file"
        @change="onFileSelected"
      >

      <ul
        v-if="contextMenu.visible"
        class="canvas-context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @pointerdown.stop
        @mousedown.stop
        @click.stop
      >
        <li
          v-for="item in CREATE_ROOT_MENU"
          :key="item.kind"
          @pointerdown.stop.prevent="onMenuPick(item.kind)"
        >
          {{ item.label }}
        </li>
      </ul>
    </Teleport>

    <svg
      ref="svgRef"
      class="flow-svg"
      :style="svgStyle"
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <marker
          id="fm-arrow"
          markerWidth="6"
          markerHeight="6"
          refX="5"
          refY="3"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L6,3 L0,6 Z" fill="var(--flow-edge)" />
        </marker>
      </defs>

      <line
        v-for="e in layout?.edges ?? []"
        :key="e.id"
        :x1="e.x1"
        :y1="e.y1"
        :x2="e.x2"
        :y2="e.y2"
        class="fm-edge"
        marker-end="url(#fm-arrow)"
      />

      <g
        v-for="ln in layout?.nodes ?? []"
        :key="ln.node.id"
        :transform="`translate(${ln.x}, ${ln.y})`"
      >
        <g
          class="fm-node"
          :class="nodeClasses(ln)"
          @click.stop="onSelectNode(ln.node.id)"
          @contextmenu.stop
        >
          <rect
            :width="ln.width"
            :height="ln.height"
            rx="4"
            class="fm-rect"
          />
          <text
            x="8"
            y="14"
            class="fm-kind"
            pointer-events="none"
          >
            {{ nodeKindTag(ln.node) }}
          </text>
          <text
            v-if="hitlBadge(ln.node)"
            :x="ln.width - 8"
            y="14"
            text-anchor="end"
            class="fm-tool"
            :class="`fm-tool-${hitlBadge(ln.node)!.kind}`"
            pointer-events="none"
          >
            {{ hitlBadge(ln.node)!.text }}
          </text>
          <foreignObject
            x="8"
            :y="NODE_BODY_TOP"
            :width="ln.width - 16"
            :height="nodeBodyHeight(ln)"
            pointer-events="none"
          >
            <div
              class="fm-body"
              :title="nodeBodyText(ln.node)"
            >
              {{ nodeDisplayText(ln.node) }}
            </div>
          </foreignObject>
          <foreignObject
            v-if="skillBadge(ln.node)"
            x="4"
            :y="ln.height - 28"
            :width="ln.width - 8"
            height="24"
            pointer-events="none"
          >
            <div
              class="fm-skill-chip"
              :title="skillBadge(ln.node)!.title"
            >
              {{ skillBadge(ln.node)!.text }}
            </div>
          </foreignObject>
        </g>
      </g>
    </svg>

    <p v-if="!snapshot" class="empty-hint">加载 Map 快照…</p>
  </div>
</template>

<style scoped>
.flow-map-topology {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  justify-content: stretch;
  background: var(--bg-viewport);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  padding: var(--space-md);
  overflow: hidden;
  position: relative;
  cursor: grab;
  user-select: none;
  -webkit-user-select: none;
}

.flow-map-topology:active {
  cursor: grabbing;
}

.flow-svg {
  width: 100%;
  min-height: 240px;
  max-height: 100%;
  flex: 1;
}

.zoom-controls {
  position: absolute;
  top: var(--space-md);
  right: var(--space-md);
  z-index: 2;
  display: flex;
  gap: 4px;
  background: var(--flow-node-bg, #fff);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  padding: 4px;
  box-shadow: 0 1px 3px rgb(0 0 0 / 8%);
}

.zoom-btn {
  min-width: 28px;
  height: 28px;
  padding: 0 6px;
  border: 1px solid var(--border-subtle);
  border-radius: 4px;
  background: var(--flow-node-bg, #fff);
  color: var(--text, #0f172a);
  font-size: 13px;
  font-family: var(--ui-font);
  cursor: pointer;
}

.zoom-btn:hover {
  background: var(--bg-viewport);
}

.zoom-btn-wide {
  min-width: 44px;
  font-size: 11px;
}

.empty-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: var(--ui-font-size-md);
  pointer-events: none;
}

.hidden-file {
  position: fixed;
  left: -9999px;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.canvas-context-menu {
  position: fixed;
  z-index: 10000;
  min-width: 120px;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
}

.canvas-context-menu li {
  padding: 6px 12px;
  font-size: var(--ui-font-size-md);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.canvas-context-menu li:hover {
  background: var(--bg-hover);
}

.fm-edge {
  stroke: var(--flow-edge, #98a2b3);
  stroke-width: 1.2;
  fill: none;
}

.fm-node { cursor: pointer; }

.fm-rect {
  fill: var(--flow-node-bg, #fff);
  stroke: var(--flow-node-stroke, #cbd5e1);
  stroke-width: 1;
}

.fm-node.source .fm-rect   { fill: #fffbeb; stroke: #b45309; }
.fm-node.parseAgent .fm-rect { fill: #f0f9ff; stroke: #0369a1; }
.fm-node.news .fm-rect      { fill: #f8fafc; stroke: #334155; }
.fm-node.subAgent .fm-rect { fill: var(--flow-node-bg, #eef2ff); stroke: #6366f1; }
.fm-node.claim .fm-rect     { fill: #fefce8; stroke: #ca8a04; }
.fm-node.opinion .fm-rect   { fill: #ecfeff; stroke: #0891b2; }

.fm-node.phase-workerOut .fm-rect { stroke-dasharray: 4 3; }
.fm-node.phase-persisted .fm-rect { stroke-width: 1.5; }
.fm-node.should-not-save .fm-rect { opacity: 0.45; }
.fm-node.should-not-save .fm-body { opacity: 0.55; }

.fm-node.active .fm-rect  { stroke: var(--warning, #d97706); stroke-width: 2; }
.fm-node.selected .fm-rect { stroke: var(--accent, #2563eb); stroke-width: 2; }

.fm-node.tool-active .fm-rect {
  stroke: var(--warning, #d97706);
  animation: fm-pulse 1.4s ease-in-out infinite;
}

.fm-node.skill-active .fm-rect {
  stroke: #0891b2;
}

@keyframes fm-pulse {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.55; }
}

.fm-kind {
  font-size: 9px;
  fill: var(--text-dim, #94a3b8);
  font-family: var(--ui-font);
  letter-spacing: 0.04em;
}

.fm-tool {
  font-size: 9px;
  font-family: var(--ui-font);
  font-weight: 600;
}

.fm-tool-hitl-active {
  fill: var(--warning, #d97706);
}

.fm-tool-hitl-pending {
  fill: #b45309;
}

.fm-skill-chip {
  font-size: 9px;
  line-height: 1.3;
  color: #0e7490;
  background: #ecfeff;
  border: 1px solid #67e8f9;
  border-radius: 3px;
  padding: 2px 4px;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--ui-font);
  font-weight: 600;
}

.fm-body {
  font-size: 11px;
  line-height: 1.35;
  color: var(--text, #0f172a);
  font-family: var(--ui-font);
  font-weight: 500;
  white-space: normal;
  word-break: break-word;
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  text-overflow: ellipsis;
  height: 100%;
  user-select: none;
  -webkit-user-select: none;
}
</style>
