<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import PanelRegion from './shell/PanelRegion.vue'
import { useWorkspaceStore } from '../stores/workspace'
import { useFlowMapStore } from '../stores/flow-map'

const store = useWorkspaceStore()
const flowMap = useFlowMapStore()
const { mapList, currentMapId, loading } = storeToRefs(store)

const fileInput = ref<HTMLInputElement | null>(null)

onMounted(() => store.loadMapList())

function preview(content: string) {
  return content.length > 36 ? `${content.slice(0, 36)}…` : content
}

function onImportClick() {
  fileInput.value?.click()
}

async function onFileSelected(ev: Event) {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return

  let mapId = currentMapId.value
  if (!mapId) {
    await store.createMap()
    mapId = currentMapId.value
  }
  if (!mapId) return

  await flowMap.attachMap(mapId)
  const path = (file as File & { path?: string }).path ?? file.name
  await flowMap.addSourceChain(path, file.name)
}
</script>

<template>
  <PanelRegion title="案件" class="sidebar">
    <template #actions>
      <input
        ref="fileInput"
        type="file"
        accept=".txt,.md,text/plain"
        class="hidden-file"
        @change="onFileSelected"
      >
      <button class="secondary" :disabled="loading" @click="onImportClick">
        导入
      </button>
      <button class="primary" :disabled="loading" @click="store.createMap()">
        + 新建
      </button>
    </template>

    <ul v-if="mapList.length" class="news-list">
      <li
        v-for="item in mapList"
        :key="item._id"
        :class="{ active: item._id === currentMapId }"
        @click="store.selectMap(item._id)"
      >
        <p class="preview">{{ preview(item.content) }}</p>
        <span class="meta">{{ item.claimCount }} 条</span>
      </li>
    </ul>
    <p v-else class="empty">暂无案件</p>
  </PanelRegion>
</template>

<style scoped>
.sidebar {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.sidebar :deep(.panel-region-head) {
  gap: var(--space-sm);
}

.news-list {
  list-style: none;
}

.news-list li {
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  min-height: 28px;
}

.news-list li:hover {
  background: var(--bg-hover);
}

.news-list li.active {
  background: var(--bg-hover);
  border-left: 3px solid var(--accent);
  padding-left: calc(var(--space-md) - 3px);
}

.preview {
  font-size: var(--ui-font-size-md);
  line-height: 1.35;
  margin-bottom: 1px;
}

.meta {
  font-size: var(--ui-font-size);
  color: var(--text-dim);
}

.empty {
  padding: var(--space-md);
  color: var(--text-dim);
}

.hidden-file {
  display: none;
}

button.secondary {
  margin-right: var(--space-xs);
}
</style>
