<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../stores/workspace'
import StepFlow from './StepFlow.vue'
import FlowCanvas from './FlowCanvas.vue'
import HitlEditor from './HitlEditor.vue'

const store = useWorkspaceStore()
const {
  currentNews,
  selectedClaimId,
  executionMode,
  viewMode,
  graphType,
  graphStatus,
  nextNode,
  graphState,
  graphError,
  isRunning,
  isInterrupted,
} = storeToRefs(store)

const statusText = computed(() => {
  const map: Record<string, string> = {
    idle: '空闲',
    running: '运行中…',
    interrupted: '等待审核',
    completed: '已完成',
    error: '出错',
  }
  return map[graphStatus.value] ?? graphStatus.value
})

const canSplit = computed(() => currentNews.value && !isRunning.value)
const canVerify = computed(
  () => currentNews.value && selectedClaimId.value && !isRunning.value,
)

function onModeChange(event: Event) {
  const value = (event.target as HTMLSelectElement).value as 'auto' | 'human-in-loop'
  store.setExecutionMode(value)
}
</script>

<template>
  <aside class="workflow panel">
    <div class="workflow-head">
      <h2 class="panel-title">流程控制</h2>
      <span class="status" :class="graphStatus">{{ statusText }}</span>
    </div>

    <div class="controls">
      <label class="mode-select">
        运行模式
        <select :value="executionMode" @change="onModeChange">
          <option value="auto">自动执行</option>
          <option value="human-in-loop">手动步进</option>
        </select>
      </label>

      <div class="btn-row">
        <button class="primary" :disabled="!canSplit" @click="store.startSplit()">
          启动拆分
        </button>
        <button :disabled="!canVerify" @click="store.startVerify()">
          核查选中事实
        </button>
        <button v-if="isRunning || isInterrupted" @click="store.cancelRun()">
          取消
        </button>
      </div>
    </div>

    <div v-if="graphType" class="viz">
      <StepFlow
        v-if="viewMode === 'workspace'"
        :graph-type="graphType"
        :next-node="nextNode"
        :status="graphStatus"
      />
      <FlowCanvas
        v-else
        :graph-type="graphType"
        :next-node="nextNode"
        :status="graphStatus"
      />
    </div>

    <p v-if="graphError" class="error">{{ graphError }}</p>

    <p v-else-if="isRunning" class="running-hint">
      正在调用 LLM（route → subAgent → merge → save），每步可能需要数十秒，请稍候…
    </p>

    <HitlEditor
      v-if="isInterrupted && graphState && graphType && nextNode"
      :graph-type="graphType"
      :next-node="nextNode"
      :state="graphState"
      @resume="store.resume($event)"
    />

    <div v-else-if="graphStatus === 'completed'" class="done-msg panel">
      流程已完成，左侧事实列表已刷新。
    </div>
  </aside>
</template>

<style scoped>
.workflow {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow-y: auto;
}

.workflow-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.status {
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  background: #f3f4f6;
}

.status.running { background: #eff6ff; color: var(--primary); }
.status.interrupted { background: #fffbeb; color: #b45309; }
.status.completed { background: #ecfdf5; color: var(--success); }
.status.error { background: #fef2f2; color: var(--danger); }

.controls {
  padding: 0.75rem;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.mode-select {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
}

.btn-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.viz {
  padding: 0.75rem;
  border-bottom: 1px solid var(--border);
}

.error {
  padding: 0.75rem;
  color: var(--danger);
  font-size: 0.875rem;
}

.running-hint {
  margin: 0.75rem;
  padding: 0.625rem 0.75rem;
  font-size: 0.8125rem;
  color: var(--text-muted);
  background: #f9fafb;
  border: 1px dashed var(--border);
  border-radius: 4px;
}

.done-msg {
  margin: 0.75rem;
  padding: 0.75rem;
  font-size: 0.875rem;
  color: var(--success);
}
</style>
