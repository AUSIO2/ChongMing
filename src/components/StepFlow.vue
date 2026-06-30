<script setup lang="ts">
import { computed } from 'vue'
import type { GraphInterruptNode, GraphType } from '../../electron/api/types'

const props = defineProps<{
  graphType: GraphType | null
  nextNode: GraphInterruptNode | null
  status: string
}>()

const splitSteps = [
  { id: 'load', label: '加载' },
  { id: 'route', label: '路由' },
  { id: 'subAgent', label: 'SubAgent' },
  { id: 'merge', label: '合并' },
  { id: 'save', label: '保存' },
]

const verifySteps = [
  { id: 'load', label: '加载' },
  { id: 'route', label: '路由' },
  { id: 'subAgent', label: 'SubAgent' },
  { id: 'merge', label: '合并' },
  { id: 'save', label: '保存' },
]

const steps = computed(() => (props.graphType === 'verify' ? verifySteps : splitSteps))

const activeIndex = computed(() => {
  if (props.status === 'idle') return -1
  if (!props.nextNode) {
    return props.status === 'completed' ? steps.value.length : 1
  }
  const map: Record<GraphInterruptNode, number> = {
    subAgent: 2,
    merge: 3,
    save: 4,
  }
  return map[props.nextNode] ?? 1
})

function stepClass(index: number) {
  if (index < activeIndex.value) return 'done'
  if (index === activeIndex.value) {
    return props.status === 'interrupted' ? 'active pulse' : 'active'
  }
  return 'pending'
}
</script>

<template>
  <div class="step-flow">
    <template v-for="(step, index) in steps" :key="step.id">
      <div class="step" :class="stepClass(index)">
        <span class="dot" />
        <span class="label">{{ step.label }}</span>
      </div>
      <div v-if="index < steps.length - 1" class="connector" :class="stepClass(index)" />
    </template>
  </div>
</template>

<style scoped>
.step-flow {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 0.5rem 0;
}

.step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  min-width: 3.5rem;
}

.dot {
  width: 0.75rem;
  height: 0.75rem;
  border-radius: 50%;
  border: 2px solid var(--border);
  background: #fff;
}

.step.done .dot {
  background: var(--success);
  border-color: var(--success);
}

.step.active .dot {
  background: var(--primary);
  border-color: var(--primary);
}

.step.active.pulse .dot {
  animation: pulse-amber 1.5s ease-in-out infinite;
  background: var(--amber-pulse);
  border-color: var(--amber-pulse);
}

.label {
  font-size: 0.6875rem;
  color: var(--text-muted);
}

.step.active .label {
  color: var(--primary);
  font-weight: 600;
}

.connector {
  flex: 1;
  height: 2px;
  background: var(--border);
  min-width: 1rem;
  margin-bottom: 1rem;
}

.connector.done {
  background: var(--success);
}
</style>
