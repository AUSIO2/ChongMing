<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const { viewMode } = storeToRefs(store)

function setView(mode: 'workspace' | 'flow') {
  store.viewMode = mode
}
</script>

<template>
  <header class="header">
    <div class="brand">
      <h1>崇明</h1>
      <span>事实拆分与核查系统</span>
    </div>
    <div class="view-toggle">
      <button
        :class="{ active: viewMode === 'workspace' }"
        @click="setView('workspace')"
      >
        工作台
      </button>
      <button
        :class="{ active: viewMode === 'flow' }"
        @click="setView('flow')"
      >
        流程图
      </button>
    </div>
  </header>
</template>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}

.brand {
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
}

.brand h1 {
  font-size: 1.125rem;
  font-weight: 700;
}

.brand span {
  font-size: 0.875rem;
  color: var(--text-muted);
}

.view-toggle {
  display: flex;
  gap: 0.25rem;
}

.view-toggle button.active {
  background: var(--primary);
  border-color: var(--primary);
  color: #fff;
}
</style>
