<!-- 工作台首页：连接会话，组织工作区与图标签、画布、详情和创建对话框。 -->
<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LocalServiceState } from '../../../contracts/desktop'
import type { DataTypeDefinition } from '../../../contracts/data-definition'
import type { GraphPayload, GraphRun } from '../../../contracts/graph'
import AppShell from '../components/shell/AppShell.vue'
import GraphCanvas from '../features/graph/GraphCanvas.vue'
import NodeInspector from '../features/graph/NodeInspector.vue'
import DataPayloadEditor from '../features/graph/DataPayloadEditor.vue'
import RunReview from '../features/run/RunReview.vue'
import ManagementPanel from '../features/management/ManagementPanel.vue'
import { graphCreateRunPlan, graphReadNodeText, graphReadNodeType } from '../features/graph/graph-layout'
import { definitionKey, payloadCreateInitial } from '../features/graph/data-payload'
import { useClientStore } from '../state/client-session'
import { api } from '../transport/client-gateway'

const session = useClientStore()
const desktop = typeof window !== 'undefined' && !!window.chongmingClient
const localState = ref<LocalServiceState>({ status: 'stopped' })
let stopLocalState = () => {
  // 在本机状态监听建立前提供可安全调用的空清理函数。
}
const baseUrl = ref('')
const token = ref('')
const remember = ref(false)
const managementOpen = ref(false)
const workspaceDialog = ref<HTMLDialogElement | null>(null)
const mapDialog = ref<HTMLDialogElement | null>(null)
const nodeDialog = ref<HTMLDialogElement | null>(null)
const runDialog = ref<HTMLDialogElement | null>(null)
const workspaceName = ref(''), workspaceDescription = ref(''), mapName = ref('')
const nodeTypeKey = ref(''), nodePayload = ref<GraphPayload>({})
const runTransitionKey = ref(''), runMode = ref<GraphRun['mode']>('human-in-loop')
const runNodeIds = ref<string[]>([]), runRegenerate = ref(false)
const dataTypes = computed(() => session.catalog?.dataTypes ?? [])
const nodeType = computed(() => dataTypes.value.find(type => definitionKey(type) === nodeTypeKey.value) ?? dataTypes.value[0])
const runnableTransitions = computed(() => (session.catalog?.transitions ?? []).filter(transition =>
  transition.ports.input.length === 1 && transition.ports.context.every(port => port.count.min === 0)))
const runTransition = computed(() => runnableTransitions.value.find(transition => definitionKey(transition) === runTransitionKey.value) ?? runnableTransitions.value[0])
const runNodes = computed(() =>
  session.snapshot?.nodes.filter(node => node.typeId === runTransition.value?.ports.input[0]?.inputType.id
    && node.typeVersion === runTransition.value?.ports.input[0]?.inputType.version) ?? [])
const runSelectionChanged = computed(() =>
  /* 检查已选运行节点是否因图或目标变化而失效。 */
  runNodeIds.value.some(id =>
    /* 检测所选标识是否已经不在可运行节点集合中。 */
    !runNodes.value.some(node =>
      /* 匹配仍可作为运行起点的节点标识。 */
      node.id === id)))
const runCardinalityError = computed(() => {
  const transition = runTransition.value, count = runNodeIds.value.length
  if (!transition) return ''
  const port = transition.ports.input[0]
  if (transition.cardinality !== 'N:1' && transition.cardinality !== 'N:M') return ''
  return count < port.count.min || count > port.count.max ? `这个转换需要选择 ${port.count.min}–${port.count.max} 项输入。` : ''
})
function homeSelectRun(event: Event) {
  void session.selectRun((event.target as HTMLSelectElement).value || null)
}
const roleLabel = computed(() =>
  /* 把当前工作区角色转换为中文展示名称。 */
  ({ owner: '所有者', editor: '编辑者', viewer: '只读成员' })[session.workspace?.role ?? 'viewer'])
