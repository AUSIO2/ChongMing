<!-- 固定文件和目标图后核对精确类型、具体引用位置及剩余必填正文。 -->
<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from 'vue'

import type { ClientErrorData } from '../../../../contracts/client'
import type { Asset } from '../../../../contracts/control'
import type { DefinitionCatalog, DefinitionRef, JsonValue } from '../../../../contracts/data-definition'
import type { GraphPayload } from '../../../../contracts/graph'
import DataPayloadEditor from '../graph/DataPayloadEditor.vue'
import { definitionKey } from '../graph/data-payload'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { assetBuildSourceDraft, assetCreateSourcePayload, assetReadSourceTargets, type AssetSourceChoice } from './asset-source'

const props = defineProps<{
  asset: Asset
  catalog: DefinitionCatalog
  workspaceId: string
  mapName: string
  busy: boolean
  pendingRetry: boolean
  targetChanged: boolean
  error: ClientErrorData | null
  message: string
  submit: (input: { typeRef: DefinitionRef; payload: GraphPayload }) => Promise<boolean>
  retry: () => Promise<boolean>
}>()
const emit = defineEmits<{ close: [] }>()
enum AssetSourceDialogMessage {
  INITIAL_VALUE_FAILED = '这个来源类型的初值无法用于对象正文，请选择其它类型。',
  TARGET_CHANGED = '目标图或工作区已变化，请关闭后重新选择。',
}
const dialog = ref<HTMLDialogElement | null>(null)
const typeKey = ref(''), targetKey = ref(''), payload = ref<GraphPayload>({})
const creationError = ref('')
const submitting = ref(false)
let alive = true
const types = computed(() => /* 列出全部精确资产类型，不从目录首项推断语义。 */ props.catalog.dataTypes.filter(
  (/* 当前目录中的一份不可变类型。 */ type) => /* 有明确资产声明才可快捷填写。 */ type.references.some(
    (/* 该类型的一项引用。 */ reference) => /* 节点引用不属于文件位置。 */ reference.target.kind === 'asset',
  ),
))
const selectedType = computed(() => /* 当前明确选择的完整类型。 */ types.value.find(
  (/* 当前真实的精确类型。 */ type) => /* 同ID其它版本不替换用户选择。 */ definitionKey(type) === typeKey.value,
))
const targets = computed(() => /* 数组位置只来自用户已建立的项，非对象初值不能继续构造。 */ selectedType.value && !creationError.value ? assetReadSourceTargets(selectedType.value, payload.value) : [])
const options = computed(() => /* 相同具体位置的不同声明仍可明确选择，普通位置保留Pointer值。 */ targets.value.map(
  (/* 当前可填写的具体位置。 */ target) => {
    // 唯一位置的值就是可读Pointer；仅重复规则追加索引，不解析任意用户路径。
    const repeated = targets.value.filter((/* 另一引用位置。 */ item) => /* 比较完整具体Pointer。 */ item.path === target.path).length > 1
    return { target, key: repeated ? `${target.path}#${target.referenceIndex}` : target.path,
      label: repeated ? `${target.path}（引用规则 ${target.referenceIndex + 1}）` : target.path }
  },
))
const selectedTarget = computed<AssetSourceChoice | null>(() => /* 选择必须仍属于当前类型及表单中的实际位置。 */
  options.value.find((/* 一个真实位置选项。 */ option) => /* 使用公开选项身份固定目标。 */ option.key === targetKey.value)?.target ?? null)
const built = computed(() => /* 确认前始终构造独立副本，不把用户Vue草稿交给异步读取。 */ selectedType.value && !creationError.value
  ? assetBuildSourceDraft({ workspaceId: props.workspaceId, asset: props.asset, type: selectedType.value, payload: payload.value, target: selectedTarget.value }) : null)
const locked = computed(() => /* 包含文件复核与实际图写入的完整等待期。 */ props.busy || props.pendingRetry || props.targetChanged || submitting.value)

function sourceChangeType(): void {
  // 合法目录也可包含非对象根；初始化拒绝留在窗口内，用户仍可切回对象类型。
  creationError.value = ''
  payload.value = {}
  targetKey.value = ''
  try { if (selectedType.value) payload.value = assetCreateSourcePayload(selectedType.value) }
  catch (cause) { creationError.value = cause instanceof Error ? cause.message : AssetSourceDialogMessage.INITIAL_VALUE_FAILED }
}

function sourceUpdatePayload(
  /* 原递归表单发出的完整JSON正文。 */ value: JsonValue,
): void {
  // 图节点根必须是对象；不通过类型断言把数组或标量伪装成可创建来源。
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) payload.value = value
}

async function sourceSubmit(): Promise<void> {
  // 只将已核对的精确类型和独立正文交给资产管理的原请求流程。
  const result = built.value, type = selectedType.value
  if (locked.value || !result?.ok || !type) return
  submitting.value = true
  try { if (await props.submit({ typeRef: { id: type.id, version: type.version }, payload: result.payload }) && alive) emit('close') }
  finally { if (alive) submitting.value = false }
}

