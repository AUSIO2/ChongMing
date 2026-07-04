<script setup lang="ts">
import RightNewsPanel from './RightNewsPanel.vue'
import FlowNodeInspector from './flow/FlowNodeInspector.vue'
import FlowMapInspector from './flow/FlowMapInspector.vue'
import { USE_MAP_FLOW } from '../config/map-flow'

const useMapFlow = USE_MAP_FLOW
</script>

<template>
  <div class="right-sidebar">
    <RightNewsPanel />
    <FlowMapInspector v-if="useMapFlow" class="inspector" />
    <FlowNodeInspector v-else class="inspector" />
  </div>
</template>

<style scoped>
.right-sidebar {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.inspector.collapsed {
  flex: 0 0 auto;
}

.inspector:not(.collapsed) {
  flex: 2 1 0;
  min-height: 0;
}
</style>
