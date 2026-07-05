<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { DisplayMapSummary } from '../../electron/api/types'
import PanelRegion from './shell/PanelRegion.vue'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const { mapList, currentMapId, loading } = storeToRefs(store)

const editingId = ref<string | null>(null)
const editDraft = ref('')

onMounted(() => store.loadMapList())

function mapReadTitle(item: DisplayMapSummary): string {
  return item.name?.trim() || 'Map'
}

async function onSelectMap(mapId: string) {
  if (editingId.value) return
  await store.selectMap(mapId)
}

function startRename(item: DisplayMapSummary) {
  editingId.value = item._id
  editDraft.value = item.name?.trim() || 'Map'
}

function focusRenameInput(el: HTMLInputElement | null) {
  if (!el) return
  el.focus()
  el.select()
}

function cancelRename() {
  editingId.value = null
  editDraft.value = ''
}

async function commitRename(item: DisplayMapSummary) {
  if (editingId.value !== item._id) return
  const next = editDraft.value.trim() || 'Map'
  cancelRename()
  if (next === mapReadTitle(item)) return
  await store.renameMap(item._id, next === 'Map' ? '' : next)
}
</script>

<template>
  <PanelRegion title="Map" class="sidebar">
    <template #actions>
      <button class="primary" :disabled="loading" @click="store.createMap()">
        + 新建
      </button>
    </template>

    <ul v-if="mapList.length" class="map-list">
      <li
        v-for="item in mapList"
        :key="item._id"
        :class="{ active: item._id === currentMapId }"
        @click="onSelectMap(item._id)"
      >
        <input
          v-if="editingId === item._id"
          :ref="(el) => focusRenameInput(el as HTMLInputElement | null)"
          v-model="editDraft"
          class="map-name-input"
          @click.stop
          @keydown.enter="commitRename(item)"
          @keydown.esc.prevent="cancelRename"
          @blur="commitRename(item)"
        >
        <p
          v-else
          class="map-name"
          title="双击重命名"
          @dblclick.stop="startRename(item)"
        >
          {{ mapReadTitle(item) }}
        </p>
        <span class="map-id">{{ item._id }}</span>
      </li>
    </ul>
    <p v-else class="empty">暂无 Map</p>
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

.map-list {
  list-style: none;
}

.map-list li {
  padding: var(--space-sm) var(--space-md);
  border-bottom: 1px solid var(--border-subtle);
  cursor: pointer;
  min-height: 28px;
}

.map-list li:hover {
  background: var(--bg-hover);
}

.map-list li.active {
  background: var(--bg-hover);
  border-left: 3px solid var(--accent);
  padding-left: calc(var(--space-md) - 3px);
}

.map-name {
  font-size: var(--ui-font-size-md);
  line-height: 1.35;
  margin-bottom: 2px;
}

.map-name-input {
  width: 100%;
  margin-bottom: 2px;
  padding: 1px 4px;
  font-size: var(--ui-font-size-md);
  line-height: 1.35;
  border: 1px solid var(--accent);
  border-radius: 2px;
  background: var(--bg-panel);
}

.map-id {
  display: block;
  font-size: 10px;
  line-height: 1.3;
  color: var(--text-dim);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  word-break: break-all;
}

.empty {
  padding: var(--space-md);
  color: var(--text-dim);
}
</style>
