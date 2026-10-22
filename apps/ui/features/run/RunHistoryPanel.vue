<!-- 独立只读运行历史：分页摘要与一份详情，不改变当前Run选择和控制权。 -->
<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'

import type { ClientGateway } from '../../../../contracts/client'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphReview } from '../../../../contracts/graph-run'
import { uiReadErrorMessage, uiReadRunStatus } from '../../presentation/ui-labels'
import { graphReadOperationLabel, graphReadRunProgress } from '../graph/graph-layout'
import type { OperationOriginTarget } from '../graph/node-origin'
import OperationReview from './OperationReview.vue'
import RunSteps from './RunSteps.vue'
import { useRunHistory, type RunHistoryContext } from './run-history'

const props = defineProps<{
  gateway: ClientGateway
  context: RunHistoryContext
  snapshot: GraphSnapshot
  previewSupported: boolean
}>()
const emit = defineEmits<{ close: []; unauthorized: []; openOperation: [target: OperationOriginTarget]; returnAll: [] }>()
const historyContext = computed(() => /* 身份与开关由页面装配，内容revision不触发历史刷新。 */ props.context)
const history = useRunHistory(props.gateway, historyContext, () => {
  // 状态模块已排除旧身份的认证错误，再交当前会话处理。
  emit('unauthorized')
})
const dialog = ref<HTMLDialogElement | null>(null)
const detailSection = ref<HTMLElement | null>(null)
const identity = computed(() => /* 只读内容仍需真实身份范围，不能借另一Map的候选或正文。 */ ({
  userId: props.context.userId, connectionKey: props.context.connectionKey, workspaceId: props.context.workspaceId,
}))
const detail = computed(() => /* 只显示当前Map上下文中的已确认详情，不回写session快照。 */
  props.snapshot.mapId === props.context.mapId ? history.detail.value : null)
const selectedSummary = computed(() => /* 归档标记是目录读取时的物理归属，不从运行状态推断。 */
  history.items.value.find((/* 已读取的一条目录摘要。 */ item) => /* 当前独立历史选择。 */ item.runId === history.selectedId.value))
const originDirectoryMessage = computed(() => {
  // 来源目录只解释实际匹配结果，不猜测运行身份或自动扫描全部历史。
  if (!props.context.target || !props.context.supported || history.loading.value || history.error.value || history.directoryVersion.value === null) return null
  if (!history.items.value.length) return '原运行记录不可用，未找到保存的来源处理项。'
  if (history.items.value.length > 1 || history.nextCursor.value !== null) return '来源运行尚未唯一确定，请选择记录或继续加载。'
  return null
})
const originVersionMessage = computed(() => {
  // 当前正文的新版本不替代已发布版本，但不阻止阅读核对通过的来源记录。
  const target = props.context.target, revision = history.originOutputRevision.value
  if (target?.kind !== 'producer' || revision === null || revision === target.node.revision) return null
  return `当前版本 ${target.node.revision} · 产出版本 ${revision}。当前正文可能已编辑，以下为原发布记录。`
})

watch([detail, () => /* 只对明确来源Operation聚焦，不改变当前图节点选择。 */ props.context.target?.operationId], async () => {
  // 详情先经过精确来源核对，再将焦点放到同面板的对应处理项。
  const currentDetail = detail.value, target = props.context.target
  if (!currentDetail || !target) return
  await nextTick()
  if (detail.value !== currentDetail || props.context.target !== target) return
  const section = Array.from(detailSection.value?.querySelectorAll<HTMLElement>('[data-operation-id]') ?? [])
    .find((/* 当前面板已渲染的一项处理记录。 */ element) => /* 身份按属性原值比较，不拼接选择器。 */ element.dataset.operationId === target.operationId)
  section?.focus({ preventScroll: true })
  section?.scrollIntoView({ block: 'start' })
}, { flush: 'post' })

function historyReadTime(
  /* 服务端已校验的ISO时间，按用户浏览器时区显示。 */ value: string,
): string {
  // 日期展示不参与目录排序或游标版本计算。
  return new Date(value).toLocaleString('zh-CN')
}

function historyClose(): void {
  // 仅关闭只读面板，当前运行和它的控制租约继续由原会话拥有。
  dialog.value?.close()
}

