<script setup lang="ts">
import { computed } from 'vue'
import { usePanelResize } from '../../composables/usePanelResize'
import ResizableSplit from './ResizableSplit.vue'

const { leftWidth, rightWidth, startResizeLeft, startResizeRight } = usePanelResize()

const mainStyle = computed(() => ({
  '--panel-left-width': `${leftWidth.value}px`,
  '--panel-right-width': `${rightWidth.value}px`,
}))
</script>

<template>
  <div class="app-shell" :style="mainStyle">
    <slot name="top" />

    <div class="main-row">
      <aside class="panel-left">
        <slot name="left" />
      </aside>

      <ResizableSplit side="left" @drag-start="startResizeLeft" />

      <main class="panel-center">
        <slot name="center" />
      </main>

      <ResizableSplit side="right" @drag-start="startResizeRight" />

      <aside class="panel-right">
        <slot name="right" />
      </aside>
    </div>

    <div v-if="$slots['bottom-dock']" class="bottom-dock">
      <slot name="bottom-dock" />
    </div>

    <footer class="bottom-bar">
      <slot name="bottom" />
    </footer>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--bg-app);
}

.main-row {
  display: flex;
  flex: 1;
  min-height: 0;
}

.panel-left {
  width: var(--panel-left-width);
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
  border-right: none;
}

.panel-center {
  flex: 1;
  min-width: 280px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-viewport);
}

.panel-right {
  width: var(--panel-right-width);
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-panel);
}

.bottom-dock {
  flex-shrink: 0;
  max-height: 40vh;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.bottom-bar {
  flex-shrink: 0;
  border-top: 1px solid var(--border);
  background: var(--bg-header);
}
</style>
