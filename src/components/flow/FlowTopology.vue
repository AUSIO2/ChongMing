<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { buildUnifiedFlowNodes } from '../../composables/useUnifiedFlowFromNews'
import { useFlowTopology } from '../../composables/useFlowTopology'
import { useWorkspaceStore } from '../../stores/workspace'
import FlowEdge from './FlowEdge.vue'

const store = useWorkspaceStore()
const {
  flowNodes,
  currentNews,
  graphState,
  graphType,
  graphStatus,
  nextNode,
  flowPhase,
  selectedFlowNodeId,
  pipelineStatus,
  activeClaimId,
  claimsToVerify,
  commitMergedClaims,
  isSplitCommitStep,
} = storeToRefs(store)

const displayNodes = computed(() =>
  buildUnifiedFlowNodes({
    news: currentNews.value,
    graphState: graphState.value,
    graphType: graphType.value,
    runtimeNodes: flowNodes.value,
    pipelineStatus: pipelineStatus.value,
    activeClaimId: activeClaimId.value,
    claimsToVerify: claimsToVerify.value,
    commitMergedClaims: commitMergedClaims.value,
    isSplitCommitStep: isSplitCommitStep.value,
    graphStatus: graphStatus.value,
    nextNode: nextNode.value,
  }),
)

const { layoutNodes, layoutEdges, viewBox } = useFlowTopology(displayNodes)

const visibleNodes = computed(() =>
  layoutNodes.value.filter(n => n.phase !== 'hidden'),
)

function nodeClasses(node: typeof visibleNodes.value[number]) {
  return [
    node.phase,
    node.nodeCategory,
    node.kind,
    {
      selected: selectedFlowNodeId.value === node.id,
      bridge: node.isBridge,
      preview: node.isPreview,
      'pending-delete': node.pendingDelete,
      agent: node.nodeCategory === 'agent',
      info: node.nodeCategory === 'info',
    },
  ]
}

function onSelectNode(id: string) {
  store.selectFlowNode(id)
}

function onCanvasClick() {
  store.selectFlowNode(null)
}

const isCanvasContext = computed(
  () => (flowPhase.value === 'awaitingSplit' || flowPhase.value === 'awaitingVerifyRoute')
    && !selectedFlowNodeId.value,
)
</script>

<template>
  <div
    class="flow-topology"
    :class="{ 'canvas-selected': isCanvasContext }"
    @click="onCanvasClick"
  >
    <svg
      class="flow-svg"
      :viewBox="viewBox"
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
      @click="onCanvasClick"
    >
      <defs>
        <marker
          id="flow-arrow"
          markerWidth="5"
          markerHeight="5"
          refX="4.5"
          refY="2.5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L5,2.5 L0,5 Z" fill="var(--flow-edge)" />
        </marker>
        <marker
          id="flow-arrow-muted"
          markerWidth="5"
          markerHeight="5"
          refX="4.5"
          refY="2.5"
          orient="auto"
          markerUnits="strokeWidth"
        >
          <path d="M0,0 L5,2.5 L0,5 Z" fill="var(--flow-edge-muted)" />
        </marker>
        <linearGradient id="bridge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35" />
          <stop offset="100%" stop-color="var(--success)" stop-opacity="0.25" />
        </linearGradient>
      </defs>

      <FlowEdge
        v-for="edge in layoutEdges"
        :key="edge.id"
        :edge="edge"
      />

      <g
        v-for="node in visibleNodes"
        :key="node.id"
        :transform="`translate(${node.x}, ${node.y})`"
      >
        <g
          class="flow-node"
          :class="nodeClasses(node)"
          :style="{ transitionDelay: node.spawnIndex != null ? `${node.spawnIndex * 100}ms` : '0ms' }"
          @click.stop="onSelectNode(node.id)"
        >
        <!-- Agent 节点 -->
        <template v-if="node.nodeCategory === 'agent'">
          <rect
            :width="node.width"
            :height="node.height"
            rx="2"
            class="node-rect agent-rect"
          />
          <rect
            :width="node.width"
            height="10"
            rx="2"
            class="agent-header"
          />
          <text
            x="6"
            y="7"
            class="agent-role"
            pointer-events="none"
          >
            {{ node.stage === 'split' ? '拆分' : '核查' }}
          </text>
          <text
            :x="node.width / 2"
            :y="node.height / 2 + 4"
            text-anchor="middle"
            dominant-baseline="central"
            class="node-label agent-label"
            pointer-events="none"
          >
            {{ node.label }}
          </text>
        </template>

        <!-- Info 节点 -->
        <template v-else>
          <rect
            :width="node.width"
            :height="node.height"
            rx="2"
            class="node-rect info-rect"
            :class="{ 'bridge-rect': node.isBridge, 'preview-rect': node.isPreview, 'pending-delete-rect': node.pendingDelete }"
          />
          <text
            x="6"
            y="9"
            class="info-type"
            pointer-events="none"
          >
            {{ node.infoType === 'opinion' ? '意见' : (node.isPreview ? '合并' : (node.isBridge && node.agentName === 'merge' ? '合并' : '事实')) }}
          </text>
          <text
            :x="node.width / 2"
            :y="node.height / 2 + 5"
            text-anchor="middle"
            dominant-baseline="central"
            class="node-label info-label"
            pointer-events="none"
          >
            {{ node.label }}
          </text>
          <text
            v-if="node.isBridge && node.claimId"
            :x="node.width - 6"
            y="9"
            text-anchor="end"
            class="bridge-id"
            pointer-events="none"
          >
            #{{ node.claimId }}
          </text>
        </template>
        </g>
      </g>
    </svg>

    <p v-if="!currentNews" class="empty-hint">
      从左侧选择新闻，查看拆分与核查流程
    </p>
    <p v-else-if="!visibleNodes.length" class="empty-hint">
      点击「运行」启动流程，节点将随进度出现
    </p>
  </div>
