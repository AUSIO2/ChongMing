<!-- 收录依据编辑：只读选择当前工作区的精确材料，按加入顺序交付四类固定引用。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'

import { clientReadError } from '../../../../client/graph-client'
import type { ClientGateway } from '../../../../contracts/client'
import type { Asset } from '../../../../contracts/control'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { EvidenceBasisRef } from '../../../../contracts/evidence-library'
import type { GraphMapSummary, GraphSnapshot } from '../../../../contracts/graph-api'
import { graphReadNodeText, graphReadNodeType } from '../graph/graph-layout'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import type { EvidenceSelectionContext } from './evidence-selection'
import { evidenceCreateState, type EvidenceUiContext } from './evidence-state'
import { evidenceReadBasis, evidenceReadJudgment } from './evidence-presentation'

const props = defineProps<{
  gateway: ClientGateway
  context: EvidenceSelectionContext
  maps: readonly GraphMapSummary[]
  catalog: DefinitionCatalog | null
  modelValue: EvidenceBasisRef[]
  disabled: boolean
}>()
const emit = defineEmits<{
  'update:modelValue': [/* 用户明确加入或移除后的完整有序依据集合。 */ refs: EvidenceBasisRef[]]
  unauthorized: []
}>()

enum BasisEditorMessage {
  MAP_MISMATCH = '返回的依据数据图与当前工作区不匹配。',
  ASSET_MISMATCH = '返回的依据文件不属于当前工作区。',
}

const MAX_BASES = 64
const MAX_TEXT_BYTES = 64 * 1024
const kind = ref<EvidenceBasisRef['kind']>('manual')
const manualText = ref('')
const selectedMapId = ref(''), selectedNodeId = ref(''), selectedAssetId = ref(''), selectedLibraryId = ref('')
const graph = shallowRef<GraphSnapshot | null>(null)
const assets = shallowRef<Asset[]>([])
const assetCursor = ref<string | null>(null)
const loading = ref(false), error = ref('')
const labels = ref<Record<string, string>>({})
let generation = 0
let controller: AbortController | null = null
const identity = computed(() => /* 依据选择只能属于同一服务、用户、工作区和原Claim目标。 */ JSON.stringify([
  props.context.userId, props.context.connectionKey, props.context.workspaceId, props.context.targetKey,
]))
const originalIdentity = identity.value
const ready = computed(() => /* 父页面按原Claim重新挂载；旧实例不能向后来目标交付依据。 */
  !props.disabled && props.context.active && identity.value === originalIdentity)
const availableMaps = computed(() => /* 只提供当前工作区目录中的真实图。 */
  props.maps.filter((/* 页面已授权读取的图摘要。 */ map) => /* 不把其他工作区的图放进选择。 */ map.workspaceId === props.context.workspaceId))
const nodeOptions = computed(() => /* 节点依据不限Claim，但必须有精确注册类型。 */
  (graph.value?.nodes ?? []).filter((/* 所选图中的已保存节点。 */ node) => /* 同名类型的其他版本不冒充精确定义。 */
    props.catalog?.dataTypes.some((/* 当前工作区一份不可变类型定义。 */ type) => /* 身份及版本同时匹配。 */ type.id === node.typeId && type.version === node.typeVersion)))
const libraryContext = computed<EvidenceUiContext>(() => /* 库候选读取沿用既有取消和身份隔离，不取得写权限。 */ ({
  userId: props.context.userId, connectionKey: props.context.connectionKey, workspaceId: props.context.workspaceId,
  active: ready.value && kind.value === 'library', canEdit: false,
}))
const library = evidenceCreateState(props.gateway, libraryContext, () => {
  // 当前库候选身份过期时通知工作区统一结束会话。
  emit('unauthorized')
})
const libraryOptions = computed(() => /* 新依据只能选择当前检索得到的活动条目。 */
  library.items.value.filter((/* 真实查询返回的一项库摘要。 */ entry) => /* 已撤回材料保留阅读，不成为新的收录依据。 */ entry.status === 'active'))
const selectedRows = computed(() => /* 展示标题仅属于本窗口，协议保留原引用及顺序。 */
  evidenceReadBasis(props.modelValue).map((/* 一项实际依据的通用展示。 */ row) => /* 选择时保留可读材料名，旧值仍可按固定身份解释。 */
    ({ ...row, text: labels.value[JSON.stringify(row.basis)] ?? row.text })))
