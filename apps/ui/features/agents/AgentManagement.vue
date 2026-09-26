<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { ClientGateway, CommandInputMap } from '../../../../contracts/client'
import type { AgentInput, AgentList, AgentProfile, AgentScope, AppBootstrap, PromptKind, WorkspaceView } from '../../../../contracts/control'
import { useManagementTask } from '../management/use-management'

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap }>()
const emit = defineEmits<{ changed: []; unauthorized: [] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => emit('unauthorized') })
const { busy, error, canRetry } = task
const scopeKind = ref<'workspace' | 'library'>('workspace')
const list = ref<AgentList | null>(null), library = ref<AgentList | null>(null)
const selectedId = ref<string | null>(null), draft = ref<AgentInput | null>(null)
const baseContent = ref(''), baseRevision = ref(0), baseAgentRevision = ref(0)
const message = ref(''), deleteTarget = ref<AgentProfile | null>(null)
const pendingSelection = ref<{ scope: 'workspace' | 'library'; id: string | null; create: boolean } | null>(null)
const copyIds = ref<string[]>([]), copyMode = ref<'merge' | 'replace'>('merge')
const copyPreview = ref<{ params: CommandInputMap['agent.copy']; workspaceName: string; added: string[]; replaced: string[]; removed: string[]; removesFixed: boolean } | null>(null)
const kinds: Record<PromptKind, string> = { parseExtract: '来源解析', splitRoute: '拆分路由', splitSubAgent: '拆分智能体', splitMerge: '拆分汇总', verifyRoute: '核查路由', verifySubAgent: '核查智能体', verifyMerge: '核查汇总' }
const scope = computed<AgentScope | null>(() => scopeKind.value === 'library' ? { kind: 'library' }
  : props.workspace ? { kind: 'workspace', workspaceId: props.workspace.id } : null)
const writable = computed(() => scopeKind.value === 'library' ? props.bootstrap.identity.hostAdmin : props.workspace?.role === 'owner')
const locked = computed(() => busy.value || canRetry.value)
const selected = computed(() => list.value?.items.find(agent => agent.id === selectedId.value) ?? null)
const dirty = computed(() => !!draft.value && JSON.stringify(draft.value) !== baseContent.value)
const stale = computed(() => !!draft.value && !!list.value && (list.value.revision !== baseRevision.value || (!!selectedId.value && (!selected.value || selected.value.revision !== baseAgentRevision.value))))
const variables = computed(() => draft.value ? props.bootstrap.metadata.variables[draft.value.kind] ?? [] : [])
const output = computed(() => props.bootstrap.metadata.outputs.find(output => output.kind === draft.value?.kind)?.content)
const validation = computed(() => {
  if (!draft.value) return ''
  const agent = draft.value
  if (![agent.name, agent.description, agent.content, agent.promptPath].every(value => value.trim())) return '名称、说明、提示词和配置路径均不能为空。'
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agent.id)) return '标识使用 1–64 位字母、数字、下划线或连字符。'
  if (agent.promptVars.some(name => !variables.value.includes(name))) return '草稿包含当前类型不支持的变量，请移除后保存。'
  if (agent.tools.some(name => !props.bootstrap.settings.tools.some(tool => tool.name === name))) return '草稿引用了工具目录中不存在的工具，请移除后保存。'
  return ''
})

