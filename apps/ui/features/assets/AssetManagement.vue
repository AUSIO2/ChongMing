<!-- 资产管理：分页浏览、上传下载、创建来源及分阶段导入工作区。 -->
<script setup lang="ts">
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { computed, onMounted, onScopeDispose, ref, shallowRef } from 'vue'
import { CLIENT_FILE_LIMIT, type ClientDownloadInput, type ClientGateway } from '../../../../contracts/client'
import type { AppBootstrap, Asset, DefinitionView, ImportResult, WorkspaceView } from '../../../../contracts/control'
import type { DefinitionCatalog, DefinitionRef } from '../../../../contracts/data-definition'
import type { GraphPayload } from '../../../../contracts/graph'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import { payloadFindType } from '../graph/data-payload'
import { clientSaveFile } from './file-save'
import { useManagementTask } from '../management/use-management'
import AssetSourceDialog from './AssetSourceDialog.vue'
import { assetReadSourceChoices, assetReadSourceReferences } from './asset-source'

enum AssetSourceManagementMessage {
  FILE_CHANGED = '所选文件已不可用或内容标识发生变化，请关闭后重新选择。',
  TARGET_CHANGED = '目标图、工作区或精确来源类型已变化，请重新选择。',
}

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap; snapshot: GraphSnapshot | null }>()
const emit = defineEmits<{ changed: []; unauthorized: []; imported: [workspaceId: string] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => /* 将资产操作中的认证失效通知父组件。 */ emit('unauthorized') })
const { busy, error, canRetry } = task
const assets = ref<Asset[]>([]), nextCursor = ref<string | null>(null), loaded = ref(false)
const selectedFile = ref<File | null>(null), uploaded = ref<Asset | null>(null), importFile = ref<File | null>(null)
const uploadInput = ref<HTMLInputElement | null>(null), importInput = ref<HTMLInputElement | null>(null)
const importName = ref(''), importStage = ref<{ targetId: string; asset: Asset; result: ImportResult | null; name: string } | null>(null)
const deleteTarget = ref<Asset | null>(null), readingFile = ref(false), localError = ref(''), message = ref('')
const createdSources = ref<Record<string, number>>({})
const definitions = shallowRef<DefinitionView | null>(null)
const sourceTarget = shallowRef<{ asset: Asset; workspaceId: string; mapId: string; mapName: string; nodeId: string; catalog: DefinitionCatalog } | null>(null)
const owner = computed(() => /* 判断当前用户是否拥有工作区管理权限。 */ props.workspace?.role === 'owner')
const canUpload = computed(() => /* 判断当前工作区是否允许上传和新增来源。 */ !!props.workspace && props.workspace.role !== 'viewer')
const locked = computed(() => /* 在请求执行、等待重试或读取本地文件时锁定资产操作。 */ busy.value || canRetry.value || readingFile.value)
const currentMap = computed(() => /* 仅使用属于当前工作区的图快照作为来源添加目标。 */ props.snapshot?.workspaceId === props.workspace?.id ? props.snapshot : null)
const sourceChoices = computed(() => /* 当前目录的全部精确类型和资产声明，不按首项猜语义。 */ assetReadSourceChoices(definitions.value?.catalog ?? null))
const sourceTargetChanged = computed(() => /* 待确认的文件来源始终属于打开时的同一工作区和Map。 */ !!sourceTarget.value
  && (sourceTarget.value.workspaceId !== props.workspace?.id || sourceTarget.value.mapId !== currentMap.value?.mapId || !canUpload.value))
const mediaTypes: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', json: 'application/json' }
let alive = true
onScopeDispose(() => {
  // 卸载后停止接纳本地文件读取结果。
  alive = false
})

/**
 * 按字节数选择 B、KiB 或 MiB 单位显示文件大小。
 *
 * @param size 文件实际大小，单位字节。
 */
