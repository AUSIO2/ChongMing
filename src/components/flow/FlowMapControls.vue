<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../../stores/flow-map'
import { RUN_PHASE_LABEL, labelFormatFocusNode, labelFormatHitl } from '../../flow-map'
import type { ExecutionMode } from '../../flow-map'

const store = useFlowMapStore()
const { snapshot, runPhase, mode, isRunning, isInterrupted } = storeToRefs(store)

const label = computed(() => RUN_PHASE_LABEL[runPhase.value])

/** 主按钮：idle/error → 运行；interrupted → 继续 */
const primaryAction = computed<'run' | 'continue' | null>(() => {
  if (!snapshot.value) return null
  if (runPhase.value === 'idle' || runPhase.value === 'error') return 'run'
  if (runPhase.value === 'interrupted') return 'continue'
  return null
})

const primaryLabel = computed(() =>
  primaryAction.value === 'continue' ? '继续' : '运行',
)

const primaryDisabled = computed(() => primaryAction.value == null)

const primaryHint = computed(() => {
  if (!snapshot.value) return '等待新闻加载…'
  if (runPhase.value === 'running') return '执行中（调用模型，请稍候或取消）'
  if (runPhase.value === 'interrupted') return '已暂停，点主按钮推进下一步'
  if (runPhase.value === 'completed') return '已完成（取消可回到空闲）'
  if (runPhase.value === 'error') return '上次出错，可重新运行'
  return null
})

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
  const t = s.pendingTool ? `（${labelFormatHitl(s.pendingTool, 'pending')}）` : ''
  return `焦点 · ${labelFormatFocusNode(n)}${t}`
})

function onModeChange(ev: Event) {
  const v = (ev.target as HTMLSelectElement).value as ExecutionMode
  void store.setMode(v)
}

function onPrimary() {
  if (primaryAction.value === 'continue') {
    void store.continueStep()
    return
  }
  if (primaryAction.value === 'run') {
    void store.startRun()
  }
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
        :class="{ continue: isInterrupted }"
        :disabled="primaryDisabled"
        :title="primaryHint ?? ''"
        @click="onPrimary"
      >
        {{ primaryLabel }}
      </button>
      <button v-if="canCancel" @click="store.cancelRun()">取消</button>
    </div>

    <span v-if="focusText" class="graph-tag">{{ focusText }}</span>
    <span v-else-if="primaryHint" class="graph-tag">{{ primaryHint }}</span>
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
button.primary.continue { background: var(--warning, #d97706); }
button[disabled] { opacity: 0.5; cursor: not-allowed; }

.graph-tag { font-size: var(--ui-font-size); color: var(--text-dim); }
</style>
