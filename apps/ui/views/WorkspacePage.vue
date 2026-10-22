<!-- 工作台首页：连接会话，组织工作区与图标签、画布、详情和创建对话框。 -->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'

import { ClientError, type CommandInputMap } from '../../../contracts/client'
import type { LocalServiceState } from '../../../contracts/desktop'
import type { DataTypeDefinition, DefinitionRef } from '../../../contracts/data-definition'
import type { GraphNode, GraphPayload } from '../../../contracts/graph'
import { EvidenceMessage, type EvidenceClaimRef, type EvidenceLibraryRef, type EvidenceUseRef } from '../../../contracts/evidence-library'

import { clientSaveFile } from '../features/assets/file-save'
import { evidenceFindFixedBasisNode, type EvidenceBasisOpen } from '../features/evidence-library/evidence-presentation'
import AppShell from '../components/shell/AppShell.vue'
import AccountLogin from '../features/auth/AccountLogin.vue'
import AccountSettings from '../features/auth/AccountSettings.vue'
import WorkspaceSidebar from '../components/shell/WorkspaceSidebar.vue'
import WorkspaceViews from '../components/shell/WorkspaceViews.vue'
import type { NodeIdentity } from '../features/graph/node-identity'
import type { OperationOriginOpen, OperationOriginTarget } from '../features/graph/node-origin'
import { readerCreateSourceAnchors, type ReaderSourceFocus } from '../features/reader/reader-sources'
import { readerReadFields } from '../features/reader/reader-content'
import { useWorkspaceView, type WorkspaceViewContext } from '../features/workspace/use-workspace-view'
import NodeInspector from '../features/graph/NodeInspector.vue'
import DataPayloadEditor from '../features/graph/DataPayloadEditor.vue'
import RunReview from '../features/run/RunReview.vue'
import RunComposer, { type RunComposerTarget } from '../features/run/RunComposer.vue'
import type { RunDraftSeed, RunStartInput } from '../features/run/run-draft'
import RunHistoryPanel from '../features/run/RunHistoryPanel.vue'
import type { RunHistoryContext } from '../features/run/run-history'
import type { PublicationPreviewContext } from '../features/run/publication-preview'
import ManagementPanel from '../features/management/ManagementPanel.vue'
import EvidenceLibraryView from '../features/evidence-library/EvidenceLibraryView.vue'
import EvidenceEntryDetails from '../features/evidence-library/EvidenceEntryDetails.vue'
import EvidenceCollectDialog from '../features/evidence-library/EvidenceCollectDialog.vue'
import NodeEvidenceEditor from '../features/evidence-library/NodeEvidenceEditor.vue'
import type { EvidenceSelectionContext } from '../features/evidence-library/evidence-selection'
import { evidenceCreateState, type EvidenceCollectInput, type EvidenceUiContext } from '../features/evidence-library/evidence-state'
import type { EvidenceUsesContext } from '../features/evidence-library/evidence-uses'
import { graphReadNodeText, graphReadNodeType } from '../features/graph/graph-layout'
import { definitionKey, payloadCreateInitial } from '../features/graph/data-payload'
import { useClientStore } from '../state/client-session'
import { api } from '../transport/client-gateway'
import { uiReadErrorMessage, uiReadRunStatus } from '../presentation/ui-labels'

const session = useClientStore()
const surface = ref<'map' | 'evidence'>('map')
const runTarget = shallowRef<RunComposerTarget | null>(null)
const historyOpen = ref(false)
const historyTarget = ref<OperationOriginTarget | null>(null)
const libraryMode = ref<'map' | 'page'>('map')
const libraryView = ref<InstanceType<typeof EvidenceLibraryView> | null>(null)
const librarySourceNotice = ref('')
let navigationRevision = 0
let basisDownloadController: AbortController | null = null
const basisDownloading = ref(false)
const collectionOpen = ref(false)
const collectionTarget = ref<{ workspaceId: string; claim: EvidenceClaimRef; content: string } | null>(null)
const nodeEvidenceTarget = ref<{ mapId: string; workspaceId: string; node: GraphNode } | null>(null)
const nodeEvidenceDialogKey = ref(0)
const nodeEvidenceChanged = computed(() => {
  // 窗口仅确认打开时的消费者版本，外部内容变化后不能静默改写原引用草稿。
  const target = nodeEvidenceTarget.value
  return !target || session.snapshot?.mapId !== target.mapId || session.workspace?.id !== target.workspaceId
    || session.snapshot.nodes.find((/* 最新图中的消费者。 */ node) => /* 核对原节点身份和版本。 */ node.id === target.node.id)?.revision !== target.node.revision
})
const libraryAvailable = computed(() => /* 只有当前服务明确声明可用时才开放证据库。 */
  session.bootstrap?.metadata.capabilities?.evidenceLibrary === true)
const reviewIdentity = computed<Pick<PublicationPreviewContext, 'userId' | 'connectionKey' | 'workspaceId'>>(() =>
  /* 审核读取按服务与用户隔离，和当前库面板是否打开无关。 */ ({
    userId: session.bootstrap?.identity.userId ?? null, connectionKey: session.connection?.baseUrl ?? null,
    workspaceId: session.workspace?.id ?? null,
  }))
const historyContext = computed<RunHistoryContext>(() => /* 历史是独立只读面板，不依赖当前Run选择或命令busy。 */ ({
  ...reviewIdentity.value, mapId: session.activeMapId, active: historyOpen.value && surface.value === 'map',
  supported: session.bootstrap?.metadata.capabilities?.runHistory === true,
  target: historyTarget.value ?? undefined,
}))
watch(() => /* 更换服务、身份、工作区或Map时结束旧历史窗口。 */ JSON.stringify([
  historyContext.value.userId, historyContext.value.connectionKey, historyContext.value.workspaceId, historyContext.value.mapId, surface.value,
]), () => {
  // 面板卸载取消自己的读取，当前Run控制和未确认命令不受影响。
  historyOpen.value = false
  historyTarget.value = null
}, { flush: 'sync' })

function homeOpenHistory(): void {
  // 普通入口总是从当前图的完整目录开始，不沿用上一次来源过滤。
  if (!historyContext.value.supported || !session.snapshot || surface.value !== 'map') return
  historyTarget.value = null
  historyOpen.value = true
}

function homeCloseHistory(): void {
  // 仅结束历史阅读，不改变当前运行、控制权、节点选择或草稿。
  historyOpen.value = false
  historyTarget.value = null
}

function homeOpenOperation(
  /* 来源组件发出的固定图身份和已保存来源记录。 */ input: OperationOriginOpen,
): void {
  // 拒绝来自旧图的意图；生成目标还须对应当前保存节点，读取从不借用编辑草稿。
  const snapshot = session.snapshot
  if (!snapshot || surface.value !== 'map' || !historyContext.value.supported
    || input.workspaceId !== session.workspace?.id || input.workspaceId !== snapshot.workspaceId
    || input.mapId !== session.activeMapId || input.mapId !== snapshot.mapId) return
  const target = input.target
  if (target.kind === 'producer') {
    const node = snapshot.nodes.find((/* 当前图中的真实节点。 */ item) => /* 导航绑定原节点而非后来选中的节点。 */ item.id === target.node.id)
    if (!node || node.importedFrom || node.revision !== target.node.revision || node.producer?.operationId !== target.operationId) return
  }
  historyTarget.value = target
  historyOpen.value = true
}

function homeOpenHistoryOperation(
  /* 当前只读历史中的一次明确直接来源点击。 */ target: OperationOriginTarget,
): void {
  // 历史窗口的身份已随Map切换清理，每次只进入保存的下一跳。
  const context = historyContext.value
  if (!context.active || !context.workspaceId || !context.mapId) return
  homeOpenOperation({ workspaceId: context.workspaceId, mapId: context.mapId, target })
}
const libraryCanEdit = computed(() => /* 库命令按工作区角色授权，与 Map 实时流及编辑租约独立。 */
  libraryAvailable.value && session.workspace !== null && session.workspace.role !== 'viewer')
const libraryContext = computed<EvidenceUiContext>(() => /* 限定当前库请求的身份、服务和工作区归属。 */ ({
  userId: session.bootstrap?.identity.userId ?? null,
  connectionKey: session.connection?.baseUrl ?? null,
  workspaceId: session.workspace?.id ?? null,
  active: libraryAvailable.value && surface.value === 'evidence',
  canEdit: libraryCanEdit.value,
}))
const library = evidenceCreateState(api, libraryContext, () => /* 库认证过期时结束同一客户端会话。 */ session.disconnect())
const libraryUsesContext = computed<EvidenceUsesContext>(() => {
  // 真实API与当前身份绑定到使用面板，邻域材料没有独立库条目使用目录。
  const current = libraryContext.value
  return { userId: current.userId, connectionKey: current.connectionKey, workspaceId: current.workspaceId,
    entryId: library.entry.value?.id ?? null, active: current.active && library.selectedRelationNode.value === null }
})
const sidebarUsesContext = computed<EvidenceUsesContext>(() => /* 隐藏右侧详情时暂停其读取，单页由View内部独立激活。 */
  ({ ...libraryUsesContext.value, active: libraryUsesContext.value.active && libraryMode.value === 'map' }))
