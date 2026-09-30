<!-- 通用 Operation 审核：按冻结阶段展示计划、候选和结果，提交版本化审核决定。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { CommandInputMap } from '../../../../contracts/client'
import type { GraphOperation, GraphRun, GraphSnapshot, GraphStageResult } from '../../../../contracts/graph'
import { graphReadNodeText, graphReadNodeType, graphReadOperationLabel, graphReadOperationProgress } from '../graph/graph-layout'

const props = defineProps<{ snapshot: GraphSnapshot; run: GraphRun; operation: GraphOperation; canEdit: boolean; canControl: boolean; busy: boolean }>()
const emit = defineEmits<{ answer: [input: Omit<CommandInputMap['review.answer'], 'control'>] }>()
const review = computed(() => props.operation.review)
const pending = computed(() => props.operation.status === 'waiting' && review.value?.state === 'pending')
const inputs = computed(() => props.operation.group.inputRefs.map(ref => ({ ref, node: props.snapshot.nodes.find(node => node.id === ref.id) })))
const stages = computed(() => props.operation.stages.map(group => ({
  group,
  spec: props.operation.executionSpec.stages.find(stage => stage.id === group.stageId),
  agentNames: [...new Set(group.planSlots.map(slot => props.run.agents.find(agent => agent.ref.id === slot.agentRef.id && agent.ref.version === slot.agentRef.version)?.profile.name ?? slot.agentRef.id))],
})))
const planResults = computed(() => props.operation.stages.flatMap(stage => stage.results.filter((result): result is Extract<GraphStageResult, { mode: 'plan' }> => result.mode === 'plan')))
const outputResults = computed(() => props.operation.stages.flatMap(stage => stage.results.filter((result): result is Extract<GraphStageResult, { mode: 'outputs' }> => result.mode === 'outputs')))
const selectionResults = computed(() => props.operation.stages.flatMap(stage => stage.results.filter((result): result is Extract<GraphStageResult, { mode: 'selection' }> => result.mode === 'selection')))
const latestPlan = computed(() => planResults.value[planResults.value.length - 1])
const latestSelection = computed(() => selectionResults.value[selectionResults.value.length - 1])

/**
 * @param decision 用户对当前版本审核的决定。
 */
function reviewAnswer(decision: 'approve' | 'reject'): void {
  const current = review.value
  if (!current || !pending.value || !props.canEdit || !props.canControl || props.busy) return
  emit('answer', { mapId: props.snapshot.mapId, runId: props.run.id, operationId: props.operation.id,
    reviewId: current.id, expectedReviewRevision: current.revision, decision })
}
</script>

