<!-- 精确定义包浏览与工作区JSON草稿发布；请求与原意图确认沿用管理任务。 -->
<script setup lang="ts">
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'

import { CLIENT_FILE_LIMIT, type ClientGateway } from '../../../../contracts/client'
import type { AppBootstrap, DefinitionPublishResult, DefinitionView, LibraryDefinitionView, WorkspaceView } from '../../../../contracts/control'
import type { DefinitionCatalog, DefinitionPackage, DefinitionRef } from '../../../../contracts/data-definition'
import type { GraphSuccess } from '../../../../contracts/graph-api'
import { uiReadErrorMessage, uiReadStage } from '../../presentation/ui-labels'
import { useManagementTask } from '../management/use-management'
import { definitionCreateVersionDraft, definitionReadChangeSummary, definitionReadDraft } from './definition-editor'

const props = defineProps<{ gateway: ClientGateway; workspace: WorkspaceView | null; bootstrap: AppBootstrap; active: boolean }>()
const emit = defineEmits<{ changed: []; unauthorized: [] }>()
const task = useManagementTask({ gateway: props.gateway, onUnauthorized: () => {
  // 只把当前管理任务仍有效的认证失败交给会话。
  emit('unauthorized')
} })
const scopeKind = ref<'workspace' | 'library'>('workspace')
const catalog = shallowRef<DefinitionCatalog | null>(null)
const selectedRef = ref<DefinitionRef | null>(null)
const selectedPackage = shallowRef<DefinitionPackage | null>(null)
const draftOpen = ref(false)
const draftText = ref('')
const draftBaseline = shallowRef<DefinitionPackage | null>(null)
const baseRevision = ref<number | null>(null)
const checkedText = ref<string | null>(null)
const publication = shallowRef<DefinitionPublishResult | null>(null)
const readingFile = ref(false)
const localError = ref('')
let alive = true
const libraryAvailable = computed(() => /* 旧服务只关闭共享目录，不影响工作区定义能力。 */ props.bootstrap.metadata.capabilities?.libraryDefinitions === true)
const writable = computed(() => /* 本批共享库仅浏览，工作区发布遵循原owner授权。 */ scopeKind.value === 'workspace' && props.workspace?.role === 'owner')
const locked = computed(() => /* 原请求结果不明时不允许换范围、改稿或建立第二次发布。 */ task.busy.value || task.canRetry.value || readingFile.value)
const draft = computed(() => /* 原始JSON保持unknown，轻量元信息不冒充服务端完整包校验。 */ definitionReadDraft(draftText.value, catalog.value))
const summary = computed(() => /* 对照复制时的包，移出新包不代表删除旧目录定义。 */ definitionReadChangeSummary(draft.value, draftBaseline.value ?? undefined))
const checked = computed(() => /* 修改任意文本后必须重新检查，不能发布旧摘要对应的另一份JSON。 */ draftOpen.value && checkedText.value === draftText.value)
const stale = computed(() => /* 外部工作区写入不能静默提升原草稿的发布版本。 */ draftOpen.value && baseRevision.value !== null
  && (catalog.value?.revision !== baseRevision.value || (props.workspace?.revision ?? 0) > baseRevision.value))
const canPublish = computed(() => /* 权限、固定版本和已检查文本同时满足才提交原发布命令。 */ writable.value && checked.value
  && !locked.value && !stale.value && task.error.value?.code !== 'REVISION_CONFLICT'
  && baseRevision.value !== null && draft.value.metadata !== null && draft.value.errors.length === 0)
const errorMessage = computed(() => {
  // 中文解释发布错误类别，原服务端字段路径另供明确展开核对。
  const error = task.error.value
  if (!error) return ''
  if (error.code === 'DEFINITION_VERSION_CONFLICT') return '精确版本已发布且内容不同，请为修改后的包或定义指定新版本。'
  if (error.code === 'DEFINITION_NOT_FOUND') return '所需的精确包、类型、转换或智能体版本不存在，请核对依赖与版本。'
  if (error.code === 'DEFINITION_INVALID') return '定义包未通过校验，请核对定义归属、字段和精确依赖。'
  return uiReadErrorMessage(error.message)
})

function definitionAcceptCatalog(
  /* 同一任务读到的工作区或真实共享库目录。 */ view: DefinitionView | LibraryDefinitionView,
): void {
  // 更新只读目录时保留草稿、复制基线和原预期revision。
  catalog.value = view.catalog
}

