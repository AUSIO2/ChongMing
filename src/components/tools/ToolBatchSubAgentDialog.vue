<script setup lang="ts">
import { computed, ref } from 'vue'
import { storeToRefs } from 'pinia'
import type { Priority } from '../../flow-map'
import { useFlowMapStore } from '../../stores/flow-map'
import { useWorkspaceTabsStore } from '../../stores/workspace-tabs'
import { toolCloseDialog, toolDialogOpen } from '../../chrome/tool-dialogs'
import { chromeShowToast } from '../../chrome/use-chrome-menu'

const tabsStore = useWorkspaceTabsStore()
const flowMap = useFlowMapStore()
const { activeMapId } = storeToRefs(tabsStore)

const busy = ref(false)
const priority = ref<Priority>('medium')
const hint = ref('')
const agentName = ref('')

const priorityOnly = computed(() => toolDialogOpen.value === 'batch-priority')

async function onConfirm() {
  const mapId = activeMapId.value
  if (!mapId || busy.value) return
  busy.value = true
  try {
    const patch: {
      priority?: Priority
      hint?: string
      agentName?: string
    } = { priority: priority.value }
    if (!priorityOnly.value && hint.value.trim()) {
      patch.hint = hint.value.trim()
    }
    if (agentName.value.trim()) {
      patch.agentName = agentName.value.trim()
    }
    const result = await window.electronAPI.mapper.dispatch({
      type: 'routes.batch-update',
      mapId,
      patch,
    })
    if (result.type === 'map.updated') flowMap.snapshot = result.snapshot
    toolCloseDialog()
    chromeShowToast('批量更新完成')
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '更新失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="backdrop" @click.self="toolCloseDialog()">
    <div class="dialog panel" role="dialog">
      <h2>{{ priorityOnly ? '批量改优先级' : '批量改 SubAgent 参数' }}</h2>
      <label class="field">
        <span>优先级</span>
        <select v-model="priority">
          <option value="high">high</option>
          <option value="medium">medium</option>
          <option value="low">low</option>
        </select>
      </label>
      <label v-if="!priorityOnly" class="field">
        <span>hint（留空不改）</span>
        <input v-model="hint" type="text" placeholder="协调者提示">
      </label>
      <label class="field">
        <span>agentName 过滤（留空=全部）</span>
        <input v-model="agentName" type="text">
      </label>
      <div class="actions">
        <button type="button" @click="toolCloseDialog()">取消</button>
        <button type="button" class="primary" :disabled="busy" @click="onConfirm">
          {{ busy ? '处理中…' : '执行' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
}

.dialog {
  width: min(440px, 92vw);
  padding: var(--space-md);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--space-sm);
  font-size: var(--ui-font-size-sm);
}

.field input,
.field select {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--bg-viewport);
  color: var(--text);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
  margin-top: var(--space-md);
}

button.primary {
  background: var(--accent, #2563eb);
  color: #fff;
  border: none;
  padding: 6px 12px;
  border-radius: 4px;
  cursor: pointer;
}
</style>
