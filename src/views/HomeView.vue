<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import AppHeader from '../components/AppHeader.vue'
import AppShell from '../components/shell/AppShell.vue'
import NewsSidebar from '../components/NewsSidebar.vue'
import RightSidebar from '../components/RightSidebar.vue'
import FlowMapTopology from '../components/flow/FlowMapTopology.vue'
import FlowMapTimelinePanel from '../components/flow/FlowMapTimelinePanel.vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useFlowMapStore } from '../stores/flow-map'
import { portIsInstalled, portReadApi } from '../flow-map'
import { useAppShortcuts } from '../shortcuts'

const store = useWorkspaceStore()
const flowMapStore = useFlowMapStore()
const { currentMap } = storeToRefs(store)
const { storeReadError } = storeToRefs(flowMapStore)

const hasElectron = typeof window !== 'undefined' && !!window.electronAPI
const canRun = computed(() => hasElectron && portIsInstalled())
const currentMapId = computed(() => currentMap.value?._id ?? null)

useAppShortcuts()

let mapUnsub: (() => void) | null = null

watch(
  currentMapId,
  (mapId) => {
    mapUnsub?.()
    mapUnsub = null
    if (!mapId || !canRun.value) return
    mapUnsub = portReadApi().onUpdated((id, reason) => {
      if (id !== mapId) return
      void flowMapStore.refresh()
      if (reason === 'completed') void store.refreshCurrentMap()
    })
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  mapUnsub?.()
  mapUnsub = null
})

onMounted(async () => {
  if (!canRun.value) return
  await store.loadMapList()
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
          <FlowMapTopology :map-id="currentMapId" />
          <p v-if="storeReadError" class="viewport-msg error">{{ storeReadError }}</p>
        </div>
      </template>

      <template #right>
        <RightSidebar />
      </template>

      <template #bottom-dock>
        <FlowMapTimelinePanel />
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
