<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { storeToRefs } from 'pinia'
import AppHeader from '../components/AppHeader.vue'
import AppShell from '../components/shell/AppShell.vue'
import NewsSidebar from '../components/NewsSidebar.vue'
import NewsSidebarHead from '../components/NewsSidebarHead.vue'
import RightSidebar from '../components/RightSidebar.vue'
import FlowMapTopology from '../components/flow/FlowMapTopology.vue'
import FlowMapTimelinePanel from '../components/flow/FlowMapTimelinePanel.vue'
import WorkspaceTabBar from '../components/shell/WorkspaceTabBar.vue'
import DatabaseCanvas from '../components/workspace/DatabaseCanvas.vue'
import AgentManagerCanvas from '../components/workspace/AgentManagerCanvas.vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useFlowMapStore } from '../stores/flow-map'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import { useRunCoordinatorStore } from '../stores/run-coordinator'
import { portIsInstalled, portReadApi } from '../flow-map'
import { useAppShortcuts } from '../shortcuts'
import ToolDedupDialog from '../components/tools/ToolDedupDialog.vue'
import ToolBatchSubAgentDialog from '../components/tools/ToolBatchSubAgentDialog.vue'
import { toolDialogOpen } from '../chrome/tool-dialogs'
import { AppStatusBar } from '../chrome'

const workspace = useWorkspaceStore()
const flowMapStore = useFlowMapStore()
const tabsStore = useWorkspaceTabsStore()
const coordinator = useRunCoordinatorStore()
const { storeReadError } = storeToRefs(flowMapStore)
const { activeTab, activeMapId } = storeToRefs(tabsStore)

const hasElectron = typeof window !== 'undefined' && !!window.electronAPI
const canRun = computed(() => hasElectron && portIsInstalled())

const isMapTab = computed(() => activeTab.value?.kind === 'map')

useAppShortcuts(() => isMapTab.value)

let mapUnsub: (() => void) | null = null

watch(
  activeMapId,
  (mapId) => {
    mapUnsub?.()
    mapUnsub = null
    if (!mapId || !canRun.value) return
    mapUnsub = portReadApi().onUpdated(async (id, reason) => {
      if (!tabsStore.hasMapTab(id)) return
      const phase = await coordinator.runSyncPhase(id)
      if (tabsStore.activeMapId === id) void flowMapStore.refresh()
      if (reason === 'completed' && tabsStore.activeMapId === id) {
        void workspace.refreshCurrentMap()
      }
      void phase
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
  await workspace.loadMapList()
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

      <template #left-head>
        <NewsSidebarHead />
      </template>

      <template #left>
        <NewsSidebar />
      </template>

      <template #center-head>
        <WorkspaceTabBar />
      </template>

      <template #center>
        <div class="viewport">
          <div class="canvas">
            <FlowMapTopology
              v-if="activeTab?.kind === 'map'"
              :map-id="activeMapId"
            />
            <DatabaseCanvas v-else-if="activeTab?.kind === 'database'" />
            <AgentManagerCanvas v-else-if="activeTab?.kind === 'agents'" />
            <p v-else class="viewport-empty">暂无打开的画布</p>
          </div>
          <p v-if="isMapTab && storeReadError" class="viewport-msg error">{{ storeReadError }}</p>
        </div>
      </template>

      <template #right>
        <RightSidebar v-if="isMapTab" />
        <div v-else class="right-placeholder panel">
          <p>请打开地图标签以查看侧栏</p>
        </div>
      </template>

      <template #bottom-dock>
        <FlowMapTimelinePanel v-if="isMapTab" />
      </template>

      <template #footer>
        <AppStatusBar />
      </template>
    </AppShell>

    <ToolDedupDialog v-if="toolDialogOpen === 'dedup'" />
    <ToolBatchSubAgentDialog
      v-if="toolDialogOpen === 'batch-subagent' || toolDialogOpen === 'batch-priority'"
    />
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
  position: relative;
}

.canvas {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: var(--space-md);
}

.viewport-empty {
  margin: auto;
  color: var(--text-muted);
  font-size: var(--ui-font-size-md);
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

.right-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-muted);
  font-size: var(--ui-font-size-sm);
  padding: var(--space-md);
  text-align: center;
}

.no-electron {
  margin: 2rem;
  padding: 1rem;
  text-align: center;
  color: var(--text-muted);
}
</style>
