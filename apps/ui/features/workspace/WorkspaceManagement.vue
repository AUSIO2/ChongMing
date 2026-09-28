<!-- 工作区管理：编辑资料、设置成员角色和确认删除，保留发生版本冲突的草稿。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { ClientGateway } from '../../../../contracts/client'
import type { AppBootstrap, Member, Role, WorkspaceView } from '../../../../contracts/control'
import { useManagementTask } from '../management/use-management'

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap }>()
const emit = defineEmits<{ changed: []; unauthorized: [] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => /* 将管理请求的认证失效通知父组件。 */ emit('unauthorized') })
const { busy, error, canRetry } = task
const owner = computed(() => /* 判断当前用户是否为工作区所有者。 */ props.workspace?.role === 'owner')
const name = ref(''), description = ref(''), revision = ref(0), baseline = ref('')
const serialized = computed(() => /* 序列化工作区名称与说明，供编辑草稿比较。 */ JSON.stringify({ name: name.value, description: description.value }))
const dirty = computed(() => /* 判断资料草稿是否偏离已保存基线。 */ serialized.value !== baseline.value)
const conflict = computed(() => /* 判断未保存资料所依据的工作区版本是否过期。 */ dirty.value && props.workspace?.revision !== revision.value)
const memberId = ref(''), memberRole = ref<Role>('viewer'), memberAction = ref<'set' | 'remove'>('set'), memberRevision = ref(0)
const member = computed(() =>
  /* 按表单中的用户标识查找现有成员。 */
  props.workspace?.members.find(/* 当前工作区的一条成员记录，只用于匹配用户身份。 */ item =>
    /* 匹配去掉首尾空白的成员用户标识。 */
    item.userId === memberId.value.trim()))
const memberConflict = computed(() => /* 判断成员表单所依据的工作区版本是否已变化。 */ !!memberId.value && memberRevision.value !== props.workspace?.revision)
const deleteName = ref('')
const roleLabels: Record<Role, string> = { owner: '所有者', editor: '编辑者', viewer: '只读成员' }

function workspaceReadDraft() {
  // 载入工作区名称与说明，同时重置资料版本和内容基线。
  if (!props.workspace) return
  name.value = props.workspace.name; description.value = props.workspace.description
  revision.value = props.workspace.revision; baseline.value = serialized.value
}
watch(() => /* 观察当前工作区资料和权限变化。 */ props.workspace, /* 父组件传入的最新工作区；空值表示当前没有可编辑工作区。 */ workspace => {
  // 未修改资料时接纳服务端版本，并为空白成员表单更新版本基线。
  if (!workspace) return
  if (!baseline.value || !dirty.value) workspaceReadDraft()
  if (!memberId.value) memberRevision.value = workspace.revision
}, { immediate: true })
function workspaceReadMember(
  /* 从成员列表选择的只读记录，将身份和角色复制进编辑表单。 */ item: Member,
  /* 本次成员操作为设定角色或移除，用于确定表单模式。 */ action: 'set' | 'remove'
) {
  // 把所选成员和操作类型载入成员表单，并记住工作区版本。
  memberId.value = item.userId; memberRole.value = item.role; memberAction.value = action
  memberRevision.value = props.workspace!.revision
}
function workspaceResetMember() {
  // 清空成员表单，恢复只读角色和当前工作区版本。
  memberId.value = ''; memberRole.value = 'viewer'; memberAction.value = 'set'; memberRevision.value = props.workspace!.revision
}
async function workspaceUpdateDetails() {
  // 仅在所有者有有效改动且版本未冲突时保存工作区资料。
  if (!props.workspace || !owner.value || !dirty.value || conflict.value || !name.value.trim()) return
  await task.command('workspace.update', { workspaceId: props.workspace.id, expectedRevision: revision.value, name: name.value.trim(), description: description.value }, /* 资料保存成功的响应，提供服务端确认的名称、说明与版本。 */ result => {
    // 接纳保存后的名称、说明与版本，重置脏状态并通知父组件。
    name.value = result.data.name; description.value = result.data.description; revision.value = result.data.revision; baseline.value = serialized.value
    emit('changed')
  })
}
async function workspaceUpdateMember() {
  // 按成员表单版本设置角色或移除成员。
  if (!props.workspace || !owner.value || !memberId.value.trim() || memberConflict.value) return
  await task.command('member.set', { workspaceId: props.workspace.id, expectedRevision: memberRevision.value, userId: memberId.value.trim(), role: memberAction.value === 'remove' ? null : memberRole.value }, () => {
    // 成员变更成功后重置表单并通知父组件刷新。
    workspaceResetMember(); emit('changed')
  })
}
async function workspaceDelete() {
  // 在所有者输入准确名称后按当前版本删除工作区。
  if (!props.workspace || !owner.value || deleteName.value !== props.workspace.name) return
  await task.command('workspace.delete', { workspaceId: props.workspace.id, expectedRevision: props.workspace.revision }, () =>
    /* 删除成功后通知父组件刷新工作区状态。 */
    emit('changed'))
}
</script>

<template>
  <!-- 工作区资料、成员表单和删除确认共享版本与请求状态。 -->
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
/* 划分资料、成员与删除区域，并突出权限变更和冲突提示。 */
.management-page{display:grid;gap:16px}.section-head,.actions,.member-row{display:flex;align-items:center;gap:9px}.section-head{justify-content:space-between}h3{font-size:15px}h4{font-size:13px}form,label{display:grid;gap:8px}form{gap:12px}input,textarea,select{padding:7px;font-size:12px;min-width:0}form>button{justify-self:start}.muted,small{color:var(--text-muted);line-height:1.6;font-size:11px}code,small{overflow-wrap:anywhere}.member-list{display:grid;gap:8px}.member-row{justify-content:space-between;border:1px solid var(--border-subtle);padding:10px;align-items:flex-start}.member-row>div:first-child{display:grid;gap:5px;min-width:0}.member-row span{font-size:11px}.member-form,.delete-section{padding:14px;background:var(--bg-viewport);border:1px solid var(--border-subtle)}.actions{flex-wrap:wrap}.conflict,.error{padding:12px;border:1px solid var(--border);background:var(--bg-viewport);line-height:1.7}.conflict button{margin:6px 8px 0 0}.danger,.error{color:var(--danger)}.delete-section summary{cursor:pointer;color:var(--danger)}.delete-section p,.delete-section button,.delete-section label{margin-top:12px}
</style>