function historyReadDecision(
  /* 该Operation实际保存的人工审核记录。 */ review: GraphReview,
  /* 当前Operation是否复制了历史结果及其审核记录。 */ reused: boolean,
): string {
  // 只解释保存的决定，不从运行终态推断人工批准或拒绝。
  if (reused) {
    if (review.state === 'pending') return '沿用的待决定记录（历史只读）'
    if (review.decision === 'approve') return '历史已批准（本次沿用）'
    if (review.decision === 'reject') return '历史已拒绝（本次沿用）'
    return '沿用记录未保存决定'
  }
  if (review.state === 'pending') return '待决定（历史只读）'
  if (review.decision === 'approve') return '已批准'
  if (review.decision === 'reject') return '已拒绝'
  return '未保存决定'
}

function historyRetryDetail(): void {
  // 重读当前历史选择，不确认或重建任何运行命令。
  if (history.selectedId.value) void history.select(history.selectedId.value)
}

onMounted(() => {
  // 使用原生模态焦点与Escape关闭行为，组件卸载时状态模块统一取消读取。
  dialog.value?.showModal()
})
</script>

<template>
  <dialog ref="dialog" class="history-dialog" aria-label="运行历史" @close="emit('close')">
    <header class="history-header">
      <div><h2>运行历史</h2><p>只读查看 · {{ snapshot.name }}</p></div>
      <button type="button" aria-label="关闭运行历史" @click="historyClose">关闭</button>
    </header>
    <p class="history-note">列表和详情为读取时记录。查看历史不会切换或控制当前运行。</p>
    <div v-if="context.target" class="history-origin">
      <p>{{ context.target.kind === 'producer' ? '节点生成来源' : '直接复用来源' }}：<code>{{ context.target.operationId }}</code></p>
      <button type="button" @click="emit('returnAll')">返回全部运行</button>
    </div>
    <div class="history-body">
      <section class="history-directory" aria-label="运行历史目录" :aria-busy="history.loading.value">
        <div class="directory-heading"><h3>运行记录</h3><button type="button" :disabled="history.loading.value || !context.supported" @click="history.refresh()">刷新列表</button></div>
        <p v-if="!context.supported" class="muted">{{ context.target ? '当前服务未提供运行历史目录，来源记录暂不可定位。' : '当前服务未提供运行历史目录，请升级服务后查看。' }}</p>
        <p v-else-if="history.loading.value && !history.items.value.length" class="muted" role="status">正在读取运行记录…</p>
        <p v-else-if="!context.target && !history.items.value.length && !history.error.value" class="muted">此数据图没有运行记录。</p>
        <p v-if="originDirectoryMessage" class="muted" role="status">{{ originDirectoryMessage }}</p>
        <p v-if="history.error.value" class="history-error" role="alert">{{ uiReadErrorMessage(history.error.value.message) }}</p>
        <ul class="history-list">
          <li v-for="item in history.items.value" :key="item.runId">
            <button type="button" :aria-label="`查看运行 ${item.runId}`" :aria-pressed="history.selectedId.value === item.runId" @click="history.select(item.runId)">
              <strong>{{ uiReadRunStatus(item.status) }}<template v-if="item.paused"> · 已暂停</template></strong>
              <span>{{ item.archived ? '已归档' : '未归档' }} · {{ item.mode === 'auto' ? '自动处理' : '人工审核' }}</span>
              <time :datetime="item.createdAt" :title="item.createdAt">{{ historyReadTime(item.createdAt) }}</time>
              <span>步骤 {{ item.stepCount }} · 处理项 {{ item.operationCount }} · 待审核 {{ item.pendingReviewCount }} · 产物引用 {{ item.outputCount }}</span>
              <small>{{ item.runId }}</small>
            </button>
          </li>
        </ul>
        <p v-if="history.loading.value && history.items.value.length" class="muted" role="status">正在加载更多记录…</p>
        <button v-if="history.nextCursor.value" type="button" :disabled="history.loading.value" @click="history.loadMore()">加载更多</button>
        <p v-if="history.cursorExpired.value" class="muted">请刷新列表，从第一页重新查看。</p>
      </section>
      <section ref="detailSection" class="history-details" aria-label="运行历史详情" :aria-busy="history.detailLoading.value">
        <p v-if="history.detailLoading.value" class="detail-state" role="status">正在读取运行详情…</p>
        <div v-else-if="history.detailError.value" class="detail-state">
          <p class="history-error" role="alert">{{ uiReadErrorMessage(history.detailError.value.message) }}</p>
          <button type="button" @click="historyRetryDetail">重新读取详情</button>
        </div>
        <template v-else-if="detail">
          <p v-if="originVersionMessage" class="history-note" role="status">{{ originVersionMessage }}</p>
          <header class="detail-header">
            <h3>{{ graphReadRunProgress(detail) }}</h3>
            <p>只读 · {{ detail.mode === 'auto' ? '自动处理' : '人工审核' }}<template v-if="detail.paused"> · 已暂停</template></p>
            <p v-if="selectedSummary">目录读取时：{{ selectedSummary.archived ? '已归档' : '未归档' }}</p>
            <p>创建：{{ historyReadTime(detail.createdAt) }} · 更新：{{ historyReadTime(detail.updatedAt) }}</p>
            <small>{{ detail.id }}</small>
          </header>
          <p v-if="detail.error" class="detail-state history-error" role="alert" :title="detail.error.code">{{ uiReadErrorMessage(detail.error.message) }}</p>
          <RunSteps :run="detail" />
          <p v-if="!detail.operations.length" class="detail-state">此运行没有已实例化的处理项。</p>
          <details v-for="operation in detail.operations" :key="operation.id" class="history-operation" open>
            <summary>{{ graphReadOperationLabel(operation) }}</summary>
            <p class="audit-note" v-if="operation.review">
              {{ operation.review.kind === 'plan' ? '规划审核' : '结果审核' }}：
              {{ historyReadDecision(operation.review, Boolean(operation.reusedFromOperationId)) }}
              <time v-if="operation.review.answeredAt" :datetime="operation.review.answeredAt"> · {{ operation.reusedFromOperationId ? '原记录时间：' : '' }}{{ historyReadTime(operation.review.answeredAt) }}</time>
            </p>
            <p v-else class="audit-note">未保存人工审核记录。</p>
            <OperationReview :snapshot="snapshot" :run="detail" :operation="operation" :gateway="gateway" :identity="identity" tabindex="-1"
              :preview-supported="previewSupported" :history-available="context.supported" :can-edit="false" :can-control="false" :busy="false" read-only
              @open-operation="emit('openOperation', $event)" />
          </details>
        </template>
        <p v-else class="detail-state">选择一条运行记录，查看保存的步骤、候选和产物。</p>
      </section>
    </div>
  </dialog>
