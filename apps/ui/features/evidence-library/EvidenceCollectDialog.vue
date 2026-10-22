<!-- 显式收录当前 Claim 版本，原文只读且不预选确定判断。 -->
<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from 'vue'

import type { ClientErrorData, ClientGateway } from '../../../../contracts/client'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { GraphMapSummary } from '../../../../contracts/graph-api'
import type { EvidenceClaimRef } from '../../../../contracts/evidence-library'

import { uiReadErrorMessage } from '../../presentation/ui-labels'
import type { EvidenceSelectionContext } from './evidence-selection'
import type { EvidenceCollectInput } from './evidence-state'
import EvidenceBasisEditor from './EvidenceBasisEditor.vue'
import { evidenceBuildCollectParams, evidenceCreateCollectDraft, type EvidencePresentationMessage } from './evidence-presentation'

const props = defineProps<{
  gateway: ClientGateway
  context: EvidenceSelectionContext
  maps: readonly GraphMapSummary[]
  catalog: DefinitionCatalog | null
  open: boolean
  claim: EvidenceClaimRef | null
  content: string
  busy: boolean
  error: ClientErrorData | null
  canRetry: boolean
}>()
const emit = defineEmits<{
  close: []
  submit: [params: EvidenceCollectInput]
  retry: []
  unauthorized: []
}>()
const dialog = ref<HTMLDialogElement | null>(null)
const firstChoice = ref<HTMLInputElement | null>(null)
const draft = ref(evidenceCreateCollectDraft())
const validation = ref<EvidencePresentationMessage | null>(null)

async function synchronizeDialog(): Promise<void> {
  // 按父页面的草稿生命周期开关原生模态对话框，并把焦点放到显式判断选项。
  await nextTick()
  const element = dialog.value
  if (!element) return
  if (props.open && props.claim && !element.open) {
    element.showModal()
    firstChoice.value?.focus()
  } else if ((!props.open || !props.claim) && element.open) element.close()
}

function submitCollection(): void {
  // 校验这份草稿后发出独立参数副本；结果不确定时仅允许重试原命令。
  if (!props.claim || props.busy || props.canRetry) return
  const result = evidenceBuildCollectParams(props.claim, draft.value)
  validation.value = result.ok ? null : result.message
  if (result.ok) emit('submit', result.params)
}

function requestClose(): void {
  // 保存中保持原目标，其他取消只清理窗口草稿，不替换会话原请求。
  if (!props.busy) emit('close')
}

function acceptNativeClose(): void {
  // 只把用户关闭当前对话框传给页面，忽略旧关闭事件抵达已重新打开的对话框。
  if (props.open && dialog.value && !dialog.value.open) emit('close')
}

watch(() => /* 每次打开或来源精确版本变动时草稿重新绑定来源。 */ [props.open, props.claim?.mapId, props.claim?.nodeId, props.claim?.revision] as const, async () => {
  // 丢弃上一次来源的判断与理由，再同步原生对话框显示。
  draft.value = evidenceCreateCollectDraft()
  validation.value = null
  await synchronizeDialog()
})
onMounted(async () => {
  // 支持父页面初次挂载时就带着打开的收录目标。
  await synchronizeDialog()
})
</script>

