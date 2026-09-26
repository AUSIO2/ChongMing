<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { LocalServiceState } from '../../../contracts/desktop'
import type { GraphRun } from '../../../contracts/graph'
import AppShell from '../components/shell/AppShell.vue'
import GraphCanvas from '../features/graph/GraphCanvas.vue'
import NodeInspector from '../features/graph/NodeInspector.vue'
import RunReview from '../features/run/RunReview.vue'
import ManagementPanel from '../features/management/ManagementPanel.vue'
import { GRAPH_KIND_LABELS, graphCanProcessNode, graphReadNodeText } from '../features/graph/graph-layout'
import { useClientStore } from '../state/client-session'
import { api } from '../transport/client-gateway'

const session = useClientStore()
const desktop = typeof window !== 'undefined' && !!window.chongmingClient
const localState = ref<LocalServiceState>({ status: 'stopped' })
let stopLocalState = () => {}
const baseUrl = ref('')
const token = ref('')
const remember = ref(false)
const managementOpen = ref(false)
const workspaceDialog = ref<HTMLDialogElement | null>(null)
const mapDialog = ref<HTMLDialogElement | null>(null)
const nodeDialog = ref<HTMLDialogElement | null>(null)
const runDialog = ref<HTMLDialogElement | null>(null)
const workspaceName = ref(''), workspaceDescription = ref(''), mapName = ref('')
const nodeKind = ref<'claim' | 'news' | 'source'>('claim'), nodeContent = ref(''), nodeCategory = ref('')
const runUntil = ref<GraphRun['until']>('verified'), runMode = ref<GraphRun['mode']>('human-in-loop')
const runNodeIds = ref<string[]>([]), runRegenerate = ref(false)
const runNodes = computed(() => session.snapshot?.nodes.filter(node => graphCanProcessNode(node, runUntil.value)) ?? [])
const runSelectionChanged = computed(() => runNodeIds.value.some(id => !runNodes.value.some(node => node.id === id)))
const roleLabel = computed(() => ({ owner: '所有者', editor: '编辑者', viewer: '只读成员' })[session.workspace?.role ?? 'viewer'])
const connectedAddress = computed(() => {
  try { return new URL(session.connection?.baseUrl ?? '').host } catch { return '' }
})
const activeTitle = computed(() => session.mapList.find(map => map.id === session.activeMapId)?.name ?? '数据图')
const syncLabel = computed(() => session.streamState === 'live' ? '实时同步' : session.streamState === 'connecting' ? '正在连接实时更新' : session.streamState === 'reconnecting' ? '实时连接中断 · 自动重连' : session.streamError ? '连接中断' : session.lastSync ? '已同步' : session.bootstrap ? '已连接' : '未连接')

watch(() => session.connection?.baseUrl, value => { if (value) baseUrl.value = value }, { immediate: true })
watch(() => session.bootstrap?.identity.userId, () => {
  managementOpen.value = false
  token.value = ''; workspaceName.value = ''; workspaceDescription.value = ''; mapName.value = ''
  nodeContent.value = ''; nodeCategory.value = ''
  workspaceDialog.value?.close(); mapDialog.value?.close(); nodeDialog.value?.close(); runDialog.value?.close()
})
watch(() => session.activeMapId, () => { runDialog.value?.close(); runNodeIds.value = []; nodeDialog.value?.close() })
watch(runUntil, () => { runNodeIds.value = runNodeIds.value.filter(id => runNodes.value.some(node => node.id === id)) })
onMounted(() => {
  if (window.chongmingClient) {
    stopLocalState = window.chongmingClient.onLocalState(value => { localState.value = value })
    void window.chongmingClient.localState().then(result => { if (result.ok) localState.value = result.value })
  }
  void session.initialize()
})
onBeforeUnmount(() => { stopLocalState(); session.dispose() })

