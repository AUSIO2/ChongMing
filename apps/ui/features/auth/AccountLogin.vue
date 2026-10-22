<!-- 纸面账户入口：用户名与邮箱流程只提交当前服务，会话仍由原store接纳。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clientReadError } from '../../../../client/graph-client'
import { api } from '../../transport/client-gateway'
import { useClientStore } from '../../state/client-session'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { AccountUiMessage } from './account-messages'

type AuthMode = 'username-login' | 'username-register' | 'login' | 'register' | 'verify' | 'forgot' | 'reset'
const props = defineProps<{ baseUrl: string; canRemember: boolean; disabled: boolean }>()
const session = useClientStore()
const mode = ref<AuthMode>('username-login')
const username = ref(''), email = ref(''), displayName = ref(''), password = ref(''), confirmation = ref(''), code = ref('')
const remember = ref(false), message = ref(''), problem = ref(''), sending = ref(false)
const nextSendAt = ref(0), now = ref(Date.now())
let request = 0
let timer: ReturnType<typeof setInterval> | undefined
const busy = computed(() => /* 认证与当前表单投递共用禁用状态，不影响图的写入busy。 */ sending.value || props.disabled || session.connecting)
const remaining = computed(() => /* 仅提示本表单重发冷却，验证码有效性仍由服务器判断。 */ Math.max(0, Math.ceil((nextSendAt.value - now.value) / 1000)))
const usernameMode = computed(() => /* 用户名不冒充已验证邮箱，两种身份使用各自的明确入口。 */ mode.value === 'username-login' || mode.value === 'username-register')
const registering = computed(() => /* 两种注册均要求用户确认新密码。 */ mode.value === 'username-register' || mode.value === 'register')
const signingIn = computed(() => /* 登录只校验必填，密码规则在创建与修改时提示。 */ mode.value === 'username-login' || mode.value === 'login')
const titles: Record<AuthMode, string> = { 'username-login': '登录账户', 'username-register': '创建账户', login: '登录账户', register: '创建账户', verify: '验证邮箱', forgot: '找回密码', reset: '设置新密码' }
const actions: Record<AuthMode, string> = { 'username-login': '登录', 'username-register': '注册并登录', login: '登录', register: '注册并发送验证码', verify: '验证并登录', forgot: '发送重置验证码', reset: '重置密码' }