<template>
  <section class="run-review" :aria-label="`${graphReadOperationLabel(operation)}进度与审核`" :data-operation-id="operation.id">
    <header class="run-header"><div><h2>{{ graphReadOperationLabel(operation) }}</h2><small>{{ operation.transitionRef.id }}@{{ operation.transitionRef.version }}</small></div></header>
    <div class="run-content">
      <div class="targets">
        <article v-for="item in inputs" :key="item.ref.key"><small>{{ item.ref.port }}</small><strong>{{ item.node ? graphReadNodeType(item.node, run.definitions) : item.ref.type.id }}</strong><p>{{ item.node ? graphReadNodeText(item.node, run.definitions) : item.ref.id }}</p></article>
      </div>
      <div class="run-status" :class="{ attention: pending || operation.status === 'running', failed: operation.status === 'failed', cancelled: operation.status === 'cancelled' }"><span class="status-dot" aria-hidden="true" /><strong>{{ graphReadOperationProgress(operation) }}</strong></div>
      <p v-if="operation.status === 'failed'" class="muted">本项处理未完成，已经接纳的阶段结果仍保留。</p>

      <section class="progress-section">
        <div class="section-heading"><h3>执行阶段</h3><span>{{ stages.filter(item => item.group.closed).length }} / {{ stages.length }}</span></div>
        <article v-for="item in stages" :key="item.group.stageId" class="stage-row">
          <div><strong>{{ item.group.stageId }}</strong><p>{{ item.agentNames.join('、') || item.spec?.agent.profile.name || '等待计划' }}</p></div>
          <span>{{ item.group.closed ? '已完成' : `${item.group.results.length} / ${item.group.expectedWorkIds.length || '待计划'}` }}</span>
        </article>
      </section>

      <section v-if="latestPlan" class="result-section">
        <div class="section-heading"><h3>执行计划</h3><span>{{ latestPlan.plan.slots.length }} 个 Agent 工作</span></div>
        <p class="result-reason">{{ latestPlan.plan.reason }}</p>
        <article v-for="slot in latestPlan.plan.slots" :key="slot.id" class="result-card"><strong>{{ slot.angle || slot.stageId }}</strong><p>{{ slot.hint || '按阶段定义执行' }}</p><small>{{ slot.agentRef.id }}@{{ slot.agentRef.version }} · {{ slot.tools.length ? slot.tools.join('、') : '不使用工具' }}</small></article>
      </section>

      <section v-if="outputResults.length" class="result-section">
        <div class="section-heading"><h3>候选产物</h3><span>{{ outputResults.reduce((count, result) => count + result.outputs.length, 0) }} 项</span></div>
        <template v-for="result in outputResults" :key="result.workId">
          <p class="result-reason">{{ result.reason }}</p>
          <article v-for="output in result.outputs" :key="`${result.workId}:${output.key}`" class="result-card"><strong>{{ output.port }} · {{ output.typeRef.id }}@{{ output.typeRef.version }}</strong><pre>{{ JSON.stringify(output.payload, null, 2) }}</pre></article>
        </template>
      </section>

      <section v-if="latestSelection" class="result-section">
        <div class="section-heading"><h3>候选选择</h3><span>{{ latestSelection.selection.length }} 项</span></div>
        <p class="result-reason">{{ latestSelection.reason }}</p>
      </section>

      <div v-if="pending && canEdit && canControl" class="review-actions">
        <button type="button" class="primary" :disabled="busy" @click="reviewAnswer('approve')">{{ review?.kind === 'plan' ? '批准执行计划' : '批准并发布结果' }}</button>
        <button type="button" :disabled="busy" @click="reviewAnswer('reject')">拒绝本项处理</button>
      </div>
      <p v-else-if="pending" class="muted">{{ canEdit ? '领取运行控制权后可审核。' : '等待工作区 Editor 或 Owner 确认。' }}</p>
      <p v-if="run.paused && pending" class="muted">运行已暂停；审核后仍需点击继续才会执行后续工作。</p>
    </div>
  </section>
</template>

<style scoped>
.run-review{border-top:1px solid var(--border);background:var(--bg-panel);min-width:0}.run-header{padding:12px 14px;border-bottom:1px solid var(--border-subtle)}.run-header small{display:block;margin-top:3px;color:var(--text-muted)}h2{font-size:14px;font-weight:600}h3{font-size:12px;font-weight:600}.run-content{display:grid;gap:13px;padding:12px 14px}.targets{display:grid;gap:6px}.targets article{border-left:2px solid var(--border);padding-left:9px;min-width:0}.targets small,.targets p{color:var(--text-muted);font-size:11px}.targets p{margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.run-status{display:flex;align-items:center;gap:7px;font-size:12px}.status-dot{width:7px;height:7px;border-radius:50%;background:var(--success);flex-shrink:0}.attention .status-dot{background:var(--accent)}.failed .status-dot{background:var(--danger)}.cancelled .status-dot{background:var(--text-muted)}.section-heading{display:flex;justify-content:space-between;gap:8px;align-items:baseline}.section-heading>span,.muted{color:var(--text-muted);font-size:11px;line-height:1.6}.progress-section,.result-section{display:grid;gap:9px}.stage-row,.result-card{display:flex;justify-content:space-between;gap:8px;padding:9px;border:1px solid var(--border-subtle);background:var(--flow-node-bg)}.stage-row p,.stage-row>span,.result-card small{color:var(--text-muted);font-size:11px}.result-card{display:grid}.result-card pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.result-reason{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.6 var(--content-font)}.review-actions{display:grid;gap:7px}.review-actions button{min-height:32px}
</style>
