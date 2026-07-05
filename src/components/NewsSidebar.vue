<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import type { DisplayMapSummary } from '../../electron/api/types'
import PanelRegion from './shell/PanelRegion.vue'
import { useWorkspaceStore } from '../stores/workspace'

const store = useWorkspaceStore()
const { mapList, currentMapId, loading } = storeToRefs(store)

const editingId = ref<string | null>(null)
const editDraft = ref('')

const contextMenu = ref({
  visible: false,
  x: 0,
  y: 0,
  item: null as DisplayMapSummary | null,
})

onMounted(() => store.loadMapList())

function mapReadTitle(item: DisplayMapSummary): string {
  return item.name?.trim() || 'Map'
}

async function onSelectMap(mapId: string) {
  if (editingId.value) return
  closeContextMenu()
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

function onContextMenu(ev: MouseEvent, item: DisplayMapSummary) {
  ev.preventDefault()
  contextMenu.value = {
    visible: true,
    x: ev.clientX,
    y: ev.clientY,
    item,
  }
}

function closeContextMenu() {
  contextMenu.value.visible = false
  contextMenu.value.item = null
  dismissMenu?.()
  dismissMenu = null
}

let dismissMenu: (() => void) | null = null

watch(
  () => contextMenu.value.visible,
  (visible) => {
    dismissMenu?.()
    dismissMenu = null
    if (!visible) return
    const onDismiss = (ev: Event) => {
      if ((ev.target as Element).closest('.sidebar-context-menu')) return
      closeContextMenu()
    }
    const onDismissKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') closeContextMenu()
    }
    dismissMenu = () => {
      document.removeEventListener('pointerdown', onDismiss)
      document.removeEventListener('keydown', onDismissKey)
    }
    requestAnimationFrame(() => {
      document.addEventListener('pointerdown', onDismiss)
      document.addEventListener('keydown', onDismissKey)
    })
  },
)

function onMenuRename() {
  const item = contextMenu.value.item
  closeContextMenu()
  if (item) startRename(item)
}

async function onMenuDelete() {
  const item = contextMenu.value.item
  closeContextMenu()
  if (!item) return
  const title = mapReadTitle(item)
  if (!confirm(`确定删除 Map「${title}」？此操作不可撤销。`)) return
  await store.deleteMap(item._id)
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
        @contextmenu="onContextMenu($event, item)"
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
        <p v-else class="map-name">
          {{ mapReadTitle(item) }}
        </p>
        <span class="map-id">{{ item._id }}</span>
      </li>
    </ul>
    <p v-else class="empty">暂无 Map</p>

    <Teleport to="body">
      <ul
        v-if="contextMenu.visible"
        class="sidebar-context-menu"
        :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }"
        @pointerdown.stop
        @mousedown.stop
        @click.stop
      >
        <li @pointerdown.stop.prevent="onMenuRename">重命名</li>
        <li class="danger" @pointerdown.stop.prevent="onMenuDelete">删除</li>
      </ul>
    </Teleport>
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

<style>
.sidebar-context-menu {
  position: fixed;
  z-index: 10000;
  min-width: 120px;
  margin: 0;
  padding: 4px 0;
  list-style: none;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 4px 12px rgb(0 0 0 / 12%);
}

.sidebar-context-menu li {
  padding: 6px 12px;
  font-size: var(--ui-font-size-md);
  color: var(--text);
  cursor: pointer;
  white-space: nowrap;
}

.sidebar-context-menu li:hover {
  background: var(--bg-hover);
}

.sidebar-context-menu li.danger {
  color: var(--danger, #dc2626);
}
</style>
