<!-- 模型连接独立于提示词版本保存，Key只接受替换或移除，不从查询回填。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import type { ClientGateway } from '../../../../contracts/client'
import type { ModelConnectionInput, ModelConnectionView, ModelScope } from '../../../../contracts/model-connection'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { useManagementTask } from '../management/use-management'

const props = defineProps<{ gateway: ClientGateway; scope: ModelScope; writable: boolean; disabled?: boolean; agentName?: string }>()
const emit = defineEmits<{ changed: []; unauthorized: [] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => /* 认证失效仍交给原会话处理。 */ emit('unauthorized') })
const saved = shallowRef<ModelConnectionView | null>(null)
const provider = ref(''), model = ref(''), baseUrl = ref(''), apiKey = ref('')
const baseline = ref(''), notice = ref('')
const agentScope = computed(() => /* Agent未填字段使用同工作区配置。 */ props.scope.kind === 'agent')
const title = computed(() => /* 用独立区域名区分两层表单。 */ agentScope.value ? '智能体模型调用' : '工作区模型调用')
const serialized = computed(() => /* 只比较非秘密字段，Key输入单独计入脏状态。 */ JSON.stringify({ provider: provider.value, model: model.value, baseUrl: baseUrl.value }))
const dirty = computed(() => /* Key从不放进基线或后端返回对象。 */ serialized.value !== baseline.value || apiKey.value.length > 0)
const locked = computed(() => /* 等待原请求结果时不发起另一份保存。 */ task.busy.value || task.canRetry.value || props.disabled === true)
const editable = computed(() => /* 所有者才能提交连接及Key，其他成员只看脱敏状态。 */ props.writable && !locked.value)
const effective = computed(() => /* 已保存的解析结果不替代尚未保存的表单。 */ saved.value?.effective)
const keyStatus = computed(() => {
  // 区分本层拥有Key、继承Key与缺少可用Key，不显示掩码或任何密钥片段。
  if (!effective.value?.apiKeyConfigured) return '未配置可用 Key'
  return effective.value.apiKeySource === 'agent' ? '已配置 · 智能体 Key' : '已配置 · 工作区 Key'
})
const keyPlaceholder = computed(() => /* 输入框永远为空起步，省略字段表示保持或继承。 */ saved.value?.apiKeyConfigured ? '留空保持已配置 Key'
  : agentScope.value ? '留空继承工作区 Key' : '输入 API Key')

function accept(
  /* 当前作用域读取或保存后返回的脱敏视图。 */ view: ModelConnectionView,
): void {
  // 已配置Key只保留布尔状态，不尝试从返回字段或掩码恢复原值。
  saved.value = view
  provider.value = view.provider ?? (agentScope.value ? '' : 'deepseek-official')
  model.value = view.model ?? (agentScope.value ? '' : 'deepseek-flash')
  baseUrl.value = view.baseUrl ?? (agentScope.value ? '' : 'https://api.deepseek.com')
  apiKey.value = ''; baseline.value = serialized.value
}

async function read(): Promise<void> {
  // 读取当前作用域时不保留旧Key输入，避免切换对象后提交到错误工作区。
  if (task.busy.value || task.canRetry.value) return
  apiKey.value = ''; notice.value = ''
  await task.read('model.get', { scope: props.scope }, accept)
}

function configuration(): ModelConnectionInput {
  // 空文本只用于字段继承；Key空输入不等于删除已有密钥。
  return { provider: provider.value.trim() || null, model: model.value.trim() || null, baseUrl: baseUrl.value.trim() || null,
    ...(apiKey.value.length ? { apiKey: apiKey.value } : {}) }
}

async function save(
  /* 只由明确的移除按钮传入true，普通空密码输入保持原Key。 */ removeKey = false,
): Promise<void> {
  // 每层连接使用自己的版本与原管理请求重试，不修改Agent提示词或定义包。
  if (!editable.value || !saved.value || (!dirty.value && !removeKey)) return
  notice.value = ''
  const input = configuration()
  if (removeKey) input.apiKey = null
  await task.command('model.update', { scope: props.scope, expectedRevision: saved.value.revision, configuration: input }, result => {
    // 服务端确认后立即清空Key输入，并接纳该连接自己的实际版本。
    accept(result.data); notice.value = '模型调用配置已保存。'; emit('changed')
  })
}

