<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GraphOperation, GraphRouteSlot, GraphRun, GraphSnapshot } from '../../../../contracts/graph'
import { GRAPH_OPERATION_LABELS, graphReadNodeText, graphReadOperationProgress, graphReadScore } from '../graph/graph-layout'

const props = defineProps<{ snapshot: GraphSnapshot; run: GraphRun; operation: GraphOperation; canEdit: boolean; busy: boolean }>()
const emit = defineEmits<{
  update: [input: { mapId: string; expectedRevision: number; runId: string; operationId: string; reviewId: string; expectedReviewRevision: number; reason: string; slots: GraphRouteSlot[] }]
  answer: [input: { mapId: string; expectedRevision: number; runId: string; operationId: string; reviewId: string; expectedReviewRevision: number; decision: 'approve' | 'reject' }]
}>()

const run = computed(() => props.run)
const operation = computed(() => props.operation)
const review = computed(() => operation.value.review)
const route = computed(() => operation.value.route)
const reports = computed(() => operation.value.kind === 'split' ? operation.value.splitReports : operation.value.reports)
const configuration = computed(() => operation.value.kind === 'split' ? run.value.configuration.split! : run.value.configuration)
const outputClaims = computed(() => operation.value.contentDraft?.kind === 'split' ? operation.value.contentDraft.selected.map(selection => operation.value.splitReports.find(report => report.id === selection.reportId)!.claims[selection.index]) : [])
const pending = computed(() => operation.value.status === 'waiting' && review.value?.state === 'pending')
const pendingRoute = computed(() => pending.value && review.value?.kind === 'route')
const target = computed(() => props.snapshot.nodes.find(node => node.id === operation.value.targetId))
const form = ref<{ reason: string; slots: GraphRouteSlot[] } | null>(null)
const baseFingerprint = ref('')
const baseMapRevision = ref(0)
const baseReviewRevision = ref(0)
const baseReviewId = ref<string | null>(null)
const baseRunId = ref<string | null>(null)
const pendingSave = ref<string | null>(null)
const fingerprint = computed(() => JSON.stringify(form.value))
const dirty = computed(() => !!form.value && fingerprint.value !== baseFingerprint.value)
const sameReview = computed(() => run.value?.id === baseRunId.value && review.value?.id === baseReviewId.value)
const versionChanged = computed(() => dirty.value && (!sameReview.value || props.snapshot.revision !== baseMapRevision.value || review.value?.revision !== baseReviewRevision.value))
const routeEditable = computed(() => props.canEdit && !props.busy && pendingRoute.value && sameReview.value)
const reportCount = computed(() => route.value?.slots.filter(slot => reports.value.some(report => report.slotId === slot.id && report.routeRevision === route.value!.revision)).length ?? 0)
const validation = computed(() => {
  const draft = form.value
  const agents = configuration.value.agents
  if (!draft) return ''
  if (!draft.reason.trim()) return '请填写选择这些角度的理由。'
  if (!draft.slots.length || draft.slots.length > run.value.configuration.maxSlots) return `请保留 1–${run.value.configuration.maxSlots} 个核查角度。`
  if (new Set(draft.slots.map(slot => slot.id)).size !== draft.slots.length) return '角度标识重复，请移除重复项后重新添加。'
  for (const slot of draft.slots) {
    if (!slot.angle.trim()) return '请为每个角度填写明确的处理问题。'
    const agent = agents.find(agent => agent.id === slot.agentId)
    if (!agent) return '请选择本次核查配置中的智能体。'
    if (slot.tools.some(tool => !agent.tools.includes(tool))) return '所选工具超出了这个智能体的能力范围。'
  }
  return ''
})