// 用途：读取输入，并把结构化结果交给调用方。
function agentReadInput(agent: AgentProfile): AgentInput {
  return { id: agent.id, name: agent.name, description: agent.description, content: agent.content, promptPath: agent.promptPath,
    kind: agent.kind, provider: agent.provider, model: agent.model, tools: [...agent.tools], promptVars: [...agent.promptVars],
    defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory }
}
// 用途：读取草稿，并把结构化结果交给调用方。
function agentReadDraft(id: string | null, create = false) {
  selectedId.value = id
  const agent = list.value?.items.find(agent => agent.id === id)
  draft.value = agent ? agentReadInput(agent) : create ? { id: crypto.randomUUID(), name: '', description: '', content: '',
    promptPath: 'custom/' + crypto.randomUUID(), kind: 'verifySubAgent', provider: null, model: null, tools: [],
    promptVars: [...props.bootstrap.metadata.variables.verifySubAgent], defaultPriority: 'medium', claimCategory: null } : null
  baseRevision.value = list.value?.revision ?? 0
  baseAgentRevision.value = agent?.revision ?? 0
  baseContent.value = JSON.stringify(draft.value)
  deleteTarget.value = null
}
// 用途：更新列表，并保持相关状态一致。
function agentUpdateList(value: AgentList, preserveDraft = true) {
  list.value = value
  if (!preserveDraft || !dirty.value) agentReadDraft(value.items.some(agent => agent.id === selectedId.value) ? selectedId.value : value.items[0]?.id ?? null)
}
// 用途：读取列表，并把结构化结果交给调用方。
async function agentReadList() {
  if (!scope.value) { list.value = null; agentReadDraft(null); return }
  await task.read('agent.list', { scope: scope.value }, value => agentUpdateList(value))
}
// 用途：更新范围，并保持相关状态一致。
async function agentUpdateScope(next: 'workspace' | 'library', id: string | null = null, create = false) {
  if (locked.value) return
  if (dirty.value) { pendingSelection.value = { scope: next, id, create }; return }
  await agentUpdateSelection(next, id, create)
}
// 用途：更新选择结果，并保持相关状态一致。
async function agentUpdateSelection(next: 'workspace' | 'library', id: string | null, create: boolean) {
  pendingSelection.value = null
  if (scopeKind.value !== next) {
    scopeKind.value = next; draft.value = null; selectedId.value = null; list.value = null
    await agentReadList()
  } else agentReadDraft(id, create)
}
// 用途：更新类型，并保持相关状态一致。
function agentUpdateKind() { if (draft.value && !selectedId.value) draft.value.promptVars = [...variables.value] }
// 用途：更新变量，并保持相关状态一致。
function agentUpdateVariableOrder(index: number, direction: number) {
  const values = draft.value?.promptVars
  if (!values || index + direction < 0 || index + direction >= values.length) return
  const [value] = values.splice(index, 1); values.splice(index + direction, 0, value)
}
// 用途：更新变量，并保持相关状态一致。
function agentUpdateVariable(name: string) {
  if (!draft.value) return
  const index = draft.value.promptVars.indexOf(name)
  if (index < 0) draft.value.promptVars.push(name)
  else draft.value.promptVars.splice(index, 1)
}
// 用途：更新配置，并保持相关状态一致。
async function agentUpdateProfile() {
  if (!scope.value || !draft.value || !writable.value || validation.value || stale.value) return
  const agent = { ...draft.value, name: draft.value.name.trim(), promptPath: draft.value.promptPath.trim(),
    provider: draft.value.provider?.trim() || null, model: draft.value.model?.trim() || null }
  const accept = (result: { data: AgentList }) => {
    selectedId.value = agent.id; agentUpdateList(result.data, false); message.value = '智能体配置已保存；已有运行继续使用冻结配置。'; emit('changed')
  }
  if (selectedId.value) await task.command('agent.update', { scope: scope.value, expectedRevision: baseRevision.value,
    agentId: selectedId.value, expectedAgentRevision: baseAgentRevision.value, agent }, accept)
  else await task.command('agent.create', { scope: scope.value, expectedRevision: baseRevision.value, agent }, accept)
}
// 用途：更新草稿版本，并保持相关状态一致。
async function agentUpdateDraftRevision() {
  if (!scope.value) return
  await task.read('agent.list', { scope: scope.value }, value => {
    list.value = value
    const current = value.items.find(agent => agent.id === selectedId.value)
    if (selectedId.value && !current) { message.value = '所选智能体已经删除；草稿仍保留。'; return }
    baseRevision.value = value.revision; baseAgentRevision.value = current?.revision ?? 0
  })
}
// 用途：处理界面相关工作，并把结果交给调用方。
async function agentDeleteProfile() {
  if (!deleteTarget.value || !scope.value || !writable.value || !deleteTarget.value.deletable || !list.value) return
  await task.command('agent.delete', { scope: scope.value, expectedRevision: list.value.revision,
    agentId: deleteTarget.value.id, expectedAgentRevision: deleteTarget.value.revision }, result => {
    deleteTarget.value = null; agentUpdateList(result.data, false); message.value = '所选智能体已删除。'; emit('changed')
  })
}
// 用途：读取库，并把结构化结果交给调用方。
async function agentReadLibrary() {
  await task.read('agent.list', { scope: { kind: 'library' } }, value => {
    library.value = value; copyIds.value = value.items.map(agent => agent.id); copyPreview.value = null
  })
}
// 用途：读取界面，并把结构化结果交给调用方。
function agentReadCopyPreview() {
  if (!props.workspace || props.workspace.role !== 'owner' || !library.value || !copyIds.value.length || dirty.value) return
  const agents = library.value.items.filter(agent => copyIds.value.includes(agent.id))
  const overwritten = props.workspace.agents.filter(agent => agents.some(source => source.promptPath === agent.promptPath))
  const removed = copyMode.value === 'replace' ? props.workspace.agents.filter(agent => !agents.some(source => source.promptPath === agent.promptPath)) : []
  copyPreview.value = { params: { workspaceId: props.workspace.id, expectedRevision: props.workspace.revision,
    libraryRevision: library.value.revision, agentIds: agents.map(agent => agent.id), mode: copyMode.value }, workspaceName: props.workspace.name,
    added: agents.filter(agent => !overwritten.some(target => target.promptPath === agent.promptPath)).map(agent => agent.name),
    replaced: overwritten.map(agent => agent.name), removed: removed.map(agent => agent.name), removesFixed: removed.some(agent => !agent.deletable) }
}
// 用途：更新库，并保持相关状态一致。
async function agentUpdateLibraryCopy() {
  const preview = copyPreview.value
  if (!preview || preview.removesFixed || dirty.value) return
  await task.command('agent.copy', preview.params, result => {
    copyPreview.value = null
    if (scopeKind.value === 'workspace') agentUpdateList({ scope: { kind: 'workspace', workspaceId: result.data.id }, revision: result.data.revision, items: result.data.agents }, false)
    message.value = '共享库配置已复制到工作区。'; emit('changed')
  })
}
watch(() => props.workspace, value => {
  if (value && scopeKind.value === 'workspace') agentUpdateList({ scope: { kind: 'workspace', workspaceId: value.id }, revision: value.revision, items: value.agents })
}, { immediate: true })
onMounted(agentReadList)
</script>

