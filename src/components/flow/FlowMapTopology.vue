<script setup lang="ts">
import { computed } from 'vue'
import { useFlowMap } from '../../composables/use-flow-map'
import type { MapLayoutNode } from '../../flow-map'
import type { MapNode } from '../../flow-map'
import { isParamsLocked } from '../../flow-map'

const props = defineProps<{ newsId: string | null }>()

const { store, layout, snapshot, selectedNodeId } = useFlowMap(() => props.newsId)

const viewBox = computed(() => {
  const l = layout.value
  if (!l) return '0 0 600 300'
  return `0 0 ${Math.max(l.width, 600)} ${Math.max(l.height, 300)}`
})

const isActive = (id: string) => snapshot.value?.activeNodeId === id
const isSelected = (id: string) => selectedNodeId.value === id

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
  if (n.kind === 'news') return '新闻'
  if (n.kind === 'subAgent') return 'SubAgent'
  if (n.kind === 'claim') return '事实'
  return '意见'
}

function nodeToolBadge(n: MapNode): string | null {
  const t = n.runtime?.pendingTool ?? n.runtime?.activeTool
  if (!t) return null
  return t === 'save' ? '保存' : t === 'validate' ? '校验' : '调用'
}

function nodeClasses(ln: MapLayoutNode) {
  const n = ln.node
  const snap = snapshot.value
  const cls: Record<string, boolean> = {
    [n.kind]: true,
    active: isActive(n.id),
    selected: isSelected(n.id),
    'has-runtime': !!n.runtime,
    'params-locked': snap ? isParamsLocked(snap, n) : false,
  }
  if (n.kind === 'claim' || n.kind === 'opinion') {
    cls[`phase-${n.dataPhase}`] = true
  }
  if (n.kind === 'claim' && !n.shouldSave) {
    cls['should-not-save'] = true
  }
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
  <div class="flow-map-topology" @click="onCanvasClick">
    <svg
      class="flow-svg"
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
            v-if="nodeToolBadge(ln.node)"
            :x="ln.width - 8"
            y="14"
            text-anchor="end"
            class="fm-tool"
            pointer-events="none"
          >
            {{ nodeToolBadge(ln.node) }}
          </text>
          <text
            :x="ln.width / 2"
            :y="ln.node.kind === 'news' ? 32 : ln.height / 2 + 6"
            text-anchor="middle"
            class="fm-label"
            pointer-events="none"
          >
            {{ nodeLabel(ln.node) }}
          </text>
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
  overflow: auto;
  position: relative;
}

.flow-svg {
  width: 100%;
  min-height: 240px;
  max-height: 100%;
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

.fm-kind {
  font-size: 9px;
  fill: var(--text-dim, #94a3b8);
  font-family: var(--ui-font);
  letter-spacing: 0.04em;
}

.fm-tool {
  font-size: 9px;
  fill: var(--warning, #d97706);
  font-family: var(--ui-font);
}

.fm-label {
  font-size: 11px;
  fill: var(--text, #0f172a);
  font-family: var(--ui-font);
  font-weight: 500;
}
</style>
