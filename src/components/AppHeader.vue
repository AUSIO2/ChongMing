<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../stores/flow-map'
import { RUN_PHASE_LABEL } from '../flow-map'

const store = useFlowMapStore()
const { runPhase } = storeToRefs(store)

const statusText = computed(() => RUN_PHASE_LABEL[runPhase.value])
</script>

<template>
  <header class="top-bar">
    <h1 class="brand">重明</h1>
    <div class="status-area">
      <span class="status-dot" :class="[runPhase]" />
      <span class="status-text">{{ statusText }}</span>
    </div>
  </header>
</template>

<style scoped>
.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 var(--space-md);
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.brand {
  font-size: var(--ui-font-size-lg);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.status-area {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: var(--ui-font-size);
  color: var(--text-muted);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}

.status-dot.running,
.status-dot.interrupted { background: var(--warning); }
.status-dot.completed,
.status-dot.idle { background: var(--text-dim); }
.status-dot.error { background: var(--danger); }
.status-dot.running { background: var(--accent); }
</style>
