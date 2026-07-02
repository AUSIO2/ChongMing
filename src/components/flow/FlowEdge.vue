<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { LayoutEdge } from '../../types/flow'

const props = defineProps<{
  edge: LayoutEdge
}>()

const pathRef = ref<SVGPathElement | null>(null)
const dashOffset = ref(0)
const pathLength = ref(200)

const d = computed(() => {
  const { x1, y1, x2, y2 } = props.edge
  const dx = Math.abs(x2 - x1)
  const bend = Math.max(24, dx * 0.45)
  const c1x = x1 + bend
  const c2x = x2 - bend
  return `M ${x1} ${y1} C ${c1x} ${y1}, ${c2x} ${y2}, ${x2} ${y2}`
})

const isMerge = computed(() => props.edge.edgeKind === 'mergeBridge')

const dashArray = computed(() => {
  if (isMerge.value) return '6 5'
  if (props.edge.phase === 'entering') return String(pathLength.value)
  return 'none'
})

function updateLength() {
  if (pathRef.value) {
    pathLength.value = pathRef.value.getTotalLength() || 200
    if (props.edge.phase === 'hidden') {
      dashOffset.value = pathLength.value
    } else if (props.edge.phase === 'entering' && !isMerge.value) {
      dashOffset.value = pathLength.value
      requestAnimationFrame(() => {
        dashOffset.value = 0
      })
    } else {
      dashOffset.value = 0
    }
  }
}

onMounted(updateLength)
watch(() => [props.edge.phase, props.edge.x1, props.edge.y1, props.edge.x2, props.edge.y2], updateLength)
</script>

<template>
  <path
    v-if="edge.phase !== 'hidden'"
    ref="pathRef"
    :d="d"
    class="flow-edge"
    :class="[edge.phase, edge.edgeKind]"
    fill="none"
    stroke-width="1.15"
    stroke-linecap="round"
    stroke-linejoin="round"
    pointer-events="none"
    :marker-end="isMerge ? 'url(#flow-arrow-muted)' : 'url(#flow-arrow)'"
    :stroke-dasharray="dashArray"
    :stroke-dashoffset="dashOffset"
    :style="{ transition: edge.phase === 'entering' && !isMerge ? 'stroke-dashoffset 0.45s ease-out' : 'none' }"
  />
</template>

<style scoped>
.flow-edge {
  stroke: var(--flow-edge);
}

.flow-edge.mergeBridge {
  stroke: var(--flow-edge-muted);
  stroke-width: 1;
}

.flow-edge.entering {
  stroke-opacity: 0.85;
}
</style>