<template>
  <section class="agent-management" aria-label="智能体管理">
    <header class="toolbar"><div><h2>智能体配置</h2><p>提示词、模型与工具独立保存；已有运行保持原配置。</p></div><button :disabled="locked" @click="agentReadList">刷新列表</button></header>
    <div class="toolbar scope-tabs"><button :aria-pressed="scopeKind === 'workspace'" :disabled="locked || !workspace" @click="agentUpdateScope('workspace')">工作区智能体</button><button :aria-pressed="scopeKind === 'library'" :disabled="locked" @click="agentUpdateScope('library')">共享智能体库</button><span>{{ writable ? '可编辑' : '只读' }}</span></div>
    <div v-if="error" class="notice error" role="alert"><p>{{ error.message }}</p><div class="actions"><button v-if="canRetry" :disabled="busy" @click="task.retry">重试同一操作</button><button :disabled="busy" @click="task.clearError">{{ canRetry ? '放弃重试' : '关闭提示' }}</button></div></div>
    <p v-if="message" class="notice" role="status">{{ message }}</p>
    <div v-if="pendingSelection" class="notice confirmation" role="alertdialog" aria-label="确认放弃智能体草稿"><p>“{{ draft?.name || '新智能体' }}”尚未保存，切换将丢弃这份草稿。</p><div class="actions"><button @click="agentUpdateSelection(pendingSelection.scope, pendingSelection.id, pendingSelection.create)">放弃草稿并切换</button><button @click="pendingSelection = null">继续编辑</button></div></div>
    <div class="agent-columns">
      <aside class="agent-list"><button v-if="writable" :disabled="locked || !list" @click="agentUpdateScope(scopeKind, null, true)">新增智能体</button><p v-if="!list?.items.length">暂无智能体配置。</p><button v-for="agent in list?.items ?? []" :key="agent.id" class="agent-row" :class="{ selected: agent.id === selectedId }" :disabled="locked" @click="agentUpdateScope(scopeKind, agent.id)"><strong>{{ agent.name }}</strong><span>{{ kinds[agent.kind] }}{{ agent.deletable ? '' : ' · 固定角色' }}</span></button></aside>
      <form v-if="draft" class="agent-form" @submit.prevent="agentUpdateProfile">
        <div v-if="stale" class="notice" role="status"><p>服务器版本已变化，草稿已保留。</p><div class="actions"><button type="button" :disabled="locked" @click="agentReadDraft(selectedId)">重新载入，丢弃草稿</button><button type="button" :disabled="locked || !writable" @click="agentUpdateDraftRevision">保留草稿，采用最新版本</button></div></div>
        <fieldset :disabled="!writable || locked">
          <div class="form-grid"><label>名称<input v-model="draft.name" aria-label="智能体名称" required></label><label>角色类型<select v-model="draft.kind" :disabled="!!selectedId" @change="agentUpdateKind"><option v-for="(label, kind) in kinds" :key="kind" :value="kind" :disabled="!selectedId && kind !== 'splitSubAgent' && kind !== 'verifySubAgent'">{{ label }}</option></select></label></div>
          <label>说明<textarea v-model="draft.description" aria-label="智能体说明" rows="2" required /></label>
          <details><summary>身份与配置路径{{ selectedId ? '（已有身份不可修改）' : '' }}</summary><label>标识<input v-model="draft.id" :readonly="!!selectedId" aria-label="智能体标识" required></label><label>配置路径<input v-model="draft.promptPath" :readonly="!!selectedId" aria-label="智能体配置路径" required></label></details>
          <div class="form-grid"><label>模型提供方<input v-model="draft.provider" :placeholder="`继承：${bootstrap.settings.llm.provider}`" aria-label="智能体模型提供方"><small>留空继承共享设置</small></label><label>模型<input v-model="draft.model" :placeholder="`继承：${bootstrap.settings.llm.model}`" aria-label="智能体模型"><small>留空继承共享设置</small></label></div>
          <div class="form-grid"><label>默认优先级<select v-model="draft.defaultPriority" aria-label="默认优先级"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label><label>默认事实类别<select v-model="draft.claimCategory" aria-label="默认事实类别"><option :value="null">不限定</option><option value="data">数据事实</option><option value="quote">引用观点</option><option value="causal">因果关系</option></select></label></div>
          <label>提示词<textarea v-model="draft.content" aria-label="智能体提示词" rows="8" required /></label>
          <div class="field-group"><strong>注入变量</strong><p>勾选要提供的变量，并调整正文后的注入顺序。</p><div class="checks"><label v-for="name in variables" :key="name"><input type="checkbox" :checked="draft.promptVars.includes(name)" @change="agentUpdateVariable(name)">{{ name }}</label></div><ol class="variable-order"><li v-for="(name, index) in draft.promptVars" :key="name"><code>{{ name }}</code><button type="button" :disabled="index === 0" :aria-label="`上移变量 ${name}`" @click="agentUpdateVariableOrder(index, -1)">↑</button><button type="button" :disabled="index === draft.promptVars.length - 1" :aria-label="`下移变量 ${name}`" @click="agentUpdateVariableOrder(index, 1)">↓</button><button type="button" :aria-label="`移除变量 ${name}`" @click="draft.promptVars.splice(index, 1)">移除</button></li></ol></div>
          <div class="field-group"><strong>允许工具</strong><p v-if="!bootstrap.settings.tools.length">共享工具目录为空。</p><label v-for="tool in bootstrap.settings.tools" :key="tool.name" class="tool"><input v-model="draft.tools" type="checkbox" :value="tool.name"><span><strong>{{ tool.name }}</strong><small>{{ tool.description }}</small></span></label><div v-for="name in draft.tools.filter(name => !bootstrap.settings.tools.some(tool => tool.name === name))" :key="name" class="actions error">未知工具 {{ name }}<button type="button" @click="draft.tools = draft.tools.filter(tool => tool !== name)">移除</button></div></div>
        </fieldset>
        <details v-if="output"><summary>当前角色的结果格式</summary><pre>{{ JSON.stringify(JSON.parse(output), null, 2) }}</pre></details>
        <p v-if="validation && (dirty || !selectedId)" class="error" role="alert">{{ validation }}</p>
        <div v-if="writable" class="actions"><button class="primary" type="submit" :disabled="locked || stale || !!validation || (!dirty && !!selectedId)">保存智能体</button><button v-if="selected?.deletable" class="danger" type="button" :disabled="locked || dirty || stale" @click="deleteTarget = selected">删除智能体</button><span v-if="dirty">未保存</span></div>
        <div v-if="deleteTarget" class="notice confirmation" role="alertdialog" aria-label="确认删除智能体"><p>删除 {{ deleteTarget.name }}（{{ deleteTarget.id }}）。已有运行的配置副本仍保留；被图策略引用时会拒绝删除。</p><div class="actions"><button type="button" class="danger" :disabled="locked" @click="agentDeleteProfile">确认删除该智能体</button><button type="button" :disabled="busy" @click="deleteTarget = null">取消</button></div></div>
      </form>
      <p v-else class="empty">选择智能体查看配置，或新增拆分、核查智能体。</p>
    </div>
    <details v-if="workspace?.role === 'owner'" class="copy-section"><summary>从共享库复制到工作区“{{ workspace.name }}”</summary><p>合并保留未选中的工作区配置；替换将移除未选中的可删除智能体。固定角色必须保留。</p><button :disabled="locked || dirty" @click="agentReadLibrary">读取共享库供选择</button><template v-if="library"><div class="checks"><label v-for="agent in library.items" :key="agent.id"><input v-model="copyIds" type="checkbox" :value="agent.id" :disabled="locked">{{ agent.name }} · {{ kinds[agent.kind] }}</label></div><label>复制方式<select v-model="copyMode" :disabled="locked"><option value="merge">合并</option><option value="replace">替换工作区配置</option></select></label><button :disabled="locked || dirty || !copyIds.length" @click="agentReadCopyPreview">预览复制影响</button></template><p v-if="dirty">请先保存或放弃当前智能体草稿。</p>
      <div v-if="copyPreview" class="notice confirmation" role="alertdialog" aria-label="确认复制智能体"><strong>目标：{{ copyPreview.workspaceName }}</strong><p>新增：{{ copyPreview.added.join('、') || '无' }}</p><p>覆盖配置：{{ copyPreview.replaced.join('、') || '无' }}</p><p>移除配置：{{ copyPreview.removed.join('、') || '无' }}</p><p v-if="copyPreview.removesFixed" class="error">此选择会移除固定角色，请补选对应共享库配置。</p><div class="actions"><button class="primary" :disabled="locked || dirty || copyPreview.removesFixed" @click="agentUpdateLibraryCopy">确认{{ copyPreview.params.mode === 'merge' ? '合并' : '替换' }}到此工作区</button><button :disabled="busy" @click="copyPreview = null">取消</button></div></div>
    </details>
  </section>
