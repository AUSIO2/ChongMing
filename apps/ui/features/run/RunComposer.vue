<!-- 两入口共用的运行计划表单；根拥有唯一草稿，各步骤拥有自己的选材。 -->
<script lang="ts">
export interface RunComposerTarget {
  userId: string
  connectionKey: string
  workspaceId: string
  mapId: string
  seed: import('./run-draft').RunDraftSeed
}
</script>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'

import type { ClientErrorData, ClientGateway } from '../../../../contracts/client'
import type { DefinitionCatalog, DefinitionRef } from '../../../../contracts/data-definition'
import type { EvidenceLibraryRef } from '../../../../contracts/evidence-library'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphRunStep } from '../../../../contracts/graph-run'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { graphReadNodeText, graphReadNodeType } from '../graph/graph-layout'
import RunStepEditor from './RunStepEditor.vue'
import {
  runAddStep, runBindPort, runBuildSubmission, runCreateDraft, runCreateStep,
  runReadScopeNodeIds, runReadSelectionKey, runRemoveStep, runSetDependencies,
  type RunStartInput, type RunStepDraft,
} from './run-draft'

const props = defineProps<{
  target: RunComposerTarget
  gateway: ClientGateway
  snapshot: GraphSnapshot | null
  catalog: DefinitionCatalog | null
  libraryAvailable: boolean
  canEdit: boolean
  busy: boolean
  pendingRetry: boolean
  error: ClientErrorData | null
  submit: (/* 窗口创建时绑定的完整身份。 */ target: RunComposerTarget, /* 本次确认后独立冻结的计划。 */ input: RunStartInput) => Promise<boolean>
  retry: (/* 窗口创建时绑定的完整身份。 */ target: RunComposerTarget) => Promise<boolean>
}>()
const emit = defineEmits<{ close: [target: RunComposerTarget]; unauthorized: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const snapshot = computed(() => /* 只读打开时真实Map，旧图快照不成为新目标输入。 */
  props.snapshot?.workspaceId === props.target.workspaceId && props.snapshot.mapId === props.target.mapId ? props.snapshot : null)
const draft = ref(runCreateDraft(props.target.seed, props.catalog, snapshot.value))
const activeStepId = ref(draft.value.steps[0]?.id ?? '')
const submitting = ref(false)
const editError = ref('')
let alive = true
const locked = computed(() => /* 锁定完整启动等待，不只依赖session短暂的准备busy。 */
  submitting.value || props.busy || props.pendingRetry || !props.canEdit)
const stepKeys = computed(() => /* 上游依赖变化只清理受影响步骤；材料引用本身不参与key。 */ new Map(draft.value.steps.map(
  (/* 本窗口唯一草稿中的稳定步骤。 */ step) => /* 每步按自身目标及上游目标计算。 */ [step.id, runReadSelectionKey(draft.value, snapshot.value, props.libraryAvailable, step.id)],
)))
watch(stepKeys, (/* 最新各步目标key。 */ next, /* 修改前各步目标key。 */ previous) => {
  // 同步移除旧引用，防止用户在子组件下一次渲染前提交到旧材料。
  let changed = false
  const steps = draft.value.steps.map((/* 原草稿的一项步骤。 */ step) => {
    // 新增空步骤没有旧材料，其它步骤只在实际目标改变时清理。
    if (!step.libraryClaimRefs?.length || !previous.has(step.id) || previous.get(step.id) === next.get(step.id)) return step
    const copy = { ...step }
    delete copy.libraryClaimRefs
    changed = true
    return copy
  })
  if (changed) draft.value = { ...draft.value, steps }
}, { flush: 'sync' })
const submission = computed(() => /* 确认后不再消费可变表单对象，所有材料都从所属步骤取得。 */
  runBuildSubmission(draft.value, { snapshot: snapshot.value, catalog: props.catalog }))
const scopeNodes = computed(() => /* 包括上下文的去重并集可供用户核对授权范围。 */ {
  const ids = new Set(runReadScopeNodeIds(draft.value))
  return snapshot.value?.nodes.filter((/* 本图已保存节点。 */ node) => /* 库来源与未来产物不属于启动范围。 */ ids.has(node.id)) ?? []
})

function composerPatchStep(/* 用户正在编辑的稳定步骤身份。 */ id: string, /* 明确变动的步骤字段。 */ patch: Partial<RunStepDraft>): void {
  // 所有表单变动只写这个根草稿，不启动Run或写入节点。
  if (locked.value) return
  editError.value = ''
  draft.value = { ...draft.value, steps: draft.value.steps.map((/* 原步骤。 */ step) => /* 不影响其它独立步骤。 */ step.id === id ? { ...step, ...patch } : step) }
}
function composerAddStep(): void {
  // 添加未配置步骤后立即展开，由用户明确选择转换及端口。
  if (locked.value || draft.value.steps.length >= 64) return
  draft.value = runAddStep(draft.value)
  activeStepId.value = draft.value.steps[draft.value.steps.length - 1]?.id ?? ''
  editError.value = ''
}
function composerRemoveStep(/* 用户明确移除的稳定步骤身份。 */ id: string): void {
  // 拒绝删除仍被依赖的步骤，不隐式改写其它端口来源。
  if (locked.value) return
  const result = runRemoveStep(draft.value, id)
  if (!result.ok) { editError.value = result.message; return }
  draft.value = result.draft
  if (activeStepId.value === id) activeStepId.value = draft.value.steps[0]?.id ?? ''
  editError.value = ''
}
function composerChangeTransition(/* 本次明确改转换的步骤。 */ id: string, /* 已发布的精确转换引用或空选择。 */ reference: DefinitionRef | null): void {
  // 重建声明端口并保留稳定步骤身份及显式依赖，不继承另一转换的材料。
  const original = draft.value.steps.find((/* 唯一草稿中的步骤。 */ step) => /* 使用稳定身份定位。 */ step.id === id)
  if (!original || locked.value) return
  const transition = props.catalog?.transitions.find((/* 当前发布定义。 */ item) => /* 不降级到同名其它版本。 */ item.id === reference?.id && item.version === reference.version) ?? null
  const next = runCreateStep(transition, { snapshot: snapshot.value })
  composerPatchStep(id, { ...next, id, dependsOn: [...original.dependsOn], libraryClaimRefs: undefined })
}
function composerBindPort(/* 当前被编辑的稳定步骤。 */ id: string, /* 子表单确认的一个完整端口来源。 */ binding: { kind: 'input' | 'context'; port: string; source: GraphRunStep['input'][number]['source'] }): void {
  // 由纯草稿模块自动建立正式输出所需的直接依赖。
  if (locked.value) return
  draft.value = runBindPort(draft.value, { stepId: id, ...binding })
  editError.value = ''
}
function composerDependencies(/* 当前被编辑的稳定步骤。 */ id: string, /* 用户明确选择的直接依赖列表。 */ ids: string[]): void {
  // 端口引用依赖受模块约束，界面不自行拼接依赖规则。
  if (locked.value) return
  const result = runSetDependencies(draft.value, id, ids)
  if (result.ok) { draft.value = result.draft; editError.value = '' }
  else editError.value = result.message
}
function composerMaterials(/* 仍挂载的材料拥有步骤身份。 */ id: string, /* 本步骤显式选中的固定引用。 */ refs: EvidenceLibraryRef[]): void {
  // 引用清空也允许在锁定时同步回写，已提交请求持有独立冻结副本。
  const original = draft.value.steps.find((/* 当前仍存活的步骤。 */ step) => /* 删除步骤的迟到事件被丢弃。 */ step.id === id)
  if (!original || JSON.stringify(original.libraryClaimRefs ?? []) === JSON.stringify(refs)) return
  const copy = { ...original }
  if (refs.length) copy.libraryClaimRefs = refs.map((/* 原选材引用。 */ reference) => /* 根草稿取得独立条目副本。 */ ({ ...reference }))
  else delete copy.libraryClaimRefs
  draft.value = { ...draft.value, steps: draft.value.steps.map((/* 当前步骤。 */ step) => /* 仅更新材料拥有者。 */ step.id === id ? copy : step) }
}
async function composerSubmit(): Promise<void> {
  // Page仍是session启动的调用者，此组件等待完整结果后再决定是否关闭。
  const built = submission.value
  if (locked.value || !built.ok) return
  const target = props.target
  submitting.value = true
  try {
    if (await props.submit(target, built.input) && alive) emit('close', target)
  } finally {
    if (alive) submitting.value = false
  }
}
async function composerRetry(): Promise<void> {
  // 原请求确认不重建计划、Run ID或材料，参数由session保留。
  if (submitting.value || props.busy || !props.pendingRetry) return
  const target = props.target
  submitting.value = true
  try {
    if (await props.retry(target) && alive) emit('close', target)
  } finally {
    if (alive) submitting.value = false
  }
}
function composerClose(): void {
  // 正在启动时等本次调用结束；待确认状态可关窗口，原请求仍由session保留。
  if (!submitting.value) emit('close', props.target)
}
function composerCancel(/* 原生dialog的Escape关闭意图。 */ event: Event): void {
  // 统一经过窗口关闭处理，不借Escape取消Run或丢弃原重试。
  event.preventDefault()
  composerClose()
}
onMounted(() => {
  // 窗口首次挂载时使用原生模态焦点和键盘约束。
  dialog.value?.showModal()
})
onScopeDispose(() => {
  // 各步骤结束自己的请求；旧提交完成后不再关闭后来打开的窗口。
  alive = false
})
</script>

<template>
  <dialog ref="dialog" class="run-composer" aria-labelledby="run-dialog-title" @cancel="composerCancel" @close="composerClose">
    <form @submit.prevent="composerSubmit">
      <h2 id="run-dialog-title">运行数据转换</h2>
      <fieldset class="run-fields" :disabled="locked">
        <label>处理方式<select v-model="draft.mode"><option value="human-in-loop">人工审核角度与结果</option><option value="auto">自动处理并保存结果</option></select></label>
        <RunStepEditor v-for="(step, index) in draft.steps" :key="step.id" :step="step" :draft="draft" :index="index" :active="activeStepId === step.id" :target="target" :gateway="gateway" :snapshot="snapshot" :catalog="catalog" :library-available="libraryAvailable" :can-edit="canEdit" :disabled="locked" :material-key="stepKeys.get(step.id) ?? ''" @activate="activeStepId = step.id" @remove="composerRemoveStep(step.id)" @transition="composerChangeTransition(step.id, $event)" @bind="composerBindPort(step.id, $event)" @dependencies="composerDependencies(step.id, $event)" @grouping="composerPatchStep(step.id, {grouping:$event})" @on-empty="composerPatchStep(step.id, {onEmpty:$event})" @materials="composerMaterials(step.id, $event)" @unauthorized="emit('unauthorized')" />
        <button type="button" :disabled="draft.steps.length >= 64" @click="composerAddStep">添加步骤</button>
        <p class="muted">步骤 {{ draft.steps.length }}/64 · 每个端口只使用本图节点或一个前步的正式输出。产物数量在运行时确定。</p>
        <label class="check"><input v-model="draft.regenerate" type="checkbox">重新生成已有结果</label>
      </fieldset>
      <section class="plan-review" aria-label="计划核对"><h3>计划核对</h3><p class="muted">运行范围 {{ scopeNodes.length }} 个保存节点，包含输入和只读上下文。系统按该范围及后继检查分支权限。</p><ul><li v-for="node in scopeNodes" :key="node.id">{{ graphReadNodeType(node, catalog) }} · {{ graphReadNodeText(node, catalog) }} · {{ node.id }}</li></ul><details v-if="submission.ok"><summary>查看完整计划与逐步材料</summary><pre>{{ JSON.stringify(submission.input, null, 2) }}</pre></details></section>
      <p class="muted">一次运行使用冻结的转换、类型和智能体定义；默认复用规格与输入版本完全一致的有效结果。</p>
      <p v-if="editError" class="error" role="alert">{{ editError }}</p>
      <p v-if="!submission.ok" class="error">{{ submission.message }}</p>
      <p v-if="error" class="error" role="alert" :title="error.message">{{ uiReadErrorMessage(error.message) }}</p>
      <div class="dialog-actions"><button type="button" :disabled="submitting" @click="composerClose">取消</button><button v-if="pendingRetry" type="button" :disabled="busy || submitting" @click="composerRetry">重试同一操作</button><button class="primary" type="submit" :disabled="locked || !submission.ok">开始处理</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.run-composer{margin:auto;width:min(900px,calc(100vw - 40px));max-height:calc(100vh - 40px);overflow:auto;padding:24px;border:1px solid var(--border);border-radius:var(--radius-dialog);background:var(--bg-panel);color:var(--text)}.run-composer::backdrop{background:#00000024}
form,.run-fields{display:grid;gap:13px;min-width:0}.run-fields{border:0;padding:0}h2{font-size:20px}h3{font-size:13px}label{display:grid;gap:6px;font-size:13px}.muted{font-size:12px;line-height:1.7;color:var(--text-muted)}.check{display:flex;gap:8px;align-items:start;line-height:1.7}.check input{margin-top:5px;flex:none}.dialog-actions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;margin-top:7px}.error{font-size:12px;line-height:1.7;color:var(--danger)}.plan-review{display:grid;gap:8px;border-top:1px solid var(--border);padding-top:12px}.plan-review ul{display:grid;gap:4px;max-height:130px;overflow:auto;margin:0;padding-left:18px;font-size:11px;line-height:1.7;overflow-wrap:anywhere}.plan-review summary{font-size:12px;cursor:pointer}.plan-review pre{font-size:11px;max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
</style>