// 用途：处理界面相关工作，并把结果交给调用方。
async function homeConnectSession() {
  const value = token.value
  token.value = ''
  await session.connect({ baseUrl: baseUrl.value, token: value, remember: remember.value })
}
// 用途：处理界面相关工作，并把结果交给调用方。
function homeOpenWorkspaceDialog() { session.clearError(); workspaceDialog.value?.showModal() }
// 用途：处理界面相关工作，并把结果交给调用方。
function homeOpenMapDialog() { session.clearError(); mapDialog.value?.showModal() }
// 用途：处理界面相关工作，并把结果交给调用方。
function homeOpenNodeDialog(kind: 'claim' | 'news' | 'source') {
  session.clearError(); nodeKind.value = kind; nodeContent.value = ''; nodeCategory.value = ''
  nodeDialog.value?.showModal()
}
// 用途：创建工作区，供后续流程使用。
async function homeCreateWorkspace() {
  if (await session.createWorkspace(workspaceName.value.trim(), workspaceDescription.value)) {
    workspaceDialog.value?.close(); workspaceName.value = ''; workspaceDescription.value = ''
  }
}
// 用途：创建数据图，供后续流程使用。
async function homeCreateMap() {
  if (await session.createMap(mapName.value.trim())) { mapDialog.value?.close(); mapName.value = '' }
}
// 用途：创建节点，供后续流程使用。
async function homeCreateNode() {
  const created = nodeKind.value === 'source'
    ? await session.createSource(nodeContent.value.trim(), nodeCategory.value)
    : await session.createNode(nodeKind.value, nodeContent.value.trim(), nodeCategory.value.trim() || null)
  if (created) {
    nodeDialog.value?.close(); nodeContent.value = ''; nodeCategory.value = ''
  }
}
// 用途：处理界面相关工作，并把结果交给调用方。
function homeOpenRunDialog() {
  session.clearError(); runUntil.value = 'verified'; runRegenerate.value = false
  runNodeIds.value = runNodes.value.map(node => node.id)
  runDialog.value?.showModal()
}
// 用途：启动运行状态流程，并返回执行结果。
async function homeStartRun() {
  if (runSelectionChanged.value || !runNodeIds.value.length) return
  if (await session.startRun({ scope: { nodeIds: [...runNodeIds.value] }, until: runUntil.value, mode: runMode.value, regenerate: runRegenerate.value })) runDialog.value?.close()
}
// 用途：处理界面相关工作，并把结果交给调用方。
async function homeRetryDialog(dialog: HTMLDialogElement | null) { if (await session.retry()) dialog?.close() }
// 用途：读取数据图标题，并把结构化结果交给调用方。
function homeReadMapTitle(id: string) { return session.mapList.find(map => map.id === id)?.name ?? '数据图' }
// 用途：处理界面相关工作，并把结果交给调用方。
async function homeOpenImport(workspaceId: string) {
  managementOpen.value = false
  await session.loadWorkspaces()
  await session.selectWorkspace(workspaceId)
}
</script>

