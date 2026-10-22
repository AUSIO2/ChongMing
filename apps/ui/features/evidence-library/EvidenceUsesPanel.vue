<!-- 当前/历史使用记录与原消费者正文；定位当前数据图是独立显式动作。 -->
<script setup lang="ts">
import { computed, watch } from 'vue'

import type { ClientGateway } from '../../../../contracts/client'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { EvidenceClaimRef } from '../../../../contracts/evidence-library'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import DataPayloadView from '../reader/DataPayloadView.vue'
import { readerFindDefinition, readerReadFields, readerReadHeading } from '../reader/reader-content'
import { evidenceCreateUses, type EvidenceUsesContext } from './evidence-uses'

const props = defineProps<{ gateway: ClientGateway; context: EvidenceUsesContext; catalog: DefinitionCatalog | null }>()
const emit = defineEmits<{ unauthorized: []; openConsumer: [ref: EvidenceClaimRef]; selectionChanged: [] }>()
const context = computed(() => /* 面板由父页面绑定完整身份，不自行切换服务或库根。 */ props.context)
const state = evidenceCreateUses(props.gateway, context, () => {
  // 当前读取401交回窗口会话，面板不维护认证凭据。
  emit('unauthorized')
})
const detail = state.detail
const presentation = computed(() => {
  // 单页正文只取使用记录保存的消费者快照，当前Map不参与此投影。
  const node = detail.value?.consumerSnapshot
  if (!node) return null
  const definition = readerFindDefinition(node, props.catalog, [])
  return { heading: readerReadHeading(node, definition), fields: readerReadFields(node, definition) }
})

function openConsumer(): void {
  // 定位当前Map属于用户显式动作，固定正文仍保存在使用记录里。
  const usage = detail.value
  if (!usage || !props.context.active || usage.workspaceId !== props.context.workspaceId || usage.ref.entryId !== props.context.entryId) return
  emit('openConsumer', { mapId: usage.consumer.mapId, nodeId: usage.consumer.nodeId, revision: usage.consumer.revision })
}
watch(() => /* 根、身份或使用选择改变时使父页面旧导航任务过期。 */ [props.context.userId, props.context.connectionKey,
  props.context.workspaceId, props.context.entryId, props.context.active, state.selectedUsageId.value] as const, () => {
  // 父页面据此推进当前消费者跳转的代次，迟到旧定位不能抢回新选择。
  emit('selectionChanged')
})
</script>