async function definitionLoadCatalog(): Promise<void> {
  // 当前范围只使用自己的公开查询，不借工作区目录填补旧服务的共享能力。
  if (locked.value) return
  localError.value = ''
  let loaded: DefinitionView | LibraryDefinitionView | null
  if (scopeKind.value === 'library') {
    if (!libraryAvailable.value) return
    loaded = await task.read('definition.library.get', {}, definitionAcceptCatalog)
  } else {
    if (!props.workspace) return
    loaded = await task.read('definition.get', { workspaceId: props.workspace.id }, definitionAcceptCatalog)
  }
  if (!loaded || !alive || draftOpen.value || selectedPackage.value) return
  const reference = selectedRef.value ?? loaded.catalog.packages[0]?.ref
  if (reference) await definitionLoadExactPackage(reference)
}

async function definitionLoadExactPackage(
  /* 用户明确选择的精确包身份，版本不会被替换为latest。 */ reference: DefinitionRef,
): Promise<void> {
  // 包体和目录由同一查询返回，已发布正文只读；草稿存在时不更换比较基线。
  if (locked.value || draftOpen.value) return
  selectedRef.value = { ...reference }
  selectedPackage.value = null
  const accept = (/* 对应精确查询的保存包及目录。 */ view: DefinitionView | LibraryDefinitionView): void => {
    // 公共客户端已核对范围和包ID/版本，这里只接纳读取结果。
    catalog.value = view.catalog
    selectedPackage.value = view.package ?? null
  }
  const params = { packageId: reference.id, packageVersion: reference.version }
  if (scopeKind.value === 'library') {
    if (libraryAvailable.value) await task.read('definition.library.get', params, accept)
  } else if (props.workspace) await task.read('definition.get', { workspaceId: props.workspace.id, ...params }, accept)
}

async function definitionSwitchScope(
  /* 用户选择的真实目录范围。 */ next: 'workspace' | 'library',
): Promise<void> {
  // 在空闲且没有草稿时切换目录，旧范围不会成为新范围的发布内容。
  if (locked.value || draftOpen.value || next === scopeKind.value || (next === 'library' && !libraryAvailable.value)) return
  scopeKind.value = next
  catalog.value = null
  selectedRef.value = null
  selectedPackage.value = null
  publication.value = null
  task.clearError()
  await definitionLoadCatalog()
}

function definitionBeginDraft(
  /* 粘贴、文件或复制得到的独立JSON文本。 */ text: string,
  /* 复制起点；新JSON稿没有旧包比较基线。 */ baseline: DefinitionPackage | null,
): void {
  // 草稿固定目录读取时的工作区revision，后续刷新不自动更改。
  draftText.value = text
  draftBaseline.value = baseline
  baseRevision.value = catalog.value?.revision ?? null
  checkedText.value = null
  draftOpen.value = true
  publication.value = null
  localError.value = ''
  task.clearError()
}

function definitionCreateDraft(
  /* 是否从当前精确包复制；false建立不预设业务定义的空模板。 */ copy: boolean,
): void {
  // 创建只是编辑起点，复制保留包、类型和转换的所有原版本，交用户明确调整。
  if (!writable.value || locked.value || draftOpen.value || !catalog.value) return
  const baseline = copy ? selectedPackage.value : null
  if (copy && !baseline) return
  const text = baseline ? definitionCreateVersionDraft(baseline) : JSON.stringify({
    id: '', version: 1, title: '', schemaDialect: 'http://json-schema.org/draft-07/schema#',
    dataTypes: [], transitions: [], dependencies: { packages: [], agents: [] },
  }, null, 2)
  definitionBeginDraft(text, baseline)
}

async function definitionReadFile(
  /* JSON文件输入框的真实选择事件。 */ event: Event,
): Promise<void> {
  // 本地读取绑定同一图外工作区范围，关闭或身份替换后丢弃迟到文件内容。
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const file = input.files?.[0]
  if (!file || !writable.value || locked.value || draftOpen.value || !catalog.value) return
  if (file.size > CLIENT_FILE_LIMIT) {
    localError.value = 'JSON文件不能超过64 MiB。'
    input.value = ''
    return
  }
  const workspaceId = props.workspace?.id
  readingFile.value = true
  try {
    const text = await file.text()
    if (alive && writable.value && props.workspace?.id === workspaceId) definitionBeginDraft(text, null)
  } catch {
    if (alive) localError.value = '读取JSON文件失败，请重新选择。'
  } finally {
    if (alive) readingFile.value = false
    input.value = ''
  }
}

