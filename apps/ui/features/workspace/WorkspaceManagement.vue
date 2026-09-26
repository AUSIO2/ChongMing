<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ClientGateway } from '../../../../contracts/client'
import type { AppBootstrap, Member, Role, WorkspaceView } from '../../../../contracts/control'
import { useManagementTask } from '../management/use-management'

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap }>()
const emit = defineEmits<{ changed: []; unauthorized: [] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => emit('unauthorized') })
const { busy, error, canRetry } = task
const owner = computed(() => props.workspace?.role === 'owner')
const name = ref(''), description = ref(''), revision = ref(0), baseline = ref('')
const serialized = computed(() => JSON.stringify({ name: name.value, description: description.value }))
const dirty = computed(() => serialized.value !== baseline.value)
const conflict = computed(() => dirty.value && props.workspace?.revision !== revision.value)
const memberId = ref(''), memberRole = ref<Role>('viewer'), memberAction = ref<'set' | 'remove'>('set'), memberRevision = ref(0)
const member = computed(() => props.workspace?.members.find(item => item.userId === memberId.value.trim()))
const memberConflict = computed(() => !!memberId.value && memberRevision.value !== props.workspace?.revision)
const deleteName = ref('')
const roleLabels: Record<Role, string> = { owner: '所有者', editor: '编辑者', viewer: '只读成员' }

// 用途：读取草稿，并把结构化结果交给调用方。
function workspaceReadDraft() {
  if (!props.workspace) return
  name.value = props.workspace.name; description.value = props.workspace.description
  revision.value = props.workspace.revision; baseline.value = serialized.value
}
watch(() => props.workspace, workspace => {
  if (!workspace) return
  if (!baseline.value || !dirty.value) workspaceReadDraft()
  if (!memberId.value) memberRevision.value = workspace.revision
}, { immediate: true })
// 用途：读取界面，并把结构化结果交给调用方。
function workspaceReadMember(item: Member, action: 'set' | 'remove') {
  memberId.value = item.userId; memberRole.value = item.role; memberAction.value = action
  memberRevision.value = props.workspace!.revision
}
// 用途：处理界面相关工作，并把结果交给调用方。
function workspaceResetMember() { memberId.value = ''; memberRole.value = 'viewer'; memberAction.value = 'set'; memberRevision.value = props.workspace!.revision }
// 用途：更新界面，并保持相关状态一致。
async function workspaceUpdateDetails() {
  if (!props.workspace || !owner.value || !dirty.value || conflict.value || !name.value.trim()) return
  await task.command('workspace.update', { workspaceId: props.workspace.id, expectedRevision: revision.value, name: name.value.trim(), description: description.value }, result => {
    name.value = result.data.name; description.value = result.data.description; revision.value = result.data.revision; baseline.value = serialized.value
    emit('changed')
  })
}
// 用途：更新界面，并保持相关状态一致。
async function workspaceUpdateMember() {
  if (!props.workspace || !owner.value || !memberId.value.trim() || memberConflict.value) return
  await task.command('member.set', { workspaceId: props.workspace.id, expectedRevision: memberRevision.value, userId: memberId.value.trim(), role: memberAction.value === 'remove' ? null : memberRole.value }, () => {
    workspaceResetMember(); emit('changed')
  })
}
// 用途：处理界面相关工作，并把结果交给调用方。
async function workspaceDelete() {
  if (!props.workspace || !owner.value || deleteName.value !== props.workspace.name) return
  await task.command('workspace.delete', { workspaceId: props.workspace.id, expectedRevision: props.workspace.revision }, () => emit('changed'))
}
</script>