const manualTooLong = computed(() => /* 人工依据保持原文，长度与服务端按UTF-8一致。 */
  new TextEncoder().encode(manualText.value).byteLength > MAX_TEXT_BYTES)
const candidate = computed<{ basis: EvidenceBasisRef; label: string } | null>(() => {
  // 将明确选择和其只读显示绑在一起，不在点击加入时重新提升节点版本或材料摘要。
  if (kind.value === 'manual') return manualText.value.trim() && !manualTooLong.value
    ? { basis: { kind: 'manual', text: manualText.value }, label: manualText.value } : null
  if (kind.value === 'node') {
    const map = graph.value
    const node = nodeOptions.value.find((/* 所选图中类型合法的实际节点。 */ item) => /* 必须由用户明确选中。 */ item.id === selectedNodeId.value)
    const summary = availableMaps.value.find((/* 当前图目录中的真实摘要。 */ item) => /* 已离开目录的图不能成为新的依据。 */ item.id === map?.mapId)
    return map && node && summary ? { basis: { kind: 'node', ref: { mapId: map.mapId, nodeId: node.id, revision: node.revision } },
      label: `${summary.name} · ${graphReadNodeType(node, props.catalog)} · 原版本 ${node.revision}\n${graphReadNodeText(node, props.catalog)}` } : null
  }
  if (kind.value === 'asset') {
    const asset = assets.value.find((/* 当前已加载的真实文件元数据。 */ item) => /* 摘要只能来自用户选择的该文件。 */ item.id === selectedAssetId.value)
    return asset ? { basis: { kind: 'asset', assetId: asset.id, sha256: asset.sha256 }, label: `${asset.filename} · ${asset.size.toLocaleString('zh-CN')} 字节` } : null
  }
  const entry = libraryOptions.value.find((/* 当前检索到的活动条目。 */ item) => /* 不凭外部输入构造固定摘要。 */ item.id === selectedLibraryId.value)
  return entry ? { basis: { kind: 'library', ref: { entryId: entry.id, contentDigest: entry.contentDigest } },
    label: `${evidenceReadJudgment(entry.confidence)}\n${entry.content}` } : null
})

function cancelRead(): void {
  // 结束该组件拥有的图或文件请求，迟到结果不能覆盖后来选择。
  generation++
  controller?.abort()
  controller = null
  loading.value = false
}

function readIsCurrent(
  /* 请求启动时固定的本窗口读取代次。 */ attempt: number,
  /* 该次图或文件读取独占的取消控制器。 */ signalOwner: AbortController,
): boolean {
  // 身份、类型、选择和关闭都会推进代次，显式disabled时也不接纳旧结果。
  return ready.value && attempt === generation && controller === signalOwner && !signalOwner.signal.aborted
}

function showReadError(
  /* 仅由仍有效的当前读取交付的失败。 */ cause: unknown,
): void {
  // 读取失败保留已经加入的依据，认证结束交给页面处理。
  const problem = clientReadError(cause)
  error.value = uiReadErrorMessage(problem.message)
  if (problem.status === 401 || problem.code === 'UNAUTHORIZED') emit('unauthorized')
}

async function readSelectedMap(): Promise<void> {
  // 只读一个明确选择的数据图，工作台当前图和节点选择保持由会话持有。
  const mapId = selectedMapId.value, workspaceId = props.context.workspaceId
  if (!ready.value || !workspaceId || !availableMaps.value.some((/* 已授权目录中的图。 */ map) => /* 只读用户明确选中的图。 */ map.id === mapId)) return
  const attempt = generation, signalOwner = new AbortController()
  controller = signalOwner; loading.value = true; error.value = ''
  try {
    const result = await props.gateway.read('map.get', { mapId }, signalOwner.signal)
    if (!readIsCurrent(attempt, signalOwner)) return
    if (result.mapId !== mapId || result.workspaceId !== workspaceId) throw new Error(BasisEditorMessage.MAP_MISMATCH)
    graph.value = result
  } catch (cause) {
    if (readIsCurrent(attempt, signalOwner)) showReadError(cause)
  } finally {
    if (readIsCurrent(attempt, signalOwner)) { loading.value = false; controller = null }
  }
}

