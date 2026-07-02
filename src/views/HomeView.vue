<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'
import AppHeader from '../components/AppHeader.vue'
import AppShell from '../components/shell/AppShell.vue'
import NewsSidebar from '../components/NewsSidebar.vue'
import RightSidebar from '../components/RightSidebar.vue'
import FlowTopology from '../components/flow/FlowTopology.vue'
import WorkflowControls from '../components/WorkflowControls.vue'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const {
  graphError,
  isRunning,
} = storeToRefs(store)

const isMock = import.meta.env.VITE_MOCK_ELECTRON
const hasElectron = typeof window !== 'undefined' && !!window.electronAPI
const canRun = computed(() => hasElectron)

onMounted(async () => {
  if (!canRun.value) return
  store.initGraphEvents()
  if (isMock) {
    await store.loadNewsList()
    const first = store.newsList[0]
    if (first) await store.selectNews(first._id)
  }
})

onUnmounted(() => store.disposeGraphEvents())
</script>

<template>
  <div class="app-root">
    <div v-if="isMock" class="mock-banner">
      Web 预览（Mock）— 热更新可用
    </div>

    <div v-if="!canRun" class="no-electron panel">
      请运行 <code>npm run dev</code> 或 <code>npm run dev:web</code>
    </div>

    <AppShell v-else class="shell">
      <template #top>
        <AppHeader />
      </template>

      <template #left>
        <NewsSidebar />
      </template>

      <template #center>
        <div class="viewport">
          <FlowTopology />
          <p v-if="graphError" class="viewport-msg error">{{ graphError }}</p>
          <p v-else-if="isRunning" class="viewport-msg">流程执行中…</p>
        </div>
      </template>

      <template #right>
        <RightSidebar />
      </template>

      <template #bottom>
        <WorkflowControls />
      </template>
    </AppShell>
  </div>
</template>

<style scoped>
.app-root {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.shell {
  flex: 1;
  min-height: 0;
}

.viewport {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-md);
  position: relative;
}

.viewport-msg {
  margin-top: var(--space-sm);
  padding: var(--space-sm) var(--space-md);
  font-size: var(--ui-font-size-md);
  color: var(--text-muted);
  background: var(--bg-panel);
  border: 1px dashed var(--border-subtle);
}

.viewport-msg.error {
  color: var(--danger);
  border-style: solid;
}

.mock-banner {
  padding: 2px var(--space-md);
  font-size: var(--ui-font-size);
  text-align: center;
  color: #7c5a00;
  background: #fff8e6;
  border-bottom: 1px solid #e8c84a;
  flex-shrink: 0;
}

.no-electron {
  margin: 2rem;
  padding: 1rem;
  text-align: center;
  color: var(--text-muted);
}
</style>