<template>
  <section class="management-page" aria-label="工作区与成员管理">
    <p v-if="!workspace" class="muted">先选择或创建一个工作区，再管理资料与成员。</p>
    <template v-else>
      <div class="section-head"><h3>工作区资料</h3><button type="button" :disabled="busy" @click="emit('changed')">刷新资料</button></div>
      <p class="muted">工作区 ID：<code>{{ workspace.id }}</code> · 当前角色：{{ roleLabels[workspace.role] }}</p>
      <p v-if="!owner" class="muted">工作区所有者可以修改资料和成员权限。</p>
      <form @submit.prevent="workspaceUpdateDetails">
        <label>工作区名称<input v-model="name" required maxlength="120" :readonly="!owner || busy || canRetry"></label>
        <label>工作区说明<textarea v-model="description" rows="3" :readonly="!owner || busy || canRetry" /></label>
        <div v-if="conflict" class="conflict"><p>工作区已更新，当前草稿已保留。</p><button type="button" :disabled="busy || canRetry" @click="workspaceReadDraft">重新载入资料</button><button type="button" :disabled="busy || canRetry" @click="revision = workspace.revision">保留草稿，采用当前版本</button></div>
        <button v-if="owner" class="primary" :disabled="busy || canRetry || !dirty || conflict || !name.trim()">保存工作区资料</button>
      </form>
      <h3>工作区成员 · {{ workspace.members.length }}</h3>
      <div class="member-list"><article v-for="item in workspace.members" :key="item.userId" class="member-row"><div><strong>{{ item.displayName }}</strong><small>{{ item.userId }}</small><span>{{ roleLabels[item.role] }}</span></div><div v-if="owner" class="actions"><button type="button" :disabled="busy || canRetry" @click="workspaceReadMember(item, 'set')">编辑权限</button><button type="button" :disabled="busy || canRetry" @click="workspaceReadMember(item, 'remove')">移除</button></div></article></div>
      <form v-if="owner" class="member-form" @submit.prevent="workspaceUpdateMember">
        <h4>{{ memberAction === 'remove' ? '确认移除成员' : member ? '修改成员权限' : '添加已有用户' }}</h4>
        <p class="muted">添加已经在服务中注册的用户；账户和令牌由管理员管理。</p>
        <label>用户 ID<input v-model="memberId" required :readonly="busy || canRetry || memberAction === 'remove'" autocomplete="off" placeholder="管理员提供的用户 ID"></label>
        <label v-if="memberAction === 'set'">工作区角色<select v-model="memberRole" :disabled="busy || canRetry"><option value="viewer">只读成员</option><option value="editor">编辑者</option><option value="owner">所有者</option></select></label>
        <p v-else class="danger">{{ member?.displayName ?? memberId }} 将失去此工作区的访问权限。</p>
        <div v-if="memberConflict" class="conflict"><p>成员编辑期间工作区版本已变化；请核对当前成员列表。</p><button type="button" :disabled="busy || canRetry" @click="memberRevision = workspace.revision">保留选择，采用当前版本</button></div>
        <div class="actions"><button :class="memberAction === 'remove' ? 'danger' : 'primary'" :disabled="busy || canRetry || !memberId.trim() || memberConflict">{{ memberAction === 'remove' ? '确认移除此成员' : '保存成员权限' }}</button><button type="button" :disabled="busy || canRetry" @click="workspaceResetMember">清空成员表单</button></div>
      </form>
      <details v-if="owner" class="delete-section"><summary>删除工作区</summary><p>删除「{{ workspace.name }}」后，此工作区将不再可访问。请先取消其中所有未结束的运行。</p><label>输入工作区名称以确认<input v-model="deleteName" :readonly="busy || canRetry" autocomplete="off"></label><button class="danger" type="button" :disabled="busy || canRetry || deleteName !== workspace.name" @click="workspaceDelete">删除此工作区</button></details>
    </template>
    <div v-if="error" class="error" role="alert"><p>{{ error.message }}</p><div v-if="canRetry" class="actions"><button type="button" :disabled="busy" @click="task.retry">重试同一操作</button><button type="button" :disabled="busy" @click="task.clearError">放弃重试</button></div><button v-else type="button" :disabled="busy" @click="task.clearError">关闭提示</button></div>
  </section>
</template>

<style scoped>
.management-page{display:grid;gap:16px}.section-head,.actions,.member-row{display:flex;align-items:center;gap:9px}.section-head{justify-content:space-between}h3{font-size:15px}h4{font-size:13px}form,label{display:grid;gap:8px}form{gap:12px}input,textarea,select{padding:7px;font-size:12px;min-width:0}form>button{justify-self:start}.muted,small{color:var(--text-muted);line-height:1.6;font-size:11px}code,small{overflow-wrap:anywhere}.member-list{display:grid;gap:8px}.member-row{justify-content:space-between;border:1px solid var(--border-subtle);padding:10px;align-items:flex-start}.member-row>div:first-child{display:grid;gap:5px;min-width:0}.member-row span{font-size:11px}.member-form,.delete-section{padding:14px;background:var(--bg-viewport);border:1px solid var(--border-subtle)}.actions{flex-wrap:wrap}.conflict,.error{padding:12px;border:1px solid var(--border);background:var(--bg-viewport);line-height:1.7}.conflict button{margin:6px 8px 0 0}.danger,.error{color:var(--danger)}.delete-section summary{cursor:pointer;color:var(--danger)}.delete-section p,.delete-section button,.delete-section label{margin-top:12px}
</style>