function assetFormatSize(size: number) {
  return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`
}
/**
 * 把新资产放到列表首位，同时替换已有同标识条目。
 *
 * @param asset 服务端确认的资产记录，将替换列表中的同身份旧记录。
 */
function assetUpdateList(asset: Asset) {
  assets.value = [asset, ...assets.value.filter(item => /* 移除列表中与新资产同标识的旧记录。 */ item.id !== asset.id)]
}
/**
 * 读取上传或导入文件选择，拒绝超限文件并清空相应输入。
 *
 * @param event 文件输入框的选择事件，从 target.files 取得用户选择的文件。
 * @param importing 是否选择导入包，默认 false 表示普通资产上传。
 */
function assetUpdateFileSelection(
  event: Event,
  importing = false
) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  localError.value = ''
  if (importing) importFile.value = null
  else selectedFile.value = null
  if (file && file.size > CLIENT_FILE_LIMIT) { localError.value = '单个文件或导入包不能超过 64 MiB。'; (event.target as HTMLInputElement).value = ''; return }
  if (importing) importFile.value = file
  else selectedFile.value = file
}
/**
 * 读取当前工作区首批或下一批资产，并更新分页状态。
 *
 * @param more 是否追加下一页，默认 false 表示重载首批资产。
 */
async function assetReadList(more = false) {
  if (!props.workspace || (more && !nextCursor.value)) return
  await task.read('asset.list', { workspaceId: props.workspace.id, limit: 20, ...(more && nextCursor.value ? { cursor: nextCursor.value } : {}) }, value => {
    // 接纳资产页，追加时按标识去重，并保存下一页游标。
    assets.value = more ? [...assets.value, ...value.items.filter(item =>
      /* 只追加尚未存在于当前资产列表的条目。 */
      !assets.value.some(existing =>
        /* 匹配当前列表中的同标识资产。 */
        existing.id === item.id))] : value.items
    nextCursor.value = value.nextCursor; loaded.value = true
  })
}
/**
 * 读取已选文件字节并上传，成功后记录普通资产或待导入包，忽略卸载后的结果。
 *
 * @param importing 是否上传暂存导入包，默认 false；导入时额外要求所有者权限。
 */
async function assetCreateUpload(importing = false) {
  const file = importing ? importFile.value : selectedFile.value
  if (!file || !props.workspace || !canUpload.value || locked.value || (importing && !owner.value)) return
  localError.value = ''; readingFile.value = true
  let bytes: Uint8Array
  try { bytes = new Uint8Array(await file.arrayBuffer()) }
  catch { if (alive) localError.value = '文件读取失败，请重新选择文件。'; return }
  finally { if (alive) readingFile.value = false }
  if (!alive || (importing ? importFile.value : selectedFile.value) !== file) return
  const targetId = crypto.randomUUID()
  const extension = file.name.toLowerCase().match(/\.(txt|md|markdown|html|htm|json)$/)?.[1] ?? ''
  await task.run({ workspaceId: props.workspace.id, filename: file.name, mediaType: file.type || mediaTypes[extension] || 'application/octet-stream', bytes },
    (
      input,
      requestId,
      signal
    ) => /* 将文件参数、稳定请求标识和取消信号交给网关上传。 */ props.gateway.upload(requestId, input, signal), result => {
      // 接纳上传资产，重置相应文件输入并展示后续引用或导入入口。
      assetUpdateList(result.data)
      if (importing) { importStage.value = { targetId, asset: result.data, result: null, name: '' }; importFile.value = null; if (importInput.value) importInput.value.value = ''; message.value = '导入包已暂存。确认下方目标名称后创建新工作区。' }
      else { uploaded.value = result.data; selectedFile.value = null; if (uploadInput.value) uploadInput.value.value = ''; message.value = '上传完成，可将此资产添加为当前图的来源。' }
      emit('changed')
    })
}
/**
 * 判断资产是否已有来源节点，或其新增来源结果已确认但新快照尚未到达。
 *
 * @param asset 待检查的资产记录，只用其身份查找已存在或刚确认的来源引用。
 */
function assetIsSourceReference(
  /* 已上传且属于当前工作区的真实文件记录。 */ asset: Asset,
): boolean {
  // 只认已保存的活跃引用；数组和when条件使用与快捷构造相同的解释。
  const map = currentMap.value
  if (!map) return false
  const submittedRevision = createdSources.value[map.mapId + ':' + asset.id]
  return (submittedRevision !== undefined && map.revision < submittedRevision)
    || map.nodes.some((/* 当前图真实保存的节点。 */ node) => {
      // 同名其它类型版本不提供引用依据。
      const type = payloadFindType(definitions.value?.catalog, node)
      return !!type && assetReadSourceReferences(type, node.payload).some(
        (/* 该精确类型实际启用的一项引用。 */ reference) => /* 不因缺少可选位置而误报已引用。 */ reference.assetId === asset.id,
      )
    })
}
function assetOpenSource(
  /* 上传结果或列表中用户明确选择的固定资产。 */ asset: Asset,
): void {
  // 开窗只固定目标，不读取首类型拼正文，也不发graph.apply。
  const map = currentMap.value, catalog = definitions.value?.catalog
  if (!map || !catalog || !props.workspace || asset.workspaceId !== props.workspace.id
    || !canUpload.value || locked.value || !sourceChoices.value.length || assetIsSourceReference(asset)) return
  localError.value = ''
  sourceTarget.value = { asset: { ...asset }, workspaceId: props.workspace.id,
    mapId: map.mapId, mapName: map.name, nodeId: crypto.randomUUID(), catalog }
}
function assetCloseSource(): void {
  // 关闭窗口不删除上传文件，也不清掉已发送管理命令的原请求重试。
  sourceTarget.value = null
}
async function assetConfirmSource(
  /* 窗口已经核对的精确类型与独立正文，资产位置已由构造模块固定。 */ input: { typeRef: DefinitionRef; payload: GraphPayload },
): Promise<boolean> {
  // 新提交先核真实文件身份；未知结果的图命令仍直接重放原收据，不再先读文件阻断确认。
  const target = sourceTarget.value
  if (!target || locked.value || sourceTargetChanged.value) return false
  localError.value = ''
  const asset = await task.read('asset.get', { assetId: target.asset.id })
  if (!asset) return false
  if (sourceTarget.value !== target || sourceTargetChanged.value) return false
  if (asset.id !== target.asset.id || asset.workspaceId !== target.workspaceId || asset.sha256 !== target.asset.sha256
    || asset.mediaType !== target.asset.mediaType) { localError.value = AssetSourceManagementMessage.FILE_CHANGED; return false }
  const type = target.catalog.dataTypes.find((/* 打开时保存的精确目录。 */ item) =>
    /* 不使用后来同名版本或另一工作区目录。 */ item.id === input.typeRef.id && item.version === input.typeRef.version)
  if (!type) { localError.value = AssetSourceManagementMessage.TARGET_CHANGED; return false }
  return !!await task.command('graph.apply', { mapId: target.mapId, branch: { rootIds: [target.nodeId], expectedVersion: null },
    changes: { nodes: { put: [{ id: target.nodeId, typeId: type.id, typeVersion: type.version, payload: input.payload }] } } }, (
      /* 原请求确认的完整写入结果。 */ result,
    ) => {
    // 接纳回调也用于原请求重放，避免换一组节点身份重新创建。
    const confirmed = result.data.snapshot
    createdSources.value[target.mapId + ':' + target.asset.id] = confirmed.revision
    message.value = `已将“${target.asset.filename}”添加到“${target.mapName}”。`
    if (sourceTarget.value === target) sourceTarget.value = null
    emit('changed')
  })
}
async function assetRetrySource(): Promise<boolean> {
  // 图写入确认才关闭窗口；若重试的只是文件读取，留下草稿供用户继续确认。
  const target = sourceTarget.value
  return !!target && await task.retry() && sourceTarget.value !== target
}
async function assetReadDefinitions() {
  if (!props.workspace) return
  await task.read('definition.get', { workspaceId: props.workspace.id }, value => { definitions.value = value })
}
async function assetRefresh() {
  await assetReadDefinitions()
  if (!canRetry.value) await assetReadList()
}
/**
 * 下载指定文件，并在成功后通过浏览器保存。
 *
 * @param input 用户选择的下载对象，限定为资产、图或工作区及其身份。
 */
async function assetReadFile(input: ClientDownloadInput) {
  await task.run(input, (
    payload,
    _requestId,
    signal
  ) => /* 使用管理任务的取消信号下载所选资产或导出包。 */ props.gateway.download(payload, signal), clientSaveFile)
}
async function assetDeleteFile() {
  // 所有者确认后按资产摘要删除文件，并清理相关本地操作状态。
  if (!deleteTarget.value || !owner.value) return
  const asset = deleteTarget.value
  await task.command('asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 }, () => {
    // 删除成功后移除列表和上传、导入缓存中的资产并通知父组件。
    assets.value = assets.value.filter(item => /* 从资产列表中排除刚删除的资产。 */ item.id !== asset.id)
    if (uploaded.value?.id === asset.id) uploaded.value = null
    if (importStage.value?.asset.id === asset.id && !importStage.value.result) importStage.value = null
    deleteTarget.value = null; message.value = `已删除资产“${asset.filename}”。`; emit('changed')
  })
}
async function assetCreateWorkspace() {
  // 把已暂存的包导入固定目标工作区，并读取新工作区名称用于完成提示。
  const stage = importStage.value
  if (!stage || stage.result || !props.workspace || !owner.value) return
  await task.run({ id: stage.targetId, stagingWorkspaceId: props.workspace.id,
    bundleAssetId: stage.asset.id, name: importName.value.trim() || null }, async (
      params,
      requestId,
      signal
    ) => {
    // 使用原请求标识执行导入，再查询新工作区名称；重试保留导入目标身份。
    const result = await props.gateway.dispatch(requestId, 'workspace.import', params, signal)
    const workspace = await props.gateway.read('workspace.get', { workspaceId: result.data.workspaceId }, signal)
    return { imported: result.data, name: workspace.name }
  }, result => {
    // 记录导入结果和名称，展示打开新工作区入口并通知父组件。
    stage.result = result.imported; stage.name = result.name; message.value = '新工作区已创建，原工作区保持原样。'; emit('changed')
  })
}
function assetResetImport() {
  // 操作空闲时清空导入阶段、文件选择、名称和本地错误。
  if (locked.value) return; importStage.value = null; importFile.value = null; importName.value = ''; localError.value = ''
}
onMounted(async () => {
  // 资产引用需要精确类型定义；与列表一起加载并缓存于当前管理面板。
  await assetReadDefinitions()
  await assetReadList()
})
</script>

<template>
  <!-- 按上传、列表、导出和分阶段导入组织资产操作与确认信息。 -->
  <section class="asset-management" aria-label="资产与导入导出">
    <header class="toolbar"><div><h2>资产与文件流转</h2><p>上传文件保存在共享工作区；单个文件或包最大 64 MiB。</p></div><button :disabled="locked || !workspace" @click="assetRefresh">刷新资产</button></header>
    <p v-if="!workspace" class="notice">选择工作区后查看资产与导入导出。</p>
    <template v-else>
      <div v-if="error" class="notice error" role="alert"><p :title="`${error.code}: ${error.message}`">{{ uiReadErrorMessage(error.message) }}</p><p v-if="canRetry">请求结果尚未确认。重试保留原请求与目标身份，已完成的阶段不会重复创建。</p><div class="actions"><button v-if="canRetry" :disabled="busy" @click="task.retry">重试同一操作</button><button :disabled="busy" @click="task.clearError">{{ canRetry ? '放弃重试' : '关闭提示' }}</button></div></div>
      <p v-if="localError" class="error notice" role="alert">{{ localError }}</p><p v-if="message" class="notice" role="status">{{ message }}</p>
      <section v-if="canUpload" class="file-card"><h3>上传资产</h3><label>选择文件<input ref="uploadInput" type="file" :disabled="locked" aria-label="上传资产文件" @change="assetUpdateFileSelection($event)"></label><div class="actions"><span v-if="selectedFile">{{ selectedFile.name }} · {{ assetFormatSize(selectedFile.size) }}</span><button class="primary" :disabled="locked || !selectedFile" @click="assetCreateUpload()">{{ readingFile ? '读取文件…' : '上传资产' }}</button></div><div v-if="uploaded" class="upload-result"><strong>已上传：{{ uploaded.filename }}</strong><small>{{ assetFormatSize(uploaded.size) }} · {{ uploaded.mediaType }}</small><button :disabled="locked || !currentMap || !sourceChoices.length || assetIsSourceReference(uploaded)" @click="assetOpenSource(uploaded)">{{ assetIsSourceReference(uploaded) ? '当前图已有此来源' : '将已上传资产添加为来源' }}</button><p>引用失败时资产仍保留；重试引用即可，无需重新上传。</p></div></section>
      <p v-if="!canUpload" class="muted">当前为只读成员，可以下载资产和导出当前图。</p>
      <section class="asset-list"><div class="toolbar"><h3>工作区资产</h3><span>{{ assets.length }} 项已载入</span></div><p v-if="loaded && !assets.length" class="muted">还没有共享资产。</p><p v-if="!currentMap" class="muted">打开当前工作区的数据图后，可把资产添加为来源。</p><p v-else-if="!sourceChoices.length" class="muted">当前定义目录没有声明资产引用的数据类型。</p><p class="muted">来源解析支持不超过 1 MiB 的 UTF-8 文本、Markdown、HTML 或 JSON；其他文件仍可作为共享资产保存。</p>
        <article v-for="asset in assets" :key="asset.id" class="asset-row"><div class="asset-info"><strong>{{ asset.filename }}</strong><span>{{ asset.mediaType }} · {{ assetFormatSize(asset.size) }}</span><details><summary>文件详情</summary><small>资产标识：{{ asset.id }}</small><small title="SHA-256">校验摘要：{{ asset.sha256 }}</small></details></div><div class="actions"><button :disabled="locked" :aria-label="`下载资产 ${asset.filename}`" @click="assetReadFile({ kind: 'asset', id: asset.id })">下载</button><button v-if="canUpload" :disabled="locked || !currentMap || !sourceChoices.length || assetIsSourceReference(asset)" :aria-label="`添加来源 ${asset.filename}`" @click="assetOpenSource(asset)">{{ assetIsSourceReference(asset) ? '已引用' : '添加为来源' }}</button><button v-if="owner" class="danger" :disabled="locked" :aria-label="`删除资产 ${asset.filename}`" @click="deleteTarget = asset">删除</button></div></article>
        <button v-if="nextCursor" :disabled="locked" @click="assetReadList(true)">载入更多资产</button>
      </section>
      <div v-if="deleteTarget" class="notice confirmation" role="alertdialog" aria-label="确认删除资产"><p>删除资产“{{ deleteTarget.filename }}”（{{ assetFormatSize(deleteTarget.size) }}）。被图引用的资产会由服务端拒绝删除。</p><div class="actions"><button class="danger" :disabled="locked" @click="assetDeleteFile">确认删除此资产</button><button :disabled="busy" @click="deleteTarget = null">取消</button></div></div>
      <section class="file-card"><h3>导出</h3><p>导出 v4 包包含数据、定义与引用资产，不包含运行记录或访问凭证。</p><div class="actions"><button :disabled="locked || !currentMap" @click="currentMap && assetReadFile({ kind: 'map', id: currentMap.mapId })">导出当前数据图</button><button v-if="owner" :disabled="locked" @click="assetReadFile({ kind: 'workspace', id: workspace.id })">导出整个工作区</button></div></section>
      <section v-if="owner" class="file-card"><h3>导入为新工作区</h3><p>仅接受重明 v4 数据图包或工作区包。先暂存文件，再创建新工作区；原工作区的数据不会被替换。</p>
        <template v-if="!importStage"><label>选择导入包<input ref="importInput" type="file" accept=".json,application/json" :disabled="locked" aria-label="导入包文件" @change="assetUpdateFileSelection($event, true)"></label><div class="actions"><span v-if="importFile">{{ importFile.name }} · {{ assetFormatSize(importFile.size) }}</span><button :disabled="locked || !importFile" @click="assetCreateUpload(true)">上传导入包</button></div></template>
        <template v-else><p>暂存包：{{ importStage.asset.filename }} · {{ assetFormatSize(importStage.asset.size) }}</p><template v-if="!importStage.result"><label>新工作区名称<input v-model="importName" :disabled="locked" placeholder="留空使用包中的名称" aria-label="导入工作区名称"></label><div class="actions"><button class="primary" :disabled="locked" @click="assetCreateWorkspace">确认创建新工作区</button><button :disabled="locked" @click="assetResetImport">改用其他导入包</button></div></template><div v-else class="notice" role="status"><strong>已创建“{{ importStage.name }}”</strong><p>{{ importStage.result.mapIds.length }} 张图 · {{ importStage.result.assetIds.length }} 项资产</p><div class="actions"><button class="primary" :disabled="locked" @click="emit('imported', importStage.result.workspaceId)">打开已创建的工作区</button><button :disabled="locked" @click="assetResetImport">开始新的导入</button></div></div><p class="muted">暂存包会保留在资产列表中；确认不再需要后可单独删除。</p></template>
      </section>
    </template>
    <AssetSourceDialog v-if="sourceTarget" :asset="sourceTarget.asset" :catalog="sourceTarget.catalog" :workspace-id="sourceTarget.workspaceId" :map-name="sourceTarget.mapName"
      :busy="busy" :pending-retry="canRetry" :target-changed="sourceTargetChanged" :error="error" :message="localError"
      :submit="assetConfirmSource" :retry="assetRetrySource" @close="assetCloseSource" />
  </section>
</template>

<style scoped>
/* 用文件卡片和资产行布局展示文件状态，窄屏改为纵向操作。 */
.asset-management{display:grid;gap:14px;min-width:0}.toolbar,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar{justify-content:space-between}.toolbar h2{font-size:16px}h3{font-size:13px}p,.muted,small,.asset-info span{line-height:1.6;color:var(--text-muted)}.notice,.file-card{padding:12px;background:var(--bg-input);border:1px solid var(--border-subtle);display:grid;gap:10px;overflow-wrap:anywhere}.file-card label{display:grid;gap:6px}.file-card input[type=file]{padding:7px}.asset-list{display:grid;gap:10px;min-width:0}.asset-row{display:flex;justify-content:space-between;gap:12px;padding:10px;border-bottom:1px solid var(--border-subtle);align-items:center}.asset-info{display:grid;gap:4px;min-width:0;overflow-wrap:anywhere}.asset-row>.actions{flex-shrink:0}.upload-result{display:grid;gap:8px;padding:10px;border-left:3px solid var(--success);background:var(--bg-panel)}.upload-result button{justify-self:start}.error,.danger{color:var(--danger)}.confirmation{border-color:var(--warning)}@media(max-width:700px){.asset-row{align-items:flex-start;flex-direction:column}.asset-row>.actions{flex-wrap:wrap}}
</style>