async function readAssets(
  /* true继续当前有界文件页，false重新读取第一页。 */ append = false,
): Promise<void> {
  // 文件依据只选择已有ready资产，不创建上传入口或扫描所有分页。
  const workspaceId = props.context.workspaceId, cursor = assetCursor.value
  if (!ready.value || kind.value !== 'asset' || !workspaceId || loading.value || append && !cursor) return
  const attempt = generation, signalOwner = new AbortController()
  controller = signalOwner; loading.value = true; error.value = ''
  try {
    const result = await props.gateway.read('asset.list', { workspaceId, limit: 50, ...(append && cursor ? { cursor } : {}) }, signalOwner.signal)
    if (!readIsCurrent(attempt, signalOwner)) return
    if (result.items.some((/* 当前资产页中的真实文件。 */ asset) => /* 文件不得来自其他工作区。 */ asset.workspaceId !== workspaceId)) throw new Error(BasisEditorMessage.ASSET_MISMATCH)
    assets.value = append ? [...assets.value, ...result.items] : result.items
    assetCursor.value = result.nextCursor
  } catch (cause) {
    if (readIsCurrent(attempt, signalOwner)) showReadError(cause)
  } finally {
    if (readIsCurrent(attempt, signalOwner)) { loading.value = false; controller = null }
  }
}

async function searchLibrary(): Promise<void> {
  // 检索只更新活动库候选，已经加入的固定引用和原判断不会随检索变化。
  if (!ready.value || kind.value !== 'library') return
  selectedLibraryId.value = ''
  await library.search()
}

function copyBasis(
  /* 父草稿中的一项有序依据，复制后不共享嵌套身份对象。 */ basis: EvidenceBasisRef,
): EvidenceBasisRef {
  // 只复制既有合同字段，不将本组件的显示标题写入收录协议。
  if (basis.kind === 'node') return { ...basis, ref: { ...basis.ref } }
  if (basis.kind === 'library') return { ...basis, ref: { ...basis.ref } }
  return { ...basis }
}

function addBasis(): void {
  // 明确加入时才追加精确引用，保留重复材料和人工原文的原始顺序。
  const selected = candidate.value
  if (!ready.value || !selected || props.modelValue.length >= MAX_BASES || loading.value || library.loading.value) return
  labels.value[JSON.stringify(selected.basis)] = selected.label
  emit('update:modelValue', [...props.modelValue.map((/* 先前明确加入的依据。 */ basis) => /* 解除父草稿的对象共享。 */ copyBasis(basis)), copyBasis(selected.basis)])
  if (kind.value === 'manual') manualText.value = ''
}

function removeBasis(
  /* 用户点击的依据在完整有序集合中的位置。 */ index: number,
): void {
  // 仅移除对应位置，重复的同一固定引用仍有各自独立顺序。
  if (!ready.value) return
  emit('update:modelValue', props.modelValue.filter((/* 当前保留的依据。 */ _basis, /* 当前依据位置。 */ position) => /* 保留其他位置的依据。 */ position !== index)
    .map((/* 移除后仍存在的一项依据。 */ basis) => /* 返回与原草稿解除引用的完整集合。 */ copyBasis(basis)))
}

watch(() => /* 任何读取范围变化都结束旧图或文件请求；父页面更换Claim时重新挂载。 */
  [identity.value, kind.value, selectedMapId.value, ready.value] as const, () => {
  // 查询结果只服务当前类型与选择，不因切Map而改变已经加入的依据。
  cancelRead()
  graph.value = null; selectedNodeId.value = ''; assets.value = []; assetCursor.value = null
  selectedAssetId.value = ''; selectedLibraryId.value = ''; error.value = ''
  if (!ready.value) return
  if (kind.value === 'node') void readSelectedMap()
  else if (kind.value === 'asset') void readAssets()
}, { immediate: true, flush: 'sync' })

onBeforeUnmount(() => {
  // 收录窗口关闭时取消该实例的直接读取；库读取由其原有作用域统一清理。
  cancelRead()
})
</script>

