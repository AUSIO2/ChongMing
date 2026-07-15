<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../stores/flow-map'
import { RUN_PHASE_LABEL } from '../flow-map'
import { useStatusBarHealth } from '../composables/useStatusBarHealth'

const { runPhase } = storeToRefs(useFlowMapStore())
const {
  version,
  dbHealth,
  endpointPing,
  endpointHealth,
  endpointChecking,
  refreshEndpoint,
} = useStatusBarHealth()

const statusText = computed(() => RUN_PHASE_LABEL[runPhase.value])

const endpointLabel = computed(() => {
  if (endpointChecking.value) return '检测中…'
  const ping = endpointPing.value
  if (!ping) return '—'
  if (!ping.ok) return `${ping.host} · 不可用`
  return `${ping.host} · ${ping.latencyMs}ms`
})

const endpointTitle = computed(() => {
  const ping = endpointPing.value
  if (!ping) return '点击检测 endpoint 连通性'
  if (ping.error) return `${ping.baseUrl}\n${ping.error}`
  return ping.baseUrl
})

const networkTone = computed(() => {
  switch (endpointHealth.value) {
    case 'ok': return 'ok'
    case 'slow': return 'slow'
    case 'error': return 'error'
    default: return 'muted'
  }
})

const dbTone = computed(() => (dbHealth.value.connected ? 'ok' : 'error'))
</script>

<template>
  <footer class="app-status-bar" aria-label="状态栏">
    <div class="status-left">
      <span class="status-dot" :class="[runPhase]" />
      <span class="status-text">{{ statusText }}</span>
    </div>

    <div class="status-right">
      <button
        type="button"
        class="status-item"
        :title="endpointTitle"
        @click="refreshEndpoint()"
      >
        <svg
          class="status-icon"
          :class="networkTone"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <path
            fill="currentColor"
            d="M8 13.5a1.25 1.25 0 1 0 0-2.5 1.25 1.25 0 0 0 0 2.5Zm-3.9-2.1a4.5 4.5 0 0 1 6.3 0l.9.9 1.4-1.4-.9-.9a6.5 6.5 0 0 0-8.2 0l-.9.9 1.4 1.4.9-.9ZM2.7 7.3a7.5 7.5 0 0 1 10.6 0l.9.9L15.6 6.7l-.9-.9a9.5 9.5 0 0 0-13.4 0l-.9.9 1.4 1.4.9-.9Z"
          />
        </svg>
        <span class="status-item-text">{{ endpointLabel }}</span>
      </button>

      <span class="status-sep" aria-hidden="true" />

      <span class="status-item" :title="dbHealth.title">
        <svg
          class="status-icon"
          :class="dbTone"
          viewBox="0 0 16 16"
          width="12"
          height="12"
          aria-hidden="true"
        >
          <ellipse cx="8" cy="4" rx="5.5" ry="2" fill="none" stroke="currentColor" stroke-width="1.2" />
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            d="M2.5 4v8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2V4"
          />
          <path
            fill="none"
            stroke="currentColor"
            stroke-width="1.2"
            d="M2.5 8c0 1.1 2.46 2 5.5 2s5.5-.9 5.5-2"
          />
        </svg>
        <span class="status-item-text">{{ dbHealth.label }}</span>
      </span>

      <span class="status-sep" aria-hidden="true" />

      <span class="status-item version">v{{ version }}</span>
    </div>
  </footer>
</template>

<style scoped>
.app-status-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--space-md);
  height: var(--statusbar-height);
  min-height: var(--statusbar-height);
  padding: 0 var(--space-md);
  border-top: 1px solid var(--border-subtle);
  background: var(--bg-header);
  font-size: var(--ui-font-size);
  color: var(--text-muted);
  -webkit-app-region: no-drag;
}

.status-left,
.status-right {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  min-width: 0;
}

.status-right {
  margin-left: auto;
  flex-shrink: 0;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
  flex-shrink: 0;
}

.status-dot.running { background: var(--accent); }
.status-dot.interrupted { background: var(--warning); }
.status-dot.completed,
.status-dot.idle { background: var(--text-dim); }
.status-dot.error { background: var(--danger); }

.status-text {
  white-space: nowrap;
}

.status-item {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  border: none;
  background: transparent;
  padding: 0;
  color: inherit;
  font: inherit;
  cursor: default;
}

button.status-item {
  cursor: pointer;
}

button.status-item:hover {
  color: var(--text);
}

.status-item-text {
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status-sep {
  width: 1px;
  height: 12px;
  background: var(--border-subtle);
  flex-shrink: 0;
}

.status-icon.ok { color: var(--success); }
.status-icon.slow { color: var(--warning); }
.status-icon.error { color: var(--danger); }
.status-icon.muted { color: var(--text-dim); }

.version {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
</style>