</template>

<style scoped>
.agent-management{display:grid;gap:14px;min-width:0}.toolbar,.actions,.checks{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar{justify-content:space-between}.toolbar h2{font-size:16px}.toolbar p,p,small{color:var(--text-muted);line-height:1.6}.scope-tabs{justify-content:flex-start}.scope-tabs [aria-pressed="true"]{border-color:var(--accent);background:#fff4e7}.agent-columns{display:grid;grid-template-columns:minmax(150px,210px) minmax(0,1fr);gap:16px;align-items:start}.agent-list{display:grid;gap:6px;max-height:480px;overflow:auto;position:sticky;top:0}.agent-row{text-align:left;padding:9px;display:grid;gap:4px;overflow-wrap:anywhere}.agent-row span{color:var(--text-muted)}.agent-row.selected{border-color:var(--accent);background:#fff4e7}.agent-form,.agent-form fieldset{display:grid;gap:12px;min-width:0}.agent-form fieldset{border:0;padding:0}.agent-form label,.copy-section>label{display:grid;gap:5px}.form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}textarea{line-height:1.6}.field-group{display:grid;gap:7px}.checks label,.tool{display:flex!important;align-items:flex-start;gap:7px}.tool span,.tool small{display:block}.variable-order{padding-left:23px}.variable-order li{padding:3px 0}.variable-order code{display:inline-block;min-width:120px;overflow-wrap:anywhere}.variable-order button{margin-left:5px}.notice{padding:10px;border:1px solid var(--border-subtle);background:var(--bg-input);display:grid;gap:8px;overflow-wrap:anywhere}.error,.danger{color:var(--danger)}.confirmation{border-color:var(--warning)}summary{cursor:pointer;line-height:1.8}pre{white-space:pre-wrap;overflow-wrap:anywhere;padding:10px;background:var(--bg-input);font-size:11px}.copy-section{border-top:1px solid var(--border);padding-top:12px}.copy-section>*{margin-bottom:10px}.empty{padding:18px}@media(max-width:700px){.agent-columns{grid-template-columns:1fr}.agent-list{position:static;max-height:190px}.form-grid{grid-template-columns:1fr}}
</style>