function selectProvider(): void {
  // 工作区切换官方提供方时补齐对应地址，Agent仍允许分别继承字段。
  if (!agentScope.value) {
    baseUrl.value = provider.value === 'openai' ? 'https://api.openai.com/v1' : 'https://api.deepseek.com'
    if (provider.value === 'openai' && model.value === 'deepseek-flash') model.value = ''
  }
}

watch(() => /* 仅身份变化触发重新读取，父组件重新创建scope对象不会擦除草稿。 */ `${props.scope.kind}:${props.scope.workspaceId}:${props.scope.kind === 'agent' ? props.scope.agentId : ''}`, read, { immediate: true })
onBeforeUnmount(() => { /* 组件卸载后不保留尚未提交的Key文本。 */ apiKey.value = '' })
</script>

<template>
  <section class="model-connection" :aria-label="title">
    <header><div><h3>{{ title }}{{ agentName ? ` · ${agentName}` : '' }}</h3><p>{{ agentScope ? '未填写的项继承工作区；独立配置只用于这个智能体。' : '工作区为智能体提供默认模型与调用凭据。' }}</p></div><button type="button" :disabled="locked" @click="read">重新载入模型配置</button></header>
    <p class="connection-status">Key 状态：{{ keyStatus }}</p>
    <p v-if="!writable" class="muted">只有工作区所有者可以修改模型调用配置。</p>
    <form @submit.prevent="save()">
      <div class="fields">
        <label>模型提供方<select v-model="provider" :disabled="!editable" @change="selectProvider"><option v-if="agentScope" value="">继承工作区</option><option value="deepseek-official">DeepSeek</option><option value="openai">OpenAI</option></select></label>
        <label>模型名称<input v-model="model" :readonly="!editable" :required="!agentScope" :placeholder="agentScope ? `继承：${effective?.model ?? '未配置'}` : '填写提供方的模型 ID'"></label>
      </div>
      <label>API 地址<input v-model="baseUrl" type="url" :readonly="!editable" :placeholder="agentScope ? `继承：${effective?.baseUrl ?? '未配置'}` : '提供方官方 HTTPS API 地址'"></label>
      <label v-if="writable">API Key<input v-model="apiKey" type="password" autocomplete="off" :readonly="!editable" :placeholder="keyPlaceholder"></label>
      <p v-if="writable" class="muted">Key 保存后不回显；输入框留空保持当前配置。{{ agentScope ? '更换提供方或地址时，请同时配置匹配的 Key。' : '' }}</p>
      <div v-if="writable" class="actions"><button class="primary" type="submit" :disabled="!editable || !saved || !dirty">保存模型配置</button><button v-if="saved?.apiKeyConfigured" type="button" :disabled="!editable || dirty" @click="save(true)">{{ agentScope ? '继承工作区 Key' : '移除工作区 Key' }}</button></div>
    </form>
    <p class="muted">模型连接在新运行开始时解析；已有运行保留原模型，Key 轮换在后续获权调用时生效。</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <div v-if="task.error.value" class="error" role="alert"><p>{{ uiReadErrorMessage(task.error.value.message) }}</p><div class="actions"><button v-if="task.canRetry.value" type="button" :disabled="task.busy.value" @click="task.retry">重试同一操作</button><button type="button" :disabled="task.busy.value" @click="task.clearError">{{ task.canRetry.value ? '放弃重试' : '关闭提示' }}</button></div></div>
  </section>
</template>

<style scoped>
.model-connection{display:grid;gap:12px;padding:16px;border:1px solid var(--border-subtle);background:var(--bg-viewport)}header,.actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}header{justify-content:space-between;align-items:flex-start}h3{font:500 16px var(--content-font);margin:0 0 6px}header p,.muted{color:var(--text-muted);font-size:11px;line-height:1.7;margin:0}form,label{display:grid;gap:8px}form{gap:12px}.fields{display:grid;grid-template-columns:1fr 1fr;gap:12px}label{font-size:12px}input,select{width:100%;min-width:0;padding:8px;font-size:12px}.connection-status{font-size:12px;margin:0}.error{color:var(--danger);font-size:12px;line-height:1.7}.error p{margin:0 0 8px}[role=status]{font-size:12px;margin:0}@media(max-width:700px){.fields{grid-template-columns:1fr}}
</style>
