<script setup lang="ts">
import { computed } from 'vue'
import { usePanelResize } from '../../composables/usePanelResize'
import { useBottomDockResize } from '../../composables/useBottomDockResize'
import ResizableSplit from './ResizableSplit.vue'
import ResizableRowSplit from './ResizableRowSplit.vue'

const { leftWidth, rightWidth, startResizeLeft, startResizeRight } = usePanelResize()
const { dockHeight, startResizeBottom } = useBottomDockResize()

const mainStyle = computed(() => ({
  '--panel-left-width': `${leftWidth.value}px`,
  '--panel-right-width': `${rightWidth.value}px`,
  '--bottom-dock-height': `${dockHeight.value}px`,
}))
</script>

<template>
  <div class="app-shell" :style="mainStyle">
    <slot name="top" />

    <div class="main-row">
      <div class="workspace-bundle">
        <div class="workspace-row">
          <aside class="panel-left">
            <slot name="left" />
          </aside>

          <ResizableSplit side="left" @drag-start="startResizeLeft" />

          <main class="panel-center">
            <slot name="center" />
          </main>
        </div>

        <ResizableRowSplit
          v-if="$slots['bottom-dock']"
          @drag-start="startResizeBottom"
        />

        <div
          v-if="$slots['bottom-dock']"
          class="bottom-dock"
        >
          <slot name="bottom-dock" />
        </div>
      </div>

      <ResizableSplit side="right" @drag-start="startResizeRight" />

      <aside class="panel-right">
        <slot name="right" />
      </aside>
    </div>
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

.workspace-bundle {
  flex: 1;
  min-width: 280px;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.workspace-row {
  flex: 1;
  min-height: 0;
  display: flex;
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
  min-width: 200px;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-viewport);
  overflow: hidden;
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
  height: var(--bottom-dock-height, 132px);
  min-height: 72px;
  overflow: hidden;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}
</style>