<template>
  <section class="basis-editor" aria-label="收录依据">
    <h3>收录依据</h3><p class="note">可添加人工说明、图中节点、已有文件或固定库条目，依据将随收录决定保存。</p>
    <fieldset :disabled="!ready" class="basis-input">
      <label>依据类型<select aria-label="依据类型" v-model="kind"><option value="manual">人工说明</option><option value="node">图中节点</option><option value="asset">已有文件</option><option value="library">固定库条目</option></select></label>
      <template v-if="kind === 'manual'"><label>人工依据 · 可选<textarea v-model="manualText" rows="3" /></label><p v-if="manualTooLong" class="error">人工依据最多为64 KiB。</p></template>
      <template v-else-if="kind === 'node'">
        <label>依据数据图<select aria-label="依据数据图" v-model="selectedMapId"><option value="">选择数据图</option><option v-for="map in availableMaps" :key="map.id" :value="map.id">{{ map.name }}</option></select></label>
        <label>依据节点<select aria-label="依据节点" v-model="selectedNodeId" :disabled="loading || !graph"><option value="">选择节点</option><option v-for="node in nodeOptions" :key="node.id" :value="node.id">{{ graphReadNodeType(node, catalog) }} · 版本 {{ node.revision }} · {{ graphReadNodeText(node, catalog).slice(0, 100) }}</option></select></label>
      </template>
      <template v-else-if="kind === 'asset'">
        <label>依据文件<select aria-label="依据文件" v-model="selectedAssetId"><option value="">选择已有文件</option><option v-for="asset in assets" :key="asset.id" :value="asset.id">{{ asset.filename }} · {{ asset.size.toLocaleString('zh-CN') }} 字节</option></select></label>
        <button v-if="assetCursor" type="button" :disabled="loading" @click="readAssets(true)">加载更多依据文件</button>
      </template>
      <template v-else>
        <label>依据库检索<input v-model="library.filters.value.query" type="search"></label><button type="button" :disabled="library.loading.value" @click="searchLibrary">检索依据库</button>
        <label>依据库条目<select aria-label="依据库条目" v-model="selectedLibraryId"><option value="">选择活动库条目</option><option v-for="entry in libraryOptions" :key="entry.id" :value="entry.id">{{ evidenceReadJudgment(entry.confidence) }} · {{ entry.content }}</option></select></label>
        <button v-if="library.nextCursor.value" type="button" :disabled="library.loading.value" @click="library.loadMore()">加载更多依据库条目</button>
      </template>
      <p v-if="candidate && kind !== 'manual'" class="candidate-summary">{{ candidate.label }}</p>
      <p v-if="loading || library.loading.value" class="note" role="status">正在读取依据候选…</p>
      <p v-if="error || library.error.value" class="error" role="alert">{{ error || uiReadErrorMessage(library.error.value?.message ?? '') }}</p>
      <button type="button" :disabled="!candidate || modelValue.length >= MAX_BASES || loading || library.loading.value" @click="addBasis">加入依据</button>
    </fieldset>
    <section class="selected-bases" aria-label="已选收录依据"><header><h4>已选收录依据</h4><span>{{ modelValue.length }}/64 项</span></header><p v-if="!selectedRows.length" class="note">尚未添加依据。</p>
      <article v-for="(row, index) in selectedRows" :key="row.key"><div><strong>{{ index + 1 }}. {{ row.label }}</strong><button type="button" :disabled="!ready" :aria-label="`移除依据 ${index + 1}`" @click="removeBasis(index)">移除</button></div><p>{{ row.text }}</p></article>
    </section>
  </section>
</template>

<style scoped>
.basis-editor { display: grid; gap: 10px; min-width: 0; }
h3, h4 { margin: 0; font-size: 13px; font-weight: 600; }
.note, .selected-bases>header span { color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.basis-input { display: grid; gap: 10px; min-width: 0; padding: 13px 15px; border: 1px solid var(--border); border-radius: var(--radius-evidence); }
label { display: grid; gap: 6px; min-width: 0; font-size: 12px; }
input, select, textarea { width: 100%; min-width: 0; padding: 7px 9px; font: 12px/1.7 var(--ui-font); }
textarea { resize: vertical; }
button { justify-self: start; padding: 6px 10px; }
.candidate-summary { max-height: 160px; overflow: auto; padding: 9px 11px; background: var(--bg-related); white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 var(--content-font); }
.selected-bases { display: grid; gap: 9px; }
.selected-bases>header, article>div { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
article { display: grid; gap: 7px; border-bottom: 1px solid var(--border-subtle); padding: 10px 0; }
article strong { font-size: 12px; }
article p { white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.8 var(--content-font); }
.error { color: var(--danger); font-size: 12px; line-height: 1.7; }
</style>