const libraryViewKey = computed(() => /* 工作区或身份更换时重新建立库的展示状态。 */ JSON.stringify([
  libraryContext.value.userId, libraryContext.value.connectionKey, libraryContext.value.workspaceId,
]))
const selectedClaim = computed(() => {
  // 只允许收录当前已加载且被明确选中的注册 Claim 版本。
  const snapshot = session.snapshot
  const node = session.selectedNode
  if (!snapshot || !node || node.typeId !== 'factcheck.claim' || snapshot.workspaceId !== session.workspace?.id
    || snapshot.mapId !== session.activeMapId || typeof node.payload.content !== 'string') return null
  return { workspaceId: snapshot.workspaceId,
    claim: { mapId: snapshot.mapId, nodeId: node.id, revision: node.revision }, content: node.payload.content }
})
const viewContext = computed<WorkspaceViewContext>(() => {
  const snapshot = session.snapshot
  const workspaceId = session.workspace?.id ?? null
  const mapId = session.activeMapId
  const snapshotMatches = !!snapshot && snapshot.workspaceId === workspaceId && snapshot.mapId === mapId
  return {
    userId: session.bootstrap?.identity.userId ?? null,
    workspaceId,
    mapId,
    selectedId: session.selectedId,
    selectedNodePresent: snapshotMatches && !!snapshot?.nodes.some(node => node.id === session.selectedId),
    loading: session.loading,
  }
})
const workspaceView = useWorkspaceView(viewContext)
const desktop = !!window.chongmingClient
const localState = ref<LocalServiceState>({ status: 'stopped' })
const workspaceNoticeVisible = computed(() => Boolean(session.error || librarySourceNotice.value
  || desktop && localState.value.status === 'failed' && session.connection?.mode === 'local'
  || session.workspace && session.preferenceSync !== 'synced' && session.preferenceSync !== 'saving'))
let stopLocalState = () => {
  // 在本机状态监听建立前提供可安全调用的空清理函数。
}
const baseUrl = ref('')
const token = ref('')
const managementOpen = ref(false)
const workspaceDialog = ref<HTMLDialogElement | null>(null)
const mapDialog = ref<HTMLDialogElement | null>(null)
const renameMapDialog = ref<HTMLDialogElement | null>(null)
const deleteMapDialog = ref<HTMLDialogElement | null>(null)
const renamedMapName = ref('')
const childTarget = ref<{ mapId: string; parent: GraphNode } | null>(null)
const childSourcePath = ref(''), childSourceLines = ref(''), nodeFormError = ref('')
const mapActionTarget = ref<{ workspaceId: string; mapId: string; revision: number; name: string; nodeCount: number } | null>(null)
const mapActionChanged = computed(() => {
  // 对话框确认的是打开时的图版本；外部变化后须重新审阅，不静默提升删除或改名基线。
  const target = mapActionTarget.value
  return !target || target.workspaceId !== session.workspace?.id || target.mapId !== session.snapshot?.mapId
    || target.revision !== session.snapshot.revision
})
const nodeDialog = ref<HTMLDialogElement | null>(null)
const workspaceName = ref(''), workspaceDescription = ref(''), mapName = ref('')
const workspaceAgentSource = ref<CommandInputMap['workspace.create']['agentSource']>('library')
const nodeTypeKey = ref(''), nodePayload = ref<GraphPayload>({})
const nodeEvidenceContext = computed<EvidenceSelectionContext>(() => /* 独立窗口选材只属于当前消费者，不影响运行选材。 */ ({
  userId: session.bootstrap?.identity.userId ?? null, connectionKey: session.connection?.baseUrl ?? null,
  workspaceId: nodeEvidenceTarget.value?.workspaceId ?? null,
  active: libraryAvailable.value && nodeEvidenceTarget.value !== null, canEdit: false,
  targetKey: JSON.stringify([nodeEvidenceTarget.value?.mapId, nodeEvidenceTarget.value?.node.id, nodeEvidenceTarget.value?.node.revision]),
}))
const collectionContext = computed<EvidenceSelectionContext>(() => /* 依据候选只属于收录窗口打开时的原Claim，查询不切换当前图。 */ ({
  userId: session.bootstrap?.identity.userId ?? null, connectionKey: session.connection?.baseUrl ?? null,
  workspaceId: collectionTarget.value?.workspaceId ?? null,
  active: libraryAvailable.value && collectionOpen.value, canEdit: false,
  targetKey: JSON.stringify([collectionTarget.value?.claim.mapId, collectionTarget.value?.claim.nodeId, collectionTarget.value?.claim.revision]),
}))
const dataTypes = computed(() => session.catalog?.dataTypes ?? [])
const nodeType = computed(() => dataTypes.value.find(type => definitionKey(type) === nodeTypeKey.value) ?? dataTypes.value[0])
const childSourceFields = computed(() => {
  // 来源定位只读取对话框打开时固定的父正文，不把行号套在之后的服务器新版上。
  const parent = childTarget.value?.parent
  const definition = parent ? dataTypes.value.find((/* 父节点的精确类型。 */ type) => /* ID和版本同时匹配。 */ type.id === parent.typeId && type.version === parent.typeVersion) : undefined
  return parent ? readerReadFields(parent, definition).filter((/* 已按展示定义解析的父字段。 */ field) => /* 只有真实文本支持行号定位。 */ typeof field.value === 'string') : []
})
const runnableTransitions = computed(() => /* 完整运行表单已能逐端口配置所有已发布转换。 */ session.catalog?.transitions ?? [])
function homeSelectRun(event: Event) {
  void session.selectRun((event.target as HTMLSelectElement).value || null)
}
const connectedAddress = computed(() => {
  // 尚无连接时留空；已有地址已经由公共网关解析为 HTTP(S) origin。
  return session.connection ? new URL(session.connection.baseUrl).host : ''
})
const syncLabel = computed(() =>
  /* 按事件流、错误和既有快照状态生成连接状态文案。 */
  session.streamState === 'live' ? '实时同步' : session.streamState === 'connecting' ? '正在连接实时更新' : session.streamState === 'reconnecting' ? '实时连接中断 · 自动重连' : session.streamError ? '连接中断' : session.lastSync ? '已同步' : session.bootstrap ? '已连接' : '未连接')

watch(() => /* 观察当前连接的服务地址。 */ session.connection?.baseUrl, value => {
  // 将已恢复的服务地址写入登录表单。
  if (value) baseUrl.value = value
}, { immediate: true })
watch(() => /* 观察登录身份变化以清理上一个用户的界面草稿。 */ session.bootstrap?.identity.userId, () => {
  // 身份变化时关闭管理面板和创建对话框，并清空令牌与表单草稿。
  managementOpen.value = false
  token.value = ''; workspaceName.value = ''; workspaceDescription.value = ''; mapName.value = ''
  workspaceAgentSource.value = 'library'
    nodeTypeKey.value = ''; nodePayload.value = {}
  workspaceDialog.value?.close(); mapDialog.value?.close(); nodeDialog.value?.close()
})
watch(() => /* 观察当前图切换以清理图相关对话框。 */ session.activeMapId, () => {
  // 切图时关闭节点相关窗口；运行表单按完整身份单独释放。
  nodeDialog.value?.close()
  homeCloseMapActions()
  homeCloseNodeDialog()
  homeCloseNodeEvidence()
})
watch(() => /* 服务能力与原有身份范围共同决定库导航和选材的有效期。 */
  [libraryViewKey.value, libraryAvailable.value] as const, () => {
  // 身份、服务、工作区或能力变化后退出库，清空选材并关闭旧来源的收录草稿。
  surface.value = 'map'
  libraryMode.value = 'map'
  librarySourceNotice.value = ''
  navigationRevision += 1
  homeCloseCollection()
  homeCloseMapActions()
  homeCloseNodeDialog()
  homeCloseNodeEvidence()
}, { flush: 'sync' })
watch(() => /* 后继表单只属于打开时选中的父节点。 */ session.selectedId, () => {
  // 创建成功会选中新子节点；转向其他节点时关闭旧父表单。
  if (childTarget.value && childTarget.value.parent.id !== session.selectedId) homeCloseNodeDialog()
  if (nodeEvidenceTarget.value && nodeEvidenceTarget.value.node.id !== session.selectedId) homeCloseNodeEvidence()
})
watch(() => /* 工作区或固定阅读目标变化时停止旧依据文件读取。 */
  [libraryViewKey.value, surface.value, library.selectedId.value, library.selectedRelationKey.value] as const, () => {
  // 文件只在发起它的固定条目下保存，离开目标及时中断字节传输。
  basisDownloadController?.abort()
}, { flush: 'sync' })
watch(selectedClaim, (/* 当前来源版本及可读原文。 */ current) => {
  // 来源选择、版本或工作区改变后废弃旧收录表单，避免把新内容送入旧引用。
  const target = collectionTarget.value
  if (target && (!current || current.workspaceId !== target.workspaceId || current.claim.mapId !== target.claim.mapId
    || current.claim.nodeId !== target.claim.nodeId || current.claim.revision !== target.claim.revision)) homeCloseCollection()
}, { flush: 'sync' })
watch(libraryCanEdit, (/* 当前成员是否仍可写入库。 */ canEdit) => {
  // 权限降级时关闭尚未确认的收录表单，避免只读成员面对可点击提交按钮。
  if (!canEdit) { homeCloseCollection(); homeCloseNodeEvidence() }
}, { flush: 'sync' })
watch(() => /* 当前运行表单不能跨服务、身份、工作区、Map或中心区域复用。 */ JSON.stringify([
  reviewIdentity.value.userId, reviewIdentity.value.connectionKey, reviewIdentity.value.workspaceId, session.activeMapId, surface.value,
]), () => {
  // 组件卸载结束本窗口草稿和选材，不触碰session的原请求或已提交Run。
  runTarget.value = null
}, { flush: 'sync' })
onMounted(() => {
  // 挂载时订阅并读取本机服务状态，然后初始化客户端会话。
  if (window.chongmingClient) {
    stopLocalState = window.chongmingClient.onLocalState(value => {
      // 接纳桌面桥接推送的本机服务状态。
      localState.value = value
    })
    void window.chongmingClient.localState().then(result => {
      // 仅在桥接读取成功时接纳初始本机状态。
      if (result.ok) localState.value = result.value
    })
  }
  void session.initialize()
})
onBeforeUnmount(() => {
  // 卸载页面时中断依据文件读取，移除本机监听并释放客户端会话。
  basisDownloadController?.abort()
  stopLocalState(); library.dispose(); session.dispose()
})

