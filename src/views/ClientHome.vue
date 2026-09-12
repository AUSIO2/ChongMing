<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppShell from '../components/shell/AppShell.vue'
import GraphCanvas from '../components/client/GraphCanvas.vue'
import NodeInspector from '../components/client/NodeInspector.vue'
import RunReview from '../components/client/RunReview.vue'
import { useClientStore } from '../stores/client'

const session = useClientStore()
const desktop = typeof window !== 'undefined' && !!window.chongmingClient
const baseUrl = ref('')
const token = ref('')
const remember = ref(false)
const workspaceDialog = ref<HTMLDialogElement | null>(null)
const mapDialog = ref<HTMLDialogElement | null>(null)
const nodeDialog = ref<HTMLDialogElement | null>(null)
const workspaceName = ref(''), workspaceDescription = ref(''), mapName = ref('')
const nodeKind = ref<'claim' | 'news'>('claim'), nodeContent = ref(''), nodeCategory = ref('')
const roleLabel = computed(() => ({ owner: '所有者', editor: '编辑者', viewer: '只读成员' })[session.workspace?.role ?? 'viewer'])
const connectedAddress = computed(() => {
  try { return new URL(session.connection?.baseUrl ?? '').host } catch { return '' }
})
const activeTitle = computed(() => session.mapList.find(map => map.id === session.activeMapId)?.name ?? '数据图')
const syncLabel = computed(() => session.pollError ? '连接中断 · 自动重试' : session.lastSync ? '已同步' : session.bootstrap ? '已连接' : '未连接')

watch(() => session.connection?.baseUrl, value => { if (value) baseUrl.value = value }, { immediate: true })
watch(() => session.bootstrap?.identity.userId, () => {
  token.value = ''; workspaceName.value = ''; workspaceDescription.value = ''; mapName.value = ''
  nodeContent.value = ''; nodeCategory.value = ''
  workspaceDialog.value?.close(); mapDialog.value?.close(); nodeDialog.value?.close()
})
onMounted(() => { void session.initialize() })
onBeforeUnmount(() => session.dispose())

async function homeConnectSession() {
  const value = token.value
  token.value = ''
  await session.connect({ baseUrl: baseUrl.value, token: value, remember: remember.value })
}
function homeOpenWorkspaceDialog() { session.clearError(); workspaceDialog.value?.showModal() }
function homeOpenMapDialog() { session.clearError(); mapDialog.value?.showModal() }
function homeOpenNodeDialog(kind: 'claim' | 'news') {
  session.clearError(); nodeKind.value = kind; nodeContent.value = ''; nodeCategory.value = ''
  nodeDialog.value?.showModal()
}
async function homeCreateWorkspace() {
  if (await session.createWorkspace(workspaceName.value.trim(), workspaceDescription.value)) {
    workspaceDialog.value?.close(); workspaceName.value = ''; workspaceDescription.value = ''
  }
}
async function homeCreateMap() {
  if (await session.createMap(mapName.value.trim())) { mapDialog.value?.close(); mapName.value = '' }
}
async function homeCreateNode() {
  if (await session.createNode(nodeKind.value, nodeContent.value.trim(), nodeCategory.value.trim() || null)) {
    nodeDialog.value?.close(); nodeContent.value = ''; nodeCategory.value = ''
  }
}
async function homeRetryDialog(dialog: HTMLDialogElement | null) { if (await session.retry()) dialog?.close() }
function homeReadMapTitle(id: string) { return session.mapList.find(map => map.id === id)?.name ?? '数据图' }
</script>