const connectedAddress = computed(() => {
  // 从连接地址提取主机部分，地址无效时不展示。
  try { return new URL(session.connection?.baseUrl ?? '').host } catch { return '' }
})
const activeTitle = computed(() =>
  /* 查找当前图名称作为画布区域标题。 */
  session.mapList.find(map =>
    /* 匹配当前打开的数据图。 */
    map.id === session.activeMapId)?.name ?? '数据图')
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
    nodeTypeKey.value = ''; nodePayload.value = {}
  workspaceDialog.value?.close(); mapDialog.value?.close(); nodeDialog.value?.close(); runDialog.value?.close()
})
watch(() => /* 观察当前图切换以清理图相关对话框。 */ session.activeMapId, () => {
  // 切图时关闭运行与节点对话框并清空批量选择。
  runDialog.value?.close(); runNodeIds.value = []; nodeDialog.value?.close()
})
watch(runTransitionKey, () => {
  // 转换变化时移除已不符合输入类型的起点。
  runNodeIds.value = runNodeIds.value.filter(id =>
    /* 仅保留仍在可运行节点集合中的选择。 */
    runNodes.value.some(node =>
      /* 按标识匹配可运行节点。 */
      node.id === id))
})
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
  // 卸载页面时移除本机状态监听并释放客户端会话。
  stopLocalState(); session.dispose()
})

