<script setup lang="ts">
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useFlowMapStore } from '../../stores/flow-map'
import { useWorkspaceTabsStore } from '../../stores/workspace-tabs'
import { toolCloseDialog } from '../../chrome/tool-dialogs'
import { chromeShowToast } from '../../chrome/use-chrome-menu'

const tabsStore = useWorkspaceTabsStore()
const flowMap = useFlowMapStore()
const { activeMapId } = storeToRefs(tabsStore)

const busy = ref(false)

async function onConfirm() {
  const mapId = activeMapId.value
  if (!mapId || busy.value) return
  busy.value = true
  try {
    const result = await window.electronAPI.mapper.dispatch({
      type: 'claims.dedup',
      mapId,
    })
    if (result.type === 'map.updated') flowMap.snapshot = result.snapshot
    toolCloseDialog()
    chromeShowToast('Claim 去重完成')
  } catch (e) {
    chromeShowToast(e instanceof Error ? e.message : '去重失败')
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="backdrop" @click.self="toolCloseDialog()">
    <div class="dialog panel" role="dialog" aria-labelledby="dedup-title">
      <h2 id="dedup-title">Claim 去重</h2>
      <p class="hint">按同一 SubAgent 父节点下 content + category 去重，保留第一条。</p>
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
  width: min(420px, 92vw);
  padding: var(--space-md);
}

.hint {
  margin: var(--space-sm) 0 var(--space-md);
  color: var(--text-muted);
  font-size: var(--ui-font-size-sm);
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-sm);
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
