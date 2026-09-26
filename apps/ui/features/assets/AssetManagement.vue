<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref } from 'vue'
import { CLIENT_FILE_LIMIT, type ClientDownloadInput, type ClientGateway } from '../../../../contracts/client'
import type { AppBootstrap, Asset, ImportResult, WorkspaceView } from '../../../../contracts/control'
import type { GraphSnapshot } from '../../../../contracts/graph'
import { clientSaveFile } from './file-save'
import { useManagementTask } from '../management/use-management'

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap; snapshot: GraphSnapshot | null }>()
const emit = defineEmits<{ changed: []; unauthorized: []; imported: [workspaceId: string] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => emit('unauthorized') })
const { busy, error, canRetry } = task
const assets = ref<Asset[]>([]), nextCursor = ref<string | null>(null), loaded = ref(false)
const selectedFile = ref<File | null>(null), uploaded = ref<Asset | null>(null), importFile = ref<File | null>(null)
const uploadInput = ref<HTMLInputElement | null>(null), importInput = ref<HTMLInputElement | null>(null)
const importName = ref(''), importStage = ref<{ targetId: string; asset: Asset; result: ImportResult | null; name: string } | null>(null)
const deleteTarget = ref<Asset | null>(null), readingFile = ref(false), localError = ref(''), message = ref('')
const createdSources = ref<Record<string, number>>({})
const owner = computed(() => props.workspace?.role === 'owner')
const canUpload = computed(() => !!props.workspace && props.workspace.role !== 'viewer')
const locked = computed(() => busy.value || canRetry.value || readingFile.value)
const currentMap = computed(() => props.snapshot?.workspaceId === props.workspace?.id ? props.snapshot : null)
const mapActive = computed(() => !!currentMap.value?.run && ['running', 'waiting'].includes(currentMap.value.run.status))
const mediaTypes: Record<string, string> = { txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', json: 'application/json' }
let alive = true
onScopeDispose(() => { alive = false })

// 用途：把大小转换成调用方需要的格式。
function assetFormatSize(size: number) { return size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB` }
// 用途：更新列表，并保持相关状态一致。
function assetUpdateList(asset: Asset) { assets.value = [asset, ...assets.value.filter(item => item.id !== asset.id)] }
// 用途：更新文件选择结果，并保持相关状态一致。
function assetUpdateFileSelection(event: Event, importing = false) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null
  localError.value = ''
  if (importing) importFile.value = null
  else selectedFile.value = null
  if (file && file.size > CLIENT_FILE_LIMIT) { localError.value = '单个文件或导入包不能超过 64 MiB。'; (event.target as HTMLInputElement).value = ''; return }
  if (importing) importFile.value = file
  else selectedFile.value = file
}
// 用途：读取列表，并把结构化结果交给调用方。
async function assetReadList(more = false) {
  if (!props.workspace || (more && !nextCursor.value)) return
  await task.read('asset.list', { workspaceId: props.workspace.id, limit: 20, ...(more && nextCursor.value ? { cursor: nextCursor.value } : {}) }, value => {
    assets.value = more ? [...assets.value, ...value.items.filter(item => !assets.value.some(existing => existing.id === item.id))] : value.items
    nextCursor.value = value.nextCursor; loaded.value = true
  })
}
// 用途：创建上传内容，供后续流程使用。
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
    (input, requestId, signal) => props.gateway.upload(requestId, input, signal), result => {
      assetUpdateList(result.data)
      if (importing) { importStage.value = { targetId, asset: result.data, result: null, name: '' }; importFile.value = null; if (importInput.value) importInput.value.value = ''; message.value = '导入包已暂存。确认下方目标名称后创建新工作区。' }
      else { uploaded.value = result.data; selectedFile.value = null; if (uploadInput.value) uploadInput.value.value = ''; message.value = '上传完成，可将此资产添加为当前图的来源。' }
      emit('changed')
    })
}
// 用途：判断界面是否满足当前条件。
function assetIsSourceReference(asset: Asset) {
  const map = currentMap.value
  if (!map) return false
  const submittedRevision = createdSources.value[map.mapId + ':' + asset.id]
  return (submittedRevision !== undefined && map.revision < submittedRevision)
    || map.nodes.some(node => node.data.kind === 'source' && node.data.locator.kind === 'asset' && node.data.locator.assetId === asset.id)
}
// 用途：创建来源，供后续流程使用。
async function assetCreateSource(asset: Asset) {
  const map = currentMap.value
  if (!map || !canUpload.value || mapActive.value || assetIsSourceReference(asset)) return
  const nodeId = crypto.randomUUID()
  await task.command('graph.apply', { mapId: map.mapId, expectedRevision: map.revision,
    changes: { nodes: { put: [{ id: nodeId, data: { kind: 'source', locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: asset.filename } }] } } }, result => {
    const confirmed = result.data.snapshot
    createdSources.value[confirmed.mapId + ':' + asset.id] = confirmed.revision
    message.value = `已将“${asset.filename}”添加到“${map.name}”。`; emit('changed')
  })
}
// 用途：读取文件，并把结构化结果交给调用方。
async function assetReadFile(input: ClientDownloadInput) {
  await task.run(input, (payload, _requestId, signal) => props.gateway.download(payload, signal), clientSaveFile)
}
// 用途：处理界面相关工作，并把结果交给调用方。
async function assetDeleteFile() {
  if (!deleteTarget.value || !owner.value) return
  const asset = deleteTarget.value
  await task.command('asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 }, () => {
    assets.value = assets.value.filter(item => item.id !== asset.id)
    if (uploaded.value?.id === asset.id) uploaded.value = null
    if (importStage.value?.asset.id === asset.id && !importStage.value.result) importStage.value = null
    deleteTarget.value = null; message.value = `已删除资产“${asset.filename}”。`; emit('changed')
  })
}
// 用途：创建工作区，供后续流程使用。
async function assetCreateWorkspace() {
  const stage = importStage.value
  if (!stage || stage.result || !props.workspace || !owner.value) return
  await task.run({ id: stage.targetId, stagingWorkspaceId: props.workspace.id,
    bundleAssetId: stage.asset.id, name: importName.value.trim() || null }, async (params, requestId, signal) => {
    const result = await props.gateway.dispatch(requestId, 'workspace.import', params, signal)
    const workspace = await props.gateway.read('workspace.get', { workspaceId: result.data.workspaceId }, signal)
    return { imported: result.data, name: workspace.name }
  }, result => {
    stage.result = result.imported; stage.name = result.name; message.value = '新工作区已创建，原工作区保持原样。'; emit('changed')
  })
}
// 用途：处理界面相关工作，并把结果交给调用方。
function assetResetImport() { if (locked.value) return; importStage.value = null; importFile.value = null; importName.value = ''; localError.value = '' }
onMounted(() => assetReadList())
</script>

<template>
  <section class="asset-management" aria-label="资产与导入导出">
    <header class="toolbar"><div><h2>资产与文件流转</h2><p>上传文件保存在共享工作区；单个文件或包最大 64 MiB。</p></div><button :disabled="locked || !workspace" @click="assetReadList()">刷新资产</button></header>
    <p v-if="!workspace" class="notice">选择工作区后查看资产与导入导出。</p>
    <template v-else>
      <div v-if="error" class="notice error" role="alert"><p>{{ error.message }}</p><p v-if="canRetry">请求结果尚未确认。重试保留原请求与目标身份，已完成的阶段不会重复创建。</p><div class="actions"><button v-if="canRetry" :disabled="busy" @click="task.retry">重试同一操作</button><button :disabled="busy" @click="task.clearError">{{ canRetry ? '放弃重试' : '关闭提示' }}</button></div></div>
      <p v-if="localError" class="error notice" role="alert">{{ localError }}</p><p v-if="message" class="notice" role="status">{{ message }}</p>
      <section v-if="canUpload" class="file-card"><h3>上传资产</h3><label>选择文件<input ref="uploadInput" type="file" :disabled="locked" aria-label="上传资产文件" @change="assetUpdateFileSelection($event)"></label><div class="actions"><span v-if="selectedFile">{{ selectedFile.name }} · {{ assetFormatSize(selectedFile.size) }}</span><button class="primary" :disabled="locked || !selectedFile" @click="assetCreateUpload()">{{ readingFile ? '读取文件…' : '上传资产' }}</button></div><div v-if="uploaded" class="upload-result"><strong>已上传：{{ uploaded.filename }}</strong><small>{{ assetFormatSize(uploaded.size) }} · {{ uploaded.mediaType }}</small><button :disabled="locked || !currentMap || mapActive || assetIsSourceReference(uploaded)" @click="assetCreateSource(uploaded)">{{ assetIsSourceReference(uploaded) ? '当前图已有此来源' : '将已上传资产添加为来源' }}</button><p>引用失败时资产仍保留；重试引用即可，无需重新上传。</p></div></section>
      <p v-if="!canUpload" class="muted">当前为只读成员，可以下载资产和导出当前图。</p>
      <section class="asset-list"><div class="toolbar"><h3>工作区资产</h3><span>{{ assets.length }} 项已载入</span></div><p v-if="loaded && !assets.length" class="muted">还没有共享资产。</p><p v-if="mapActive" class="muted">当前图正在运行或暂停，结束或取消后可添加来源。</p><p v-else-if="!currentMap" class="muted">打开当前工作区的数据图后，可把资产添加为来源。</p><p class="muted">来源解析支持不超过 1 MiB 的 UTF-8 文本、Markdown、HTML 或 JSON；其他文件仍可作为共享资产保存。</p>
        <article v-for="asset in assets" :key="asset.id" class="asset-row"><div class="asset-info"><strong>{{ asset.filename }}</strong><span>{{ asset.mediaType }} · {{ assetFormatSize(asset.size) }}</span><details><summary>文件详情</summary><small>资产 ID：{{ asset.id }}</small><small>SHA-256：{{ asset.sha256 }}</small></details></div><div class="actions"><button :disabled="locked" :aria-label="`下载资产 ${asset.filename}`" @click="assetReadFile({ kind: 'asset', id: asset.id })">下载</button><button v-if="canUpload" :disabled="locked || !currentMap || mapActive || assetIsSourceReference(asset)" :aria-label="`添加来源 ${asset.filename}`" @click="assetCreateSource(asset)">{{ assetIsSourceReference(asset) ? '已引用' : '添加为来源' }}</button><button v-if="owner" class="danger" :disabled="locked" :aria-label="`删除资产 ${asset.filename}`" @click="deleteTarget = asset">删除</button></div></article>
        <button v-if="nextCursor" :disabled="locked" @click="assetReadList(true)">载入更多资产</button>
      </section>
      <div v-if="deleteTarget" class="notice confirmation" role="alertdialog" aria-label="确认删除资产"><p>删除资产“{{ deleteTarget.filename }}”（{{ assetFormatSize(deleteTarget.size) }}）。被图引用的资产会由服务端拒绝删除。</p><div class="actions"><button class="danger" :disabled="locked" @click="assetDeleteFile">确认删除此资产</button><button :disabled="busy" @click="deleteTarget = null">取消</button></div></div>
      <section class="file-card"><h3>导出</h3><p>导出 v3 包包含数据与引用资产，不包含运行记录或访问凭证。</p><div class="actions"><button :disabled="locked || !currentMap" @click="currentMap && assetReadFile({ kind: 'map', id: currentMap.mapId })">导出当前数据图</button><button v-if="owner" :disabled="locked" @click="assetReadFile({ kind: 'workspace', id: workspace.id })">导出整个工作区</button></div></section>
      <section v-if="owner" class="file-card"><h3>导入为新工作区</h3><p>接受重明 v3 数据图包或工作区包。先暂存文件，再创建新工作区；原工作区的数据不会被替换。</p>
        <template v-if="!importStage"><label>选择导入包<input ref="importInput" type="file" accept=".json,application/json" :disabled="locked" aria-label="导入包文件" @change="assetUpdateFileSelection($event, true)"></label><div class="actions"><span v-if="importFile">{{ importFile.name }} · {{ assetFormatSize(importFile.size) }}</span><button :disabled="locked || !importFile" @click="assetCreateUpload(true)">上传导入包</button></div></template>
        <template v-else><p>暂存包：{{ importStage.asset.filename }} · {{ assetFormatSize(importStage.asset.size) }}</p><template v-if="!importStage.result"><label>新工作区名称<input v-model="importName" :disabled="locked" placeholder="留空使用包中的名称" aria-label="导入工作区名称"></label><div class="actions"><button class="primary" :disabled="locked" @click="assetCreateWorkspace">确认创建新工作区</button><button :disabled="locked" @click="assetResetImport">改用其他导入包</button></div></template><div v-else class="notice" role="status"><strong>已创建“{{ importStage.name }}”</strong><p>{{ importStage.result.mapIds.length }} 张图 · {{ importStage.result.assetIds.length }} 项资产</p><div class="actions"><button class="primary" :disabled="locked" @click="emit('imported', importStage.result.workspaceId)">打开已创建的工作区</button><button :disabled="locked" @click="assetResetImport">开始新的导入</button></div></div><p class="muted">暂存包会保留在资产列表中；确认不再需要后可单独删除。</p></template>
      </section>
    </template>
  </section>
</template>

<style scoped>
.asset-management{display:grid;gap:14px;min-width:0}.toolbar,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar{justify-content:space-between}.toolbar h2{font-size:16px}h3{font-size:13px}p,.muted,small,.asset-info span{line-height:1.6;color:var(--text-muted)}.notice,.file-card{padding:12px;background:var(--bg-input);border:1px solid var(--border-subtle);display:grid;gap:10px;overflow-wrap:anywhere}.file-card label{display:grid;gap:6px}.file-card input[type=file]{padding:7px}.asset-list{display:grid;gap:10px;min-width:0}.asset-row{display:flex;justify-content:space-between;gap:12px;padding:10px;border-bottom:1px solid var(--border-subtle);align-items:center}.asset-info{display:grid;gap:4px;min-width:0;overflow-wrap:anywhere}.asset-row>.actions{flex-shrink:0}.upload-result{display:grid;gap:8px;padding:10px;border-left:3px solid var(--success);background:var(--bg-panel)}.upload-result button{justify-self:start}.error,.danger{color:var(--danger)}.confirmation{border-color:var(--warning)}@media(max-width:700px){.asset-row{align-items:flex-start;flex-direction:column}.asset-row>.actions{flex-wrap:wrap}}
</style>
