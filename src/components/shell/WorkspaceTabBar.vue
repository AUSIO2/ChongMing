<script setup lang="ts">
import { storeToRefs } from 'pinia'
import { useRunCoordinatorStore } from '../../stores/run-coordinator'
import {
  useWorkspaceTabsStore,
  type WorkspaceTab,
} from '../../stores/workspace-tabs'

const tabsStore = useWorkspaceTabsStore()
const coordinator = useRunCoordinatorStore()
const { tabs, activeTabId } = storeToRefs(tabsStore)

function tabIcon(tab: WorkspaceTab): string {
  if (tab.kind === 'database') return '⌗'
  if (tab.kind === 'agents') return '◎'
  return '▦'
}

function runDotClass(mapId: string): string | null {
  const phase = coordinator.runReadPhase(mapId)
  if (phase === 'running') return 'dot-running'
  if (phase === 'interrupted') return 'dot-interrupted'
  if (phase === 'error') return 'dot-error'
  return null
}

async function onSelectTab(id: string) {
  await tabsStore.activateTab(id)
}

async function onCloseTab(tab: WorkspaceTab, ev: Event) {
  ev.stopPropagation()
  if (tab.kind === 'map' && coordinator.runReadPhase(tab.id) === 'running') {
    if (!confirm('运行中将取消执行，确定关闭标签？')) return
    await tabsStore.closeTab(tab.id, { forceCancelRunning: true })
    return
  }
  await tabsStore.closeTab(tab.id)
}
</script>

<template>
  <div class="workspace-tab-bar">
    <div v-if="tabs.length === 0" class="tab-empty">
      从左侧选择 Map，或从菜单打开数据库 / 智能体
    </div>
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      class="tab"
      :class="{ active: tab.id === activeTabId }"
      @click="onSelectTab(tab.id)"
    >
      <span class="tab-icon">{{ tabIcon(tab) }}</span>
      <span
        v-if="tab.kind === 'map' && runDotClass(tab.id)"
        class="run-dot"
        :class="runDotClass(tab.id)"
      />
      <span class="tab-title">{{ tab.title }}</span>
      <span
        class="tab-close"
        title="关闭"
        @click="onCloseTab(tab, $event)"
      >×</span>
    </button>
  </div>
</template>

<style scoped>
.workspace-tab-bar {
  display: flex;
  align-items: stretch;
  gap: 0;
  height: 100%;
  flex-shrink: 0;
  overflow-x: auto;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
}

.tab-empty {
  display: flex;
  align-items: center;
  height: 100%;
  padding: 0 var(--space-md);
  font-size: var(--ui-font-size-sm);
  color: var(--text-muted);
}

.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  max-width: 220px;
  padding: 0 10px;
  border: none;
  border-right: 1px solid var(--border-subtle);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--ui-font-size-sm);
  cursor: pointer;
  flex-shrink: 0;
}

.tab:hover {
  background: var(--bg-viewport);
  color: var(--text);
}

.tab.active {
  background: var(--bg-viewport);
  color: var(--text);
  box-shadow: inset 0 -2px 0 var(--accent, #2563eb);
}

.tab-icon {
  opacity: 0.75;
  font-size: 11px;
}

.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tab-close {
  margin-left: 2px;
  padding: 0 4px;
  border-radius: 4px;
  opacity: 0.5;
  line-height: 1;
}

.tab-close:hover {
  opacity: 1;
  background: var(--bg-panel);
}

.run-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.dot-running {
  background: #2563eb;
  animation: pulse 1.2s ease-in-out infinite;
}

.dot-interrupted {
  background: #d97706;
}

.dot-error {
  background: var(--danger, #dc2626);
}

@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
</style>