function changeMode(
  /* 用户明确选择或服务器确认后的下一步。 */ next: AuthMode,
  /* 已验证接口返回的公开提示。 */ notice = '',
): void {
  // 切换流程清空敏感字段并隔离迟到表单响应，不保存密码或验证码。
  request++
  mode.value = next; message.value = notice; problem.value = ''
  password.value = ''; confirmation.value = ''; code.value = ''; sending.value = false
  session.clearError()
}
function startCooldown(): void {
  // 本次真实投递成功后提示等待，不将计时结果当作服务端授权。
  now.value = Date.now(); nextSendAt.value = now.value + 60_000
}
async function submit(): Promise<void> {
  // 按当前流程提交一份固定输入；服务切换或组件卸载后不接纳旧反馈。
  if (busy.value) return
  const account = api.account
  if (!account) { problem.value = AccountUiMessage.UNAVAILABLE; return }
  if ((registering.value || mode.value === 'reset') && password.value !== confirmation.value) {
    problem.value = AccountUiMessage.PASSWORD_MISMATCH
    return
  }
  const current = ++request, baseUrl = props.baseUrl, selectedMode = mode.value
  sending.value = true; problem.value = ''; message.value = ''; session.clearError()
  try {
    if (selectedMode === 'username-login') {
      await session.loginUsername({ baseUrl, username: username.value, password: password.value, remember: remember.value })
    } else if (selectedMode === 'username-register') {
      await session.registerUsername({ baseUrl, username: username.value, displayName: displayName.value, password: password.value, remember: remember.value })
    } else if (selectedMode === 'login') {
      await session.login({ baseUrl, email: email.value, password: password.value, remember: remember.value })
      if (current === request && session.error?.code === 'EMAIL_NOT_VERIFIED') changeMode('verify', session.error.message)
    } else if (selectedMode === 'verify') {
      await session.verifyEmail({ baseUrl, email: email.value, code: code.value, remember: remember.value })
    } else if (selectedMode === 'register') {
      const result = await account.register({ baseUrl, email: email.value, displayName: displayName.value, password: password.value })
      if (current === request) { changeMode('verify', result.message); startCooldown() }
    } else if (selectedMode === 'forgot') {
      const result = await account.forgotPassword({ baseUrl, email: email.value })
      if (current === request) { changeMode('reset', result.message); startCooldown() }
    } else {
      const result = await account.resetPassword({ baseUrl, email: email.value, code: code.value, password: password.value })
      if (current === request) changeMode('login', result.message)
    }
  } catch (cause) {
    if (current === request) problem.value = uiReadErrorMessage(clientReadError(cause).message)
  } finally {
    if (current === request) { sending.value = false; password.value = ''; confirmation.value = '' }
  }
}
async function resend(): Promise<void> {
  // 重发仅作用于当前邮箱和用途，成功后清空旧码并重新提示等待。
  if (busy.value || remaining.value > 0 || mode.value !== 'verify' && mode.value !== 'reset') return
  const account = api.account
  if (!account) { problem.value = AccountUiMessage.UNAVAILABLE; return }
  const current = ++request, input = { baseUrl: props.baseUrl, email: email.value }
  sending.value = true; problem.value = ''; session.clearError()
  try {
    const result = mode.value === 'verify' ? await account.resendVerification(input) : await account.forgotPassword(input)
    if (current === request) { message.value = result.message; code.value = ''; startCooldown() }
  } catch (cause) {
    if (current === request) problem.value = uiReadErrorMessage(clientReadError(cause).message)
  } finally { if (current === request) sending.value = false }
}
watch(() => /* 当前选定服务是本表单所有账户动作的归属。 */ props.baseUrl, () => {
  // 更换服务不沿用验证码、密码和原服务的成功提示。
  changeMode('username-login'); nextSendAt.value = 0
})
onMounted(() => {
  // 计时只属于当前表单，卸载时统一结束。
  timer = setInterval(() => { /* 更新公开冷却秒数。 */ now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => {
  // 结束本表单请求意图与敏感输入，不修改远端已经完成的注册。
  request++; clearInterval(timer); password.value = ''; confirmation.value = ''; code.value = ''
})
</script>

<template>
  <form class="account-login" :aria-label="titles[mode]" :aria-busy="busy" @submit.prevent="submit">
    <header><h2>{{ titles[mode] }}</h2><p>把事实、来源与核查结果保存在你的工作区。</p></header>
    <fieldset :disabled="busy">
      <label v-if="usernameMode">用户名<input v-model="username" type="text" autocomplete="username" required maxlength="32" :minlength="registering ? 3 : undefined" :pattern="registering ? '(?:[A-Za-z0-9_]|-){3,32}' : undefined"></label>
      <label v-else>邮箱<input v-model="email" type="email" autocomplete="username" required :readonly="mode === 'verify' || mode === 'reset'"></label>
      <small v-if="mode === 'username-register'">用户名为 3 至 32 位英文字母、数字、下划线或短横线，不区分大小写。</small>
      <label v-if="registering">显示名称<input v-model="displayName" autocomplete="name" required maxlength="80"></label>
      <label v-if="signingIn || registering">密码<input v-model="password" type="password" :autocomplete="signingIn ? 'current-password' : 'new-password'" required :minlength="registering ? 15 : undefined" maxlength="128"></label>
      <label v-if="registering">确认密码<input v-model="confirmation" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label>
      <label v-if="mode === 'verify' || mode === 'reset'">六位验证码<input v-model="code" inputmode="numeric" autocomplete="one-time-code" required pattern="[0-9]{6}" maxlength="6"></label>
      <label v-if="mode === 'reset'">新密码<input v-model="password" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label>
      <label v-if="mode === 'reset'">确认新密码<input v-model="confirmation" type="password" autocomplete="new-password" required minlength="15" maxlength="128"></label>
      <small v-if="registering || mode === 'reset'">密码长度须为 15 至 128 个字符。</small>
      <p v-if="mode === 'username-register'" class="session-note">用户名账户不支持邮件找回，请妥善保存密码；登录后可以修改密码。</p>
      <label v-if="canRemember && (signingIn || mode === 'username-register' || mode === 'verify')" class="remember"><input v-model="remember" type="checkbox">在这台设备上记住登录</label>
      <p v-if="!canRemember" class="session-note">登录信息仅在本次会话中使用。</p>
    </fieldset>
    <p v-if="message" class="message" role="status">{{ message }}</p>
    <p v-if="problem || session.error" class="error" role="alert">{{ problem || uiReadErrorMessage(session.error?.message ?? '') }}</p>
    <button class="primary" type="submit" :disabled="busy || !baseUrl.trim()">{{ busy ? '正在处理…' : actions[mode] }}</button>
    <button v-if="mode === 'verify' || mode === 'reset'" type="button" :disabled="busy || remaining > 0" @click="resend">重新发送验证码{{ remaining > 0 ? `（${remaining} 秒）` : '' }}</button>
    <nav aria-label="账户操作">
      <template v-if="mode === 'username-login'"><button type="button" :disabled="busy" @click="changeMode('username-register')">创建账户</button><button type="button" :disabled="busy" @click="changeMode('login')">邮箱登录</button></template>
      <template v-else-if="mode === 'username-register'"><button type="button" :disabled="busy" @click="changeMode('username-login')">返回登录</button><button type="button" :disabled="busy" @click="changeMode('register')">邮箱注册</button></template>
      <template v-else-if="mode === 'login'"><button type="button" :disabled="busy" @click="changeMode('register')">邮箱注册</button><button type="button" :disabled="busy" @click="changeMode('forgot')">忘记密码</button><button type="button" :disabled="busy" @click="changeMode('username-login')">用户名登录</button></template>
      <button v-else type="button" :disabled="busy" @click="changeMode('login')">返回登录</button>
    </nav>
  </form>
</template>

<style scoped>
.account-login{display:grid;gap:16px}.account-login header{padding-bottom:14px;border-bottom:1px solid var(--border-subtle)}h2{font:500 23px var(--content-font);margin:0 0 9px}header p,.session-note,small{font-size:12px;line-height:1.7;color:var(--text-muted)}fieldset{display:grid;gap:15px;border:0;padding:0;min-width:0}label{display:grid;gap:7px;font-size:12px}input{width:100%;min-width:0;padding:9px 10px}.remember{display:flex;align-items:center;gap:8px}.remember input{width:auto}.account-login>button{min-height:37px}nav{display:flex;justify-content:space-between;border-top:1px solid var(--border-subtle);padding-top:10px}nav button{border:0;background:transparent;padding:4px 0;color:var(--accent)}.error{color:var(--danger);line-height:1.7;font-size:12px}.message{color:var(--text-muted);font:14px/1.7 var(--content-font)}
</style>
