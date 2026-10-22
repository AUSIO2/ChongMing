<!-- 工作台外壳：组合左右侧栏、中心画布、底部面板和可拖动分隔条。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { usePanelResize } from '../../composables/usePanelResize'
import { useBottomDockResize } from '../../composables/useBottomDockResize'
import ResizableSplit from './ResizableSplit.vue'
import ResizableRowSplit from './ResizableRowSplit.vue'

const props = withDefaults(defineProps<{ showRightPanel?: boolean }>(), { showRightPanel: true })
const compactLeftOpen = ref(false)
const compactRightOpen = ref(false)
watch(() => props.showRightPanel, visible => { if (!visible) compactRightOpen.value = false })
function toggleCompactPanel(side: 'left' | 'right'): void {
  if (side === 'left') { compactLeftOpen.value = !compactLeftOpen.value; compactRightOpen.value = false }
  else { compactRightOpen.value = !compactRightOpen.value; compactLeftOpen.value = false }
}
const shell = ref<HTMLElement | null>(null)
const { leftWidth, rightWidth, compact, startResizeLeft, startResizeRight } = usePanelResize(shell, computed(() => props.showRightPanel))
const { dockHeight, startResizeBottom } = useBottomDockResize()

const mainStyle = computed(() => /* 将面板宽度和底部高度投影为布局使用的 CSS 变量。 */ ({
  '--panel-left-width': `${leftWidth.value}px`,
  '--panel-right-width': `${rightWidth.value}px`,
  '--bottom-dock-height': `${dockHeight.value}px`,
}))
</script>

<template>
  <!-- 插槽分别承载顶部、左右面板、画布、底部停靠区和页脚。 -->
  <div ref="shell" class="app-shell" :class="{ compact }" :style="mainStyle">
    <slot name="top" />
    <nav class="compact-panel-controls" aria-label="展开侧栏">
      <button type="button" :aria-expanded="compactLeftOpen" @click="toggleCompactPanel('left')">工作区</button>
      <button v-if="showRightPanel" type="button" :aria-expanded="compactRightOpen" @click="toggleCompactPanel('right')">节点详情</button>
    </nav>

    <div class="main-row">
      <button v-if="compactLeftOpen || compactRightOpen" class="compact-panel-backdrop" type="button" aria-label="关闭侧栏" @click="compactLeftOpen = false; compactRightOpen = false" />
      <div class="workspace-bundle">
        <div class="workspace-row">
          <div class="workspace-col-left" :class="{ 'compact-open': compactLeftOpen }">
            <div class="workspace-head">
              <slot name="left-head" />
            </div>
            <div class="workspace-col-body panel-left">
              <slot name="left" />
            </div>
          </div>

          <ResizableSplit side="left" @drag-start="startResizeLeft" />

          <div class="workspace-col-center">
            <div class="workspace-head">
              <div class="center-heading">
                <div class="center-tabs"><slot name="center-head" /></div>
                <div class="center-actions"><slot name="center-actions" /></div>
              </div>
            </div>
            <div class="workspace-col-body panel-center">
              <slot name="center" />
            </div>
          </div>
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

      <div v-show="props.showRightPanel" class="workspace-right-panel" :class="{ 'compact-open': compactRightOpen }">
        <ResizableSplit side="right" @drag-start="startResizeRight" />
        <aside class="panel-right">
          <slot name="right" />
        </aside>
      </div>
    </div>

    <slot name="footer" />
  </div>
</template>

<style scoped>
/* 用弹性布局与动态尺寸变量组织三栏和底部停靠区。 */
.app-shell {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  background: var(--bg-app);
}

.main-row {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.compact-panel-controls,.compact-panel-backdrop { display:none; }

.workspace-bundle {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.workspace-row {
  flex: 1;
  min-height: 0;
  display: flex;
}

.workspace-col-left,
.workspace-col-center {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.workspace-col-left {
  width: var(--panel-left-width);
  flex-shrink: 0;
}

.workspace-col-center {
  flex: 1;
  min-width: 200px;
}

.workspace-head {
  flex-shrink: 0;
  height: var(--workspace-head-height);
  min-height: var(--workspace-head-height);
  overflow: hidden;
}

.center-heading { display: flex; width: 100%; height: 100%; min-width: 0; align-items: stretch; }
.center-tabs { display: flex; flex: 1; min-width: 0; overflow: hidden; }
.center-actions { display: flex; flex: none; align-items: center; padding: 0 8px; border-left: 1px solid var(--border); background: var(--bg-panel); }

.workspace-col-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-left {
  background: var(--bg-panel);
  border-right: none;
}

.panel-center {
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

.workspace-right-panel { display: flex; flex: none; min-height: 0; }

.bottom-dock {
  flex-shrink: 0;
  height: var(--bottom-dock-height, 132px);
  min-height: 72px;
  overflow: hidden;
  border-top: 1px solid var(--border);
  background: var(--bg-panel);
}

.app-shell.compact .compact-panel-controls { display:flex; flex:none; align-items:center; gap:6px; padding:5px 9px; border-bottom:1px solid var(--border); background:var(--bg-panel); }
.app-shell.compact .compact-panel-controls button { min-height:27px; padding:3px 9px; font-size:11px; }
.app-shell.compact .compact-panel-controls button[aria-expanded='true'] { color:var(--accent); border-color:var(--accent); }
.app-shell.compact .workspace-bundle,.app-shell.compact .workspace-col-center { min-width:0; }
.app-shell.compact .workspace-col-left,.app-shell.compact .workspace-right-panel { display:none; }
.app-shell.compact .workspace-row>.split { display:none; }
.app-shell.compact .workspace-col-left.compact-open { position:absolute; z-index:6; inset:0 auto 0 0; display:flex; width:min(280px,85%); background:var(--bg-panel); box-shadow:4px 0 16px #00000012; }
.app-shell.compact .workspace-right-panel.compact-open { position:absolute; z-index:6; inset:0 0 0 auto; display:flex; width:min(320px,85%); background:var(--bg-panel); box-shadow:-4px 0 16px #00000012; }
.app-shell.compact .workspace-right-panel.compact-open .panel-right { width:100%; }
.app-shell.compact .workspace-right-panel>.split { display:none; }
.app-shell.compact .compact-panel-backdrop { position:absolute; z-index:5; inset:0; display:block; width:100%; height:100%; min-height:0; padding:0; border:0; border-radius:0; background:#00000024; }
</style>
