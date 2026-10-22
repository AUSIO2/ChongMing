<!-- 中心视图区：保持 Map 常驻，仅切换 Map 画布与节点单页的可见性。 -->
<script setup lang="ts">
import type { EvidenceLibraryRef } from '../../../../contracts/evidence-library'
import type { GraphActivity } from '../../../../contracts/activity'
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import { nextTick, ref, watch } from 'vue'
import type { NodeIdentity } from '../../features/graph/node-identity'
import type { OperationOriginOpen } from '../../features/graph/node-origin'
import type { ReaderSourceFocus, ReaderSourceSave } from '../../features/reader/reader-sources'
import type { WorkspaceReaderBookmark, WorkspaceViewMode } from '../../features/workspace/use-workspace-view'
import GraphScene3D from '../../features/graph/GraphScene3D.vue'
import NodeReader from '../../features/reader/NodeReader.vue'

const graphCanvas = ref<InstanceType<typeof GraphScene3D> | null>(null)
const props = withDefaults(defineProps<{
  snapshot: GraphSnapshot | null
  catalog: DefinitionCatalog | null
  activities: readonly GraphActivity[]
  selectedId: string | null
  selectedRunId?: string | null
  canOpenPage: boolean
  userId: string | null
  mode: WorkspaceViewMode
  pageIdentity: NodeIdentity | null
  bookmark: WorkspaceReaderBookmark | null
  loading: boolean
  errorMessage: string | null
  canEdit: boolean
  busy: boolean
  sourceFocus: ReaderSourceFocus | null
  libraryAvailable?: boolean
  historyAvailable?: boolean
  active?: boolean
}>(), { active: true })

const emit = defineEmits<{
  select: [id: string | null]
  openPage: [identity: NodeIdentity]
  switchView: [mode: WorkspaceViewMode]
  bookmark: [identity: NodeIdentity, value: WorkspaceReaderBookmark]
  openNode: [identity: NodeIdentity]
  editNode: [identity: NodeIdentity]
  openSource: [focus: ReaderSourceFocus]
  saveSources: [request: ReaderSourceSave]
  openEvidence: [input: { workspaceId: string; ref: EvidenceLibraryRef }]
  openOperation: [input: OperationOriginOpen]
}>()

