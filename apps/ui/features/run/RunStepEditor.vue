<!-- 稳定步骤实例拥有自己的选材生命周期；折叠只停止候选读取。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { ClientGateway } from '../../../../contracts/client'
import type { DefinitionCatalog, DefinitionRef } from '../../../../contracts/data-definition'
import type { EvidenceLibraryRef } from '../../../../contracts/evidence-library'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphPlanGrouping, GraphRunStep } from '../../../../contracts/graph-run'
import { evidenceCreateSelection, type EvidenceSelectionContext } from '../evidence-library/evidence-selection'
import EvidenceSelectionPanel from '../evidence-library/EvidenceSelectionPanel.vue'
import { definitionKey } from '../graph/data-payload'
import RunGroupingEditor from './RunGroupingEditor.vue'
import RunPortBindings from './RunPortBindings.vue'
import type { RunComposerTarget } from './RunComposer.vue'
import type { RunDraft, RunStepDraft } from './run-draft'

const props = defineProps<{
  step: RunStepDraft; draft: RunDraft; index: number; active: boolean
  target: RunComposerTarget; gateway: ClientGateway; snapshot: GraphSnapshot | null
  catalog: DefinitionCatalog | null; libraryAvailable: boolean; canEdit: boolean
  disabled: boolean; materialKey: string
}>()
const emit = defineEmits<{
  activate: []; remove: []; unauthorized: []
  transition: [ref: DefinitionRef | null]
  bind: [value: { kind: 'input' | 'context'; port: string; source: GraphRunStep['input'][number]['source'] }]
  dependencies: [ids: string[]]; grouping: [grouping: GraphPlanGrouping]
  onEmpty: [value: 'skip' | 'fail']; materials: [refs: EvidenceLibraryRef[]]
}>()
const transition = computed(() => /* 精确版本失效时保留原引用并让校验报错。 */ props.catalog?.transitions.find(
  (/* 目录中的正式转换。 */ item) => /* 同名不同版本不自动替换。 */ item.id === props.step.transitionRef?.id && item.version === props.step.transitionRef.version,
))
const previous = computed(() => /* 界面按前序依赖构建DAG，完整草稿仍检查环。 */ props.draft.steps.slice(0, props.index))
const notice = ref('')
const selectionContext = computed<EvidenceSelectionContext>(() => /* 每个步骤独立绑定身份和目标，仅展开项读取候选。 */ ({
  userId: props.target.userId, connectionKey: props.target.connectionKey, workspaceId: props.target.workspaceId,
  active: props.active && props.libraryAvailable && props.snapshot !== null && props.canEdit,
  canEdit: false, targetKey: props.materialKey,
}))
const selection = evidenceCreateSelection(props.gateway, selectionContext, () => {
  // 只由现有选材模块确认仍有效的认证失败交给页面会话。
  emit('unauthorized')
})
watch(selection.refs, (/* 本步骤显式选择的固定版本副本。 */ refs) => {
  // 根草稿保存可提交引用，摘要与候选请求继续由当前步骤拥有。
  emit('materials', refs)
}, { flush: 'sync' })
watch(() => /* 只追踪本步骤及它依赖的处理目标。 */ props.materialKey, () => {
  // 上游内容或本步骤配置变化后提醒重新核对，普通折叠不触发。
  notice.value = '处理目标或库能力已变化，材料选择已清空，请重新核对。'
})
function changeTransition(/* 用户明确改变转换的表单事件。 */ event: Event): void {
  // 只接收目录中的精确引用，端口重建由唯一草稿拥有者执行。
  const target = event.target
  if (props.disabled || !(target instanceof HTMLSelectElement)) return
  const next = props.catalog?.transitions.find((/* 当前发布转换。 */ item) => /* 不解析任意引用字符串。 */ definitionKey(item) === target.value)
  emit('transition', next ? { id: next.id, version: next.version } : null)
}
function isReferenced(/* 需要检查直接来源引用的前序步骤ID。 */ id: string): boolean {
  // 仍被端口使用的依赖需先改来源，避免制造不可见悬空引用。
  return [...props.step.input, ...props.step.context].some((/* 一项实际端口绑定。 */ binding) => /* 只阻止当前步骤仍在使用的直接来源。 */ binding.source.kind === 'step' && binding.source.stepId === id)
}
function toggleDependency(/* 用户明确勾选或取消的前序步骤ID。 */ id: string): void {
  // 自动来源依赖保留，其余显式依赖可逐项修改。
  if (props.disabled || isReferenced(id)) return
  const ids = props.step.dependsOn
  emit('dependencies', ids.includes(id) ? ids.filter((/* 原直接依赖。 */ current) => /* 只移除本次操作身份。 */ current !== id) : [...ids, id])
}
function changeEmpty(/* 空输入处理选择框的真实事件。 */ event: Event): void {
  // 空输入策略不绕过已知端口数量校验。
  const target = event.target
  if (!props.disabled && target instanceof HTMLSelectElement && (target.value === 'skip' || target.value === 'fail')) emit('onEmpty', target.value)
}
</script>

