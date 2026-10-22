<!-- 节点所用固定证据编辑：保留旧引用，只把明确选择的新材料及本次使用理由交给会话保存。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { ClientGateway } from '../../../../contracts/client'
import type { EvidenceEntrySummary, EvidenceUseRef } from '../../../../contracts/evidence-library'
import type { GraphNode } from '../../../../contracts/graph'
import { graphReadNodeText } from '../graph/graph-layout'
import EvidenceSelectionPanel from './EvidenceSelectionPanel.vue'
import { evidenceCreateSelection, type EvidenceSelectionContext } from './evidence-selection'
import { evidenceReadJudgment, evidenceReadStatus } from './evidence-presentation'

const props = defineProps<{
  gateway: ClientGateway
  context: EvidenceSelectionContext
  node: GraphNode
  canEdit: boolean
  busy: boolean
  pendingRetry: boolean
  error: string | null
  versionChanged: boolean
}>()
const emit = defineEmits<{
  save: [/* 本次明确保存的完整引用集合，空数组表示清空。 */ refs: EvidenceUseRef[]]
  retry: []
  close: []
  unauthorized: []
}>()

const MAX_REFERENCES = 32
const MAX_REASON_BYTES = 64 * 1024
const dialog = ref<HTMLDialogElement | null>(null)
// 父页面每次打开重新挂载，原引用不因候选搜索或条目撤回而被筛掉。
const original = (props.node.libraryClaimRefs ?? []).map(
  (/* 打开时已保存的精确引用及其使用理由。 */ reference) => /* 捕获独立的原始编辑基线。 */ ({ ...reference }),
)
const draft = ref<EvidenceUseRef[]>(original.map(
  (/* 原始编辑基线中的一项引用。 */ reference) => /* 草稿编辑不能改写原始基线。 */ ({ ...reference }),
))
const summaries = ref<EvidenceEntrySummary[]>([])
const draftRows = computed(() => /* 新增引用保留选择时的真实陈述与判断，旧引用按需核对固定全文。 */
  draft.value.map((/* 一项仍在编辑的精确引用。 */ reference) => /* 只显示与该引用身份和摘要完全一致的摘要。 */ ({
    reference,
    summary: summaries.value.find((/* 已明确加入的真实候选摘要。 */ candidate) => /* 同一条目不能套用另一个固定版本。 */
      candidate.id === reference.entryId && candidate.contentDigest === reference.contentDigest),
  })))
const context = computed(() => /* 候选查询只属于父页面固定的身份与目标。 */ props.context)
const selection = evidenceCreateSelection(props.gateway, context, () => {
  // 候选读取认证过期时交由工作区结束当前会话。
  emit('unauthorized')
})
const preview = computed(() => {
  // 固定详情必须仍对应草稿中的同一条目和摘要；失败或移除不会清除其他引用。
  const entry = selection.browser.entry.value
  return entry && draft.value.some((/* 仍然保留的草稿引用。 */ reference) => /* 详情只核对原固定版本。 */
    reference.entryId === entry.id && reference.contentDigest === entry.contentDigest) ? entry : null
})
const blocked = computed(() => /* 版本变化保留草稿，等待重试时禁止替换原请求的输入。 */
  !props.canEdit || props.busy || props.pendingRetry || props.versionChanged)
const additions = computed(() => {
  // 新候选只追加不同条目，已经保存的同一条目永远保留原固定摘要。
  const existingIds = new Set(draft.value.map(
    (/* 草稿中已经保留的一项固定引用。 */ reference) => /* 去重只按条目身份判断。 */ reference.entryId,
  ))
  return [...selection.selected.value].sort((/* 前一项候选。 */ left, /* 后一项候选。 */ right) =>
    /* 延续固定引用按身份排序的提交顺序。 */ left.id.localeCompare(right.id)).filter(
    (/* 用户明确选中的活动候选。 */ reference) => /* 搜索不能替换旧条目的固定版本。 */ !existingIds.has(reference.id),
  )
})
const exceedsLimit = computed(() => /* 已保存引用和新增候选共同遵守节点容量。 */
  draft.value.length + additions.value.length > MAX_REFERENCES)