</template>

<style scoped>
.history-dialog{margin:auto;width:min(1080px,calc(100vw - 32px));height:min(820px,calc(100vh - 32px));max-height:calc(100vh - 32px);padding:0;border:1px solid var(--border);border-radius:var(--radius-dialog);background:var(--bg-panel);color:var(--text)}
.history-dialog[open]{display:flex;flex-direction:column}.history-dialog::backdrop{background:#00000024}
.history-header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;border-bottom:1px solid var(--border)}
.history-header h2{font-size:18px}.history-header p,.history-note,.muted,.audit-note{font-size:12px;line-height:1.7;color:var(--text-muted)}
.history-note{padding:9px 20px;border-bottom:1px solid var(--border-subtle)}
.history-origin{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 20px;border-bottom:1px solid var(--border);font-size:12px}.history-origin p{overflow-wrap:anywhere}.history-origin code{font-size:11px}
.history-body{display:grid;grid-template-columns:minmax(245px,31%) minmax(0,1fr);min-height:0;flex:1;overflow:hidden}
.history-directory{padding:14px;overflow:auto;border-right:1px solid var(--border);min-width:0}
.directory-heading{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-bottom:10px}h3{font-size:13px}
.history-list{list-style:none;padding:0;margin:8px 0}.history-list li{border-bottom:1px solid var(--border-subtle)}
.history-list button{display:grid;gap:5px;width:100%;text-align:left;border:0;border-left:2px solid transparent;border-radius:0;background:transparent;padding:12px 8px}
.history-list button[aria-pressed="true"]{border-left-color:var(--accent);background:var(--bg-related)}
.history-list span,.history-list time{font-size:11px;color:var(--text-muted);line-height:1.6}.history-list small,.detail-header small{font-size:10px;color:var(--text-muted);overflow-wrap:anywhere}
.history-details{overflow:auto;min-width:0}.detail-state,.detail-header{padding:16px}.detail-header{display:grid;gap:7px;border-bottom:1px solid var(--border)}
.detail-header p{font-size:11px;color:var(--text-muted)}.history-operation>summary{padding:10px 14px;cursor:pointer;font-size:13px;border-top:1px solid var(--border-subtle)}
.audit-note{padding:0 14px 8px}.history-error{font-size:12px;line-height:1.7;color:var(--danger);overflow-wrap:anywhere}
@media(max-width:680px){.history-body{grid-template-columns:1fr;overflow:auto}.history-directory{max-height:240px;border-right:0;border-bottom:1px solid var(--border)}.history-details{overflow:visible}}
</style>