<template>
  <main class="client-root" :class="{ desktop }">
    <section v-if="!session.bootstrap" class="login-screen" aria-label="连接重明服务">
      <div class="login-brand"><span class="brand-mark">重</span><div><h1>重明</h1><p>把事实、来源与核查结果连接起来</p></div></div>
      <form class="login-card" @submit.prevent="homeConnectSession">
        <h2>连接工作区</h2>
        <p class="muted">使用管理员提供的服务地址和用户访问令牌登录。</p>
        <label>服务地址<input v-model="baseUrl" type="url" autocomplete="url" required placeholder="http://127.0.0.1:4320" :disabled="session.connecting || session.initializing"></label>
        <label>用户访问令牌<input v-model="token" type="password" autocomplete="off" required spellcheck="false" placeholder="粘贴用户令牌" :disabled="session.connecting || session.initializing"></label>
        <label v-if="session.connection?.canRemember" class="check"><input v-model="remember" type="checkbox">在这台设备上记住登录</label>
        <p v-else class="muted session-note">登录信息仅在本次会话中使用。</p>
        <p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p>
        <button class="primary login-button" type="submit" :disabled="session.connecting || session.initializing || !token.trim() || !baseUrl.trim()">
          {{ session.initializing ? '恢复连接…' : session.connecting ? '正在连接…' : '连接' }}
        </button>
      </form>
    </section>

    <AppShell v-else class="workbench">
      <template #top>
        <header class="client-header">
          <div class="brand"><span class="brand-mark small">重</span><strong>重明</strong><span class="muted">事实核查工作台</span></div>
          <div class="account"><span class="server" :title="session.connection?.baseUrl">{{ connectedAddress }}</span><span>{{ session.bootstrap.identity.displayName }}</span><button @click="session.disconnect()">退出登录</button></div>
        </header>
        <div v-if="session.error" class="notice" role="alert">
          <span>{{ session.error.message }}</span><button v-if="session.canRetry" :disabled="session.busy" @click="session.retry()">重试同一操作</button><button aria-label="关闭提示" @click="session.clearError()">×</button>
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
            <button :disabled="!session.canEdit || session.active || session.busy" @click="homeOpenNodeDialog('news')">＋ 新闻</button>
            <button class="primary" :disabled="!session.canEdit || session.active || session.busy" @click="homeOpenNodeDialog('claim')">＋ 事实</button>
            <button :disabled="session.loading" @click="session.refresh()">刷新</button>
          </div></div>
          <GraphCanvas :snapshot="session.snapshot" :selected-id="session.selectedId" @select="session.selectNode" />
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
            <RunReview :snapshot="session.snapshot" :can-edit="session.canEdit" :busy="session.busy" @update="session.updateReview" @answer="session.answerReview" @cancel="session.cancelRun" />
            <NodeInspector :snapshot="session.snapshot" :selected-id="session.selectedId" :can-edit="session.canEdit" :busy="session.busy" @save="session.saveNode" @remove="session.removeNode" @verify="session.startRun" @link-sources="session.linkSources" />
          </template>
          <div v-else class="inspector-empty"><h3>节点详情</h3><p>选择图中的节点，查看内容与来源。</p></div>
        </div>
      </template>
      <template #footer><footer class="client-footer"><span class="status-dot" :class="{ offline: !session.online }" />{{ syncLabel }}<span v-if="session.pollError" class="error">{{ session.pollError }}</span><span class="footer-end">{{ session.workspace?.name ?? '未选择工作区' }}<template v-if="session.snapshot"> · 版本 {{ session.snapshot.revision }}</template></span></footer></template>
    </AppShell>

    <dialog ref="workspaceDialog" class="create-dialog" aria-labelledby="workspace-dialog-title">
      <form @submit.prevent="homeCreateWorkspace"><h2 id="workspace-dialog-title">创建工作区</h2><p class="muted">使用共享 Agent 库作为初始配置，之后保留独立副本。</p><label>工作区名称<input v-model="workspaceName" required maxlength="120" autofocus></label><label>工作区说明<textarea v-model="workspaceDescription" rows="3" /></label><p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="workspaceDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(workspaceDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !workspaceName.trim()">{{ session.busy ? '创建中…' : '创建工作区' }}</button></div></form>
    </dialog>
    <dialog ref="mapDialog" class="create-dialog" aria-labelledby="map-dialog-title">
      <form @submit.prevent="homeCreateMap"><h2 id="map-dialog-title">创建数据图</h2><label>数据图名称<input v-model="mapName" required maxlength="120" autofocus></label><p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="mapDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(mapDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !mapName.trim()">{{ session.busy ? '创建中…' : '创建数据图' }}</button></div></form>
    </dialog>
    <dialog ref="nodeDialog" class="create-dialog" aria-labelledby="node-dialog-title">
      <form @submit.prevent="homeCreateNode"><h2 id="node-dialog-title">{{ nodeKind === 'claim' ? '添加事实' : '添加新闻' }}</h2><label>{{ nodeKind === 'claim' ? '事实陈述' : '新闻正文' }}<textarea v-model="nodeContent" required rows="7" autofocus :placeholder="nodeKind === 'claim' ? '输入一个可以独立核查的陈述' : '粘贴新闻内容，之后可关联到多个事实'" /></label><label v-if="nodeKind === 'claim'">分类（可选）<input v-model="nodeCategory" placeholder="例如：数据、引述、因果"></label><p v-if="session.error" class="error" role="alert">{{ session.error.message }}</p><div class="dialog-actions"><button type="button" @click="nodeDialog?.close()">取消</button><button v-if="session.canRetry" type="button" :disabled="session.busy" @click="homeRetryDialog(nodeDialog)">重试同一操作</button><button class="primary" :disabled="session.busy || !nodeContent.trim()">{{ session.busy ? '保存中…' : '添加节点' }}</button></div></form>
    </dialog>
  </main>
</template>