async function sourceRetry(): Promise<void> {
  // 重试原管理操作，不重新读取当前表单或分配另一个节点身份。
  if (props.busy || submitting.value || !props.pendingRetry) return
  submitting.value = true
  try { if (await props.retry() && alive) emit('close') }
  finally { if (alive) submitting.value = false }
}

function sourceClose(): void {
  // 未确认的原请求继续归管理任务，关闭窗口不会清掉重试意图。
  if (!submitting.value) emit('close')
}

function sourceCancel(/* 原生Escape关闭意图。 */ event: Event): void {
  // 等待实际提交期间保留窗口，其余关闭沿相同父组件清理入口。
  event.preventDefault()
  sourceClose()
}

watch(options, (/* 最新类型/正文下可用的位置。 */ current) => {
  // 只有一个位置时预填并仍显示核对，多位置由用户明确选择。
  if (!current.some((/* 当前选项。 */ option) => /* 原目标仍然存在时不替换。 */ option.key === targetKey.value)) {
    targetKey.value = current.length === 1 ? current[0].key : ''
  }
}, { immediate: true })
onMounted(() => {
  // 默认类型只在唯一时预填，两个候选时不猜目录第一项。
  if (types.value.length === 1) { typeKey.value = definitionKey(types.value[0]); sourceChangeType() }
  dialog.value?.showModal()
})
onScopeDispose(() => {
  // 关闭或身份切换后，晚完成的父操作不再触发后来窗口。
  alive = false
})
</script>

<template>
  <dialog ref="dialog" class="asset-source-dialog" aria-label="添加资产来源" @cancel="sourceCancel">
    <form @submit.prevent="sourceSubmit">
      <h2>添加资产来源</h2>
      <p>目标图：{{ mapName }} · 文件：{{ asset.filename }}</p><p class="muted">{{ asset.mediaType }} · 校验摘要 {{ asset.sha256 }}</p>
      <fieldset class="source-fields" :disabled="locked">
        <label>来源类型<select v-model="typeKey" @change="sourceChangeType"><option value="">选择精确类型</option><option v-for="type in types" :key="definitionKey(type)" :value="definitionKey(type)">{{ type.title }} · {{ definitionKey(type) }}</option></select></label>
        <label>引用位置<select v-model="targetKey"><option value="">选择具体位置</option><option v-for="option in options" :key="option.key" :value="option.key">{{ option.label }}</option></select></label>
        <p v-if="selectedType && !options.length" class="muted">请在表单中选择资产定位分支；数组需要先添加实际条目，再核对引用位置。</p>
        <p class="muted">所选位置的文件标识和媒体类型使用上方文件记录，其余字段由你填写。更换类型会重新建立表单。</p>
        <DataPayloadEditor v-if="selectedType && !creationError" :schema="selectedType.schema" :model-value="payload" :field-labels="selectedType.presentation?.fieldLabels" :enum-labels="selectedType.presentation?.enumLabels" :references="selectedType.references" :disabled="locked" @update:model-value="sourceUpdatePayload" />
      </fieldset>
      <p v-if="creationError" class="error" role="alert">{{ creationError }}</p>
      <p v-if="targetChanged" class="error" role="alert">{{ AssetSourceDialogMessage.TARGET_CHANGED }}</p>
      <p v-if="error" class="error" role="alert">{{ uiReadErrorMessage(error.message) }}</p>
      <p v-if="message" class="error" role="alert">{{ message }}</p>
      <p v-if="built && !built.ok" class="muted">{{ built.message }}</p>
      <details v-if="built?.ok"><summary>核对将保存的来源正文</summary><pre>{{ JSON.stringify(built.payload, null, 2) }}</pre></details>
      <div class="actions"><button type="button" :disabled="submitting" @click="sourceClose">取消</button><button v-if="pendingRetry" type="button" :disabled="busy || submitting" @click="sourceRetry">重试同一操作</button><button class="primary" type="submit" :disabled="locked || !built?.ok">添加来源</button></div>
    </form>
  </dialog>
</template>

<style scoped>
.asset-source-dialog{margin:auto;width:min(680px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;padding:22px;border:1px solid var(--border);border-radius:var(--radius-dialog);background:var(--bg-panel);color:var(--text)}.asset-source-dialog::backdrop{background:#00000024}
form,.source-fields{display:grid;gap:13px;min-width:0}.source-fields{border:0;padding:0}h2{font-size:18px}label{display:grid;gap:6px;font-size:12px}p,summary{font-size:12px;line-height:1.7;overflow-wrap:anywhere}.muted{color:var(--text-muted)}.error{color:var(--danger)}.actions{display:flex;gap:8px;justify-content:flex-end}pre{font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg-input);padding:10px}
</style>
