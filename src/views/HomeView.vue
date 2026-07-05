<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { storeToRefs } from 'pinia'
import AppHeader from '../components/AppHeader.vue'
import AppShell from '../components/shell/AppShell.vue'
import NewsSidebar from '../components/NewsSidebar.vue'
import RightSidebar from '../components/RightSidebar.vue'
import FlowMapTopology from '../components/flow/FlowMapTopology.vue'
import FlowMapControls from '../components/flow/FlowMapControls.vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useFlowMapStore } from '../stores/flow-map'
import { portIsInstalled } from '../flow-map'

const store = useWorkspaceStore()
const flowMapStore = useFlowMapStore()
const { currentNews } = storeToRefs(store)
const { errorMessage: mapError, snapshot: mapSnapshot } = storeToRefs(flowMapStore)
const mapRunError = computed(() => mapSnapshot.value?.error ?? mapError.value)

const hasElectron = typeof window !== 'undefined' && !!window.electronAPI
const canRun = computed(() => hasElectron && portIsInstalled())
const currentNewsId = computed(() => currentNews.value?._id ?? null)

onMounted(async () => {
  if (!canRun.value) return
  await store.loadNewsList()
})
</script>

<template>
  <div class="app-root">
    <div v-if="!canRun" class="no-electron panel">
      请运行 <code>npm run dev</code> 启动 Electron
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
          <FlowMapTopology :news-id="currentNewsId" />
          <p v-if="mapRunError" class="viewport-msg error">{{ mapRunError }}</p>
        </div>
      </template>

      <template #right>
        <RightSidebar />
      </template>

      <template #bottom>
        <FlowMapControls />
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

.no-electron {
  margin: 2rem;
  padding: 1rem;
  text-align: center;
  color: var(--text-muted);
}
</style>