<style scoped>
.client-root{height:100%;display:flex;flex-direction:column}.workbench{flex:1}.muted{color:var(--text-muted)}.error{color:var(--danger);line-height:1.6}.login-screen{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;padding:32px;background:var(--bg-viewport)}.login-brand{display:flex;align-items:center;gap:16px}.login-brand h1{font-size:28px;letter-spacing:5px}.login-brand p{color:var(--text-muted);margin-top:5px;font-size:13px}.brand-mark{display:grid;place-items:center;width:48px;height:48px;color:#fff;background:var(--accent);font-family:var(--content-font);font-size:28px;border-radius:5px}.brand-mark.small{width:24px;height:24px;font-size:17px;border-radius:3px}.login-card{width:min(100%,420px);padding:26px;background:var(--bg-panel);border:1px solid var(--border-subtle);display:grid;gap:16px;box-shadow:0 8px 30px #00000008}.login-card h2{font-size:18px}.login-card input{font-size:13px;padding:9px 10px}.login-card p{line-height:1.6}.login-button{padding:10px;font-size:13px}.check{display:flex!important;align-items:center;gap:8px}.session-note{font-size:11px}label{display:grid;gap:7px;color:var(--text);font-size:12px}.client-header{height:44px;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 12px;background:var(--bg-header);border-bottom:1px solid var(--border);flex-shrink:0}.desktop .client-header{padding-left:calc(var(--traffic-light-inset) + 8px);-webkit-app-region:drag}.client-header button{-webkit-app-region:no-drag}.brand,.account{display:flex;align-items:center;gap:10px}.brand strong{font-size:14px}.server{font-size:10px;color:var(--text-muted);max-width:230px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.notice{display:flex;align-items:center;gap:10px;padding:8px 12px;background:#fff2e4;border-bottom:1px solid #d9b287;color:#784e18}.notice span{flex:1}.pane-heading,.list-heading{display:flex;justify-content:space-between;align-items:center;padding:3px 8px}.pane-heading{height:100%;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.pane-heading button,.list-heading button{padding:0 5px;min-height:20px}.workspace-select{padding:10px 8px;border-bottom:1px solid var(--border-subtle)}.workspace-select select{padding:5px;font-size:12px}.workspace-meta{margin-top:7px;font-size:10px}.list-heading{padding-top:12px;color:var(--text-muted);font-weight:600}.map-list{display:flex;flex-direction:column;overflow:auto;padding:4px;gap:2px}.map-item{display:flex;flex-direction:column;align-items:flex-start;text-align:left;gap:5px;border-color:transparent;padding:9px 8px;min-height:48px}.map-item.selected{background:#fff1e0;border-color:#e0bd92}.map-name{white-space:nowrap;text-overflow:ellipsis;overflow:hidden;max-width:100%;font-size:12px}.map-item small{color:var(--text-muted);font-weight:normal}.sidebar-empty{padding:12px;color:var(--text-muted);line-height:1.8}.sidebar-empty button{margin-top:10px}.tabs{display:flex;height:100%;overflow:auto;background:var(--bg-header);border-bottom:1px solid var(--border-subtle)}.tab{display:flex;border-right:1px solid var(--border-subtle);min-width:90px;max-width:210px;flex-shrink:0}.tab.active{background:var(--bg-viewport);box-shadow:inset 0 2px var(--accent)}.tab button{border:0;background:transparent;border-radius:0;min-height:26px}.tab-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;text-align:left}.tab-close{padding:0 6px;color:var(--text-muted)}.tab-placeholder{padding:7px 10px;color:var(--text-muted)}.graph-area{height:100%;display:flex;flex-direction:column;min-height:0}.graph-toolbar{min-height:38px;border-bottom:1px solid var(--border-subtle);display:flex;gap:10px;align-items:center;padding:6px 10px;background:var(--bg-viewport)}.graph-toolbar strong{max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolbar-actions{display:flex;gap:5px;margin-left:auto}.center-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;gap:14px;min-height:100%;padding:28px}.center-empty h2{font-size:20px;font-family:var(--content-font);font-weight:500}.center-empty p{font-size:13px;line-height:1.8;color:var(--text-muted)}.center-empty button{padding:7px 16px}.inspector-scroll{height:100%;overflow:auto}.inspector-empty{padding:18px 14px;color:var(--text-muted);line-height:1.8}.inspector-empty h3{font-size:12px;margin-bottom:10px;color:var(--text)}.client-footer{height:26px;display:flex;align-items:center;gap:7px;flex-shrink:0;padding:0 10px;background:var(--bg-header);border-top:1px solid var(--border);font-size:10px;color:var(--text-muted)}.status-dot{width:6px;height:6px;border-radius:50%;background:var(--success)}.status-dot.offline{background:var(--warning)}.footer-end{margin-left:auto}.create-dialog{margin:auto;width:min(480px,calc(100vw - 40px));max-height:85vh;overflow:auto;padding:22px;border:1px solid var(--border);border-radius:4px;background:var(--bg-panel);color:var(--text);box-shadow:0 12px 50px #0003}.create-dialog::backdrop{background:#0005}.create-dialog form{display:grid;gap:16px}.create-dialog h2{font-size:17px}.create-dialog p{line-height:1.6}.create-dialog input,.create-dialog textarea{padding:7px;font-size:13px;line-height:1.5}.dialog-actions{display:flex;gap:8px;justify-content:flex-end}.dialog-actions button{padding:6px 12px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}@media(max-width:1050px){.server,.brand>.muted{display:none}.graph-toolbar{flex-wrap:wrap}.toolbar-actions{margin-left:auto}.graph-toolbar strong{max-width:150px}}@media(max-width:760px){.login-screen{padding:16px}.login-card{padding:20px}.client-header{padding:0 8px}}
</style>