// 用途：读取槽位，并把结构化结果交给调用方。
function reviewReadSlots(slots: GraphRouteSlot[]): GraphRouteSlot[] { return slots.map(slot => ({ ...slot, tools: [...slot.tools] })) }
// 用途：处理界面相关工作，并把结果交给调用方。
function reviewReloadDraft(): void {
  form.value = pendingRoute.value && route.value ? { reason: route.value.reason, slots: reviewReadSlots(route.value.slots) } : null
  baseFingerprint.value = JSON.stringify(form.value)
  baseMapRevision.value = props.snapshot.revision
  baseReviewRevision.value = review.value?.revision ?? 0
  baseReviewId.value = review.value?.id ?? null
  baseRunId.value = run.value?.id ?? null
  pendingSave.value = null
}
// 用途：处理界面相关工作，并把结果交给调用方。
function reviewAdoptVersion(): void {
  if (!pendingRoute.value || !sameReview.value) return
  baseMapRevision.value = props.snapshot.revision
  baseReviewRevision.value = review.value!.revision
}
watch(() => [props.snapshot.mapId, props.snapshot.revision, run.value?.id] as const, (current, previous) => {
  if (!previous || current[0] !== previous[0]) { reviewReloadDraft(); return }
  const saved = pendingRoute.value && route.value ? JSON.stringify({ reason: route.value.reason, slots: reviewReadSlots(route.value.slots) }) : ''
  if (!dirty.value || (sameReview.value && pendingSave.value !== null && pendingSave.value === fingerprint.value && saved === pendingSave.value)) reviewReloadDraft()
}, { immediate: true })

// 用途：处理界面相关工作，并把结果交给调用方。
function reviewAddSlot(): void {
  const profile = configuration.value.agents[0]
  if (!form.value || !profile || !routeEditable.value || form.value.slots.length >= run.value.configuration.maxSlots) return
  form.value.slots.push({ id: `angle-${crypto.randomUUID()}`, agentId: profile.id, angle: '', priority: profile.defaultPriority ?? 'medium', hint: '', tools: [...profile.tools] })
}
// 用途：更新Agent，并保持相关状态一致。
function reviewUpdateAgent(slot: GraphRouteSlot): void {
  const agent = configuration.value.agents.find(agent => agent.id === slot.agentId)
  slot.tools = slot.tools.filter(tool => agent?.tools.includes(tool))
}
// 用途：处理界面相关工作，并把结果交给调用方。
function reviewSaveDraft(): void {
  if (!form.value || !run.value || !review.value || !routeEditable.value || !dirty.value || validation.value || versionChanged.value) return
  pendingSave.value = fingerprint.value
  emit('update', { mapId: props.snapshot.mapId, expectedRevision: baseMapRevision.value, runId: baseRunId.value!, operationId: operation.value.id,
    reviewId: baseReviewId.value!, expectedReviewRevision: baseReviewRevision.value, reason: form.value.reason, slots: reviewReadSlots(form.value.slots) })
}
// 用途：处理界面相关工作，并把结果交给调用方。
function reviewAnswer(decision: 'approve' | 'reject'): void {
  if (!run.value || !review.value || !pending.value || !props.canEdit || props.busy || (decision === 'approve' && dirty.value)) return
  emit('answer', { mapId: props.snapshot.mapId, expectedRevision: props.snapshot.revision, runId: run.value.id, operationId: operation.value.id,
    reviewId: review.value.id, expectedReviewRevision: review.value.revision, decision })
}
// 用途：读取Agent，并把结构化结果交给调用方。
function reviewReadAgent(agentId: string): string { return configuration.value.agents.find(agent => agent.id === agentId)?.name ?? '核查智能体' }
</script>

