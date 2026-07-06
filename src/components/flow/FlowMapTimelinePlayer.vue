<script setup lang="ts">
import type { ExecutionMode } from '../../flow-map'
import {
  DATA_FRAME_LABEL,
  MAP_DATA_FRAME,
  type DataFrameIndex,
  type FrameIndex,
} from '../../flow-map/timeline-frame'

defineProps<{
  mode: ExecutionMode
  isRunning: boolean
  isInterrupted: boolean
  primaryLabel: string
  primaryDisabled: boolean
  primaryHint: string
  canCancel: boolean
  focusText: string
  dataEnd: DataFrameIndex
  playheadFrame: FrameIndex
}>()

const emit = defineEmits<{
  modeChange: [ExecutionMode]
  primary: []
  cancel: []
  dataEndChange: [DataFrameIndex]
  jumpStart: []
  jumpEnd: []
}>()

function onModeChange(ev: Event) {
  emit('modeChange', (ev.target as HTMLSelectElement).value as ExecutionMode)
}

function onEndChange(ev: Event) {
  const v = Number((ev.target as HTMLSelectElement).value) as DataFrameIndex
  emit('dataEndChange', v)
}
</script>

<template>
  <header class="timeline-player">
    <label class="mode-select">
      回放
      <select :value="mode" :disabled="isRunning" @change="onModeChange">
        <option value="auto">自动</option>
        <option value="human-in-loop">步进</option>
      </select>
    </label>

    <label class="end-select">
      结束
      <select
        :value="dataEnd"
        :disabled="isRunning"
        @change="onEndChange"
      >
        <option
          v-for="f in MAP_DATA_FRAME"
          :key="f"
          :value="f"
        >
          {{ DATA_FRAME_LABEL[f] }}
        </option>
      </select>
    </label>

    <div class="transport">
      <button
        type="button"
        class="transport-btn"
        title="跳到起点"
        :disabled="isRunning"
        @click="emit('jumpStart')"
      >
        |◀
      </button>
      <button
        type="button"
        class="transport-btn primary"
        :class="{ continue: isInterrupted }"
        :disabled="primaryDisabled"
        :title="primaryHint"
        @click="emit('primary')"
      >
        {{ primaryLabel }}
      </button>
      <button
        v-if="canCancel"
        type="button"
        class="transport-btn ghost"
        @click="emit('cancel')"
      >
        取消
      </button>
      <button
        type="button"
        class="transport-btn"
        title="跳到结束"
        :disabled="isRunning"
        @click="emit('jumpEnd')"
      >
        ▶|
      </button>
    </div>

    <span class="player-hint">{{ focusText }}</span>

    <span class="frame-badge">Frame [{{ playheadFrame }}]</span>
  </header>
</template>

<style scoped>
.timeline-player {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  flex-shrink: 0;
  padding: 4px var(--space-sm);
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.mode-select,
.end-select {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-muted);
  white-space: nowrap;
}

.mode-select select,
.end-select select {
  width: auto;
  min-width: 64px;
  padding: 2px 4px;
}

.transport {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.transport-btn {
  cursor: pointer;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid var(--border-subtle);
  background: var(--bg-panel);
  font-size: var(--ui-font-size);
  line-height: 1.2;
}

.transport-btn.primary {
  background: var(--accent, #2563eb);
  color: #fff;
  border: none;
  min-width: 48px;
}

.transport-btn.primary.continue {
  background: var(--warning, #d97706);
}

.transport-btn.ghost {
  background: transparent;
}

.transport-btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.player-hint {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: 11px;
}

.frame-badge {
  flex-shrink: 0;
  padding: 1px 6px;
  border-radius: var(--radius);
  border: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