<template>
  <section :aria-label="`步骤 ${index + 1}`" class="step">
    <header><h3>步骤 {{ index + 1 }} · {{ transition?.title ?? '选择转换' }}<small v-if="step.transitionRef"> · {{ definitionKey(step.transitionRef) }}</small></h3><div><button type="button" @click="emit('activate')">编辑步骤 {{ index + 1 }}</button><button type="button" :disabled="disabled" @click="emit('remove')">移除步骤 {{ index + 1 }}</button></div></header>
    <div v-show="active" class="step-body">
      <label>转换<select :value="step.transitionRef ? definitionKey(step.transitionRef) : ''" :disabled="disabled" @change="changeTransition"><option v-if="!transition" :value="step.transitionRef ? definitionKey(step.transitionRef) : ''">{{ step.transitionRef ? `已失效转换 ${definitionKey(step.transitionRef)}` : '选择一个已发布转换' }}</option><option v-for="item in catalog?.transitions ?? []" :key="definitionKey(item)" :value="definitionKey(item)">{{ item.title }} · {{ definitionKey(item) }}</option></select></label>
      <p v-if="transition?.description">{{ transition.description }}</p>
      <fieldset v-if="previous.length" :disabled="disabled"><legend>直接依赖</legend><label v-for="(item, position) in previous" :key="item.id" class="check"><input type="checkbox" :checked="step.dependsOn.includes(item.id)" :disabled="isReferenced(item.id)" @change="toggleDependency(item.id)">步骤 {{ position + 1 }}{{ isReferenced(item.id) ? ' · 已被端口引用' : '' }}</label></fieldset>
      <RunPortBindings :draft="draft" :step="step" kind="input" :ports="transition?.ports.input ?? []" :snapshot="snapshot" :catalog="catalog" :disabled="disabled" @bind="emit('bind', {kind:'input', ...$event})" />
      <RunPortBindings :draft="draft" :step="step" kind="context" :ports="transition?.ports.context ?? []" :snapshot="snapshot" :catalog="catalog" :disabled="disabled" @bind="emit('bind', {kind:'context', ...$event})" />
      <RunGroupingEditor :grouping="step.grouping" :input="step.input" :ports="transition?.ports.input ?? []" :snapshot="snapshot" :catalog="catalog" :disabled="disabled" @change="emit('grouping', $event)" />
      <label>没有实际输入时<select :value="step.onEmpty" :disabled="disabled" @change="changeEmpty"><option value="fail">停止并报告失败</option><option value="skip">跳过这个步骤</option></select></label>
      <p>这里使用已保存的节点内容，正文编辑草稿不会自动保存或进入运行。</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="!libraryAvailable">当前服务未提供证据库</p>
      <EvidenceSelectionPanel :selection="selection" :disabled="!libraryAvailable || disabled" description="本步骤显式选中的固定版本将在开始处理时冻结。" />
    </div>
  </section>
</template>

<style scoped>
.step{display:grid;gap:12px;padding:14px;border:1px solid var(--border);min-width:0}header{display:flex;align-items:center;justify-content:space-between;gap:9px;flex-wrap:wrap}header>div{display:flex;gap:7px}header button{font-size:11px}h3{font-size:13px}.step-body{display:grid;gap:12px;min-width:0}label{display:grid;gap:6px;font-size:12px}p{font-size:11px;color:var(--text-muted);line-height:1.7}.check{display:flex;align-items:start;gap:7px}.check input{flex:none;margin-top:4px}fieldset{display:grid;gap:7px;border:1px solid var(--border-subtle);padding:9px;min-width:0}legend{font-size:12px}
</style>