<template>
  <section class="run-review" :aria-label="`${GRAPH_OPERATION_LABELS[operation.kind]}进度与审核`" :data-operation-id="operation.id">
    <header class="run-header"><h2>{{ GRAPH_OPERATION_LABELS[operation.kind] }}</h2></header>
    <div class="run-content">
      <p v-if="target" class="run-target">{{ graphReadNodeText(target) }}</p>
      <div class="run-status" :class="{ attention: pending || operation.status === 'running', failed: operation.status === 'failed', cancelled: operation.status === 'cancelled' }"><span class="status-dot" aria-hidden="true" /><strong>{{ graphReadOperationProgress(operation) }}</strong></div>
      <p v-if="operation.status === 'failed'" class="muted">本项处理未完成；保留已接受的结果供查看。</p>
      <p v-if="operation.status === 'cancelled'" class="muted">本项处理已停止，先前保存的数据仍可查看。</p>

      <div v-if="versionChanged || (dirty && !pendingRoute)" class="conflict-box" role="status">
        <strong>{{ pendingRoute && sameReview ? '审核版本已变化，路由草稿已保留。' : '这份路由审核已结束，未保存草稿仍保留在下方。' }}</strong>
        <p>重新载入会丢弃本地草稿；采用当前版本会保留你的修改，等待再次保存。</p>
        <div class="action-row"><button type="button" :disabled="busy" @click="reviewReloadDraft">重新载入</button><button v-if="pendingRoute && sameReview" type="button" :disabled="busy || !canEdit" @click="reviewAdoptVersion">保留草稿，采用当前版本</button></div>
      </div>

      <form v-if="form && (pendingRoute || dirty)" class="route-form" @submit.prevent="reviewSaveDraft">
        <div class="section-heading"><h3>确认处理角度</h3><span>{{ form.slots.length }} / {{ run.configuration.maxSlots }}</span></div>
        <p class="muted">确认智能体的分工与工具范围，再开始收集意见。</p>
        <label class="field"><span>路由理由</span><textarea v-model="form.reason" :readonly="!routeEditable" rows="3" aria-label="路由理由" /></label>
        <fieldset v-for="(slot, index) in form.slots" :key="slot.id" class="slot-card" :disabled="!routeEditable">
          <legend>角度 {{ index + 1 }}</legend>
          <label class="field"><span>处理问题</span><input v-model="slot.angle" :aria-label="`角度 ${index + 1} 处理问题`" placeholder="例如：核对数据的原始出处"></label>
          <label class="field"><span>智能体</span><select v-model="slot.agentId" :aria-label="`角度 ${index + 1} 智能体`" @change="reviewUpdateAgent(slot)"><option v-for="agent in configuration.agents" :key="agent.id" :value="agent.id">{{ agent.name }}</option></select></label>
          <label class="field"><span>优先级</span><select v-model="slot.priority" :aria-label="`角度 ${index + 1} 优先级`"><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
          <label class="field"><span>补充提示 <small>可选</small></span><textarea v-model="slot.hint" rows="2" :aria-label="`角度 ${index + 1} 补充提示`" /></label>
          <div class="tool-options"><span class="field-label">工具范围</span>
            <label v-for="tool in configuration.agents.find(agent => agent.id === slot.agentId)?.tools ?? []" :key="tool" class="tool-choice" :title="run.configuration.tools.find(item => item.name === tool)?.description"><input v-model="slot.tools" type="checkbox" :value="tool"><span>{{ tool }}</span></label>
            <p v-if="!configuration.agents.find(agent => agent.id === slot.agentId)?.tools.length" class="muted">此智能体只使用提供的材料。</p>
          </div>
          <button v-if="canEdit" type="button" class="remove-angle" :disabled="!routeEditable || form.slots.length <= 1" @click="form.slots.splice(index, 1)">移除此角度</button>
        </fieldset>
        <button v-if="canEdit" type="button" :disabled="!routeEditable || form.slots.length >= run.configuration.maxSlots" @click="reviewAddSlot">＋ 添加核查角度</button>
        <p v-if="validation" class="error-text" role="alert">{{ validation }}</p>
        <div v-if="canEdit && pendingRoute && sameReview" class="action-row">
          <button type="submit" :disabled="!routeEditable || !dirty || !!validation || versionChanged">保存路由修改</button>
          <span v-if="dirty" class="draft-note">保存后才能批准</span><span v-else class="muted">路由已保存</span>
        </div>
      </form>

      <section v-if="route && !pendingRoute && !dirty" class="progress-section">
        <div class="section-heading"><h3>各角度意见</h3><span>{{ reportCount }} / {{ route.slots.length }}</span></div>
        <div class="progress-track" role="progressbar" aria-label="已收集的核查意见" :aria-valuenow="reportCount" :aria-valuemin="0" :aria-valuemax="route.slots.length"><div :style="{ width: `${route.slots.length ? reportCount / route.slots.length * 100 : 0}%` }" /></div>
        <div v-for="slot in route.slots" :key="slot.id" class="progress-slot">
          <div><strong>{{ slot.angle }}</strong><p>{{ reviewReadAgent(slot.agentId) }}</p></div>
          <span v-if="!reports.some(report => report.slotId === slot.id && report.routeRevision === route!.revision)" class="muted">等待意见</span><span v-else class="report-ready">已收到</span>
        </div>
      </section>

      <section v-if="operation.contentDraft" class="result-section">
        <div class="section-heading"><h3>{{ pending ? '待保存的处理结果' : '本项处理结果' }}</h3></div>
        <p class="result-reason">{{ operation.contentDraft.reason }}</p>
        <template v-if="operation.contentDraft.kind === 'parse'">
          <p v-if="!operation.contentDraft.news.length" class="muted">没有可提取的新闻；批准后将记录这次空结果。</p>
          <article v-for="(item, index) in operation.contentDraft.news" :key="index" class="report-card">
            <h3>新闻 {{ index + 1 }}</h3><p class="result-reason">{{ item.content }}</p>
            <dl v-if="Object.keys(item.context).length"><template v-for="(field, key) in item.context" :key="key"><dt>{{ key }}{{ field.visibleToAI ? '' : '（不提供给智能体）' }}</dt><dd>{{ field.value }}</dd></template></dl>
          </article>
        </template>
        <template v-else>
          <p v-if="!outputClaims.length" class="muted">没有需要保留的候选事实；批准后将记录这次空结果。</p>
          <ol><li v-for="(claim, index) in outputClaims" :key="index"><p class="result-reason">{{ claim.content }}</p><small v-if="claim.category">{{ claim.category }}</small></li></ol>
        </template>
      </section>

      <section v-if="operation.draft" class="result-section">
        <div class="section-heading"><h3>{{ pending && review?.kind === 'result' ? '待保存的汇总结论' : '本次核查结论' }}</h3><strong class="result-score" :class="`score-${String(operation.draft.score).replace('.', '_')}`">{{ graphReadScore(operation.draft.score) }}</strong></div>
        <p class="result-reason">{{ operation.draft.reason }}</p>
        <p class="muted">由 {{ configuration.merger.name }} 汇总 {{ operation.draft.reportIds.length }} 份意见。</p>
      </section>
      <div v-if="reports.length" class="reports-section">
        <details v-for="report in reports" :key="report.id" class="report-card">
          <summary><span>{{ report.angle }}</span><strong v-if="'score' in report" :class="`score-${String(report.score).replace('.', '_')}`">{{ graphReadScore(report.score) }}</strong><span v-else>{{ report.claims.length }} 条候选事实</span></summary>
          <p class="report-agent">{{ report.agentName }}</p><p class="report-reason">{{ report.reason }}</p><ol v-if="'claims' in report"><li v-for="(claim, index) in report.claims" :key="index">{{ claim.content }}</li></ol>
          <p v-if="report.tools.length" class="muted">工具范围：{{ report.tools.join('、') }}</p>
        </details>
      </div>

      <div v-if="pending && canEdit" class="review-actions">
        <button type="button" class="primary" :disabled="busy || dirty || (pendingRoute && !!validation)" @click="reviewAnswer('approve')">{{ review?.kind === 'route' ? '批准处理角度' : operation.kind === 'verify' ? '批准并保存结论' : '批准并保存结果' }}</button>
        <button type="button" :disabled="busy" @click="reviewAnswer('reject')">{{ review?.kind === 'route' ? '拒绝本次路由' : '不接受这份结果' }}</button>
      </div>
      <p v-else-if="pending" class="muted">等待工作区 Editor 或 Owner 确认。</p>
      <p v-if="run.paused && pending" class="muted">本次运行已暂停；保存审核决定后仍保持暂停，点击继续才会执行后续工作。</p>
    </div>
  </section>
