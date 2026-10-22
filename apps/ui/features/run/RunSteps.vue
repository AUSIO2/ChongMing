<!-- 当前运行与历史共用冻结步骤说明，所有状态只投影保存记录。 -->
<script setup lang="ts">
import { computed } from 'vue'

import type { GraphRun, GraphRunStep } from '../../../../contracts/graph-run'
import { runReadDependencyLinks, runReadStepPresentation } from './run-progress'

const props = defineProps<{ run: GraphRun }>()
const steps = computed(() => /* 每个面板只读自己的运行，不从当前目录或其它Run补状态。 */ runReadStepPresentation(props.run))
const links = computed(() => /* 只解释保存的直接依赖，不重建执行顺序。 */ runReadDependencyLinks(props.run))
const labels = { pending: '未启动', running: '处理中', completed: '已完成', skipped: '已跳过', failed: '已失败' }
const dependencyLabels = { ready: '依赖已满足', waiting: '等待前序步骤', blocked: '前序步骤失败', unknown: '依赖记录缺失' }
function stepName(/* 当前运行内的稳定步骤身份。 */ id: string): string {
  // 保留无法定位的原身份，不借其它运行的同名步骤。
  const index = props.run.plan.steps.findIndex((/* 保存计划的一项步骤。 */ step) => /* 使用原稳定身份定位。 */ step.id === id)
  return index < 0 ? `步骤 ${id}` : `步骤 ${index + 1}`
}
function sourceText(/* 保存的一项完整端口来源。 */ source: GraphRunStep['input'][number]['source']): string {
  // 正式产物来源只解释保存端口，范围输入不冒充冻结正文。
  if (source.kind === 'step') return `${stepName(source.stepId)} · 输出端口 ${source.port}`
  return source.nodeIds.length ? `本图保存节点：${source.nodeIds.join('、')}` : '未选择节点'
}
function groupingText(/* 保存计划中的实际分组规则。 */ grouping: GraphRunStep['grouping']): string {
  // 组数和成员属于启动规则，不被当成未来处理项总数。
  if (grouping.mode === 'each') return '逐个处理'
  if (grouping.mode === 'all') return '全部一起'
  return `显式分组 · ${grouping.groups.length} 组`
}
</script>

<template>
  <section class="run-steps" aria-label="运行步骤">
    <header><h3>运行步骤</h3><span>{{ steps.length }} 个计划步骤</span></header>
    <p class="note">步骤状态来自保存记录。处理项数量仅包含已经实例化的部分。</p>
    <section v-for="(item, index) in steps" :key="item.step.id" :aria-label="`步骤 ${index + 1}`" :data-step-id="item.step.id" class="step">
      <header><h4>步骤 {{ index + 1 }} · {{ item.title }}</h4><strong role="status">{{ item.state ? labels[item.state] : '未保存状态' }}</strong></header>
      <p class="identity">{{ item.step.transitionRef.id }}@{{ item.step.transitionRef.version }} · {{ item.step.id }}</p>
      <p v-if="item.paused">已暂停 · 保留原步骤和审核状态</p>
      <p v-if="item.state === 'pending' && ['completed', 'failed', 'cancelled'].includes(run.status)">运行已结束，此步骤未启动。</p>
      <p>{{ dependencyLabels[item.dependencyState] }}<template v-for="link in links.filter(link => link.toStepId === item.step.id)" :key="link.fromStepId"> · {{ stepName(link.fromStepId) }}（{{ link.state ? labels[link.state] : '未保存状态' }}）</template></p>
      <p>已实例化 {{ item.counts.total }} 项 · 完成 {{ item.counts.completed }} · 跳过 {{ item.counts.skipped }} · 失败 {{ item.counts.failed }} · 待审核 {{ item.counts.waitingReview }} · 复用 {{ item.counts.reused }}</p>
      <p v-if="item.missingOperationIds.length" class="warning">处理项记录缺失：{{ item.missingOperationIds.join('、') }}</p>
      <details><summary>端口来源与步骤规则</summary><div class="plan">
        <p v-for="binding in item.step.input" :key="`input:${binding.port}`">输入端口 {{ binding.port }} · {{ sourceText(binding.source) }}</p>
        <p v-for="binding in item.step.context" :key="`context:${binding.port}`">上下文端口 {{ binding.port }} · {{ sourceText(binding.source) }}</p>
        <p>{{ groupingText(item.step.grouping) }} · 无实际输入时{{ item.step.onEmpty === 'skip' ? '跳过' : '失败' }}</p>
        <p>固定库材料 {{ item.step.libraryClaimRefs?.length ?? 0 }} 条</p>
        <p v-for="reference in item.step.libraryClaimRefs ?? []" :key="reference.entryId">{{ reference.entryId }} · {{ reference.contentDigest }}</p>
        <ul v-if="item.operations.length"><li v-for="operation in item.operations" :key="operation.id">处理项 {{ operation.id }} · 已发布 {{ operation.outputRefs.length }} 项<template v-if="operation.reusedFromOperationId"> · 复用 {{ operation.reusedFromOperationId }}</template></li></ul>
        <details><summary>保存的步骤计划</summary><pre>{{ JSON.stringify(item.step, null, 2) }}</pre></details>
      </div></details>
    </section>
  </section>
</template>

<style scoped>
.run-steps{display:grid;gap:10px;padding:14px;border-top:1px solid var(--border);min-width:0}header{display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap}h3{font-size:13px}h4{font-size:12px}header span,p,li{font-size:11px;line-height:1.7;color:var(--text-muted)}strong{font-size:12px}.step{display:grid;gap:6px;padding:10px;border-left:2px solid var(--border);min-width:0}.identity,.plan{overflow-wrap:anywhere}.plan{display:grid;gap:7px;padding-top:8px}summary{font-size:11px;cursor:pointer;line-height:1.7}pre{font-size:10px;max-height:220px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}.warning{color:var(--danger)}ul{padding-left:18px;margin:0}
</style>
