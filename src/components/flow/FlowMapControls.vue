<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../../stores/flow-map'
import { RUN_PHASE_LABEL } from '../../flow-map'
import type { ExecutionMode } from '../../flow-map'

const store = useFlowMapStore()
const { snapshot, runPhase, mode, isRunning, isInterrupted } = storeToRefs(store)

const label = computed(() => RUN_PHASE_LABEL[runPhase.value])
const canRun = computed(() => !!snapshot.value && runPhase.value === 'idle')
const runDisabledReason = computed(() => {
  if (!snapshot.value) return '等待新闻加载…'
  if (runPhase.value === 'running' || runPhase.value === 'interrupted') return '流程进行中'
  if (runPhase.value === 'completed') return '已完成（取消可回到空闲）'
  if (runPhase.value === 'error') return '出错（取消可回到空闲）'
  return null
})
const canContinue = computed(() => isInterrupted.value)
const canCancel = computed(
  () => runPhase.value === 'running'
    || runPhase.value === 'interrupted'
    || runPhase.value === 'completed'
    || runPhase.value === 'error',
)
const focusText = computed(() => {
  const s = snapshot.value
  if (!s?.activeNodeId) return ''
  const n = s.nodes.find(x => x.id === s.activeNodeId)
  if (!n) return `焦点 · ${s.activeNodeId}`
  const t = s.pendingTool ? `（${s.pendingTool}）` : ''
  const name =
    n.kind === 'subAgent' ? n.params.agentName :
    n.kind === 'claim'    ? '事实' :
    n.kind === 'news'     ? '新闻' :
    '意见'
  return `焦点 · ${name}${t}`
})

function onModeChange(ev: Event) {
  const v = (ev.target as HTMLSelectElement).value as ExecutionMode
  void store.setMode(v)
}
</script>

<template>
  <div class="flow-map-controls">
    <span class="status" :class="[runPhase]">{{ label }}</span>

    <label class="mode-select">
      模式
      <select :value="mode" :disabled="isRunning" @change="onModeChange">
        <option value="auto">自动</option>
        <option value="human-in-loop">步进</option>
      </select>
    </label>

    <div class="btn-row">
      <button
        class="primary"
        :disabled="!canRun"
        :title="runDisabledReason ?? ''"
        @click="store.startRun()"
      >
        运行
      </button>
      <button class="primary" :disabled="!canContinue" @click="store.continueStep()">继续</button>
      <button v-if="canCancel" @click="store.cancelRun()">取消</button>
    </div>

    <span v-if="focusText" class="graph-tag">{{ focusText }}</span>
    <span v-else-if="runDisabledReason" class="graph-tag">{{ runDisabledReason }}</span>
  </div>
</template>

<style scoped>
.flow-map-controls {
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

.status.running       { border-color: var(--accent, #2563eb); color: var(--accent, #2563eb); }
.status.interrupted   { border-color: var(--warning, #d97706); color: var(--warning, #d97706); }
.status.error         { border-color: var(--danger, #dc2626); color: var(--danger, #dc2626); }
.status.completed,
.status.idle          { border-color: var(--border-subtle); color: var(--text-muted); }

.mode-select { display: flex; align-items: center; gap: var(--space-xs); font-size: var(--ui-font-size); color: var(--text-muted); }
.mode-select select { width: auto; min-width: 72px; }

.btn-row { display: flex; gap: var(--space-xs); margin-left: auto; }

button { cursor: pointer; padding: 4px 10px; border-radius: 3px; border: 1px solid var(--border-subtle); background: var(--bg-panel); }
button.primary { background: var(--accent, #2563eb); color: #fff; border: none; }
button[disabled] { opacity: 0.5; cursor: not-allowed; }

.graph-tag { font-size: var(--ui-font-size); color: var(--text-dim); }
</style>