<template>
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
              <span class="map-name">{{ item.name }}</span><small>{{ item.claimCount }} 个事实 · {{ item.nodeCount }} 个节点</small>
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
            <button :disabled="!session.canEdit || session.active || session.busy" @click="homeOpenNodeDialog('source')">＋ 来源</button>
            <button :disabled="!session.canEdit || session.active || session.busy" @click="homeOpenNodeDialog('news')">＋ 新闻</button>
            <button :disabled="!session.canEdit || session.active || session.busy" @click="homeOpenNodeDialog('claim')">＋ 事实</button>
            <button class="primary" :disabled="!session.canEdit || session.active || session.busy || !session.snapshot.nodes.some(node => graphCanProcessNode(node, 'verified'))" @click="homeOpenRunDialog">批量处理</button>
            <button :disabled="session.loading" @click="session.refresh()">刷新</button>
          </div></div>
          <GraphCanvas :activities="session.activities" :snapshot="session.snapshot" :selected-id="session.selectedId" @select="session.selectNode" />
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
            <RunReview :activities="session.activities" :snapshot="session.snapshot" :can-edit="session.canEdit" :busy="session.busy" @update="session.updateReview" @answer="session.answerReview" @cancel="session.cancelRun" @pause="session.pauseRun" @resume="session.resumeRun" />
            <NodeInspector :snapshot="session.snapshot" :selected-id="session.selectedId" :can-edit="session.canEdit" :busy="session.busy" @save="session.saveNode" @remove="session.removeNode" @verify="session.startRun" @link-sources="session.linkSources" />
          </template>
          <div v-else class="inspector-empty"><h3>节点详情</h3><p>选择图中的节点，查看内容与来源。</p></div>
        </div>
      </template>
      <template #footer><footer class="client-footer"><span class="status-dot" :class="{ offline: !session.online }" />{{ syncLabel }}<span v-if="session.streamError" class="error">{{ session.streamError }}</span><span class="footer-end">{{ session.workspace?.name ?? '未选择工作区' }}<template v-if="session.snapshot"> · 版本 {{ session.snapshot.revision }}</template></span></footer></template>
    </AppShell>

    <ManagementPanel v-if="managementOpen && session.bootstrap" :key="`${session.bootstrap.identity.userId}:${session.workspace?.id ?? ''}`" :gateway="api" :workspace="session.workspace" :bootstrap="session.bootstrap" :snapshot="session.snapshot" @close="managementOpen = false" @changed="session.refreshManagement" @unauthorized="session.disconnect" @imported="homeOpenImport" />

    <dialog ref="workspaceDialog" class="create-dialog" aria-labelledby="workspace-dialog-title">
      <form @submit.prevent="homeCreateWorkspace"><h2 id="workspace-dialog-title">创建工作区</h2><p class="muted">使用共享 Agent 库作为初始配置，之后保留独立副本。</p><label>工作区名称<input v-model="workspaceName" required maxlength="120" autofocus></label><label>工作区说明<textarea v-model="workspaceDescription" rows="3" /></label><p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="workspaceDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(workspaceDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !workspaceName.trim()">{{ session.busy ? '创建中…' : '创建工作区' }}</button></div></form>
    </dialog>
    <dialog ref="mapDialog" class="create-dialog" aria-labelledby="map-dialog-title">
      <form @submit.prevent="homeCreateMap"><h2 id="map-dialog-title">创建数据图</h2><label>数据图名称<input v-model="mapName" required maxlength="120" autofocus></label><p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="mapDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(mapDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !mapName.trim()">{{ session.busy ? '创建中…' : '创建数据图' }}</button></div></form>
    </dialog>
    <dialog ref="nodeDialog" class="create-dialog" aria-labelledby="node-dialog-title">
      <form @submit.prevent="homeCreateNode"><h2 id="node-dialog-title">{{ { claim: '添加事实', news: '添加新闻', source: '添加来源' }[nodeKind] }}</h2>
        <template v-if="nodeKind === 'source'"><label>来源网址<input v-model="nodeContent" type="url" pattern="https?://.+" required placeholder="https://example.com/article" autofocus></label><label>来源名称（可选）<input v-model="nodeCategory" placeholder="便于识别这份资料"></label></template>
        <template v-else><label>{{ nodeKind === 'claim' ? '事实陈述' : '新闻正文' }}<textarea v-model="nodeContent" required rows="7" autofocus :placeholder="nodeKind === 'claim' ? '输入一个可以独立核查的陈述' : '粘贴新闻内容，可以继续拆分为事实并核查'" /></label><label v-if="nodeKind === 'claim'">分类（可选）<input v-model="nodeCategory" placeholder="例如：数据、引述、因果"></label></template>
        <p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="nodeDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(nodeDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !session.canEdit || session.active || !nodeContent.trim()">{{ session.busy ? '保存中…' : '添加节点' }}</button></div></form>
    </dialog>
    <dialog ref="runDialog" class="create-dialog" aria-labelledby="run-dialog-title">
      <form @submit.prevent="homeStartRun">
        <h2 id="run-dialog-title">批量处理数据图</h2>
        <label>处理到哪一步<select v-model="runUntil" :disabled="session.busy"><option value="news">生成新闻</option><option value="claims">生成事实</option><option value="verified">完成核查</option></select></label>
        <label>处理方式<select v-model="runMode" :disabled="session.busy"><option value="human-in-loop">人工审核角度与结果</option><option value="auto">自动处理并保存结果</option></select></label>
        <div class="run-node-heading"><strong>选择起点 · {{ runNodeIds.length }} / {{ runNodes.length }}</strong><button type="button" :disabled="session.busy" @click="runNodeIds = runNodes.map(node => node.id)">全选符合条件的节点</button><button type="button" :disabled="session.busy" @click="runNodeIds = []">清空</button></div>
        <div class="run-node-list"><label v-for="node in runNodes" :key="node.id" class="check"><input v-model="runNodeIds" type="checkbox" :value="node.id" :disabled="session.busy"><span><small>{{ GRAPH_KIND_LABELS[node.data.kind] }}</small>{{ graphReadNodeText(node) }}</span></label></div>
        <p v-if="!runNodes.length" class="muted">图中没有符合这一处理目标的起点。</p>
        <p v-if="runSelectionChanged" class="error">所选节点已变化，请重新选择处理范围。</p>
        <label class="check"><input v-model="runRegenerate" type="checkbox" :disabled="session.busy">重新生成已有结果</label>
        <p class="muted">默认复用有效结果。从所选节点继续处理后续数据，直到达到指定目标。</p>
        <p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p>
        <div class="dialog-actions"><button type="button" @click="runDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(runDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || session.active || !session.canEdit || !runNodeIds.length || runSelectionChanged">开始处理</button></div>
      </form>
    </dialog>
  </main>
