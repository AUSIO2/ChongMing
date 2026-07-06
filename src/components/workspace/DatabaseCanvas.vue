<script setup lang="ts">
import { onMounted, ref } from 'vue'
import PanelRegion from '../shell/PanelRegion.vue'
import { useWorkspaceTabsStore } from '../../stores/workspace-tabs'
import { chromeShowToast } from '../../chrome/use-chrome-menu'

const tabsStore = useWorkspaceTabsStore()

const uri = ref('')
const defaultUri = ref('')
const statusText = ref('')
const busy = ref(false)

async function load() {
  const api = window.electronAPI?.db
  if (!api) return
  const [settings, status] = await Promise.all([
    api.getSettings(),
    api.getStatus(),
  ])
  uri.value = settings.uri
  defaultUri.value = settings.defaultUri
  statusText.value = status.connected
    ? `已连接 · ${status.databaseName ?? status.uri}`
    : `未连接 · ${status.uri}`
}

onMounted(() => { void load() })

async function onTest() {
  const api = window.electronAPI?.db
  if (!api || busy.value) return
  busy.value = true
  try {
    const result = await api.testConnection(uri.value)
    chromeShowToast(result.ok ? '连接成功' : (result.error ?? '连接失败'))
  } finally {
    busy.value = false
  }
}

async function onSave() {
  const api = window.electronAPI?.db
  if (!api || busy.value) return
  busy.value = true
  try {
    await api.saveSettings(uri.value)
    chromeShowToast('已保存连接设置')
    await load()
  } finally {
    busy.value = false
  }
}

async function onReconnect() {
  const api = window.electronAPI?.db
  if (!api || busy.value) return
  busy.value = true
  try {
    const list = await api.reconnect()
    chromeShowToast('已重新连接')
    await load()
    void list
  } finally {
    busy.value = false
  }
}

async function onSwitch() {
  const api = window.electronAPI?.db
  if (!api || busy.value) return
  if (tabsStore.hasRunningMapTab()) {
    chromeShowToast('有地图正在运行，请先停止')
    return
  }
  busy.value = true
  try {
    await tabsStore.flushAllMapTabs()
    const list = await api.switch(uri.value)
    await tabsStore.onDbSwitched(list)
    chromeShowToast('已切换数据库')
    await load()
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '切换失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="database-canvas">
    <PanelRegion title="数据库连接">
      <p class="status">{{ statusText }}</p>
      <label class="field">
        <span>MongoDB URI</span>
        <input v-model="uri" type="text" spellcheck="false">
      </label>
      <p class="hint">默认：{{ defaultUri }}</p>
      <div class="actions">
        <button type="button" :disabled="busy" @click="onTest">测试连接</button>
        <button type="button" :disabled="busy" @click="onSave">保存设置</button>
        <button type="button" :disabled="busy" @click="onReconnect">重新连接</button>
        <button type="button" class="primary" :disabled="busy" @click="onSwitch">切换并连接</button>
      </div>
    </PanelRegion>
  </div>
</template>

<style scoped>
.database-canvas {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.status {
  margin-bottom: var(--space-sm);
  font-size: var(--ui-font-size-sm);
  color: var(--text-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-sm);
}

.field input {
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  font-family: ui-monospace, monospace;
  font-size: var(--ui-font-size-sm);
}

.hint {
  font-size: var(--ui-font-size-sm);
  color: var(--text-muted);
  margin-bottom: var(--space-md);
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-sm);
}

button.primary {
  background: var(--accent, #2563eb);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
}
</style>