const normalized = computed<EvidenceUseRef[]>(() => /* 提交使用去空白的理由及原固定身份。 */
  draft.value.map((/* 用户正在编辑的一项引用。 */ reference) => /* 不复制搜索条目的其他管理字段。 */
    ({ entryId: reference.entryId, contentDigest: reference.contentDigest, reason: reference.reason.trim() })))
const reasonError = computed(() => {
  // 每份材料都有本次使用理由，长度按服务端相同的UTF-8字节上限判断。
  for (const reference of normalized.value) {
    if (!reference.reason) return '请为每条引用填写使用理由。'
    if (new TextEncoder().encode(reference.reason).byteLength > MAX_REASON_BYTES) return '每条使用理由最多为64 KiB。'
  }
  return ''
})
const changed = computed(() => /* []相对原非空引用是有效的显式清除。 */
  JSON.stringify(normalized.value) !== JSON.stringify(original))
const canSave = computed(() => /* 无实变、无理由或容量超限时不发送新保存意图。 */
  !blocked.value && changed.value && !reasonError.value && draft.value.length <= MAX_REFERENCES)

function addSelected(): void {
  // 明确加入才改变草稿；新材料先留空理由，旧材料不被重新选择覆盖。
  if (blocked.value || exceedsLimit.value || additions.value.length === 0) return
  summaries.value = [...summaries.value, ...additions.value.map(
    (/* 本次实际加入的完整候选摘要。 */ candidate) => /* 清空选材后草稿仍可核对原文和判断。 */ ({ ...candidate }),
  )]
  draft.value = [...draft.value, ...additions.value.map(
    (/* 用户已明确选定的一份新固定材料。 */ candidate) => /* 使用理由必须由用户随后填写。 */
      ({ entryId: candidate.id, contentDigest: candidate.contentDigest, reason: '' }),
  )]
  selection.clear()
}

function removeReference(
  /* 用户当前点击的引用在草稿中的位置。 */ index: number,
): void {
  // 只移除所选引用，保留其他材料的原摘要和理由。
  if (blocked.value) return
  const removedId = draft.value[index]?.entryId
  draft.value = draft.value.filter(
    (/* 草稿中的实际引用。 */ _reference, /* 当前引用所在的位置。 */ position) => /* 保留用户没有移除的引用。 */ position !== index,
  )
  summaries.value = summaries.value.filter(
    (/* 组件中保留的已加入摘要。 */ summary) => /* 移除引用时一并清理它的展示副本。 */ summary.id !== removedId,
  )
  if (selection.browser.selectedId.value === removedId) void selection.browser.select(null)
}

function clearReferences(): void {
  // 明确清空整个引用意图；保存前仍可以取消，原节点保持不变。
  if (blocked.value) return
  draft.value = []
  summaries.value = []
  selection.clear()
  void selection.browser.select(null)
}

async function inspectReference(
  /* 用户明确要求核对、仍保留于草稿的固定引用。 */ reference: EvidenceUseRef,
): Promise<void> {
  // 复用现有有界读取，只按原条目和摘要核对一项，撤回条目仍能阅读固定内容。
  if (props.busy || !context.value.active) return
  await selection.browser.select(reference.entryId, reference.contentDigest)
}

function saveReferences(): void {
  // 交付与草稿解除引用的完整集合，授权和原请求恢复仍由会话负责。
  if (!canSave.value) return
  emit('save', normalized.value.map(
    (/* 本次通过表单校验的一项引用。 */ reference) => /* 发出后不允许草稿修改在途参数。 */ ({ ...reference }),
  ))
}

function requestClose(): void {
  // 保存中保持原生模态窗口，结果待确认时允许退出草稿而保留会话原请求。
  if (!props.busy) emit('close')
}

onMounted(() => {
  // 每次挂载打开一个固定节点的独立模态编辑窗口。
  dialog.value?.showModal()
})
onBeforeUnmount(() => {
  // 页面结束该目标时关闭窗口，候选查询由selection的作用域清理统一取消。
  dialog.value?.close()
})
</script>

