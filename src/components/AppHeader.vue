<script setup lang="ts">
import { computed } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../stores/workspace'
import { useFlowMapStore } from '../stores/flow-map'
import { RUN_PHASE_LABEL } from '../flow-map'

const workspace = useWorkspaceStore()
const flowMap = useFlowMapStore()
const { currentNewsId } = storeToRefs(workspace)
const { runPhase } = storeToRefs(flowMap)

const isMac = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform)

const documentTitle = computed(() => {
  if (!currentNewsId.value) return '崇明 — 未打开新闻'
  return currentNewsId.value
})

const statusText = computed(() => RUN_PHASE_LABEL[runPhase.value])
</script>

<template>
  <header class="app-chrome" :class="{ mac: isMac }">
    <div class="title-bar">
      <span class="doc-title" :title="documentTitle">{{ documentTitle }}</span>
    </div>
    <div class="tool-bar">
      <h1 class="brand">重明</h1>
      <div class="status-area">
        <span class="status-dot" :class="[runPhase]" />
        <span class="status-text">{{ statusText }}</span>
      </div>
    </div>
  </header>
</template>

<style scoped>
.app-chrome {
  flex-shrink: 0;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
}

/* 顶层：文档标题（为 macOS 红绿灯留空，可拖拽移动窗口） */
.title-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--titlebar-height);
  padding: 0 var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  -webkit-app-region: drag;
  user-select: none;
}

.app-chrome.mac .title-bar {
  padding-left: var(--traffic-light-inset);
}

.doc-title {
  font-size: var(--ui-font-size-md);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: min(560px, 100%);
}

/* 第二层：品牌 + 运行状态 */
.tool-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 var(--space-md);
  -webkit-app-region: no-drag;
}

.brand {
  font-size: var(--ui-font-size-lg);
  font-weight: 700;
  letter-spacing: 0.02em;
}

.status-area {
  display: flex;
  align-items: center;
  gap: var(--space-sm);
  font-size: var(--ui-font-size);
  color: var(--text-muted);
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-dim);
}

.status-dot.running,
.status-dot.interrupted { background: var(--warning); }
.status-dot.completed,
.status-dot.idle { background: var(--text-dim); }
.status-dot.error { background: var(--danger); }
.status-dot.running { background: var(--accent); }
</style>
