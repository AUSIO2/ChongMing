<script setup lang="ts">
import { computed } from 'vue'
import type { GraphInterruptNode, GraphType } from '../../electron/api/types'

const props = defineProps<{
  graphType: GraphType | null
  nextNode: GraphInterruptNode | null
  status: string
}>()

const nodes = computed(() => {
  const load = props.graphType === 'verify' ? 'loadClaim' : 'loadNews'
  return [load, 'route', 'subAgent', 'merge', 'save']
})

const activeNode = computed(() => {
  if (props.status === 'interrupted' && props.nextNode) return props.nextNode
  if (props.status === 'running') return 'route'
  if (props.status === 'completed') return 'save'
  return null
})

function nodeState(id: string) {
  const order = nodes.value.indexOf(id === 'subAgent' ? 'subAgent' : id)
  const activeIdx = activeNode.value
    ? nodes.value.indexOf(activeNode.value === 'subAgent' ? 'subAgent' : activeNode.value)
    : -1
  if (activeIdx === -1) return 'pending'
  if (order < activeIdx) return 'done'
  if (order === activeIdx) {
    return props.status === 'interrupted' ? 'paused' : 'active'
  }
  return 'pending'
}
</script>

<template>
  <svg class="flow-canvas" viewBox="0 0 520 120" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
        <path d="M0,0 L6,3 L0,6 Z" fill="#9ca3af" />
      </marker>
    </defs>

    <g v-for="(node, i) in nodes" :key="node">
      <line
        v-if="i < nodes.length - 1"
        :x1="60 + i * 110 + 40"
        y1="50"
        :x2="60 + (i + 1) * 110 - 40"
        y2="50"
        stroke="#d1d5db"
        stroke-width="2"
        marker-end="url(#arrow)"
      />
      <rect
        :x="20 + i * 110"
        y="25"
        width="80"
        height="50"
        rx="4"
        :class="['node', nodeState(node)]"
      />
      <text
        :x="60 + i * 110"
        y="55"
        text-anchor="middle"
        class="node-label"
      >
        {{ node }}
      </text>
    </g>
  </svg>
</template>

<style scoped>
.flow-canvas {
  width: 100%;
  height: auto;
}

.node {
  fill: #f9fafb;
  stroke: #d1d5db;
  stroke-width: 1.5;
}

.node.done {
  fill: #ecfdf5;
  stroke: #10b981;
}

.node.active {
  fill: #eff6ff;
  stroke: #2563eb;
  stroke-width: 2;
}

.node.paused {
  fill: #fffbeb;
  stroke: #f59e0b;
  stroke-width: 2;
  animation: pulse-amber 1.5s ease-in-out infinite;
}

.node-label {
  font-size: 9px;
  fill: #374151;
  font-family: var(--ui-font);
}
</style>
