<script setup lang="ts">
import RightNewsPanel from './RightNewsPanel.vue'
import FlowMapInspector from './flow/FlowMapInspector.vue'
</script>

<template>
  <div class="right-sidebar">
    <RightNewsPanel />
    <FlowMapInspector class="inspector" />
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
