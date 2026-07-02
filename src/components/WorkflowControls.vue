<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../stores/workspace'
import { FLOW_PHASE_LABELS } from '../types/flow'

const store = useWorkspaceStore()
const {
  currentNews,
  selectedClaimId,
  executionMode,
  flowPhase,
  isRunning,
  isInterrupted,
  isSelectingClaims,
  claimsToVerify,
} = storeToRefs(store)

const statusText = computed(() => FLOW_PHASE_LABELS[flowPhase.value])

const canRun = computed(() => currentNews.value && !isRunning.value && !isSelectingClaims.value)
const canConfirmClaims = computed(() => isSelectingClaims.value && claimsToVerify.value.length > 0)

function onModeChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value as 'auto' | 'human-in-loop'
  store.setExecutionMode(value)
}
</script>

<template>
  <div class="workflow-controls">
    <span class="status" :class="[flowPhase]">{{ statusText }}</span>

    <label class="mode-select">
      模式
      <select :value="executionMode" :disabled="isRunning" @change="onModeChange">
        <option value="auto">自动</option>
        <option value="human-in-loop">步进</option>
      </select>
    </label>

    <div class="btn-row">
      <button
        v-if="!isSelectingClaims"
        class="primary"
        :disabled="!canRun"
        @click="store.runPipeline()"
      >
        运行
      </button>
      <template v-else>
        <button
          class="primary"
          :disabled="!canConfirmClaims"
          @click="store.confirmClaimSelection()"
        >
          继续核查 ({{ claimsToVerify.length }})
        </button>
      </template>
      <button v-if="isRunning || isInterrupted" @click="store.cancelRun()">
        取消
      </button>
    </div>

    <span v-if="selectedClaimId && flowPhase === 'running'" class="graph-tag">
      核查 #{{ selectedClaimId }}
    </span>
  </div>
</template>

<style scoped>
.workflow-controls {
  display: flex;
  align-items: center;
  gap: var(--space-md);
  flex-wrap: wrap;
  min-height: 32px;
  padding: 4px var(--space-md);
}

.status {
  font-size: var(--ui-font-size);
  padding: 1px 6px;
  border-radius: var(--radius);
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
}

.status.running { border-color: var(--accent); color: var(--accent); }
.status.awaitingSplit,
.status.awaitingSplitCommit,
.status.awaitingVerifyRoute,
.status.awaitingVerifyCommit,
.status.selectClaims { border-color: var(--warning); color: var(--warning); }
.status.completed,
.status.idle { border-color: var(--border-subtle); color: var(--text-muted); }
.status.error { border-color: var(--danger); color: var(--danger); }

.mode-select {
  display: flex;
  align-items: center;
  gap: var(--space-xs);
  font-size: var(--ui-font-size);
  color: var(--text-muted);
}

.mode-select select {
  width: auto;
  min-width: 72px;
}

.btn-row {
  display: flex;
  gap: var(--space-xs);
  margin-left: auto;
}

.graph-tag {
  font-size: var(--ui-font-size);
  color: var(--text-dim);
}
</style>