function definitionDiscardDraft(): void {
  // 明确放弃才清除草稿，不把刷新目录或发布冲突当作放弃。
  if (locked.value) return
  draftOpen.value = false
  draftText.value = ''
  draftBaseline.value = null
  baseRevision.value = null
  checkedText.value = null
  task.clearError()
}

function definitionCheckDraft(): void {
  // 固定用户已核对的这份文本；后端仍会权威校验依赖和全部发布规则。
  if (locked.value || !writable.value || !draftOpen.value) return
  checkedText.value = draftText.value
}

function definitionAdoptRevision(): void {
  // 用户刷新并明确采用新版本后保留全文，要求重新检查再形成新的发布意图。
  if (locked.value || !writable.value || !draftOpen.value || !catalog.value
    || catalog.value.revision < (props.workspace?.revision ?? 0)) return
  baseRevision.value = catalog.value.revision
  checkedText.value = null
  task.clearError()
}

function definitionAcceptPublication(
  /* 原发布或同请求重放确认的服务端结果。 */ result: GraphSuccess<DefinitionPublishResult>,
): void {
  // 先保存已发布事实，随后的目录刷新失败不能把写入误报成失败。
  publication.value = result.data
  selectedRef.value = { ...result.data.package.ref }
  selectedPackage.value = null
  draftOpen.value = false
  draftText.value = ''
  draftBaseline.value = null
  baseRevision.value = null
  checkedText.value = null
  emit('changed')
}

async function definitionPublishDraft(): Promise<void> {
  // 只提交已检查文本及原预期revision，管理任务复制参数并保留同请求确认。
  const workspace = props.workspace
  const revision = baseRevision.value
  if (!workspace || revision === null || !canPublish.value) return
  const result = await task.command('definition.publish', {
    workspaceId: workspace.id, expectedRevision: revision, package: draft.value.data,
  }, definitionAcceptPublication)
  if (result && alive) await definitionLoadCatalog()
}

async function definitionRetry(): Promise<void> {
  // 重试的是任务冻结的原参数，不重新解析用户文本或建立新的发布请求。
  if (await task.retry() && alive) await definitionLoadCatalog()
}

watch(() => /* 定义页第一次可见时才读取，切换管理分类不丢本地草稿。 */ props.active, (/* 当前分类是否可见。 */ active) => {
  // 目录由此组件拥有，普通隐藏不取消已形成的发布意图。
  if (active && !catalog.value) void definitionLoadCatalog()
}, { immediate: true })
onScopeDispose(() => {
  // 管理任务自动取消网络，本标记同时结束不可取消的本地文件读取接纳。
  alive = false
})
</script>

