<!-- 当前账户的密码设置；成功轮换同一身份，不卸载工作台或编辑表单。 -->
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { useClientStore } from '../../state/client-session'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { AccountUiMessage } from './account-messages'

const session = useClientStore()
const menuOpen = ref(false)
const dialog = ref<HTMLDialogElement | null>(null)
const currentPassword = ref(''), newPassword = ref(''), confirmation = ref(''), problem = ref('')

function openPassword(): void {
  // 每次明确打开都从空密码开始，不读取浏览器保存的旧输入。
  menuOpen.value = false; currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; problem.value = ''
  session.clearError(); dialog.value?.showModal()
}
function closePassword(): void {
  // 关闭只清理本对话框草稿，不改图编辑意图或分支授权。
  dialog.value?.close(); currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; problem.value = ''
}
async function savePassword(): Promise<void> {
  // 同一账户的新凭据由网关原地轮换，成功后只关闭密码表单。
  if (session.connecting) return
  if (newPassword.value !== confirmation.value) { problem.value = AccountUiMessage.PASSWORD_MISMATCH; return }
  problem.value = ''
  const success = await session.changePassword({ currentPassword: currentPassword.value, newPassword: newPassword.value,
    remember: session.connection?.remembered === true })
  if (success) closePassword()
}
onBeforeUnmount(closePassword)
</script>

<template>
  <div class="account-settings">
    <button type="button" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen">账户设置</button>
    <div v-if="menuOpen" class="account-menu"><button type="button" @click="openPassword">修改密码</button></div>
    <dialog ref="dialog" aria-label="修改密码" @cancel="closePassword">
      <form @submit.prevent="savePassword">
        <h2>修改密码</h2>
        <p>更新当前账户的登录密码，工作区和编辑内容保留。</p>
        <fieldset :disabled="session.connecting">
          <label>当前密码<input v-model="currentPassword" type="password" autocomplete="current-password" required></label>
          <label>新密码<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label>
          <label>确认新密码<input v-model="confirmation" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label>
        </fieldset>
        <small>密码长度须为 15 至 128 个字符。</small>
        <p v-if="problem || session.error" class="error" role="alert">{{ problem || uiReadErrorMessage(session.error?.message ?? '') }}</p>
        <footer><button type="button" :disabled="session.connecting" @click="closePassword">取消</button><button class="primary" type="submit" :disabled="session.connecting">{{ session.connecting ? '正在保存…' : '保存新密码' }}</button></footer>
      </form>
    </dialog>
  </div>
</template>

<style scoped>
.account-settings{position:relative}.account-menu{position:absolute;right:0;top:calc(100% + 5px);padding:5px;background:var(--bg-panel);border:1px solid var(--border);z-index:10;min-width:110px}.account-menu button{width:100%;white-space:nowrap}dialog{margin:auto;padding:24px;width:min(430px,calc(100vw - 32px));max-height:85vh;overflow:auto;border:1px solid var(--border);background:var(--bg-panel);color:var(--text);border-radius:var(--radius-dialog)}dialog::backdrop{background:#00000024}form,fieldset{display:grid;gap:15px}fieldset{border:0;padding:0;min-width:0}h2{font:500 22px var(--content-font)}label{display:grid;gap:7px;font-size:12px}input{width:100%;padding:9px 10px}p,small{font-size:12px;line-height:1.7;color:var(--text-muted)}footer{display:flex;justify-content:flex-end;gap:8px}.error{color:var(--danger)}
</style>
