<script setup lang="ts">
import { storeToRefs } from 'pinia'
import PanelRegion from './shell/PanelRegion.vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useMapSidebar } from '../composables/useMapSidebar'

const store = useWorkspaceStore()
const { loading } = storeToRefs(store)
const { mapSidebarExpanded } = useMapSidebar()
</script>

<template>
  <PanelRegion
    v-model:expanded="mapSidebarExpanded"
    title="Map"
    head-only
    class="sidebar-head"
  >
    <template #actions>
      <button class="primary" :disabled="loading" @click="store.createMap()">
        + 新建
      </button>
    </template>
  </PanelRegion>
</template>

<style scoped>
.sidebar-head {
  height: 100%;
}

.sidebar-head :deep(.panel-region-head) {
  height: 100%;
}
</style>