async function homeConnectSession() {
  // 取出并立即清空表单令牌，使用当前连接参数登录。
  const value = token.value
  token.value = ''
  await session.connect({ baseUrl: baseUrl.value, token: value, remember: false })
}
function homeOpenWorkspaceDialog(): void {
  // 两个创建入口共用新草稿默认值，待确认原请求不被开窗动作清除。
  if (session.busy || session.canRetry) return
  session.clearError()
  workspaceAgentSource.value = 'library'
  workspaceDialog.value?.showModal()
}
function homeOpenMapDialog() {
  // 清除旧操作错误并打开创建数据图对话框。
  session.clearError(); mapDialog.value?.showModal()
}
function homeCloseMapActions(): void {
  // 关闭旧目标的确认窗口，保留图正文草稿和服务端运行。
  renameMapDialog.value?.close()
  deleteMapDialog.value?.close()
  mapActionTarget.value = null
}
function homeOpenMapAction(
  /* 当前图上明确选择的改名或删除意图。 */ action: 'rename' | 'delete',
): void {
  // 固定确认时的图身份、版本和展示摘要；占用校验仍由后端原子执行。
  const snapshot = session.snapshot
  if (!snapshot || session.busy || session.canRetry || !session.canEdit || (action === 'rename' && !session.canRenameMap)) return
  session.clearError()
  mapActionTarget.value = { workspaceId: snapshot.workspaceId, mapId: snapshot.mapId, revision: snapshot.revision,
    name: snapshot.name, nodeCount: snapshot.nodes.length }
  renamedMapName.value = snapshot.name
  if (action === 'rename') renameMapDialog.value?.showModal()
  else deleteMapDialog.value?.showModal()
}
async function homeRenameMap(): Promise<void> {
  // 只提交用户刚确认的当前版本；失败保留名称草稿和原请求恢复入口。
  if (mapActionChanged.value || !session.canRenameMap || session.canRetry) return
  const target = mapActionTarget.value
  if (await session.renameMap(renamedMapName.value.trim()) && mapActionTarget.value === target) homeCloseMapActions()
}
async function homeDeleteMap(): Promise<void> {
  // 明确确认后删除目标图；确认回包与订阅可交错，由会话统一清理标签及偏好。
  if (mapActionChanged.value || !session.canEdit || session.canRetry) return
  const target = mapActionTarget.value
  if (await session.deleteMap() && mapActionTarget.value === target) homeCloseMapActions()
}
function homeCloseNodeDialog(): void {
  // 清理本页创建草稿，不丢弃会话仍待确认的原请求。
  nodeDialog.value?.close()
  childTarget.value = null; childSourcePath.value = ''; childSourceLines.value = ''; nodeFormError.value = ''
}
function homeOpenChildDialog(
  /* 详情中按精确定义选择的父节点和后继类型。 */ input: { parentId: string; childType: { id: string; version: number } },
): void {
  // 父身份、正文版本和后继类型在打开时固定，表单不提供自由连线选择。
  const snapshot = session.snapshot
  const parent = snapshot?.nodes.find((/* 当前图中的实际节点。 */ node) => /* 必须仍为所选父节点。 */ node.id === input.parentId)
  const definition = dataTypes.value.find((/* 已发布精确类型。 */ type) => /* 后继ID和版本同时匹配。 */ type.id === input.childType.id && type.version === input.childType.version)
  if (!snapshot || !parent || !definition || session.selectedId !== parent.id || session.busy || session.canRetry || !session.canEdit) return
  session.clearError(); nodeFormError.value = ''
  childTarget.value = { mapId: snapshot.mapId, parent: JSON.parse(JSON.stringify(parent)) as GraphNode }
  childSourceLines.value = ''; childSourcePath.value = childSourceFields.value[0]?.path ?? ''
  homeSelectNodeType(definition)
  nodeDialog.value?.showModal()
}
/**
 * @param definition 新建表单选中的精确数据类型。
 */
function homeSelectNodeType(definition: DataTypeDefinition | undefined): void {
  if (!definition) { nodeTypeKey.value = ''; nodePayload.value = {}; return }
  nodeTypeKey.value = definitionKey(definition)
  const initial = payloadCreateInitial(definition.schema)
  nodePayload.value = initial && typeof initial === 'object' && !Array.isArray(initial) ? initial : {}
}
function homeOpenNodeDialog() {
  // 独立创建与父节点下创建分开标明，保留当前合同允许的所有根类型。
  if (session.busy || session.canRetry || !session.canEdit) return
  homeCloseNodeDialog()
  session.clearError(); homeSelectNodeType(dataTypes.value[0])
  nodeDialog.value?.showModal()
}
async function homeCreateWorkspace(): Promise<void> {
  // 将明确选择的初始策略交给原会话创建动作，成功后清空本窗口草稿。
  if (session.busy || session.canRetry) return
  if (await session.createWorkspace(workspaceName.value.trim(), workspaceDescription.value, workspaceAgentSource.value)) {
    workspaceDialog.value?.close(); workspaceName.value = ''; workspaceDescription.value = ''; workspaceAgentSource.value = 'library'
  }
}
async function homeRetryWorkspace(): Promise<void> {
  // 沿会话原请求确认，不重新读取表单策略或分配另一个工作区身份。
  if (session.busy) return
  if (await session.retry()) {
    workspaceDialog.value?.close(); workspaceName.value = ''; workspaceDescription.value = ''
    workspaceAgentSource.value = 'library'
  }
}
async function homeCreateMap() {
  // 创建数据图，成功后关闭对话框并清空名称。
  if (await session.createMap(mapName.value.trim())) {
    surface.value = 'map'
    mapDialog.value?.close()
    mapName.value = ''
  }
}
async function homeCreateNode(): Promise<void> {
  // 后继以一次请求保存节点、结构及可选脚注，独立创建仍走已有根入口。
  const definition = nodeType.value, target = childTarget.value
  if (!definition || session.busy || session.canRetry || !session.canEdit) return
  nodeFormError.value = ''
  const payload = JSON.parse(JSON.stringify(nodePayload.value)) as GraphPayload
  try {
    const created = target
      ? await session.createChildNode({ mapId: target.mapId, parentId: target.parent.id, expectedParentRevision: target.parent.revision,
        childType: { id: definition.id, version: definition.version }, payload,
        ...(childSourceLines.value.trim() ? { sourceAnchors: readerCreateSourceAnchors(target.parent, childSourcePath.value, childSourceLines.value) } : {}) })
      : await session.createNode(definition, payload)
    if (created) { homeCloseNodeDialog(); nodeTypeKey.value = ''; nodePayload.value = {} }
  } catch (cause) {
    // 行号的本地格式错误保留全部正文，写入错误仍由会话展示。
    nodeFormError.value = cause instanceof Error ? cause.message : String(cause)
  }
}
function homeOpenRunDialog(
  /* 节点入口提供明确种子；顶部入口省略时保持默认批量范围。 */ seed?: RunDraftSeed,
): void {
  // 先保护待确认意图，再建立固定身份；开窗本身不读取分支或启动Run。
  const snapshot = session.snapshot, workspace = session.workspace, connection = session.connection, bootstrap = session.bootstrap
  if (!snapshot || !workspace || !connection || !bootstrap || !session.canEdit || session.busy || session.canRetry || runTarget.value
    || surface.value !== 'map' || snapshot.mapId !== session.activeMapId || snapshot.workspaceId !== workspace.id) return
  const transition = runnableTransitions.value[0]
  const input = transition?.ports.input[0]
  const initial = seed ?? { transitionRef: transition ? { id: transition.id, version: transition.version } : null,
    nodeIds: snapshot.nodes.filter((/* 当前图中的保存节点。 */ node) => /* 默认批量仅取第一个转换的精确输入类型。 */
      !!input && node.typeId === input.inputType.id && node.typeVersion === input.inputType.version).map((/* 合法保存起点。 */ node) => /* 不改变画布选择。 */ node.id) }
  if (!initial.transitionRef) return
  session.clearError()
  runTarget.value = { userId: bootstrap.identity.userId, connectionKey: connection.baseUrl, workspaceId: workspace.id,
    mapId: snapshot.mapId, seed: { transitionRef: { ...initial.transitionRef }, nodeIds: [...(initial.nodeIds ?? [])] } }
}

function homeOpenNodeRun(
  /* 侧栏发出的真实保存节点及精确转换，不含正文草稿或待提交plan。 */ input: { workspaceId: string; mapId: string; nodeId: string; transitionRef: DefinitionRef },
): void {
  // 旧图或旧选择的事件不能借当前活动Map打开另一个运行目标。
  const snapshot = session.snapshot
  if (!snapshot || snapshot.workspaceId !== input.workspaceId || snapshot.mapId !== input.mapId || session.selectedId !== input.nodeId
    || !snapshot.nodes.some((/* 当前图中的真实起点。 */ node) => /* 只接受侧栏原节点。 */ node.id === input.nodeId)) return
  homeOpenRunDialog({ transitionRef: input.transitionRef, nodeIds: [input.nodeId] })
}

