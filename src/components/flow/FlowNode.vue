<script setup lang="ts">
import type { LayoutNode } from '../../types/flow'

defineProps<{
  node: LayoutNode
  selected?: boolean
}>()

const emit = defineEmits<{
  select: [id: string]
}>()
</script>

<template>
  <g
    class="flow-node"
    :class="[node.phase, { selected }]"
    :transform="`translate(${node.x}, ${node.y})`"
    :style="{ transitionDelay: node.spawnIndex != null ? `${node.spawnIndex * 120}ms` : '0ms' }"
    @click.stop="emit('select', node.id)"
  >
    <rect
      :width="node.width"
      :height="node.height"
      rx="4"
      class="node-rect"
    />
    <text
      :x="node.width / 2"
      :y="node.height / 2"
      text-anchor="middle"
      dominant-baseline="central"
      class="node-label"
    >
      {{ node.label }}
    </text>
  </g>
</template>

<style scoped>
.flow-node {
  cursor: pointer;
  opacity: 0;
  transform-origin: center;
  animation: node-grow 0.35s ease-out forwards;
}

.flow-node.hidden {
  opacity: 0;
  animation: none;
  pointer-events: none;
}

.flow-node.entering,
.flow-node.active,
.flow-node.done,
.flow-node.paused {
  opacity: 1;
}

.flow-node.selected .node-rect {
  stroke-width: 2.5;
}

.node-rect {
  fill: #f9fafb;
  stroke: #d1d5db;
  stroke-width: 1.5;
  transition: fill 0.2s, stroke 0.2s;
}

.flow-node.done .node-rect {
  fill: #ecfdf5;
  stroke: #10b981;
}

.flow-node.active .node-rect {
  fill: #eff6ff;
  stroke: #2563eb;
  stroke-width: 2;
}

.flow-node.paused .node-rect {
  fill: #fffbeb;
  stroke: #f59e0b;
  stroke-width: 2;
  animation: pulse-amber 1.5s ease-in-out infinite;
}

.node-label {
  font-size: 10px;
  fill: #374151;
  font-family: var(--ui-font);
  pointer-events: none;
}

@keyframes node-grow {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>
