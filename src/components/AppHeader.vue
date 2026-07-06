<script setup lang="ts">
import { computed, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { AppMenuBar } from '../chrome'
import { useWorkspaceTabsStore } from '../stores/workspace-tabs'
import { uiReadUsesCustomTitleBar } from '../shared/platform'

const tabsStore = useWorkspaceTabsStore()
const { activeTab } = storeToRefs(tabsStore)

const usesCustomTitleBar = uiReadUsesCustomTitleBar()

const documentTitle = computed(() => {
  if (!activeTab.value) return '崇明 — 未打开画布'
  return activeTab.value.title
})

watch(
  documentTitle,
  (title) => {
    void window.electronAPI?.app.setTitle(`${title} — 重明`)
  },
  { immediate: true },
)
</script>

<template>
  <header class="app-chrome" :class="{ mac: usesCustomTitleBar }">
    <div v-if="usesCustomTitleBar" class="title-bar">
      <span class="doc-title" :title="documentTitle">{{ documentTitle }}</span>
    </div>
    <AppMenuBar />
  </header>
</template>

<style scoped>
.app-chrome {
  flex-shrink: 0;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
}

.title-bar {
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--titlebar-height);
  padding: 0 var(--space-md);
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
</style>