<template>
  <section class="definition-management" aria-label="定义中心">
    <header class="toolbar"><div><h2>定义中心</h2><p>{{ scopeKind === 'library' ? '共享库 · 只读' : workspace?.name ?? '未选择工作区' }}</p></div><button type="button" :disabled="locked || (scopeKind === 'library' ? !libraryAvailable : !workspace)" @click="definitionLoadCatalog">刷新目录</button></header>
    <nav class="actions" aria-label="定义目录范围">
      <button type="button" :aria-pressed="scopeKind === 'workspace'" :disabled="locked || draftOpen || !workspace" @click="definitionSwitchScope('workspace')">当前工作区</button>
      <button type="button" :aria-pressed="scopeKind === 'library'" :disabled="locked || draftOpen || !libraryAvailable" :title="libraryAvailable ? undefined : '当前服务未提供共享定义目录'" @click="definitionSwitchScope('library')">共享库</button>
    </nav>
    <p v-if="!libraryAvailable" class="muted">当前服务未提供共享定义目录；工作区浏览和发布仍可用。</p>
    <p v-if="task.busy.value || readingFile" class="muted" role="status">{{ readingFile ? '正在读取JSON文件…' : '正在处理定义请求…' }}</p>
    <p v-if="localError" class="error" role="alert">{{ localError }}</p>
    <div v-if="task.error.value" class="notice" role="alert"><p>{{ publication ? '定义包已发布，后续目录读取未完成。' : '' }}{{ errorMessage }}</p><details><summary>服务端校验说明</summary><pre>{{ task.error.value.message }}</pre></details><button v-if="task.canRetry.value" type="button" :disabled="task.busy.value" @click="definitionRetry">重试同一操作</button></div>
    <div v-if="publication" class="notice" role="status"><strong>定义包已发布：{{ publication.package.ref.id }}@{{ publication.package.ref.version }}</strong><p>摘要：{{ publication.package.digest }}</p><p>工作区版本 {{ publication.workspaceRevision }} · 已有节点和运行保留原精确版本。</p></div>
    <p v-if="!workspace && scopeKind === 'workspace'" class="muted">先选择工作区，或浏览服务提供的共享库。</p>
    <div class="definition-columns">
      <aside aria-label="定义包目录" class="package-list">
        <p v-if="catalog && !catalog.packages.length" class="muted">此范围尚无已发布定义包。</p>
        <button v-for="item in catalog?.packages ?? []" :key="`${item.ref.id}@${item.ref.version}`" type="button" :aria-label="`查看定义包 ${item.ref.id}@${item.ref.version}`" :aria-pressed="selectedRef?.id === item.ref.id && selectedRef?.version === item.ref.version" :disabled="locked || draftOpen" @click="definitionLoadExactPackage(item.ref)"><strong>{{ item.ref.id }}</strong><span>版本 {{ item.ref.version }}</span><small>{{ item.digest }}</small></button>
      </aside>
      <div class="package-detail">
        <section v-if="selectedPackage" aria-label="已发布定义包" class="saved-package">
          <header><h3>{{ selectedPackage.title }}</h3><p>{{ selectedPackage.id }} · 版本 {{ selectedPackage.version }}</p><p v-if="selectedPackage.description">{{ selectedPackage.description }}</p></header>
          <dl class="dependencies"><dt>精确包依赖</dt><dd>{{ selectedPackage.dependencies.packages.map(item => `${item.id}@${item.version}`).join('、') || '无' }}</dd><dt>精确智能体依赖</dt><dd>{{ selectedPackage.dependencies.agents.map(item => `${item.id}@${item.version}`).join('、') || '无' }}</dd></dl>
          <details v-for="type in selectedPackage.dataTypes" :key="`type:${type.id}@${type.version}`"><summary>数据类型 · {{ type.title }} · {{ type.id }}@{{ type.version }}</summary><p>{{ type.description }}</p><p>合法后继：{{ type.successorTypes.map(item => `${item.id}@${item.version}`).join('、') || '无' }}</p><h4>内容格式</h4><pre>{{ JSON.stringify(type.schema, null, 2) }}</pre><h4>引用声明</h4><pre>{{ JSON.stringify(type.references, null, 2) }}</pre><h4>展示提示</h4><pre>{{ JSON.stringify(type.presentation ?? {}, null, 2) }}</pre><h4>智能体可见字段</h4><pre>{{ JSON.stringify(type.agentProjection, null, 2) }}</pre></details>
          <details v-for="transition in selectedPackage.transitions" :key="`transition:${transition.id}@${transition.version}`"><summary>转换 · {{ transition.title }} · {{ transition.id }}@{{ transition.version }}</summary><p>{{ transition.description }}</p><h4>端口与数量</h4><pre>{{ JSON.stringify({ ports: transition.ports, cardinality: transition.cardinality }, null, 2) }}</pre><h4>执行阶段</h4><p v-for="stage in transition.execution.stages" :key="stage.id">{{ uiReadStage(stage.id) }} · 智能体 {{ stage.agentRef.id }}@{{ stage.agentRef.version }}</p><pre>{{ JSON.stringify(transition.execution, null, 2) }}</pre><h4>审核与发布规则</h4><pre>{{ JSON.stringify({ review: transition.review, publication: transition.publication }, null, 2) }}</pre></details>
          <details><summary>完整定义包 JSON</summary><pre>{{ JSON.stringify(selectedPackage, null, 2) }}</pre></details>
        </section>
        <p v-else class="muted">选择精确包版本查看已发布内容。</p>
      </div>
    </div>
    <p v-if="scopeKind === 'workspace' && workspace && !writable" class="muted">当前权限可浏览定义；发布需要工作区所有者。</p>
    <div v-if="writable && !draftOpen" class="actions"><button type="button" :disabled="locked || !catalog" @click="definitionCreateDraft(false)">新建 JSON 草稿</button><button type="button" :disabled="locked || !selectedPackage" @click="definitionCreateDraft(true)">复制为草稿</button><label class="file-input">载入 JSON 文件<input type="file" accept=".json,application/json" :disabled="locked || !catalog" @change="definitionReadFile"></label></div>
    <section v-if="draftOpen" class="draft-section" aria-label="定义发布草稿">
      <h3>发布草稿</h3><p class="muted">草稿仅在本窗口保留。包、类型和转换各自拥有版本；已发布的精确定义只能由一个包声明。复用旧定义时声明旧包依赖。</p>
      <label class="json-field">定义包 JSON<textarea v-model="draftText" rows="18" spellcheck="false" :disabled="locked || !writable" /></label>
      <p class="muted">目标：{{ workspace?.name }} · 预期工作区版本 {{ baseRevision }}</p>
      <div v-if="stale" class="notice"><p>工作区版本已变化，草稿全文和原版本已保留。请先刷新目录，再明确采用新版本并重新检查。</p><button type="button" :disabled="locked || !writable || !catalog || catalog.revision < (workspace?.revision ?? 0)" @click="definitionAdoptRevision">采用当前目录版本并重新核对</button></div>
      <div class="actions"><button type="button" :disabled="locked || !writable" @click="definitionCheckDraft">检查发布内容</button><button type="button" :disabled="locked" @click="definitionDiscardDraft">放弃草稿</button></div>
      <section v-if="checked" aria-label="发布内容核对" class="notice">
        <h3>发布内容核对</h3><p>目标工作区：{{ workspace?.name }} · {{ workspace?.id }} · 预期版本 {{ baseRevision }}</p>
        <p v-for="message in draft.errors" :key="message" class="error" role="alert">{{ message }}</p>
        <dl class="change-summary"><div v-for="(row, index) in summary" :key="index"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div></dl>
        <p v-for="message in draft.warnings" :key="message" class="muted">{{ message }}</p>
        <p class="muted">发布时由服务端核对完整依赖和定义规则；失败不会发布部分包。新定义不会自动迁移已有节点或运行。</p>
        <button class="primary" type="button" :disabled="!canPublish" @click="definitionPublishDraft">发布新版本</button>
      </section>
    </section>
  </section>