function revealTool(event: FocusEvent): void {
  // 键盘聚焦到横向操作区末端时，让按钮完整可见，而非只露出一部分。
  if (event.target instanceof HTMLElement && event.target !== event.currentTarget) {
    event.target.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

watch(() => /* 观察 Map/单页及中心区域是否可见。 */ [props.mode, props.active] as const,
async (/* 当前模式和可见性。 */ current, /* 前一次展示状态。 */ previous) => {
  // 从单页或库返回可见 Map 时恢复画布焦点与正确尺寸。
  if (!current[1] || current[0] !== 'map' || previous[0] !== 'page' && previous[1]) return
  await nextTick()
  await graphCanvas.value?.focusSelectedNode()
})
</script>

<template>
  <section class="workspace-views" :class="`mode-${mode}`">
    <header class="view-toolbar">
      <div class="view-label"><strong>{{ snapshot?.name ?? '工作区' }}</strong><span v-if="snapshot" class="view-count">{{ snapshot.nodes.length }} 个节点 · {{ snapshot.edges.length }} 条关系</span></div>
      <nav class="view-switch" aria-label="工作区视图">
        <button type="button" :aria-pressed="mode === 'map'" @click="emit('switchView', 'map')">关系图</button>
        <button type="button" :aria-pressed="mode === 'page'" :disabled="!canOpenPage" :title="canOpenPage ? '阅读选中节点' : '先在关系图中选择节点'" @click="emit('switchView', 'page')">单页</button>
      </nav>
      <div class="view-tools" role="region" aria-label="数据图操作" title="操作区可横向滚动" tabindex="0" @focusin="revealTool"><slot name="tools" /></div>
    </header>
    <div class="view-body">
      <div v-show="mode === 'map'" class="map-view">
        <GraphScene3D v-if="snapshot" ref="graphCanvas" :active="active && mode === 'map'" :activities="[...activities]" :snapshot="snapshot" :catalog="catalog" :selected-id="selectedId" :selected-run-id="selectedRunId" @select="emit('select', $event)" @open="emit('openPage', $event)" />
        <div v-else class="view-empty"><h2>{{ loading ? '正在读取数据图…' : '从一个工作区开始' }}</h2><p v-if="!loading">打开左侧数据图，或先创建工作区和数据图。</p></div>
      </div>
      <NodeReader v-show="mode === 'page'" :active="active && mode === 'page'" :user-id="userId" :identity="pageIdentity" :snapshot="snapshot" :catalog="catalog" :bookmark="bookmark" :loading="loading" :error-message="errorMessage" :can-edit="canEdit" :busy="busy" :source-focus="sourceFocus" :library-available="libraryAvailable" :history-available="historyAvailable"
        @bookmark="(identity, value) => emit('bookmark', identity, value)" @open-node="emit('openNode', $event)" @return-to-map="emit('switchView', 'map')" @edit-node="emit('editNode', $event)" @open-source="emit('openSource', $event)" @save-sources="emit('saveSources', $event)" @open-evidence="emit('openEvidence', $event)" @open-operation="emit('openOperation', $event)" />
    </div>
  </section>
</template>

<style scoped>
.workspace-views { display:flex; width:100%; height:100%; min-width:0; min-height:0; flex-direction:column; overflow:hidden; }
.view-toolbar { display:flex; flex:0 0 48px; height:48px; min-height:48px; align-items:center; gap:12px; padding:4px 12px; border-bottom:1px solid var(--border-subtle); background:var(--bg-viewport); }
.view-label { display:flex; flex:0 1 auto; min-width:0; max-width:220px; overflow:hidden; align-items:baseline; gap:10px; }
.view-label strong { min-width:0; overflow:hidden; max-width:220px; color:var(--text); font-size:13px; text-overflow:ellipsis; white-space:nowrap; }
.view-count { color:var(--text-muted); font-size:11px; white-space:nowrap; }
.view-switch { display:flex; flex:none; gap:0; padding:0; border:0; background:transparent; white-space:nowrap; }
.view-switch button { min-height:32px; padding:4px 11px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:var(--text-muted); }
.view-switch button[aria-pressed="true"] { border-bottom-color:var(--accent); background:transparent; color:var(--text); box-shadow:none; }
.view-tools { display:flex; flex:1; min-width:0; height:100%; align-items:center; gap:5px; margin-left:auto; overflow-x:auto; overflow-y:hidden; scrollbar-width:thin; }
.view-tools::-webkit-scrollbar { height:5px; }
.view-tools :deep(.toolbar-actions) { flex:none; flex-wrap:nowrap; }
.view-tools :deep(button) { flex:none; min-height:30px; padding:4px 8px; font-size:12px; white-space:nowrap; }
.view-body { position:relative; display:flex; flex:1; min-width:0; min-height:0; overflow:hidden; }
.map-view { display:flex; width:100%; height:100%; min-width:0; min-height:0; }
.view-empty { display:grid; flex:1; place-content:center; justify-items:center; gap:10px; padding:24px; text-align:center; }
.view-empty h2 { font-family:var(--content-font); font-size:20px; font-weight:500; }
.view-empty p { color:var(--text-muted); font-size:13px; line-height:1.7; }
@media(max-width:1100px) { .view-toolbar { gap:7px; padding:4px 7px; } .view-label { display:none; } .view-tools { gap:3px; } .view-tools :deep(.toolbar-actions) { flex-wrap:nowrap; } .view-tools :deep(button) { flex:none; padding:4px 6px; white-space:nowrap; } }
</style>