<template>
  <dialog ref="dialog" class="node-evidence-dialog" aria-label="编辑所用证据" @cancel.prevent="requestClose">
    <form @submit.prevent="saveReferences">
      <header><h2>编辑所用证据</h2><p>选择固定证据，并说明它在这份数据中的用途。此处修改不会改变证据原文或库内判断。</p></header>
      <p v-if="versionChanged" class="warning" role="status">节点版本已变化，草稿已保留。请关闭后重新核对，再保存引用。</p>
      <EvidenceSelectionPanel :selection="selection" :disabled="blocked" description="选择新增引用的固定证据，加入后填写本次使用理由。" />
      <div class="add-row"><button type="button" :disabled="blocked || exceedsLimit || !additions.length" @click="addSelected">加入所选证据</button><span>{{ draft.length }}/32 条引用</span></div>
      <p v-if="exceedsLimit" class="warning" role="status">合并后超过32条，请减少所选材料或移除已有引用。</p>
      <section class="references" aria-label="所用固定证据">
        <header class="references-heading"><h3>本次引用</h3><button type="button" :disabled="blocked || !draft.length" @click="clearReferences">清空引用</button></header>
        <p v-if="!draft.length" class="empty-note">{{ original.length ? '保存后会清空原节点的引用。' : '尚未添加引用。' }}</p>
        <article v-for="(row, index) in draftRows" :key="row.reference.entryId" class="reference-row">
          <div class="reference-heading"><strong>固定证据 {{ index + 1 }}</strong><div><button type="button" :aria-label="`核对固定证据 ${index + 1}`" :disabled="busy || !context.active" @click="inspectReference(row.reference)">核对固定证据</button><button type="button" :aria-label="`移除证据 ${index + 1}`" :disabled="blocked" @click="removeReference(index)">移除</button></div></div>
          <template v-if="row.summary"><p class="fixed-judgment">{{ evidenceReadJudgment(row.summary.confidence) }}</p><p class="fixed-content">{{ row.summary.content }}</p></template>
          <label :for="`node-evidence-reason-${index}`">使用理由 {{ index + 1 }}</label>
          <textarea :id="`node-evidence-reason-${index}`" v-model="row.reference.reason" :disabled="blocked" rows="3" required />
        </article>
        <section v-if="selection.browser.selectedId.value" class="fixed-preview" aria-label="固定证据核对">
          <h3>固定证据核对</h3><p v-if="selection.browser.detailLoading.value" role="status">正在读取固定证据…</p>
          <template v-else-if="preview"><p class="fixed-judgment">{{ evidenceReadJudgment(preview.confidence) }} · {{ evidenceReadStatus(preview.status) }}</p><p class="fixed-content">{{ graphReadNodeText(preview.claim.nodeSnapshot) }}</p></template>
          <p v-else class="empty-note">未读取到该固定版本，引用草稿仍然保留。</p>
        </section>
      </section>
      <p v-if="reasonError" class="error" role="status">{{ reasonError }}</p>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <footer><button type="button" :disabled="busy" @click="requestClose">取消</button><button v-if="pendingRetry" type="button" :disabled="busy || !canEdit" @click="emit('retry')">重试同一操作</button><button class="primary" type="submit" :disabled="!canSave">保存引用</button></footer>
    </form>
  </dialog>
</template>

<style scoped>
.node-evidence-dialog { width: min(680px, calc(100vw - 40px)); max-height: 85vh; margin: auto; overflow: auto; padding: 22px; border: 1px solid var(--border); border-radius: var(--radius-dialog); background: var(--bg-panel); color: var(--text); }
.node-evidence-dialog::backdrop { background: #00000024; }
form { display: grid; gap: 14px; }
h2 { margin: 0 0 8px; font-size: 17px; }
h3 { font-size: 13px; }
header p, .empty-note, .add-row span { color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.add-row, .references-heading, .reference-heading { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.references { display: grid; gap: 12px; border-top: 1px solid var(--border); padding-top: 14px; }
.reference-row { display: grid; gap: 7px; padding: 12px 0; border-bottom: 1px solid var(--border-subtle); }
.reference-heading strong, label { font-size: 12px; }
.reference-heading>div { display: flex; flex-wrap: wrap; gap: 6px; }
.fixed-judgment { color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.fixed-content { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.9 var(--content-font); }
.fixed-preview { display: grid; gap: 8px; padding: 12px; border-left: 2px solid var(--border-evidence); background: var(--bg-related); }
textarea { width: 100%; min-height: 72px; padding: 8px; resize: vertical; font-size: 13px; line-height: 1.7; }
button { padding: 6px 10px; }
footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.warning { color: var(--warning); font-size: 12px; line-height: 1.7; }
.error { color: var(--danger); font-size: 12px; line-height: 1.7; }
</style>