</template>

<style scoped>
.definition-management,.package-detail,.saved-package,.draft-section{display:grid;gap:14px;min-width:0}.toolbar,.actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.toolbar{justify-content:space-between}h2{font-size:16px}h3{font-size:14px}h4{font-size:12px}p,.muted,dt{font-size:12px;line-height:1.7;color:var(--text-muted)}
.definition-columns{display:grid;grid-template-columns:minmax(160px,220px) minmax(0,1fr);gap:18px;align-items:start}.package-list{display:grid;gap:6px;max-height:400px;overflow:auto}.package-list button{display:grid;gap:5px;text-align:left;min-width:0}.package-list button[aria-pressed="true"],nav button[aria-pressed="true"]{border-color:var(--accent);background:var(--bg-nav-selected)}.package-list small{font-size:10px;color:var(--text-muted);overflow-wrap:anywhere}.package-detail{max-height:460px;overflow:auto}.saved-package>header{display:grid;gap:6px}
details{min-width:0;border-top:1px solid var(--border-subtle);padding-top:9px;font-size:12px;line-height:1.7}summary{cursor:pointer;overflow-wrap:anywhere}details h4,details p,details pre{margin-top:9px}pre{padding:10px;background:var(--bg-input);font-size:11px;white-space:pre-wrap;overflow-wrap:anywhere}.dependencies{display:grid;gap:5px;font-size:12px}.dependencies dd,.change-summary dd{margin:0;overflow-wrap:anywhere}
.draft-section{border-top:1px solid var(--border);padding-top:16px}.json-field,.file-input{display:grid;gap:6px;font-size:12px}.json-field textarea{font:12px/1.7 ui-monospace,monospace;resize:vertical;min-height:220px}.file-input input{max-width:220px}.notice{display:grid;gap:9px;padding:12px;border:1px solid var(--border);background:var(--bg-input);overflow-wrap:anywhere}.notice button{justify-self:start}.change-summary{display:grid;gap:8px;font-size:12px}.change-summary>div{display:grid;grid-template-columns:90px minmax(0,1fr);gap:9px}.error{color:var(--danger)}
@media(max-width:700px){.definition-columns{grid-template-columns:1fr}.package-list{max-height:160px}.package-detail{max-height:none}}
</style>
