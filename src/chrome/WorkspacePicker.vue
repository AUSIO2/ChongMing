<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useWorkspaceStore } from '../stores/workspace'
import {
  chromeCloseMenu,
  chromeReadOpenMenu,
  chromeShowToast,
  chromeToggleMenu,
} from './use-chrome-menu'

const workspace = useWorkspaceStore()
const { workspaceList, currentWorkspaceId, currentWorkspace } = storeToRefs(workspace)
const openPopupId = chromeReadOpenMenu()

const creating = ref(false)
const newName = ref('')

const open = computed(() => openPopupId.value === 'workspace')
const label = computed(() => currentWorkspace.value?.name ?? '选择工作区')

watch(open, (isOpen) => {
  if (!isOpen) {
    creating.value = false
    newName.value = ''
  }
})

function toggle() {
  chromeToggleMenu('workspace')
}

function close() {
  chromeCloseMenu()
}

async function onSelect(id: string) {
  close()
  try {
    await workspace.selectWorkspace(id)
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '切换工作区失败')
  }
}

async function onCreate() {
  const name = newName.value.trim()
  if (!name) return
  try {
    await workspace.createWorkspace(name, true)
    chromeShowToast(`已创建工作区「${name}」`)
    close()
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '创建失败')
  }
}

async function onUploadLocal() {
  if (!currentWorkspaceId.value) return
  try {
    await workspace.uploadLocalAgents('merge')
    chromeShowToast('已上传本地智能体到当前工作区')
    close()
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '上传失败')
  }
}
</script>

<template>
  <div class="workspace-picker">
    <button
      type="button"
      class="picker-trigger"
      :class="{ open }"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @pointerdown.stop.prevent="toggle"
    >
      <span class="picker-label">工作区</span>
      <span class="picker-value">{{ label }}</span>
      <span class="picker-caret" aria-hidden="true">▾</span>
    </button>

    <div
      v-if="open"
      class="picker-menu"
      role="listbox"
      @pointerdown.stop
    >
      <button
        v-for="ws in workspaceList"
        :key="ws._id"
        type="button"
        class="picker-item"
        role="option"
        :aria-selected="ws._id === currentWorkspaceId"
        :class="{ active: ws._id === currentWorkspaceId }"
        @click="onSelect(ws._id)"
      >
        <span class="item-name">{{ ws.name }}</span>
        <span class="item-meta">{{ ws.mapCount }} 图 · {{ ws.agentCount }} 智能体</span>
      </button>

      <div class="picker-sep" />

      <button
        type="button"
        class="picker-item action"
        :disabled="!currentWorkspaceId"
        @click="onUploadLocal"
      >
        上传本地智能体到当前工作区
      </button>

      <template v-if="!creating">
        <button
          type="button"
          class="picker-item action"
          @click="creating = true"
        >
          新建工作区…
        </button>
      </template>
      <div v-else class="picker-create">
        <input
          v-model="newName"
          class="create-input"
          type="text"
          placeholder="工作区名称"
          @keydown.enter.prevent="onCreate"
          @keydown.esc.prevent="creating = false"
        >
        <button
          type="button"
          class="create-btn"
          :disabled="!newName.trim()"
          @click="onCreate"
        >
          创建
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.workspace-picker {
  position: relative;
  z-index: 20;
}

.picker-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  padding: 2px 8px;
  border: 1px solid var(--border-subtle);
  border-radius: 3px;
  background: var(--bg-panel, transparent);
  color: var(--text);
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.picker-trigger:hover,
.picker-trigger.open {
  background: var(--bg-hover);
}

.picker-label {
  color: var(--text-muted);
  flex-shrink: 0;
}

.picker-value {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 500;
}

.picker-caret {
  color: var(--text-muted);
  font-size: 10px;
}

.picker-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  min-width: 240px;
  max-width: 320px;
  max-height: 360px;
  overflow: auto;
  padding: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-panel);
  box-shadow: 0 8px 24px rgb(0 0 0 / 12%);
  z-index: 1000;
}

.picker-item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--text);
  font-size: var(--ui-font-size);
  text-align: left;
  cursor: pointer;
}

.picker-item:hover,
.picker-item.active {
  background: var(--bg-hover);
}

.picker-item.action {
  color: var(--text-muted);
}

.picker-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.item-name {
  font-weight: 500;
}

.item-meta {
  font-size: 11px;
  color: var(--text-muted);
}

.picker-sep {
  height: 1px;
  margin: 4px 0;
  background: var(--border-subtle);
}

.picker-create {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
  padding: 4px;
}

.create-input {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  padding: 4px 6px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-input);
  color: var(--text);
  font-size: var(--ui-font-size);
}

.create-btn {
  flex: 0 0 auto;
  white-space: nowrap;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg-hover);
  color: var(--text);
  font-size: var(--ui-font-size);
  cursor: pointer;
}

.create-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
</style>
