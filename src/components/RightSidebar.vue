<script setup lang="ts">
import { storeToRefs } from 'pinia'
import RightNewsPanel from './RightNewsPanel.vue'
import FlowMapInspector from './flow/FlowMapInspector.vue'
import { useFlowMapStore } from '../stores/flow-map'

const { selectedNode } = storeToRefs(useFlowMapStore())
</script>

<template>
  <div class="right-sidebar">
    <RightNewsPanel />
    <FlowMapInspector
      class="inspector"
      :class="{ 'has-selection': !!selectedNode }"
    />
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

.inspector {
  flex: 0 0 auto;
  min-height: 0;
  overflow: hidden;
}

.inspector.has-selection {
  flex: 2 1 0;
  min-height: 0;
}
</style>