function homeRunTargetCurrent(
  /* 本窗口打开时固定的同一目标对象，区分同图重开的新草稿。 */ target: RunComposerTarget,
): boolean {
  // 入口、提交和原请求确认均受同一完整身份约束，不从新会话借取旧意图。
  return runTarget.value === target && surface.value === 'map' && session.bootstrap?.identity.userId === target.userId
    && session.connection?.baseUrl === target.connectionKey && session.workspace?.id === target.workspaceId
    && session.activeMapId === target.mapId && session.snapshot?.mapId === target.mapId && session.snapshot.workspaceId === target.workspaceId
}

function homeCloseRun(
  /* 发出关闭意图的原窗口，晚完成不会关闭后来打开的窗口。 */ target: RunComposerTarget,
): void {
  // 关闭只释放表单；原请求和Run控制继续由session持有。
  if (runTarget.value === target) runTarget.value = null
}

async function homeStartRun(
  /* 当前明确确认的窗口身份。 */ target: RunComposerTarget,
  /* builder已经复制的完整单步提交内容。 */ input: RunStartInput,
): Promise<boolean> {
  // 会话继续独占分支核对、授权和Run身份，表单不进入控制流程。
  if (!homeRunTargetCurrent(target) || !session.canEdit || session.busy || session.canRetry) return false
  return session.startRun(input)
}

async function homeRetryRun(
  /* 请求确认仍属于原打开窗口的完整身份。 */ target: RunComposerTarget,
): Promise<boolean> {
  // 确认只用原请求，不调用builder重建plan或分配第二个Run。
  if (!homeRunTargetCurrent(target) || session.busy || !session.canRetry) return false
  return session.retry()
}
/**
 * 重试会话保留的原操作，成功时关闭对应创建对话框。
 *
 * @param dialog 触发重试的创建对话框引用，可能尚未挂载；仅重试成功后关闭。
 */
async function homeRetryDialog(dialog: HTMLDialogElement | null) {
  if (await session.retry()) dialog?.close()
}
/**
 * 按图标识查找标签页名称，缺失时使用默认标题。
 *
 * @param id 标签页记录的图身份，用于查找展示名称。
 */
function homeReadMapTitle(id: string) {
  return session.mapList.find(map => /* 匹配指定标签页对应的图摘要。 */ map.id === id)?.name ?? '数据图'
}
/**
 * 关闭管理面板，刷新工作区列表并进入刚导入的工作区。
 *
 * @param workspaceId 导入流程确认的新工作区身份，刷新列表后进入该工作区。
 */