</template>

<style scoped>
.flow-topology {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-viewport);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius);
  padding: var(--space-md);
  overflow: auto;
  position: relative;
  cursor: default;
}

.flow-topology.canvas-selected {
  outline: 2px solid var(--warning);
  outline-offset: -2px;
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
  text-align: center;
  padding: 2rem;
  pointer-events: none;
}

.flow-node {
  cursor: pointer;
  opacity: 0;
  animation: node-grow 0.3s ease-out forwards;
}

.flow-node.entering,
.flow-node.active,
.flow-node.done,
.flow-node.paused {
  opacity: 1;
}

.flow-node.selected .node-rect {
  stroke-width: 2;
  stroke: var(--accent);
}

.node-rect {
  stroke-width: 1;
  cursor: pointer;
}

.agent-rect {
  fill: var(--flow-node-bg);
  stroke: var(--flow-node-stroke);
}

.agent-header {
  fill: var(--bg-header);
  stroke: none;
  pointer-events: none;
}

.agent-role {
  font-size: 7px;
  fill: var(--text-dim);
  font-family: var(--ui-font);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.agent-label {
  font-size: 10px;
  fill: var(--text);
  font-family: var(--ui-font);
  font-weight: 500;
}

.info-rect {
  fill: var(--flow-info-bg);
  stroke: var(--flow-info-stroke);
}

.bridge-rect {
  fill: url(#bridge-gradient);
  stroke: var(--accent);
  stroke-width: 1.5;
}

.preview-rect {
  fill: #fff8ee;
  stroke: var(--accent);
  stroke-width: 1.5;
}

.pending-delete-rect {
  fill: transparent;
  stroke: var(--text-dim);
  stroke-width: 1.5;
  stroke-dasharray: 5 4;
  opacity: 0.7;
}

.flow-node.pending-delete .info-label {
  opacity: 0.65;
  text-decoration: line-through;
}

.info-type {
  font-size: 7px;
  fill: var(--text-dim);
  font-family: var(--ui-font);
}

.info-label {
  font-size: 9px;
  fill: var(--text-muted);
  font-family: var(--ui-font);
}

.bridge-id {
  font-size: 7px;
  fill: var(--text-dim);
  font-family: var(--ui-font);
}

.flow-node.done.agent .agent-rect {
  fill: var(--flow-node-done-bg);
  stroke: var(--flow-node-done-stroke);
}

.flow-node.active.agent .agent-rect {
  fill: var(--flow-node-active-bg);
  stroke: var(--flow-node-active-stroke);
  stroke-width: 1.5;
}

.flow-node.paused.agent .agent-rect {
  fill: #fff8ee;
  stroke: var(--warning);
  stroke-width: 1.5;
  animation: pulse-amber 1.5s ease-in-out infinite;
}

.flow-node.done.info .info-rect:not(.bridge-rect) {
  fill: var(--flow-info-done-bg);
  stroke: var(--flow-info-done-stroke);
}

.flow-node.active.info .info-rect {
  stroke: var(--accent);
}

.flow-node.bridge.selected .bridge-rect {
  stroke-width: 2;
  stroke: var(--accent);
}

@keyframes node-grow {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes pulse-amber {
  0%, 100% { stroke-opacity: 1; }
  50% { stroke-opacity: 0.45; }
}
</style>