<template>
  <dialog ref="dialog" class="collect-dialog" aria-labelledby="evidence-collect-title" @cancel.prevent="requestClose" @close="acceptNativeClose">
    <form @submit.prevent="submitCollection">
      <header><h2 id="evidence-collect-title">收录到证据库</h2><p>收录当前事实的固定版本，判断只有 0 或 1。</p></header>
      <section class="original"><h3>原陈述 · 版本 {{ claim?.revision }}</h3><blockquote>{{ content }}</blockquote></section>
      <fieldset :disabled="busy || canRetry" class="judgment-choices"><legend>固定判断</legend><label><input ref="firstChoice" v-model="draft.confidence" type="radio" name="evidence-confidence" value="0" required><span><strong>0 · 确定错误</strong><small>这条原陈述完全错误，原文仍原样保留。</small></span></label><label><input v-model="draft.confidence" type="radio" name="evidence-confidence" value="1" required><span><strong>1 · 确定正确</strong><small>这条原陈述完全正确。</small></span></label></fieldset>
      <fieldset :disabled="busy || canRetry" class="scope-fields"><legend>适用范围</legend><p>空字段表示未注明，不代表普遍适用。时间使用本机时区。</p><div class="field-grid"><label>主体<input v-model="draft.subject" maxlength="2000"></label><label>事件<input v-model="draft.event" maxlength="2000"></label><label>起始时间<input v-model="draft.from" type="datetime-local"></label><label>结束时间<input v-model="draft.to" type="datetime-local"></label></div><label>地点<input v-model="draft.place" maxlength="2000"></label><label>适用条件 · 每行一条<textarea v-model="draft.conditions" rows="2" /></label></fieldset>
      <fieldset :disabled="busy || canRetry" class="decision-fields"><legend>收录决定</legend><label>收录理由<textarea v-model="draft.reason" required rows="3" /></label></fieldset>
      <EvidenceBasisEditor v-if="open && claim" :key="`${claim.mapId}:${claim.nodeId}:${claim.revision}`" v-model="draft.basisRefs" :gateway="gateway" :context="context" :maps="maps" :catalog="catalog" :disabled="busy || canRetry" @unauthorized="emit('unauthorized')" />
      <p v-if="validation" class="error" role="alert">{{ validation }}</p><p v-if="error" class="error" role="alert" :title="`${error.code}: ${error.message}`">{{ uiReadErrorMessage(error.message) }}</p>
      <div class="dialog-actions"><button type="button" :disabled="busy" @click="requestClose">取消</button><button v-if="canRetry" type="button" :disabled="busy" @click="emit('retry')">重试同一收录</button><button v-else type="submit" class="primary" :disabled="busy || !claim || !draft.confidence || !draft.reason.trim()">{{ busy ? '收录中…' : '确认收录' }}</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.collect-dialog{width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 40px);padding:0;border:1px solid var(--border);border-radius:var(--radius-dialog);background:var(--bg-panel);color:var(--text);box-shadow:0 6px 24px #00000014}.collect-dialog::backdrop{background:#00000024}.collect-dialog form{display:grid;gap:18px;padding:24px}.collect-dialog header{display:grid;gap:7px}.collect-dialog h2{font-size:18px;font-weight:650}.collect-dialog header p,.scope-fields>p{color:var(--text-muted);font-size:12px;line-height:1.8}.original{padding:13px 15px;background:var(--bg-related);border-left:2px solid var(--border-evidence)}.original h3{margin-bottom:8px;color:var(--text-muted);font-size:11px;font-weight:600}.original blockquote{max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.9 var(--content-font)}fieldset{display:grid;gap:10px;min-width:0;padding:13px 15px;border:1px solid var(--border);border-radius:var(--radius-evidence)}legend{padding:0 5px;font-size:12px;font-weight:650}label{display:grid;gap:6px;font-size:12px}input:not([type=radio]),textarea{width:100%;padding:7px 9px;font:12px/1.7 var(--ui-font)}textarea{resize:vertical}.judgment-choices label{display:flex;align-items:flex-start;gap:9px;padding:5px 0}.judgment-choices input{margin-top:4px}.judgment-choices span{display:grid;gap:5px}.judgment-choices strong{font-size:13px;font-weight:600}.judgment-choices small{color:var(--text-muted);font-size:11px;line-height:1.7}.field-grid{display:grid;grid-template-columns:1fr 1fr;gap:11px}.dialog-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:9px}.dialog-actions button{min-height:34px;padding:7px 12px;font-size:12px}.primary{background:var(--accent);color:#fff;border-color:var(--accent)}.error{color:var(--danger);font-size:12px;line-height:1.8;overflow-wrap:anywhere}@media(max-width:560px){.collect-dialog form{padding:16px}.field-grid{grid-template-columns:1fr}}
</style>