<template>
  <section class="evidence-uses" aria-label="证据使用记录">
    <header><h3>使用记录</h3><button type="button" :disabled="state.loading.value || !context.active" @click="state.search()">刷新</button></header>
    <label class="history-filter"><input v-model="state.includeHistory.value" type="checkbox" :disabled="!context.active" @change="state.search()">包括已结束的历史使用</label>
    <p v-if="state.error.value" class="uses-error" role="alert" :title="`${state.error.value.code}: ${state.error.value.message}`">{{ uiReadErrorMessage(state.error.value.message) }}</p>
    <p v-if="state.loading.value && !state.items.value.length" class="uses-note" role="status">正在读取使用记录…</p>
    <p v-else-if="!state.items.value.length" class="uses-note">当前筛选下没有使用记录。</p>
    <div v-else class="uses-list"><button v-for="usage in state.items.value" :key="usage.id" class="use-row" :class="{ selected: usage.id === state.selectedUsageId.value }" type="button" @click="state.select(usage.id)"><span class="row-status"><strong>{{ usage.endedAt ? '历史使用' : '当前引用' }}</strong><small>{{ usage.kind === 'manual' ? '人工引用' : '核查产物' }}<template v-if="usage.reusedFromOperationId"> · 复用产物</template></small></span><span class="row-reason">{{ usage.reason }}</span><span class="row-identity">{{ usage.consumer.mapId }} / {{ usage.consumer.nodeId }} · 原版本 {{ usage.consumer.revision }}</span><span v-if="usage.runId" class="row-identity">Run {{ usage.runId }}</span><span v-if="usage.operationId" class="row-identity">Operation {{ usage.operationId }}</span><span v-if="usage.workId" class="row-identity">Work {{ usage.workId }}</span><span v-if="usage.reusedFromOperationId" class="row-identity">复用自 {{ usage.reusedFromOperationId }}</span></button></div>
    <footer v-if="state.items.value.length" class="uses-footer"><span>列表已加载 {{ state.items.value.length }} 条</span><button v-if="state.nextCursor.value" type="button" :disabled="state.loading.value" @click="state.loadMore()">{{ state.loading.value ? '读取中…' : '加载更多' }}</button></footer>

    <p v-if="state.detailLoading.value" class="uses-note" role="status">正在读取原消费者快照…</p>
    <article v-else-if="detail && presentation" class="consumer-snapshot" aria-label="原消费者固定正文"><header><h4>{{ presentation.heading }}</h4><button type="button" class="close-detail" aria-label="关闭消费者正文" @click="state.select(null)">×</button></header><p class="uses-note">原节点版本 {{ detail.consumer.revision }} · {{ detail.endedAt ? '已结束的历史使用' : '当前引用' }}</p><dl class="use-record"><div><dt>使用理由</dt><dd>{{ detail.reason }}</dd></div><div><dt>开始时间</dt><dd>{{ detail.startedAt }}</dd></div><div v-if="detail.endedAt"><dt>结束时间</dt><dd>{{ detail.endedAt }}</dd></div></dl><DataPayloadView :fields="presentation.fields" /><button type="button" class="consumer-link" @click="openConsumer">定位当前数据图（当前版本）↗</button><p class="uses-note">这里保存原消费者版本；定位后显示当前内容。</p></article>
  </section>
</template>

<style scoped>
.evidence-uses{display:grid;gap:10px;min-width:0;padding:16px 0;color:var(--text)}header{display:flex;align-items:center;justify-content:space-between;gap:9px;min-width:0}h3,h4{font-size:12px;font-weight:650;overflow-wrap:anywhere}header button,.uses-footer button{padding:4px 7px;font-size:10px}.history-filter{display:flex;align-items:center;gap:6px;color:var(--text-muted);font-size:11px}.uses-note{color:var(--text-muted);font-size:11px;line-height:1.8;overflow-wrap:anywhere}.uses-error{color:var(--danger);font-size:11px;line-height:1.8;overflow-wrap:anywhere}.uses-list{display:grid;gap:6px;max-height:350px;overflow:auto;padding:1px}.use-row{display:grid;gap:5px;width:100%;padding:10px;text-align:left;border-color:var(--border);background:var(--bg-related)}.use-row.selected{border-color:var(--accent);background:var(--accent-soft)}.row-status{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:5px}.row-status strong{font-size:11px;font-weight:600}.row-status small{color:var(--text-muted);font-size:10px}.row-reason{display:-webkit-box;overflow:hidden;font:12px/1.8 var(--content-font);white-space:pre-wrap;overflow-wrap:anywhere;-webkit-line-clamp:3;-webkit-box-orient:vertical}.row-identity{color:var(--text-muted);font-size:10px;line-height:1.6;overflow-wrap:anywhere}.uses-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;color:var(--text-muted);font-size:10px}.consumer-snapshot{display:grid;gap:10px;margin-top:6px;padding:12px;border-left:2px solid var(--border-evidence);background:var(--bg-related);min-width:0}.use-record{display:grid;gap:7px;font-size:11px;line-height:1.8}.use-record>div{display:grid;gap:4px}.use-record dt{color:var(--text-muted)}.use-record dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}.consumer-link{justify-self:start;padding:4px 0;border:0;background:transparent;color:var(--accent);font-size:11px;text-align:left}.consumer-snapshot :deep(.reader-field-text){font-size:13px;line-height:1.9}.consumer-snapshot :deep(.reader-field-value){font-size:11px;padding:8px}.consumer-snapshot :deep(.reader-fields){gap:12px}
</style>
