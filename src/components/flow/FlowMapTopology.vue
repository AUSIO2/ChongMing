<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useFlowMap } from '../../composables/use-flow-map'
import { useCanvasPanZoom } from '../../composables/useCanvasPanZoom'
import type { MapLayoutNode } from '../../flow-map'
import type { MapNode } from '../../flow-map'
import { labelFormatHitl, docIsParamLock, labelFormatSkill, labelFormatSkillTitle, labelFormatNodeKind } from '../../flow-map'

const props = defineProps<{ newsId: string | null }>()

const { store, layout, snapshot, selectedNodeId } = useFlowMap(() => props.newsId)

const containerRef = ref<HTMLElement | null>(null)
const svgRef = ref<SVGSVGElement | null>(null)

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

watch(() => props.newsId, () => {
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

function nodeLabel(n: MapNode): string {
  if (n.kind === 'news') return '新闻'
  if (n.kind === 'subAgent') return n.params.agentName
  return n.params.content
}

function nodePreview(n: MapNode): string | null {
  if (n.kind === 'news') {
    const text = n.params.content
    if (!text) return '（暂无正文）'
    return text.length > 120 ? text.slice(0, 120) + '…' : text
  }
  return null
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
  void store.selectNode(null)
}
</script>

<template>
  <div
    ref="containerRef"
    class="flow-map-topology"
    @click="onCanvasClick"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
  >
    <div class="zoom-controls" @click.stop>
      <button type="button" class="zoom-btn" title="放大" @click="zoomIn">+</button>
      <button type="button" class="zoom-btn" title="缩小" @click="zoomOut">−</button>
      <button type="button" class="zoom-btn zoom-btn-wide" title="适应画布" @click="fitToView">适应</button>
      <button type="button" class="zoom-btn zoom-btn-wide" title="重置为 100%" @click="resetView">{{ scalePercent }}</button>
    </div>

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
          <text
            :x="ln.width / 2"
            :y="ln.node.kind === 'news' ? 32 : (skillBadge(ln.node) ? ln.height / 2 : ln.height / 2 + 6)"
            text-anchor="middle"
            class="fm-label"
            pointer-events="none"
          >
            {{ nodeLabel(ln.node) }}
          </text>
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
          <foreignObject
            v-if="nodePreview(ln.node)"
            x="8"
            y="40"
            :width="ln.width - 16"
            :height="ln.height - 48"
            pointer-events="none"
          >
            <div class="fm-news-preview">{{ nodePreview(ln.node) }}</div>
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

.fm-node.news .fm-rect      { fill: #f8fafc; stroke: #334155; }
.fm-node.subAgent .fm-rect { fill: var(--flow-node-bg, #eef2ff); stroke: #6366f1; }
.fm-node.claim .fm-rect     { fill: #fefce8; stroke: #ca8a04; }
.fm-node.opinion .fm-rect   { fill: #ecfeff; stroke: #0891b2; }

.fm-news-preview {
  font-size: 10px;
  color: var(--text-dim, #64748b);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: normal;
  height: 100%;
}

.fm-node.phase-workerOut .fm-rect { stroke-dasharray: 4 3; }
.fm-node.phase-persisted .fm-rect { stroke-width: 1.5; }
.fm-node.should-not-save .fm-rect { opacity: 0.45; }
.fm-node.should-not-save .fm-label { opacity: 0.55; }

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

.fm-label {
  font-size: 11px;
  fill: var(--text, #0f172a);
  font-family: var(--ui-font);
  font-weight: 500;
}
</style>