</template>

<style scoped>
.run-review { border-top: 1px solid var(--border); background: var(--bg-panel); min-width: 0; }.run-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); }h2 { font-size: 14px; font-weight: 600; }h3 { font-size: 12px; font-weight: 600; }.mode-label { color: var(--text-muted); background: var(--bg-input); border: 1px solid var(--border-subtle); border-radius: 10px; padding: 2px 7px; }
.review-empty { padding: 18px 14px; color: var(--text-muted); line-height: 1.7; }.run-content { display: grid; gap: 13px; padding: 12px 14px; }.run-target { font: 13px/1.6 var(--content-font); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; border-left: 2px solid var(--border); padding-left: 9px; }
.run-status { display: flex; align-items: center; gap: 7px; font-size: 12px; }.status-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--success); flex-shrink: 0; }.attention .status-dot { background: var(--accent); }.failed .status-dot { background: var(--danger); }.cancelled .status-dot { background: var(--text-muted); }
.section-heading { display: flex; justify-content: space-between; gap: 8px; align-items: baseline; }.section-heading > span, .muted { color: var(--text-muted); font-size: 11px; line-height: 1.6; }.route-form { display: grid; gap: 11px; }
.field { display: grid; gap: 5px; font-size: 12px; }.field > span, .field-label { color: var(--text-muted); }.field small { color: var(--text-dim); }.field input, .field select { min-height: 30px; padding: 5px 7px; }.field textarea { padding: 7px; line-height: 1.6; }.field input:focus-visible, .field select:focus-visible, .field textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.slot-card { display: grid; gap: 10px; border: 1px solid var(--border-subtle); border-radius: 5px; padding: 10px; background: var(--flow-node-bg); min-width: 0; }.slot-card legend { font-weight: 600; padding: 0 5px; }.tool-options { display: grid; gap: 7px; }.tool-choice { display: flex; align-items: center; gap: 7px; overflow-wrap: anywhere; font-size: 11px; }.remove-angle { justify-self: start; color: var(--danger); background: transparent; }
.action-row { display: flex; align-items: center; flex-wrap: wrap; gap: 7px; }.action-row button { min-height: 28px; }.draft-note { color: var(--warning); font-size: 11px; }.error-text { color: var(--danger); line-height: 1.6; font-size: 12px; overflow-wrap: anywhere; }
.conflict-box { padding: 10px; border: 1px solid var(--warning); background: #fff8e9; line-height: 1.6; }.conflict-box p { margin: 6px 0; font-size: 11px; }
.progress-section { display: grid; gap: 9px; }.progress-track { height: 4px; background: var(--border-subtle); border-radius: 2px; overflow: hidden; }.progress-track > div { height: 100%; background: var(--success); }
.progress-slot { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; border-bottom: 1px solid var(--border-subtle); padding: 7px 0; }.progress-slot strong { font-size: 12px; line-height: 1.5; }.progress-slot p { margin-top: 2px; color: var(--text-muted); line-height: 1.5; }.progress-slot > span { flex-shrink: 0; padding-top: 2px; }.report-ready { color: var(--success); }
.result-section { display: grid; gap: 8px; padding: 12px; background: var(--flow-node-bg); border: 1px solid var(--border-subtle); border-radius: 5px; }.result-score { font-size: 16px; flex-shrink: 0; }.result-reason, .report-reason { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.65 var(--content-font); }
.reports-section { display: grid; gap: 7px; }.report-card { border: 1px solid var(--border-subtle); border-radius: 4px; padding: 9px; background: var(--flow-node-bg); }.report-card summary { display: flex; align-items: baseline; gap: 8px; justify-content: space-between; cursor: pointer; line-height: 1.5; }.report-card summary strong { flex-shrink: 0; }.report-agent { color: var(--text-muted); margin: 8px 0 5px; }.report-card .muted { margin-top: 6px; }
.review-actions { display: grid; gap: 7px; }.review-actions button { min-height: 32px; }.cancel-run { justify-self: start; color: var(--danger); background: transparent; }
</style>