</template>

<style scoped>
.local-divider{width:100%;border:0;border-top:1px solid var(--border);margin:12px 0}
.run-node-heading{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.run-node-heading strong{margin-right:auto}.run-node-list{max-height:230px;overflow:auto;display:grid;gap:9px}.run-node-list label{align-items:flex-start!important;padding:8px;border:1px solid var(--border-subtle);line-height:1.6}.run-node-list input{margin-top:4px;flex-shrink:0}.run-node-list span{overflow-wrap:anywhere}.run-node-list small{color:var(--text-muted);margin-right:8px}.create-dialog select{padding:7px}
.client-root{height:100%;display:flex;flex-direction:column}.workbench{flex:1}.muted{color:var(--text-muted)}.error{color:var(--danger);line-height:1.6}.login-screen{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;justify-content:flex-start;gap:26px;padding:32px;background:var(--bg-viewport)}.login-brand{margin-top:auto;flex-shrink:0;display:flex;align-items:center;gap:16px}.login-brand h1{font-size:28px;letter-spacing:5px}.login-brand p{color:var(--text-muted);margin-top:5px;font-size:13px}.brand-mark{display:grid;place-items:center;width:48px;height:48px;color:#fff;background:var(--accent);font-family:var(--content-font);font-size:28px;border-radius:5px}.brand-mark.small{width:24px;height:24px;font-size:17px;border-radius:3px}.login-card{margin-bottom:auto;flex-shrink:0;width:min(100%,420px);padding:26px;background:var(--bg-panel);border:1px solid var(--border-subtle);display:grid;gap:16px;box-shadow:0 8px 30px #00000008}.login-card h2{font-size:18px}.login-card input{font-size:13px;padding:9px 10px}.login-card p{line-height:1.6}.login-button{padding:10px;font-size:13px}.check{display:flex!important;align-items:center;gap:8px}.session-note{font-size:11px}label{display:grid;gap:7px;color:var(--text);font-size:12px}.client-header{height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px;background:var(--bg-header);border-bottom:1px solid var(--border);flex-shrink:0}.desktop .client-header{padding-left:calc(var(--traffic-light-inset) + 8px);-webkit-app-region:drag}.client-header button{-webkit-app-region:no-drag}.brand,.account{display:flex;align-items:center;gap:10px}.brand strong{font-size:14px}.server{font-size:10px;color:var(--text-muted);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notice{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#fff2e4;border-bottom:1px solid #d9b287;color:#784e18}.notice span{flex:1}.pane-heading,.list-heading{display:flex;justify-content:space-between;align-items:center;padding:3px 8px}.pane-heading{height:100%;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.pane-heading button,.list-heading button{padding:0 5px;min-height:20px}.workspace-select{padding:10px 8px;border-bottom:1px solid var(--border-subtle)}.workspace-select select{padding:5px;font-size:12px}.workspace-meta{margin-top:7px;font-size:10px}.list-heading{padding-top:12px;color:var(--text-muted);font-weight:600}.map-list{display:flex;flex-direction:column;overflow:auto;padding:4px;gap:2px}.map-item{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:5px;border-color:transparent;padding:9px 8px;min-height:48px}.map-item.selected{background:#fff1e0;border-color:#e0bd92}.map-name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;max-width:100%;font-size:12px}.map-item small{color:var(--text-muted);font-weight:normal}.sidebar-empty{padding:12px;color:var(--text-muted);line-height:1.8}.sidebar-empty button{margin-top:10px}.tabs{display:flex;height:100%;overflow:auto;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.tab{display:flex;border-right:1px solid var(--border-subtle);min-width:90px;max-width:210px;flex-shrink:0}.tab.active{background:var(--bg-viewport);box-shadow:inset 0 2px var(--accent)}.tab button{border:0;background:transparent;border-radius:0;min-height:26px}.tab-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}.tab-close{padding:0 6px;color:var(--text-muted)}.tab-placeholder{padding:7px 10px;color:var(--text-muted)}.graph-area{height:100%;display:flex;flex-direction:column;min-height:0}.graph-toolbar{min-height:38px;border-bottom:1px solid var(--border-subtle);display:flex;gap:10px;align-items:center;padding:6px 10px;background:var(--bg-viewport)}.graph-toolbar strong{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar-actions{display:flex;gap:5px;margin-left:auto}.center-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;min-height:100%;padding:28px}.center-empty h2{font-size:20px;font-family:var(--content-font);font-weight:500}.center-empty p{font-size:13px;line-height:1.8;color:var(--text-muted)}.center-empty button{padding:7px 16px}.inspector-scroll{height:100%;overflow:auto}.inspector-empty{padding:18px 14px;color:var(--text-muted);line-height:1.8}.inspector-empty h3{font-size:12px;margin-bottom:10px;color:var(--text)}.client-footer{height:26px;display:flex;align-items:center;gap:7px;flex-shrink:0;padding:0 10px;background:var(--bg-header);border-top:1px solid var(--border);font-size:10px;color:var(--text-muted)}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--success)}.status-dot.offline{background:var(--warning)}.footer-end{margin-left:auto}.create-dialog{margin:auto;width:min(480px,calc(100vw - 40px));max-height:85vh;overflow:auto;padding:22px;border:1px solid var(--border);border-radius:4px;background:var(--bg-panel);color:var(--text);box-shadow:0 12px 50px #0003}.create-dialog::backdrop{background:#0005}.create-dialog form{display:grid;gap:16px}.create-dialog h2{font-size:17px}.create-dialog p{line-height:1.6}.create-dialog input,.create-dialog textarea{padding:7px;font-size:13px;line-height:1.5}.dialog-actions{display:flex;gap:8px;justify-content:flex-end}.dialog-actions button{padding:6px 12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:1050px){.server,.brand>.muted{display:none}.graph-toolbar{flex-wrap:wrap}.toolbar-actions{margin-left:auto}.graph-toolbar strong{max-width:150px}}@media(max-width:760px){.login-screen{padding:16px}.login-card{padding:20px}.client-header{padding:0 8px}}
</style>