async function homeOpenImport(workspaceId: string) {
  managementOpen.value = false
  await session.loadWorkspaces()
  await session.selectWorkspace(workspaceId)
}
function homeCloseNodeEvidence(): void {
  // 关闭草稿窗口不替换或丢弃会话仍待确认的原请求。
  nodeEvidenceTarget.value = null
}
function homeOpenNodeEvidenceEditor(
  /* 节点详情明确请求编辑的消费者原版本。 */ input: { mapId: string; nodeId: string; expectedNodeRevision: number },
): void {
  // 窗口固定原节点副本，只修改引用理由和列表，正文仍由普通编辑表单负责。
  const snapshot = session.snapshot
  const node = snapshot?.nodes.find((/* 当前图中可读消费者。 */ item) => /* 不接受其他选择的旧事件。 */ item.id === input.nodeId)
  if (!snapshot || snapshot.mapId !== input.mapId || session.selectedId !== input.nodeId || !node
    || node.revision !== input.expectedNodeRevision || !libraryAvailable.value || !session.canEdit || session.busy || session.canRetry) return
  session.clearError()
  nodeEvidenceDialogKey.value++
  nodeEvidenceTarget.value = { mapId: snapshot.mapId, workspaceId: snapshot.workspaceId, node: JSON.parse(JSON.stringify(node)) as GraphNode }
}
async function homeSaveNodeEvidence(
  /* 窗口确认的完整引用草稿；空数组明确清空。 */ refs: EvidenceUseRef[],
): Promise<void> {
  // 会话统一取得消费者分支证明和编辑权，成功确认后才关闭同一个窗口。
  const target = nodeEvidenceTarget.value
  if (!target || nodeEvidenceChanged.value || session.canRetry) return
  if (await session.saveNodeEvidence({ mapId: target.mapId, nodeId: target.node.id, expectedNodeRevision: target.node.revision, refs })
    && nodeEvidenceTarget.value === target) homeCloseNodeEvidence()
}
async function homeRetryNodeEvidence(): Promise<void> {
  // 未知结果保持原编号和原引用参数，只结束仍属于这次原意图的窗口。
  const target = nodeEvidenceTarget.value
  if (!target || session.busy || !session.canRetry) return
  if (await session.retry() && nodeEvidenceTarget.value === target) homeCloseNodeEvidence()
}
async function homeOpenNodeEvidence(
  /* 实际阅读节点保存的工作区和精确固定引用。 */ input: { workspaceId: string; ref: EvidenceLibraryRef },
): Promise<void> {
  // 沿既有库读取核对固定摘要，再打开原文；不可用不会删除原节点的引用或理由。
  if (!libraryAvailable.value || input.workspaceId !== session.workspace?.id || session.busy) return
  const ref = { ...input.ref }, key = libraryViewKey.value
  homeOpenEvidence()
  const navigation = navigationRevision
  await nextTick()
  const ready = await library.select(ref.entryId, ref.contentDigest)
  if (key !== libraryViewKey.value || navigation !== navigationRevision || surface.value !== 'evidence') return
  if (!ready || library.entry.value?.contentDigest !== ref.contentDigest) {
    librarySourceNotice.value = '这条固定证据当前不可用；原引用与使用理由仍保留，请核对条目和内容摘要。'
    return
  }
  library.selectRelation(null)
  await libraryView.value?.openPage()
}
function homeOpenEvidence(): void {
  // 打开当前工作区的库入口，读取生命周期由库状态模块统一建立。
  if (!libraryAvailable.value || !session.workspace) return
  navigationRevision += 1
  librarySourceNotice.value = ''
  surface.value = 'evidence'
}
async function homeOpenMap(
  /* 左侧列表或已有标签中选择的真实 Map 身份。 */ mapId: string,
): Promise<void> {
  // 切回原 Map 展示并让会话完成读取及订阅，不取消已提交的核查运行。
  navigationRevision += 1
  surface.value = 'map'
  librarySourceNotice.value = ''
  await session.openMap(mapId)
}
async function homeSelectWorkspace(
  /* 用户选择的新工作区身份。 */ workspaceId: string,
): Promise<void> {
  // 工作区切换先退出库视图，再交由会话隔离该工作区的图请求。
  navigationRevision += 1
  surface.value = 'map'
  homeCloseCollection()
  await session.selectWorkspace(workspaceId)
}
function homeOpenCollection(): void {
  // 固定当前 Claim 来源，表单只决定收录判断、范围和理由。
  if (!selectedClaim.value || !libraryCanEdit.value || session.busy || library.busy.value) return
  library.clearError()
  collectionTarget.value = structuredClone(selectedClaim.value)
  collectionOpen.value = true
}
function homeCloseCollection(): void {
  // 关闭来源表单并释放本窗口的原文草稿，不更改已发送命令的收据身份。
  collectionOpen.value = false
  collectionTarget.value = null
}
async function homeCollectEvidence(
  /* 表单确认的固定来源、判断、范围与依据，工作区由状态模块绑定。 */ params: EvidenceCollectInput,
): Promise<void> {
  // 原收录目标不变时提交；首次与原请求确认共用完整结果的页面接纳。
  const target = collectionTarget.value
  if (!target || !selectedClaim.value || target.workspaceId !== session.workspace?.id
    || params.claim.mapId !== target.claim.mapId || params.claim.nodeId !== target.claim.nodeId
    || params.claim.revision !== target.claim.revision) return
  if (await library.collect(params)) await homeFinishCollection(target)
}
async function homeRetryCollection(): Promise<void> {
  // 重试保留的原命令，不从当前浏览条目猜测原收录结果。
  const target = collectionTarget.value
  if (!collectionOpen.value || !target) return
  if (await library.retry()) await homeFinishCollection(target)
}
async function homeFinishCollection(
  /* 开始提交或重试时固定的原收录窗口目标。 */ target: NonNullable<typeof collectionTarget.value>,
): Promise<void> {
  // 完整确认来自状态唯一结果，首次和原请求重放都定位该次条目并保留结果区。
  const outcome = library.collectionOutcome.value
  if (!outcome || !collectionOpen.value || collectionTarget.value !== target || target.workspaceId !== session.workspace?.id
    || outcome.entry.workspaceId !== target.workspaceId) return
  const key = libraryViewKey.value
  homeCloseCollection()
  homeOpenEvidence()
  const navigation = navigationRevision
  await nextTick()
  if (key !== libraryViewKey.value || navigation !== navigationRevision || surface.value !== 'evidence'
    || library.collectionOutcome.value !== outcome) return
  await library.select(outcome.entry.id, outcome.entry.contentDigest)
}
async function homeOpenCollectionOutcomeEntry(
  /* 结果区明确点击的本次条目或原返回相反判断身份。 */ entryId: string,
): Promise<void> {
  // 本次条目校对原摘要，相反项按原ID读取当前授权详情，失败不改写已确认收录结果。
  const outcome = library.collectionOutcome.value
  if (!outcome || !libraryAvailable.value || outcome.entry.workspaceId !== session.workspace?.id
    || entryId !== outcome.entry.id && !outcome.conflictEntryIds.includes(entryId)) return
  const key = libraryViewKey.value
  const digest = entryId === outcome.entry.id ? outcome.entry.contentDigest : undefined
  homeOpenEvidence()
  const navigation = navigationRevision
  const current = () => /* 换工作区、关闭结果或另发导航后不再接纳旧打开动作。 */
    key === libraryViewKey.value && navigation === navigationRevision && surface.value === 'evidence'
    && library.collectionOutcome.value === outcome
  await nextTick()
  if (!current()) return
  const ready = await library.select(entryId, digest)
  if (!current() || library.selectedId.value !== entryId) return
  if (!ready) {
    librarySourceNotice.value = '这条收录条目当前不可用；已确认的收录结果和返回标识仍保留。'
    return
  }
  library.selectRelation(null)
  await libraryView.value?.openPage()
}
async function homeOpenEvidenceBasis(
  /* 详情保存的原条目、依据顺序及精确材料身份。 */ input: EvidenceBasisOpen,
): Promise<void> {
  // 固定节点沿保存关系阅读，库项沿原摘要打开，文件核对原SHA后才交浏览器保存。
  const entry = library.entry.value
  const basis = entry?.decision.basisRefs[input.basisIndex]
  if (!entry || !basis || !libraryAvailable.value || surface.value !== 'evidence' || basisDownloading.value
    || entry.workspaceId !== session.workspace?.id || entry.id !== input.entryId || entry.contentDigest !== input.contentDigest
    || JSON.stringify(basis) !== JSON.stringify(input.basis)) return
  librarySourceNotice.value = ''
  if (basis.kind === 'manual') return
  if (basis.kind === 'library') {
    await homeOpenNodeEvidence({ workspaceId: entry.workspaceId, ref: basis.ref })
    return
  }
  if (basis.kind === 'node') {
    const view = library.relations.value
    if (library.relationsLoading.value) {
      librarySourceNotice.value = '正在读取收录时的节点依据，请稍后再试。'
      return
    }
    const node = view?.entryId === entry.id && view.contentDigest === entry.contentDigest
      ? evidenceFindFixedBasisNode(view, input.basisIndex, basis.ref) : null
    if (!node) {
      librarySourceNotice.value = '未保存或暂不可用的固定节点依据，无法读取当时正文；原依据身份仍保留，可另行定位当前节点。'
      return
    }
    if (library.selectRelation(node.key)) await libraryView.value?.openPage()
    return
  }
  const key = libraryViewKey.value, navigation = ++navigationRevision
  const selectedRelation = library.selectedRelationKey.value
  const current = () => /* 文件确认结果只属于仍然打开的原固定条目和阅读节点。 */
    key === libraryViewKey.value && navigation === navigationRevision && surface.value === 'evidence'
    && library.entry.value?.id === entry.id && library.entry.value.contentDigest === entry.contentDigest
    && library.selectedRelationKey.value === selectedRelation
  const controller = new AbortController()
  basisDownloadController?.abort()
  basisDownloadController = controller; basisDownloading.value = true
  try {
    const asset = await api.read('asset.get', { assetId: basis.assetId }, controller.signal)
    if (!current()) return
    if (asset.id !== basis.assetId || asset.workspaceId !== entry.workspaceId || asset.sha256 !== basis.sha256) {
      throw new ClientError({ status: 409, code: 'EVIDENCE_BASIS_INVALID', message: EvidenceMessage.BASIS_INVALID, retryable: false })
    }
    const file = await api.download({ kind: 'asset', id: basis.assetId }, controller.signal)
    if (!current()) return
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(file.bytes).buffer)),
      (/* 实际下载内容的一个摘要字节。 */ byte) => /* 与固定SHA采用相同的小写十六进制格式。 */ byte.toString(16).padStart(2, '0')).join('')
    if (!current()) return
    if (digest !== basis.sha256 || file.bytes.byteLength !== asset.size) {
      throw new ClientError({ status: 409, code: 'EVIDENCE_BASIS_INVALID', message: EvidenceMessage.BASIS_INVALID, retryable: false })
    }
    clientSaveFile(file)
  } catch (cause) {
    // 旧目标的取消和错误不覆盖当前页面；认证失败沿统一会话退出。
    if (!current() || controller.signal.aborted) return
    if (cause instanceof ClientError && cause.status === 401) { await session.disconnect(); return }
    librarySourceNotice.value = uiReadErrorMessage(cause instanceof Error ? cause.message : String(cause))
  } finally {
    if (basisDownloadController === controller) { basisDownloadController = null; basisDownloading.value = false }
  }
}
async function homeOpenLibraryTarget(
  /* 条目保存的来源或消费者精确身份，定位时只读当前图。 */ ref: EvidenceClaimRef,
  /* 本次定位的是收录出处还是使用消费者。 */ kind: 'source' | 'consumer',
): Promise<void> {
  // 在同一导航代次内定位当前图；来源与使用记录的固定单页仍保持原身份。
  const key = libraryViewKey.value
  const navigation = ++navigationRevision
  const selectedEntryId = library.selectedId.value
  const selectedRelationKey = library.selectedRelationKey.value
  if (!session.mapList.some((/* 当前用户仍可访问的实际图摘要。 */ map) => /* 已删除或不可访问图不使用旧缓存冒充当前版本。 */ map.id === ref.mapId)) {
    librarySourceNotice.value = kind === 'consumer' ? '当前消费者已不可用，使用记录仍保留原消费者正文。' : '当前来源已不可用，证据库仍保留收录时的内容。'
    return
  }
  await session.openMap(ref.mapId)
  if (key !== libraryViewKey.value || navigation !== navigationRevision || selectedEntryId !== library.selectedId.value
    || selectedRelationKey !== library.selectedRelationKey.value) return
  const snapshot = session.snapshot
  const node = snapshot?.nodes.find((/* 原 Map 当前可读的节点。 */ item) => /* 定位保存的原节点身份。 */ item.id === ref.nodeId)
  if (!snapshot || snapshot.mapId !== ref.mapId || !node) {
    librarySourceNotice.value = kind === 'consumer' ? '当前消费者已不可用，使用记录仍保留原消费者正文。' : '当前来源已不可用，证据库仍保留收录时的内容。'
    return
  }
  surface.value = 'map'
  librarySourceNotice.value = node.revision === ref.revision ? '' : kind === 'consumer'
    ? '这里是消费者的当前版本；原消费者正文仍在使用记录中。' : '这里是来源的当前版本；收录时的固定内容仍在证据库中。'
  homeOpenPage({ workspaceId: snapshot.workspaceId, mapId: ref.mapId, nodeId: ref.nodeId })
}
async function homeOpenLibrarySource(/* 收录出处的固定版本身份。 */ ref: EvidenceClaimRef): Promise<void> {
  // 来源节点定位保持原路径和保存版本提示。
  await homeOpenLibraryTarget(ref, 'source')
}
async function homeOpenLibraryConsumer(/* 使用记录保存的原消费者身份。 */ ref: EvidenceClaimRef): Promise<void> {
  // 消费者定位与固定历史正文区别显示，使用同一身份和导航保护。
  await homeOpenLibraryTarget(ref, 'consumer')
}
function homeInvalidateLibraryNavigation(): void {
  // 使用选择改变时使已发出的消费者定位过期，迟到旧请求不抢回新选择。
  navigationRevision += 1
}
function homeChangeLibraryMode(
  /* 库场景或固定单页的用户导航结果。 */ mode: 'map' | 'page',
): void {
  // 单页导航使先前尚未完成的来源跳转失效。
  navigationRevision += 1
  libraryMode.value = mode
}
function homeOpenPage(identity: NodeIdentity): void {
  const snapshot = session.snapshot
  if (!snapshot || snapshot.workspaceId !== identity.workspaceId || snapshot.mapId !== identity.mapId
    || !snapshot.nodes.some(node => node.id === identity.nodeId)) return
  if (session.selectedId !== identity.nodeId) {
    session.selectNode(identity.nodeId)
  }
  workspaceView.openPage(identity)
}
function homeSwitchView(mode: 'map' | 'page'): void {
  if (mode === 'map') workspaceView.showMap()
  else {
    const identity = workspaceView.selectedIdentity.value
    if (identity) workspaceView.openPage(identity)
  }
}
function homeOpenRelatedNode(identity: NodeIdentity): void {
  const snapshot = session.snapshot
  if (!snapshot || snapshot.workspaceId !== identity.workspaceId || snapshot.mapId !== identity.mapId
    || !snapshot.nodes.some(node => node.id === identity.nodeId)) return
  session.selectNode(identity.nodeId)
  workspaceView.openPage(identity)
}
function homeOpenSource(focus: ReaderSourceFocus): void {
  const identity = focus.target, snapshot = session.snapshot
  if (!snapshot || snapshot.workspaceId !== identity.workspaceId || snapshot.mapId !== identity.mapId
    || !snapshot.nodes.some(node => node.id === identity.nodeId)) return
  if (session.selectedId !== identity.nodeId) session.selectNode(identity.nodeId)
  workspaceView.openPage(identity, focus.anchor)
}
function homeEditPageNode(identity: NodeIdentity): void {
  const snapshot = session.snapshot
  if (!snapshot || snapshot.workspaceId !== identity.workspaceId || snapshot.mapId !== identity.mapId
    || !snapshot.nodes.some(node => node.id === identity.nodeId)) return
  workspaceView.showMap()
  if (session.selectedId !== identity.nodeId) void session.selectNode(identity.nodeId)
}
</script>

