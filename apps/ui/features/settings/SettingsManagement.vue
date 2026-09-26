<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ClientGateway } from '../../../../contracts/client'
import type { AppBootstrap, ClusterSettings, WorkspaceView } from '../../../../contracts/control'
import { useManagementTask } from '../management/use-management'

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap }>()
const emit = defineEmits<{ changed: []; unauthorized: [] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => emit('unauthorized') })
const { busy, error, canRetry } = task
const provider = ref(''), model = ref(''), maxSlots = ref(1), tools = ref<ClusterSettings['tools']>([])
const revision = ref(0), baseline = ref('')
const serialized = computed(() => JSON.stringify({ llm: { provider: provider.value, model: model.value }, tools: tools.value, limits: { maxAgentSlots: maxSlots.value } }))
const dirty = computed(() => serialized.value !== baseline.value)
const conflict = computed(() => dirty.value && props.bootstrap.settings.revision !== revision.value)
const editable = computed(() => props.bootstrap.identity.hostAdmin && !busy.value && !canRetry.value)
const validation = computed(() => {
  if (!provider.value.trim() || !model.value.trim()) return '请填写默认供应方与模型。'
  if (!Number.isInteger(maxSlots.value) || maxSlots.value < 1 || maxSlots.value > 32) return '最大角度数必须是 1–32 的整数。'
  if (tools.value.some(tool => !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name.trim()) || !tool.description.trim())) return '每个工具需填写有效名称和说明；名称只使用字母、数字、下划线或短横线。'
  if (new Set(tools.value.map(tool => tool.name.trim())).size !== tools.value.length) return '工具名称不能重复。'
  return ''
})
// 用途：读取草稿，并把结构化结果交给调用方。
function settingsReadDraft(settings = props.bootstrap.settings) {
  provider.value = settings.llm.provider; model.value = settings.llm.model; maxSlots.value = settings.limits.maxAgentSlots
  tools.value = settings.tools.map(tool => ({ ...tool })); revision.value = settings.revision; baseline.value = serialized.value
}
watch(() => props.bootstrap.settings, settings => { if (!baseline.value || !dirty.value) settingsReadDraft(settings) }, { immediate: true })
// 用途：更新界面，并保持相关状态一致。
async function settingsUpdate() {
  if (!editable.value || !dirty.value || conflict.value || validation.value) return
  await task.command('settings.update', { expectedRevision: revision.value, llm: { provider: provider.value.trim(), model: model.value.trim() }, tools: tools.value.map(tool => ({ name: tool.name.trim(), description: tool.description })), limits: { maxAgentSlots: maxSlots.value } }, result => {
    settingsReadDraft(result.data); emit('changed')
  })
}
</script>

<template>
  <section class="management-page" aria-label="全局设置管理">
    <div class="section-head"><h3>服务默认设置</h3><button type="button" :disabled="busy" @click="emit('changed')">刷新设置</button></div>
    <p class="muted">这些默认值用于新的运行；已经开始的运行保留原来的配置。工具列表声明当前服务可用的能力。</p>
    <p v-if="!bootstrap.identity.hostAdmin" class="muted">当前为只读；只有主机管理员可以保存全局设置。</p>
    <form @submit.prevent="settingsUpdate">
      <div class="columns"><label>默认供应方<input v-model="provider" required :readonly="!editable" placeholder="例如 deepseek-official"></label><label>默认模型<input v-model="model" required :readonly="!editable" placeholder="模型名称"></label></div>
      <label>每次路由的最大角度数<input v-model.number="maxSlots" type="number" min="1" max="32" required :readonly="!editable"></label>
      <div class="section-head"><h4>可用工具</h4><button v-if="bootstrap.identity.hostAdmin" type="button" :disabled="!editable" @click="tools.push({ name: '', description: '' })">添加工具</button></div>
      <p v-if="!tools.length" class="muted">当前未声明外部工具。</p>
      <div v-for="(tool, index) in tools" :key="index" class="tool-row"><label>工具名称<input v-model="tool.name" required :readonly="!editable" :aria-label="`工具 ${index + 1} 名称`"></label><label>工具说明<textarea v-model="tool.description" required rows="2" :readonly="!editable" :aria-label="`工具 ${index + 1} 说明`" /></label><button v-if="bootstrap.identity.hostAdmin" type="button" :disabled="!editable" @click="tools.splice(index, 1)">移除工具</button></div>
      <div v-if="conflict" class="conflict"><p>全局设置已更新，你的草稿已保留。</p><div class="actions"><button type="button" :disabled="busy" @click="settingsReadDraft()">重新载入设置</button><button type="button" :disabled="busy || canRetry" @click="revision = bootstrap.settings.revision">保留草稿，采用当前版本</button></div></div>
      <p v-if="dirty && validation" class="error" role="alert">{{ validation }}</p>
      <button v-if="bootstrap.identity.hostAdmin" class="primary" :disabled="!editable || !dirty || conflict || !!validation">保存全局设置</button>
    </form>
    <div v-if="error" class="error" role="alert"><p>{{ error.message }}</p><div v-if="canRetry" class="actions"><button type="button" :disabled="busy" @click="task.retry">重试同一操作</button><button type="button" :disabled="busy" @click="task.clearError">放弃重试</button></div><button v-else type="button" :disabled="busy" @click="task.clearError">关闭提示</button></div>
  </section>
</template>

<style scoped>
.management-page,form,label{display:grid;gap:12px}.management-page{gap:16px}.section-head,.actions{display:flex;align-items:center;gap:8px;justify-content:space-between}h3{font-size:15px}h4{font-size:13px}.muted{color:var(--text-muted);font-size:11px;line-height:1.7}.columns{display:grid;grid-template-columns:1fr 1fr;gap:12px}input,textarea{min-width:0;padding:7px;font-size:12px}.tool-row{display:grid;gap:10px;padding:12px;border:1px solid var(--border-subtle)}.tool-row>button,form>button{justify-self:start}.conflict,.error{padding:12px;background:var(--bg-viewport);line-height:1.7}.error{color:var(--danger)}.actions{justify-content:flex-start;flex-wrap:wrap}@media(max-width:700px){.columns{grid-template-columns:1fr}}
</style>