async function homeConnectSession() {
  // 取出并立即清空表单令牌，使用当前连接参数登录。
  const value = token.value
  token.value = ''
  await session.connect({ baseUrl: baseUrl.value, token: value, remember: remember.value })
}
function homeOpenWorkspaceDialog() {
  // 清除旧操作错误并打开创建工作区对话框。
  session.clearError(); workspaceDialog.value?.showModal()
}
function homeOpenMapDialog() {
  // 清除旧操作错误并打开创建数据图对话框。
  session.clearError(); mapDialog.value?.showModal()
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
  // 使用目录中的第一个精确类型建立通用 payload 草稿。
  session.clearError(); homeSelectNodeType(dataTypes.value[0])
  nodeDialog.value?.showModal()
}
async function homeCreateWorkspace() {
  // 创建工作区，成功后关闭对话框并清空资料草稿。
  if (await session.createWorkspace(workspaceName.value.trim(), workspaceDescription.value)) {
    workspaceDialog.value?.close(); workspaceName.value = ''; workspaceDescription.value = ''
  }
}
async function homeCreateMap() {
  // 创建数据图，成功后关闭对话框并清空名称。
  if (await session.createMap(mapName.value.trim())) { mapDialog.value?.close(); mapName.value = '' }
}
async function homeCreateNode() {
  // 按精确类型和通用 payload 创建数据实例。
  const definition = nodeType.value
  if (!definition) return
  const created = await session.createNode(definition, structuredClone(nodePayload.value))
  if (created) {
    nodeDialog.value?.close(); nodeTypeKey.value = ''; nodePayload.value = {}
  }
}
function homeOpenRunDialog() {
  // 选择第一个可用转换，默认选中它接受的全部输入节点。
  session.clearError(); runTransitionKey.value = runnableTransitions.value[0] ? definitionKey(runnableTransitions.value[0]) : ''; runRegenerate.value = false
  runNodeIds.value = runNodes.value.map(node => /* 提取可运行节点标识作为默认全选范围。 */ node.id)
  runDialog.value?.showModal()
}
async function homeStartRun() {
  // 确认批量起点仍有效后，从所选转换构造单步有限计划。
  const transition = runTransition.value
  if (!transition || runSelectionChanged.value || runCardinalityError.value || !runNodeIds.value.length) return
  if (await session.startRun({ scope: { nodeIds: [...runNodeIds.value] }, plan: graphCreateRunPlan(transition, runNodeIds.value), mode: runMode.value, regenerate: runRegenerate.value })) runDialog.value?.close()
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
</script>

<template>
  <!-- 未登录时展示连接表单；登录后按外壳插槽组织工作区、图画布和详情。 -->
  <main class="client-root" :class="{ desktop }">
    <section v-if="!session.bootstrap" class="login-screen" aria-label="连接重明服务">
      <div class="login-brand"><span class="brand-mark">重</span><div><h1>重明</h1><p>把事实、来源与核查结果连接起来</p></div></div>
      <form class="login-card" @submit.prevent="homeConnectSession">
        <template v-if="desktop">
          <h2>在这台电脑上使用重明</h2>
          <p class="muted">资料保存在本机，模型和工具照常联网。</p>
          <button class="primary login-button" type="button" :disabled="session.connecting || session.initializing" @click="session.connectLocal()">
            {{ localState.status === 'starting' ? '正在启动本机服务…' : localState.status === 'failed' ? '重试本机服务' : '在本机运行' }}
          </button>
          <p v-if="localState.message" class="error" role="alert">{{ localState.message }}<small v-if="localState.errorId">错误编号：{{ localState.errorId }}</small></p>
          <hr class="local-divider">
        </template>
        <h2>{{ desktop ? '连接已有服务' : '连接工作区' }}</h2>
        <p class="muted">使用管理员提供的服务地址和用户访问令牌登录。</p>
        <label>服务地址<input v-model="baseUrl" type="url" autocomplete="url" required placeholder="http://127.0.0.1:4320" :disabled="session.connecting || session.initializing"></label>
        <label>用户访问令牌<input v-model="token" type="password" autocomplete="off" required spellcheck="false" placeholder="粘贴用户令牌" :disabled="session.connecting || session.initializing"></label>
        <label v-if="session.connection?.canRemember" class="check"><input v-model="remember" type="checkbox">在这台设备上记住登录</label>
        <p v-else class="muted session-note">登录信息仅在本次会话中使用。</p>
        <p v-if="session.error" class="error" role="alert">{{ session.error.message }}<small>错误编号：{{ session.error.errorId }}</small></p>
        <button class="primary login-button" type="submit" :disabled="session.connecting || session.initializing || !token.trim() || !baseUrl.trim()">
          {{ session.initializing ? '恢复连接…' : session.connecting ? '正在连接…' : '连接' }}
        </button>
      </form>
    </section>

    <AppShell v-else class="workbench">
      <template #top>
        <header class="client-header">
          <div class="brand"><span class="brand-mark small">重</span><strong>重明</strong><span class="muted">事实核查工作台</span></div>
        <div class="account"><span v-if="session.connection?.mode === 'local'" class="muted">本机模式</span><button v-if="desktop && (session.connection?.mode !== 'local' || localState.status === 'failed')" :disabled="session.connecting" @click="session.connectLocal()">{{ localState.status === 'failed' ? '重启本机服务' : '回到本机' }}</button><span class="server" :title="session.connection?.baseUrl">{{ connectedAddress }}</span><span>{{ session.bootstrap.identity.displayName }}</span><button :disabled="!session.online" @click="managementOpen = true">管理工作台</button><button @click="session.disconnect()">退出登录</button></div>
        </header>
        <div v-if="desktop && localState.status === 'failed' && session.connection?.mode === 'local'" class="notice" role="alert">{{ localState.message }}</div>
        <div v-if="session.error" class="notice" role="alert">
          <span>{{ session.error.message }} · 错误编号：{{ session.error.errorId }}</span><button v-if="session.canRetry" :disabled="session.busy" @click="session.retry()">重试同一操作</button><button aria-label="关闭提示" @click="session.clearError()">×</button>
        </div>
      </template>
      <template #left-head><div class="pane-heading"><strong>工作区</strong><button title="创建工作区" aria-label="创建工作区" @click="homeOpenWorkspaceDialog">＋</button></div></template>
      <template #left>
        <div class="workspace-select">
          <label class="sr-only" for="workspace-select">当前工作区</label>
          <select id="workspace-select" :value="session.workspace?.id ?? ''" @change="session.selectWorkspace(($event.target as HTMLSelectElement).value)">
            <option disabled value="">选择工作区</option>
            <option v-for="item in session.workspaces" :key="item.id" :value="item.id">{{ item.name }}</option>
          </select>
          <p v-if="session.workspace" class="muted workspace-meta">{{ roleLabel }} · {{ session.mapList.length }} 张图</p>
        </div>
        <div v-if="!session.workspaces.length" class="sidebar-empty"><p>还没有工作区。</p><button class="primary" @click="homeOpenWorkspaceDialog">创建第一个工作区</button></div>
        <template v-else-if="session.workspace">
          <div class="list-heading"><span>数据图</span><button :disabled="!session.canEdit || session.busy" aria-label="创建数据图" @click="homeOpenMapDialog">＋</button></div>
          <nav class="map-list" aria-label="数据图列表">
            <button v-for="item in session.mapList" :key="item.id" class="map-item" :class="{ selected: item.id === session.activeMapId }" @click="session.openMap(item.id)">
              <span class="map-name">{{ item.name }}</span><small>{{ Object.keys(item.typeCounts).length }} 种数据 · {{ item.nodeCount }} 个节点</small>
            </button>
          </nav>
          <p v-if="!session.mapList.length" class="sidebar-empty">这里还没有数据图。{{ session.canEdit ? '创建一张图，记录第一个事实。' : '等待编辑者创建数据图。' }}</p>
        </template>
      </template>
      <template #center-head>
        <nav class="tabs" aria-label="打开的数据图">
          <div v-for="id in session.openMapIds" :key="id" class="tab" :class="{ active: id === session.activeMapId }">
            <button class="tab-title" @click="session.openMap(id)">{{ homeReadMapTitle(id) }}</button><button class="tab-close" :aria-label="`关闭图 ${homeReadMapTitle(id)}`" title="关闭标签，不取消核查" @click="session.closeMap(id)">×</button>
          </div>
          <span v-if="!session.openMapIds.length" class="tab-placeholder">核查画布</span>
        </nav>
      </template>
      <template #center>
        <section v-if="session.snapshot" class="graph-area" :aria-label="activeTitle">
          <div class="graph-toolbar"><strong>{{ session.snapshot.name }}</strong><span class="muted">{{ session.snapshot.nodes.length }} 个节点</span><div class="toolbar-actions">
            <button :disabled="!session.canEdit || session.busy || !dataTypes.length" @click="homeOpenNodeDialog">＋ 数据</button>
            <button class="primary" :disabled="!session.canEdit || session.busy || !runnableTransitions.length" @click="homeOpenRunDialog">运行转换</button>
            <button :disabled="session.loading" @click="session.refresh()">刷新</button>
          </div></div>
          <GraphCanvas :activities="session.activities" :snapshot="session.snapshot" :catalog="session.catalog" :selected-id="session.selectedId" @select="session.selectNode" />
        </section>
        <div v-else class="center-empty">
          <template v-if="session.loading"><h2>正在读取数据图…</h2></template>
          <template v-else-if="!session.workspace"><h2>从一个工作区开始</h2><p>工作区保存成员、数据图和核查配置。</p><button class="primary" @click="homeOpenWorkspaceDialog">创建工作区</button></template>
          <template v-else><h2>让事实有据可循</h2><p>打开左侧数据图，或创建一张新图。<br>加入新闻与事实后，可以选择事实开始核查。</p><button v-if="session.canEdit" class="primary" @click="homeOpenMapDialog">创建数据图</button></template>
        </div>
      </template>
      <template #right>
        <div class="inspector-scroll">
          <template v-if="session.snapshot">
            <label v-if="session.snapshot.runs.length" class="run-selector">运行<select :value="session.selectedRunId ?? ''" @change="homeSelectRun"><option v-for="run in session.snapshot.runs" :key="run.id" :value="run.id">{{ run.id.slice(0, 8) }} · {{ run.status }} · {{ run.scope.nodeIds.length }} 个节点</option></select></label>
            <RunReview :activities="session.activities" :snapshot="session.snapshot" :run="session.selectedRun" :leases-required="session.clientLeasesRequired" :can-edit="session.canEdit" :control="session.selectedRunControl" :busy="session.busy" @answer="session.answerReview" @cancel="session.cancelRun" @pause="session.pauseRun" @resume="session.resumeRun" @claim="session.claimRunControl()" @release="session.releaseRunControl()" />
            <NodeInspector :snapshot="session.snapshot" :branch="session.selectedBranch" :grant="session.selectedBranchGrant" :branch-loading="session.branchLoading" :catalog="session.catalog" :selected-id="session.selectedId" :leases-required="session.clientLeasesRequired" :can-edit="session.canEdit" :busy="session.busy" @save="session.saveNode" @remove="session.removeNode" @run="session.startRun" @claim="session.claimBranch()" @release="session.releaseBranch()" />
          </template>
          <div v-else class="inspector-empty"><h3>节点详情</h3><p>选择图中的节点，查看内容与来源。</p></div>
        </div>
      </template>
      <template #footer><footer class="client-footer"><span class="status-dot" :class="{ offline: !session.online }" />{{ syncLabel }}<span v-if="session.streamError" class="error">{{ session.streamError }}</span><span class="footer-end">{{ session.workspace?.name ?? '未选择工作区' }}<template v-if="session.snapshot"> · 图同步序号 {{ session.snapshot.revision }}</template></span></footer></template>
    </AppShell>

    <ManagementPanel v-if="managementOpen && session.bootstrap" :key="`${session.bootstrap.identity.userId}:${session.workspace?.id ?? ''}`" :gateway="api" :workspace="session.workspace" :bootstrap="session.bootstrap" :snapshot="session.snapshot" @close="managementOpen = false" @changed="session.refreshManagement" @unauthorized="session.disconnect" @imported="homeOpenImport" />

    <dialog ref="workspaceDialog" class="create-dialog" aria-labelledby="workspace-dialog-title">
      <form @submit.prevent="homeCreateWorkspace"><h2 id="workspace-dialog-title">创建工作区</h2><p class="muted">使用共享 Agent 库作为初始配置，之后保留独立副本。</p><label>工作区名称<input v-model="workspaceName" required maxlength="120" autofocus></label><label>工作区说明<textarea v-model="workspaceDescription" rows="3" /></label><p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="workspaceDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(workspaceDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !workspaceName.trim()">{{ session.busy ? '创建中…' : '创建工作区' }}</button></div></form>
    </dialog>
    <dialog ref="mapDialog" class="create-dialog" aria-labelledby="map-dialog-title">
      <form @submit.prevent="homeCreateMap"><h2 id="map-dialog-title">创建数据图</h2><label>数据图名称<input v-model="mapName" required maxlength="120" autofocus></label><p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="mapDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(mapDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !mapName.trim()">{{ session.busy ? '创建中…' : '创建数据图' }}</button></div></form>
    </dialog>
    <dialog ref="nodeDialog" class="create-dialog" aria-labelledby="node-dialog-title">
      <form @submit.prevent="homeCreateNode"><h2 id="node-dialog-title">添加数据</h2>
        <label>数据类型<select :value="nodeTypeKey" :disabled="session.busy" @change="homeSelectNodeType(dataTypes.find(item => definitionKey(item) === ($event.target as HTMLSelectElement).value))"><option v-for="item in dataTypes" :key="definitionKey(item)" :value="definitionKey(item)">{{ item.title }} · v{{ item.version }}</option></select></label>
        <DataPayloadEditor v-if="nodeType" :schema="nodeType.schema" :model-value="nodePayload" :disabled="session.busy" @update:model-value="nodePayload = $event as GraphPayload" />
        <p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="nodeDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(nodeDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !session.canEdit || !nodeType">{{ session.busy ? '保存中…' : '添加数据' }}</button></div></form>
    </dialog>
    <dialog ref="runDialog" class="create-dialog" aria-labelledby="run-dialog-title">
      <form @submit.prevent="homeStartRun">
        <h2 id="run-dialog-title">运行数据转换</h2>
        <label>转换<select v-model="runTransitionKey" :disabled="session.busy"><option v-for="item in runnableTransitions" :key="definitionKey(item)" :value="definitionKey(item)">{{ item.title }}</option></select></label>
        <label>处理方式<select v-model="runMode" :disabled="session.busy"><option value="human-in-loop">人工审核角度与结果</option><option value="auto">自动处理并保存结果</option></select></label>
        <div class="run-node-heading"><strong>选择起点 · {{ runNodeIds.length }} / {{ runNodes.length }}</strong><button type="button" :disabled="session.busy" @click="runNodeIds = runNodes.map(node => node.id)">全选符合条件的节点</button><button type="button" :disabled="session.busy" @click="runNodeIds = []">清空</button></div>
        <div class="run-node-list"><label v-for="node in runNodes" :key="node.id" class="check"><input v-model="runNodeIds" type="checkbox" :value="node.id" :disabled="session.busy"><span><small>{{ graphReadNodeType(node, session.catalog) }}</small>{{ graphReadNodeText(node, session.catalog) }}</span></label></div>
        <p v-if="!runNodes.length" class="muted">图中没有符合这个转换输入类型的数据。</p>
        <p v-if="runSelectionChanged" class="error">所选节点已变化，请重新选择处理范围。</p>
        <p v-if="runCardinalityError" class="error">{{ runCardinalityError }}</p>
        <label class="check"><input v-model="runRegenerate" type="checkbox" :disabled="session.busy">重新生成已有结果</label>
        <p class="muted">一次运行使用冻结的转换、类型和 Agent 定义；默认复用规格与输入版本完全一致的有效结果。</p>
        <p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p>
        <div class="dialog-actions"><button type="button" @click="runDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(runDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !session.canEdit || !runNodeIds.length || runSelectionChanged || !!runCardinalityError">开始处理</button></div>
      </form>
    </dialog>
  </main>
</template>

<style scoped>
/* 组织登录页、工作台三栏、图标签和创建对话框，并适配窄屏与桌面标题栏。 */
.local-divider{width:100%;border:0;border-top:1px solid var(--border);margin:12px 0}
.run-selector{padding:10px 14px;border-bottom:1px solid var(--border-subtle)}.run-selector select{padding:6px;font-size:11px}
.run-node-heading{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.run-node-heading strong{margin-right:auto}.run-node-list{max-height:230px;overflow:auto;display:grid;gap:9px}.run-node-list label{align-items:flex-start!important;padding:8px;border:1px solid var(--border-subtle);line-height:1.6}.run-node-list input{margin-top:4px;flex-shrink:0}.run-node-list span{overflow-wrap:anywhere}.run-node-list small{color:var(--text-muted);margin-right:8px}.create-dialog select{padding:7px}
.client-root{height:100%;display:flex;flex-direction:column}.workbench{flex:1}.muted{color:var(--text-muted)}.error{color:var(--danger);line-height:1.6}.login-screen{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:26px;padding:32px;background:var(--bg-viewport)}.login-brand{margin-top:auto;flex-shrink:0;display:flex;align-items:center;gap:16px}.login-brand h1{font-size:28px;letter-spacing:5px}.login-brand p{color:var(--text-muted);margin-top:5px;font-size:13px}.brand-mark{display:grid;place-items:center;width:48px;height:48px;color:#fff;background:var(--accent);font-family:var(--content-font);font-size:28px;border-radius:5px}.brand-mark.small{width:24px;height:24px;font-size:17px;border-radius:3px}.login-card{margin-bottom:auto;flex-shrink:0;width:min(100%,420px);padding:26px;background:var(--bg-panel);border:1px solid var(--border-subtle);display:grid;gap:16px;box-shadow:0 8px 30px #00000008}.login-card h2{font-size:18px}.login-card input{font-size:13px;padding:9px 10px}.login-card p{line-height:1.6}.login-button{padding:10px;font-size:13px}.check{display:flex!important;align-items:center;gap:8px}.session-note{font-size:11px}label{display:grid;gap:7px;color:var(--text);font-size:12px}.client-header{height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px;background:var(--bg-header);border-bottom:1px solid var(--border);flex-shrink:0}.desktop .client-header{padding-left:calc(var(--traffic-light-inset) + 8px);-webkit-app-region:drag}.client-header button{-webkit-app-region:no-drag}.brand,.account{display:flex;align-items:center;gap:10px}.brand strong{font-size:14px}.server{font-size:10px;color:var(--text-muted);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notice{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#fff2e4;border-bottom:1px solid #d9b287;color:#784e18}.notice span{flex:1}.pane-heading,.list-heading{display:flex;justify-content:space-between;align-items:center;padding:3px 8px}.pane-heading{height:100%;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.pane-heading button,.list-heading button{padding:0 5px;min-height:20px}.workspace-select{padding:10px 8px;border-bottom:1px solid var(--border-subtle)}.workspace-select select{padding:5px;font-size:12px}.workspace-meta{margin-top:7px;font-size:10px}.list-heading{padding-top:12px;color:var(--text-muted);font-weight:600}.map-list{display:flex;flex-direction:column;overflow:auto;padding:4px;gap:2px}.map-item{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:5px;border-color:transparent;padding:9px 8px;min-height:48px}.map-item.selected{background:#fff1e0;border-color:#e0bd92}.map-name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;max-width:100%;font-size:12px}.map-item small{color:var(--text-muted);font-weight:normal}.sidebar-empty{padding:12px;color:var(--text-muted);line-height:1.8}.sidebar-empty button{margin-top:10px}.tabs{display:flex;height:100%;overflow:auto;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.tab{display:flex;border-right:1px solid var(--border-subtle);min-width:90px;max-width:210px;flex-shrink:0}.tab.active{background:var(--bg-viewport);box-shadow:inset 0 2px var(--accent)}.tab button{border:0;background:transparent;border-radius:0;min-height:26px}.tab-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}.tab-close{padding:0 6px;color:var(--text-muted)}.tab-placeholder{padding:7px 10px;color:var(--text-muted)}.graph-area{height:100%;display:flex;flex-direction:column;min-height:0}.graph-toolbar{min-height:38px;border-bottom:1px solid var(--border-subtle);display:flex;gap:10px;align-items:center;padding:6px 10px;background:var(--bg-viewport)}.graph-toolbar strong{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar-actions{display:flex;gap:5px;margin-left:auto}.center-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;min-height:100%;padding:28px}.center-empty h2{font-size:20px;font-family:var(--content-font);font-weight:500}.center-empty p{font-size:13px;line-height:1.8;color:var(--text-muted)}.center-empty button{padding:7px 16px}.inspector-scroll{height:100%;overflow:auto}.inspector-empty{padding:18px 14px;color:var(--text-muted);line-height:1.8}.inspector-empty h3{font-size:12px;margin-bottom:10px;color:var(--text)}.client-footer{height:26px;display:flex;align-items:center;gap:7px;flex-shrink:0;padding:0 10px;background:var(--bg-header);border-top:1px solid var(--border);font-size:10px;color:var(--text-muted)}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--success)}.status-dot.offline{background:var(--warning)}.footer-end{margin-left:auto}.create-dialog{margin:auto;width:min(480px,calc(100vw - 40px));max-height:85vh;overflow:auto;padding:22px;border:1px solid var(--border);border-radius:4px;background:var(--bg-panel);color:var(--text);box-shadow:0 12px 50px #0003}.create-dialog::backdrop{background:#0005}.create-dialog form{display:grid;gap:16px}.create-dialog h2{font-size:17px}.create-dialog p{line-height:1.6}.create-dialog input,.create-dialog textarea{padding:7px;font-size:13px;line-height:1.5}.dialog-actions{display:flex;gap:8px;justify-content:flex-end}.dialog-actions button{padding:6px 12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:1050px){.server,.brand>.muted{display:none}.graph-toolbar{flex-wrap:wrap}.toolbar-actions{margin-left:auto}.graph-toolbar strong{max-width:150px}}@media(max-width:760px){.login-screen{padding:16px}.login-card{padding:20px}.client-header{padding:0 8px}}
</style>
