<!-- 管理模态面板：按分类组织工作区、智能体、资产和全局设置，并转发变更事件。 -->
<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { ClientGateway } from '../../../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../../../contracts/control'
import type { GraphSnapshot } from '../../../../contracts/graph'
import WorkspaceManagement from '../workspace/WorkspaceManagement.vue'
import AgentManagement from '../agents/AgentManagement.vue'
import AssetManagement from '../assets/AssetManagement.vue'
import SettingsManagement from '../settings/SettingsManagement.vue'

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap; snapshot: GraphSnapshot | null }>()
const emit = defineEmits<{ close: []; changed: []; unauthorized: []; imported: [workspaceId: string] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const tab = ref<'workspace' | 'agents' | 'assets' | 'settings'>('workspace')
const tabs = [{ id: 'workspace' as const, label: '工作区与成员' }, { id: 'agents' as const, label: '智能体配置' }, { id: 'assets' as const, label: '资产与导入导出' }, { id: 'settings' as const, label: '全局设置' }]
onMounted(() => /* 组件挂载后以模态方式打开管理工作台。 */ dialog.value!.showModal())
</script>

<template>
  <!-- 模态对话框保留各管理页实例，按当前分类切换可见性。 -->
  <dialog ref="dialog" class="management-dialog" aria-labelledby="management-title" @close="emit('close')">
    <header class="management-header"><div><h2 id="management-title">工作台管理</h2><p>{{ workspace?.name ?? '未选择工作区' }} · {{ bootstrap.identity.displayName }}</p></div><button type="button" aria-label="关闭管理面板" @click="dialog?.close()">关闭</button></header>
    <nav class="management-tabs" aria-label="管理分类"><button v-for="item in tabs" :key="item.id" type="button" :class="{ selected: tab === item.id }" :aria-pressed="tab === item.id" @click="tab = item.id">{{ item.label }}</button></nav>
    <div class="management-content">
      <WorkspaceManagement v-show="tab === 'workspace'" :gateway="props.gateway" :workspace="workspace" :bootstrap="bootstrap" @changed="emit('changed')" @unauthorized="emit('unauthorized')" />
      <AgentManagement v-show="tab === 'agents'" :gateway="props.gateway" :workspace="workspace" :bootstrap="bootstrap" @changed="emit('changed')" @unauthorized="emit('unauthorized')" />
      <AssetManagement v-show="tab === 'assets'" :gateway="props.gateway" :workspace="workspace" :bootstrap="bootstrap" :snapshot="snapshot" @changed="emit('changed')" @unauthorized="emit('unauthorized')" @imported="emit('imported', $event)" />
      <SettingsManagement v-show="tab === 'settings'" :gateway="props.gateway" :workspace="workspace" :bootstrap="bootstrap" @changed="emit('changed')" @unauthorized="emit('unauthorized')" />
    </div>
  </dialog>
</template>

<style scoped>
/* 限制对话框尺寸，并让分类导航固定、管理内容独立滚动。 */
.management-dialog{margin:auto;width:min(940px,calc(100vw - 32px));max-height:calc(100vh - 32px);height:min(760px,calc(100vh - 32px));padding:0;border:1px solid var(--border);border-radius:5px;background:var(--bg-panel);color:var(--text);box-shadow:0 15px 50px #0003}.management-dialog[open]{display:flex;flex-direction:column}.management-dialog::backdrop{background:#0006}.management-header{display:flex;justify-content:space-between;align-items:center;padding:16px 20px;border-bottom:1px solid var(--border-subtle);gap:12px;flex-shrink:0}.management-header h2{font-size:18px}.management-header p{font-size:11px;color:var(--text-muted);margin-top:5px}.management-tabs{display:flex;gap:6px;padding:10px 20px;border-bottom:1px solid var(--border-subtle);flex-shrink:0;overflow:auto}.management-tabs button{white-space:nowrap;min-height:30px}.management-tabs .selected{background:var(--accent);color:#fff;border-color:var(--accent)}.management-content{padding:20px;min-height:0;overflow:auto;flex:1}.management-content :deep(button){min-height:28px}.management-content :deep(input),.management-content :deep(textarea),.management-content :deep(select){max-width:100%;box-sizing:border-box}.management-content :deep(pre){white-space:pre-wrap;overflow-wrap:anywhere}
</style>