<template>
  <!-- 未登录时展示连接表单；登录后按外壳插槽组织工作区、图画布和详情。 -->
  <main class="client-root" :class="{ desktop }">
    <section v-if="!session.bootstrap" class="login-screen" aria-label="连接重明服务">
      <div class="login-brand"><span class="brand-mark">重</span><div><h1>重明</h1><p>把事实、来源与核查结果连接起来</p></div></div>
      <div class="login-card">
        <template v-if="desktop">
          <h2>在这台电脑上使用重明</h2>
          <p class="muted">资料保存在本机，模型和工具照常联网。</p>
          <button class="primary login-button" type="button" :disabled="session.connecting || session.initializing" @click="session.connectLocal()">
            {{ localState.status === 'starting' ? '正在启动本机服务…' : localState.status === 'failed' ? '重试本机服务' : '在本机运行' }}
          </button>
          <p v-if="localState.message" class="error" role="alert" :title="localState.message">{{ uiReadErrorMessage(localState.message) }}<small v-if="localState.errorId">错误编号：{{ localState.errorId }}</small></p>
          <hr class="local-divider">
        </template>
        <label>服务地址<input v-model="baseUrl" type="url" autocomplete="url" required placeholder="http://127.0.0.1:4320" :disabled="session.connecting || session.initializing"></label>
        <AccountLogin :base-url="baseUrl" :can-remember="session.connection?.canRemember === true" :disabled="session.initializing" />
        <details class="advanced-connection">
          <summary>使用访问令牌</summary>
          <form @submit.prevent="homeConnectSession">
            <p class="muted">使用管理员提供的用户访问令牌连接当前服务。</p>
            <label>用户访问令牌<input v-model="token" type="password" autocomplete="off" required spellcheck="false" placeholder="粘贴用户令牌" :disabled="session.connecting || session.initializing"></label>
            <p class="muted session-note">访问令牌仅在本次会话中使用。</p>
            <button class="primary login-button" type="submit" :disabled="session.connecting || session.initializing || !token.trim() || !baseUrl.trim()">
              {{ session.initializing ? '恢复连接…' : session.connecting ? '正在连接…' : '连接' }}
            </button>
          </form>
        </details>
      </div>
    </section>

    <AppShell v-else class="workbench" :show-right-panel="surface === 'evidence' ? libraryMode === 'map' : workspaceView.mode.value === 'map'">
      <template #top>
        <header class="client-header">
          <div class="brand"><span class="brand-mark small">重</span><strong>重明</strong><span class="muted">事实核查工作台</span></div>
        <div class="account"><span v-if="session.connection?.mode === 'local'" class="muted">本机模式</span><button v-if="desktop && (session.connection?.mode !== 'local' || localState.status === 'failed')" :disabled="session.connecting" @click="session.connectLocal()">{{ localState.status === 'failed' ? '重启本机服务' : '回到本机' }}</button><span class="server" :title="session.connection?.baseUrl">{{ connectedAddress }}</span><span>{{ session.bootstrap.identity.displayName }}</span><AccountSettings v-if="session.connection?.account && session.accountAvailable" /><button :disabled="!session.online" @click="managementOpen = true">管理工作台</button><button @click="session.logout()">退出登录</button></div>
        </header>
        <section v-if="workspaceNoticeVisible" class="workspace-notices" aria-label="工作区提示">
        <div v-if="desktop && localState.status === 'failed' && session.connection?.mode === 'local'" class="notice" role="alert" :title="localState.message">{{ uiReadErrorMessage(localState.message ?? '') }}</div>
        <div v-if="session.error" class="notice" role="alert">
          <span :title="session.error.message">{{ uiReadErrorMessage(session.error.message) }} · 错误编号：{{ session.error.errorId }}</span><button v-if="session.canRetry" :disabled="session.busy" @click="session.retry()">重试同一操作</button><button aria-label="关闭提示" @click="session.clearError()">×</button>
        </div>
        <div v-if="session.workspace && session.preferenceSync !== 'synced' && session.preferenceSync !== 'saving'" class="notice" role="status" aria-label="视图设置同步">
          <template v-if="session.preferenceSync === 'conflict'">
            <span>视图设置已在其他窗口更新</span>
            <button @click="session.resolvePreferencesConflict('server')">采用服务器设置</button>
            <button @click="session.resolvePreferencesConflict('local')">保留本窗口选择</button>
          </template>
          <template v-else>
            <span>{{ session.preferenceSync === 'unsynced' ? '视图设置尚未确认保存' : '视图设置保存失败，请重试同步' }}</span>
            <button @click="session.retryPreferences()">重试同步</button>
          </template>
        </div>
        <div v-if="librarySourceNotice" class="notice" role="status"><span>{{ librarySourceNotice }}</span><button type="button" aria-label="关闭来源提示" @click="librarySourceNotice = ''">关闭</button></div>
        </section>
      </template>
      <template #left-head><div class="pane-heading"><strong>工作区</strong><button title="创建工作区" aria-label="创建工作区" :disabled="session.busy || session.canRetry" @click="homeOpenWorkspaceDialog">＋</button></div></template>
      <template #left>
        <WorkspaceSidebar :workspaces="session.workspaces" :maps="session.mapList" :workspace-id="session.workspace?.id ?? null" :map-id="surface === 'map' ? session.activeMapId : null" :role="session.workspace?.role ?? null" :can-edit="session.canEdit" :busy="session.busy" :evidence-active="surface === 'evidence'" :evidence-available="libraryAvailable"
          @select-workspace="homeSelectWorkspace" @open-map="homeOpenMap" @open-evidence="homeOpenEvidence" @create-workspace="homeOpenWorkspaceDialog" @create-map="homeOpenMapDialog" />
      </template>
      <template #center-head>
        <nav class="tabs" aria-label="打开的数据图">
          <div v-if="surface === 'evidence'" class="tab active"><button class="tab-title" @click="homeOpenEvidence">证据库</button></div>
          <div v-for="id in session.openMapIds" :key="id" class="tab" :class="{ active: surface === 'map' && id === session.activeMapId }">
            <button class="tab-title" @click="homeOpenMap(id)">{{ homeReadMapTitle(id) }}</button><button class="tab-close" :aria-label="`关闭图 ${homeReadMapTitle(id)}`" title="关闭标签，不取消核查" @click="session.closeMap(id)">×</button>
          </div>
          <span v-if="!session.openMapIds.length" class="tab-placeholder">核查画布</span>
        </nav>
      </template>
      <template #center>
        <EvidenceLibraryView v-show="surface === 'evidence'" :key="libraryViewKey" ref="libraryView" :gateway="api" :uses-context="libraryUsesContext" :state="library" :catalog="session.catalog" :active="libraryContext.active" :workspace-key="libraryViewKey" :can-edit="libraryCanEdit" @open-source="homeOpenLibrarySource" @view-mode="homeChangeLibraryMode" @unauthorized="session.disconnect" @open-consumer="homeOpenLibraryConsumer" @selection-changed="homeInvalidateLibraryNavigation" @open-basis="homeOpenEvidenceBasis" @open-collection-entry="homeOpenCollectionOutcomeEntry" />
        <WorkspaceViews v-show="surface === 'map'" :active="surface === 'map'" :snapshot="session.snapshot" :catalog="session.catalog" :activities="session.activities" :selected-run-id="session.selectedRunId" :selected-id="session.selectedId" :can-open-page="workspaceView.canOpenPage.value" :user-id="session.bootstrap.identity.userId" :mode="workspaceView.mode.value" :page-identity="workspaceView.pageIdentity.value" :bookmark="workspaceView.pageIdentity.value ? workspaceView.readBookmark(workspaceView.pageIdentity.value) : null" :loading="session.loading" :error-message="session.error?.message || session.streamError || null" :can-edit="session.canEdit" :busy="session.busy" :source-focus="workspaceView.sourceFocus.value" :library-available="libraryAvailable" :history-available="historyContext.supported"
          @select="session.selectNode" @open-page="homeOpenPage" @switch-view="homeSwitchView" @bookmark="(identity, value) => workspaceView.saveBookmark(identity, value)" @open-node="homeOpenRelatedNode" @edit-node="homeEditPageNode" @open-source="homeOpenSource" @save-sources="session.saveSourceAnchors" @open-evidence="homeOpenNodeEvidence" @open-operation="homeOpenOperation">
          <template #tools><div v-if="workspaceView.mode.value === 'map'" class="toolbar-actions">
            <button :disabled="!session.canRenameMap || session.busy || session.canRetry" :title="session.bootstrap.metadata.capabilities?.mapRename === true ? undefined : '当前服务未提供数据图改名'" @click="homeOpenMapAction('rename')">改名</button>
            <button :disabled="!session.canEdit || session.busy || session.canRetry" @click="homeOpenMapAction('delete')">删除数据图</button>
            <button :disabled="!session.canEdit || session.busy || session.canRetry || !dataTypes.length" title="独立添加数据" @click="homeOpenNodeDialog">＋ 数据</button>
            <button v-if="selectedClaim" :disabled="!libraryCanEdit || session.busy || library.busy.value" @click="homeOpenCollection">收录到证据库</button>
            <button class="primary" :disabled="!session.canEdit || session.busy || session.canRetry || !runnableTransitions.length" @click="homeOpenRunDialog()">运行转换</button>
            <button :disabled="session.loading" @click="session.refresh()">刷新</button>
          </div></template>
        </WorkspaceViews>
      </template>
      <template #right>
        <div class="inspector-scroll">
          <EvidenceEntryDetails v-if="surface === 'evidence'" :gateway="api" :uses-context="sidebarUsesContext" :entry="library.entry.value" :relations="library.relations.value" :relation-node="library.selectedRelationNode.value" :catalog="session.catalog" :loading="library.detailLoading.value" :error="library.error.value" :can-edit="libraryCanEdit" :busy="library.busy.value || library.canRetry.value || basisDownloading" @open-page="libraryView?.openPage()" @open-source="homeOpenLibrarySource" @withdraw="library.withdraw($event)" @unauthorized="session.disconnect" @open-consumer="homeOpenLibraryConsumer" @selection-changed="homeInvalidateLibraryNavigation" @open-basis="homeOpenEvidenceBasis" />
          <template v-else-if="session.snapshot">
            <button type="button" class="run-history-entry" :disabled="!historyContext.supported" :title="historyContext.supported ? undefined : '当前服务未提供运行历史目录'" @click="homeOpenHistory">运行历史</button>
            <label v-if="session.snapshot.runs.length" class="run-selector">运行任务<select :value="session.selectedRunId ?? ''" @change="homeSelectRun"><option v-for="run in session.snapshot.runs" :key="run.id" :value="run.id" :title="`运行任务标识：${run.id}`">{{ run.id.slice(0, 8) }} · {{ uiReadRunStatus(run.status) }} · {{ run.scope.nodeIds.length }} 个节点</option></select></label>
            <RunReview :activities="session.activities" :snapshot="session.snapshot" :run="session.selectedRun" :gateway="api" :identity="reviewIdentity" :preview-supported="session.bootstrap.metadata.capabilities?.publicationPreview === true" :leases-required="session.clientLeasesRequired" :can-edit="session.canEdit" :control="session.selectedRunControl" :busy="session.busy || session.canRetry" :history-available="historyContext.supported" @answer="session.answerReview" @cancel="session.cancelRun" @pause="session.pauseRun" @resume="session.resumeRun" @claim="session.claimRunControl()" @release="session.releaseRunControl()" @refresh="session.refresh()" @unauthorized="session.disconnect()" @open-operation="homeOpenOperation" />
            <NodeInspector :snapshot="session.snapshot" :branch="session.selectedBranch" :grant="session.selectedBranchGrant" :branch-loading="session.branchLoading" :catalog="session.catalog" :selected-id="session.selectedId" :leases-required="session.clientLeasesRequired" :can-edit="session.canEdit" :busy="session.busy || session.canRetry" :library-available="libraryAvailable" :history-available="historyContext.supported" @edit-evidence="homeOpenNodeEvidenceEditor" @open-evidence="homeOpenNodeEvidence" @save="session.saveNode" @remove="session.removeNode" @run="homeOpenNodeRun" @claim="session.claimBranch()" @release="session.releaseBranch()" @child="homeOpenChildDialog" @open-operation="homeOpenOperation" />
          </template>
          <div v-else class="inspector-empty"><h3>节点详情</h3><p>选择图中的节点，查看内容与来源。</p></div>
        </div>
      </template>
      <template #footer>
        <footer class="client-footer">
          <span class="status-dot" :class="{ offline: !session.online }" />
          <span v-if="session.preferenceSync === 'saving'" class="footer-sync" role="status" aria-label="视图设置同步">正在保存视图设置…</span>
          <span v-else class="footer-sync">{{ surface === 'evidence' ? '证据库' : syncLabel }}</span>
          <span v-if="surface === 'map' && session.streamError" class="error" :title="session.streamError">{{ uiReadErrorMessage(session.streamError) }}</span>
          <span class="footer-end">{{ session.workspace?.name ?? '未选择工作区' }}<template v-if="surface === 'evidence' && library.libraryRevision.value !== null"> · 库版本 {{ library.libraryRevision.value }}</template><template v-else-if="surface === 'map' && session.snapshot"> · 图同步序号 {{ session.snapshot.revision }}</template></span>
        </footer>
      </template>
    </AppShell>

    <RunHistoryPanel v-if="historyOpen && session.snapshot" :gateway="api" :context="historyContext" :snapshot="session.snapshot"
      :preview-supported="session.bootstrap?.metadata.capabilities?.publicationPreview === true" @close="homeCloseHistory" @unauthorized="session.disconnect()" @return-all="historyTarget = null" @open-operation="homeOpenHistoryOperation" />

    <RunComposer v-if="runTarget" :target="runTarget" :gateway="api" :snapshot="session.snapshot" :catalog="session.catalog" :library-available="libraryAvailable" :can-edit="session.canEdit" :busy="session.busy" :pending-retry="session.canRetry" :error="session.error" :submit="homeStartRun" :retry="homeRetryRun" @close="homeCloseRun" @unauthorized="session.disconnect()" />

    <ManagementPanel v-if="managementOpen && session.bootstrap" :key="JSON.stringify([session.connection?.baseUrl, session.bootstrap.identity.userId, session.workspace?.id])" :gateway="api" :workspace="session.workspace" :bootstrap="session.bootstrap" :snapshot="session.snapshot" @close="managementOpen = false" @changed="session.refreshManagement" @unauthorized="session.disconnect" @imported="homeOpenImport" />
    <NodeEvidenceEditor v-if="nodeEvidenceTarget" :key="nodeEvidenceDialogKey" :gateway="api" :context="nodeEvidenceContext" :node="nodeEvidenceTarget.node" :can-edit="session.canEdit && libraryAvailable" :busy="session.busy" :pending-retry="session.canRetry" :version-changed="nodeEvidenceChanged" :error="session.error ? uiReadErrorMessage(session.error.message) : null" @save="homeSaveNodeEvidence" @retry="homeRetryNodeEvidence" @close="homeCloseNodeEvidence" @unauthorized="session.disconnect" />
    <EvidenceCollectDialog :gateway="api" :context="collectionContext" :maps="session.mapList" :catalog="session.catalog" :open="collectionOpen" :claim="collectionTarget?.claim ?? null" :content="collectionTarget?.content ?? ''" :busy="library.busy.value" :error="library.error.value" :can-retry="library.canRetry.value" @close="homeCloseCollection" @submit="homeCollectEvidence" @retry="homeRetryCollection" @unauthorized="session.disconnect" />

    <dialog ref="workspaceDialog" class="create-dialog" aria-labelledby="workspace-dialog-title">
      <form @submit.prevent="homeCreateWorkspace">
        <h2 id="workspace-dialog-title">创建工作区</h2>
        <label>工作区名称<input v-model="workspaceName" :disabled="session.busy || session.canRetry" required maxlength="120" autofocus></label>
        <label>工作区说明<textarea v-model="workspaceDescription" :disabled="session.busy || session.canRetry" rows="3" /></label>
        <label>初始智能体配置<select v-model="workspaceAgentSource" :disabled="session.busy || session.canRetry"><option value="library">复制共享智能体库</option><option value="empty">空智能体配置</option></select></label>
        <p v-if="workspaceAgentSource === 'library'" class="muted">复制共享库的智能体和转换，之后保留独立副本。</p>
        <p v-else class="muted">保留基础数据类型，暂不配置智能体和转换。创建后可在工作台管理的定义中心和智能体配置中继续设置。</p>
        <p v-if="session.error" class="error" role="alert" :title="session.error.message">{{ uiReadErrorMessage(session.error.message) }}</p>
        <div class="dialog-actions"><button type="button" :disabled="session.busy" @click="workspaceDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryWorkspace">重试同一操作</button><button class="primary" :disabled="session.busy || session.canRetry || !workspaceName.trim()">{{ session.busy ? '创建中…' : '创建工作区' }}</button></div>
      </form>
    </dialog>
    <dialog ref="mapDialog" class="create-dialog" aria-labelledby="map-dialog-title">
      <form @submit.prevent="homeCreateMap"><h2 id="map-dialog-title">创建数据图</h2><label>数据图名称<input v-model="mapName" required maxlength="120" autofocus></label><p v-if="session.error" class="error" role="alert" :title="session.error.message">{{ uiReadErrorMessage(session.error.message) }}</p><div class="dialog-actions"><button type="button" @click="mapDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(mapDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !mapName.trim()">{{ session.busy ? '创建中…' : '创建数据图' }}</button></div></form>
    </dialog>
    <dialog ref="renameMapDialog" class="create-dialog" aria-labelledby="rename-map-dialog-title">
      <form @submit.prevent="homeRenameMap">
        <h2 id="rename-map-dialog-title">修改数据图名称</h2>
        <label>数据图名称<input v-model="renamedMapName" required maxlength="120" autofocus></label>
        <p v-if="mapActionChanged && !session.canRetry" class="muted">数据图已变化，请关闭后重新确认。</p>
        <p v-if="session.error" class="error" role="alert">{{ uiReadErrorMessage(session.error.message) }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="session.busy" @click="homeCloseMapActions">取消</button>
          <button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(renameMapDialog)">重试同一操作</button>
          <button class="primary" :disabled="session.busy || session.canRetry || !session.canRenameMap || mapActionChanged || !renamedMapName.trim()">保存名称</button>
        </div>
      </form>
    </dialog>
    <dialog ref="deleteMapDialog" class="create-dialog" aria-labelledby="delete-map-dialog-title">
      <form @submit.prevent="homeDeleteMap">
        <h2 id="delete-map-dialog-title">删除数据图</h2>
        <p>确认删除“{{ mapActionTarget?.name }}”（{{ mapActionTarget?.nodeCount }} 个节点）？此操作不可撤销。</p>
        <p class="muted">已收录到证据库的固定内容仍会保留。</p>
        <p v-if="mapActionChanged && !session.canRetry" class="muted">数据图已变化，请关闭后重新确认。</p>
        <p v-if="session.error" class="error" role="alert">{{ uiReadErrorMessage(session.error.message) }}</p>
        <div class="dialog-actions">
          <button type="button" :disabled="session.busy" @click="homeCloseMapActions">取消</button>
          <button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(deleteMapDialog)">重试同一操作</button>
          <button class="danger" :disabled="session.busy || session.canRetry || !session.canEdit || mapActionChanged">确认删除</button>
        </div>
      </form>
    </dialog>
    <dialog ref="nodeDialog" class="create-dialog" aria-labelledby="node-dialog-title" @cancel="homeCloseNodeDialog">
      <form @submit.prevent="homeCreateNode"><h2 id="node-dialog-title">{{ childTarget ? `新增${nodeType?.title ?? '后继'}` : '添加数据' }}</h2>
        <template v-if="childTarget">
          <p class="context-note">在{{ graphReadNodeType(childTarget.parent, session.catalog) }}下新增{{ nodeType?.title }}，保存后自动建立后继关系，并标记为人工创建。</p>
          <p class="context-note">父节点：{{ graphReadNodeText(childTarget.parent, session.catalog) }}</p>
        </template>
        <template v-else>
          <p class="context-note">独立创建数据；如需建立后继，请从父节点详情中新增。</p>
          <label>数据类型<select :value="nodeTypeKey" :disabled="session.busy || session.canRetry" @change="homeSelectNodeType(dataTypes.find(item => definitionKey(item) === ($event.target as HTMLSelectElement).value))"><option v-for="item in dataTypes" :key="definitionKey(item)" :value="definitionKey(item)">{{ item.title }} · 版本 {{ item.version }}</option></select></label>
        </template>
        <DataPayloadEditor v-if="nodeType" :schema="nodeType.schema" :references="nodeType.references" :nodes="session.snapshot?.nodes" :catalog="session.catalog" :field-labels="nodeType.presentation?.fieldLabels" :enum-labels="nodeType.presentation?.enumLabels" :model-value="nodePayload" :disabled="session.busy || session.canRetry" @update:model-value="nodePayload = $event as GraphPayload" />
        <fieldset v-if="childTarget && childSourceFields.length"><legend>来源定位（可选）</legend>
          <label v-if="childSourceFields.length > 1">原文字段<select v-model="childSourcePath" :disabled="session.busy || session.canRetry"><option v-for="field in childSourceFields" :key="field.path" :value="field.path">{{ field.label }}</option></select></label>
          <label>来源行号<input v-model="childSourceLines" :disabled="session.busy || session.canRetry" placeholder="例如：1,3 或 5-7"></label>
        </fieldset>
        <p v-if="nodeFormError || session.error" class="error" role="alert">{{ uiReadErrorMessage(nodeFormError || session.error?.message || '') }}</p>
        <div class="dialog-actions"><button type="button" :disabled="session.busy" @click="homeCloseNodeDialog">取消</button><button v-if="session.selectedBranchGrant && session.error?.code === 'BRANCH_BUSY'" type="button" :disabled="session.busy || session.canRetry" @click="session.releaseBranch()">释放当前分支编辑权</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(nodeDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || session.canRetry || !session.canEdit || !nodeType">{{ session.busy ? '保存中…' : childTarget ? `保存${nodeType?.title}` : '添加数据' }}</button></div>
      </form>
    </dialog>
  </main>
</template>

<style scoped>
/* 组织登录页、工作台三栏、图标签和创建对话框，并适配窄屏与桌面标题栏。 */
.advanced-connection{border-top:1px solid var(--border-subtle);padding-top:14px}.advanced-connection summary{cursor:pointer;color:var(--text-muted);font-size:12px}.advanced-connection form{display:grid;gap:14px;padding-top:14px}
.local-divider{width:100%;border:0;border-top:1px solid var(--border);margin:12px 0}
.run-selector{padding:10px 14px;border-bottom:1px solid var(--border-subtle)}.run-selector select{padding:6px;font-size:11px}
.create-dialog select{padding:7px}
.client-root{height:100%;display:flex;flex-direction:column}.workbench{flex:1}.muted{color:var(--text-muted)}.error{color:var(--danger);line-height:1.6}.login-screen{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:26px;padding:32px;background:var(--bg-viewport)}.login-brand{margin-top:auto;flex-shrink:0;display:flex;align-items:center;gap:16px}.login-brand h1{font-size:28px;letter-spacing:5px}.login-brand p{color:var(--text-muted);margin-top:5px;font-size:13px}.brand-mark{display:grid;place-items:center;width:48px;height:48px;color:#fff;background:var(--accent);font-family:var(--content-font);font-size:28px;border-radius:var(--radius-control)}.brand-mark.small{width:24px;height:24px;font-size:17px;border-radius:var(--radius-control)}.login-card{margin-bottom:auto;flex-shrink:0;width:min(100%,420px);padding:26px;background:var(--bg-panel);border:1px solid var(--border-subtle);display:grid;gap:16px;box-shadow:none}.login-card h2{font-size:18px}.login-card input{font-size:13px;padding:9px 10px}.login-card p{line-height:1.6}.login-button{padding:10px;font-size:13px}.check{display:flex!important;align-items:center;gap:8px}.session-note{font-size:11px}label{display:grid;gap:7px;color:var(--text);font-size:12px}.client-header{height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px;background:var(--bg-header);border-bottom:1px solid var(--border);flex-shrink:0}.desktop .client-header{padding-left:calc(var(--traffic-light-inset) + 8px);-webkit-app-region:drag}.client-header button{-webkit-app-region:no-drag}.brand,.account{display:flex;align-items:center;gap:10px}.brand strong{font-size:14px}.server{font-size:10px;color:var(--text-muted);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notice{display:flex;align-items:center;gap:10px;padding:8px 12px;background:var(--bg-warning);border-bottom:1px solid var(--border);color:var(--warning)}.notice span{flex:1}.pane-heading,.list-heading{display:flex;justify-content:space-between;align-items:center;padding:3px 8px}.pane-heading{height:100%;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.pane-heading button,.list-heading button{padding:0 5px;min-height:20px}.workspace-select{padding:10px 8px;border-bottom:1px solid var(--border-subtle)}.workspace-select select{padding:5px;font-size:12px}.workspace-meta{margin-top:7px;font-size:10px}.list-heading{padding-top:12px;color:var(--text-muted);font-weight:600}.map-list{display:flex;flex-direction:column;overflow:auto;padding:4px;gap:2px}.map-item{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:5px;border-color:transparent;padding:9px 8px;min-height:48px}.map-item.selected{background:var(--bg-nav-selected);border-color:var(--border)}.map-name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;max-width:100%;font-size:12px}.map-item small{color:var(--text-muted);font-weight:normal}.sidebar-empty{padding:12px;color:var(--text-muted);line-height:1.8}.sidebar-empty button{margin-top:10px}.tabs{display:flex;height:100%;overflow:auto;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.tab{display:flex;border-right:1px solid var(--border-subtle);min-width:90px;max-width:210px;flex-shrink:0}.tab.active{background:var(--bg-viewport);box-shadow:none;border-top:2px solid var(--accent)}.tab button{border:0;background:transparent;border-radius:0;min-height:26px}.tab-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}.tab-close{padding:0 6px;color:var(--text-muted)}.tab-placeholder{padding:7px 10px;color:var(--text-muted)}.graph-area{height:100%;display:flex;flex-direction:column;min-height:0}.graph-toolbar{min-height:38px;border-bottom:1px solid var(--border-subtle);display:flex;gap:10px;align-items:center;padding:6px 10px;background:var(--bg-viewport)}.graph-toolbar strong{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar-actions{display:flex;gap:5px;margin-left:auto}.center-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;min-height:100%;padding:28px}.center-empty h2{font-size:20px;font-family:var(--content-font);font-weight:500}.center-empty p{font-size:13px;line-height:1.8;color:var(--text-muted)}.center-empty button{padding:7px 16px}.inspector-scroll{height:100%;overflow:auto}.inspector-empty{padding:18px 14px;color:var(--text-muted);line-height:1.8}.inspector-empty h3{font-size:12px;margin-bottom:10px;color:var(--text)}.client-footer{height:26px;display:flex;align-items:center;gap:7px;flex-shrink:0;padding:0 10px;background:var(--bg-header);border-top:1px solid var(--border);font-size:10px;color:var(--text-muted)}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--success)}.status-dot.offline{background:var(--warning)}.footer-end{margin-left:auto}.create-dialog{margin:auto;width:min(480px,calc(100vw - 40px));max-height:85vh;overflow:auto;padding:22px;border:1px solid var(--border);border-radius:var(--radius-dialog);background:var(--bg-panel);color:var(--text);box-shadow:0 6px 24px #00000014}.create-dialog::backdrop{background:#00000024}.create-dialog form{display:grid;gap:16px}.create-dialog h2{font-size:17px}.create-dialog p{line-height:1.6}.create-dialog input,.create-dialog textarea{padding:7px;font-size:13px;line-height:1.5}.dialog-actions{display:flex;gap:8px;justify-content:flex-end}.dialog-actions button{padding:6px 12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:1050px){.server,.brand>.muted{display:none}.graph-toolbar{flex-wrap:wrap}.toolbar-actions{margin-left:auto}.graph-toolbar strong{max-width:150px}}@media(max-width:760px){.login-screen{padding:16px}.login-card{padding:20px}.client-header{padding:0 8px}}
.footer-sync{flex:none;white-space:nowrap}
.footer-end{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.workbench{position:relative}
.workspace-notices{position:absolute;z-index:20;bottom:34px;right:12px;width:min(460px,calc(100% - 24px));max-height:min(35%,240px);overflow:auto;pointer-events:none}
.workspace-notices>.notice{pointer-events:auto;flex-wrap:wrap;flex:none;gap:8px;border:1px solid var(--border);box-shadow:0 3px 12px #00000012}
.workspace-notices>.notice+.notice{margin-top:6px}
.workspace-notices>.notice span{min-width:0;overflow-wrap:anywhere}
.workspace-notices>.notice button{flex:none;white-space:nowrap}
.client-footer>.error{min-width:0;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style>
