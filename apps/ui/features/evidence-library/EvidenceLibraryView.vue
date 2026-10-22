<!-- 证据库沿用 Map 的场景、选择与固定单页体验，页面负责工作区装配。 -->
<script setup lang="ts">
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { computed, nextTick, ref, watch } from 'vue'

import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { ClientGateway } from '../../../../contracts/client'
import type { EvidenceClaimRef } from '../../../../contracts/evidence-library'
import GraphScene from '../graph/GraphScene.vue'
import DataPayloadView from '../reader/DataPayloadView.vue'
import EvidenceEntryDetails from './EvidenceEntryDetails.vue'
import EvidenceRelationDetails from './EvidenceRelationDetails.vue'
import { EvidencePresentationMessage, evidenceReadFixedPresentation, evidenceReadJudgment, evidenceReadRelationNotice, evidenceReadRelationPresentation, evidenceReadRelationRole, evidenceReadRelationScene, evidenceReadRelationSceneKey, evidenceReadStatus, type EvidenceBasisOpen } from './evidence-presentation'
import type { EvidenceState } from './evidence-state'
import type { EvidenceUsesContext } from './evidence-uses'

const props = defineProps<{
  state: EvidenceState
  catalog: DefinitionCatalog | null
  active: boolean
  workspaceKey: string
  canEdit: boolean
  gateway: ClientGateway
  usesContext: EvidenceUsesContext
}>()
const emit = defineEmits<{
  openSource: [ref: EvidenceClaimRef]
  openBasis: [input: EvidenceBasisOpen]
  openCollectionEntry: [/* 本次收录返回的条目或相反判断身份，只发出只读导航意图。 */ entryId: string]
  viewMode: [mode: 'map' | 'page']
  unauthorized: []
  openConsumer: [ref: EvidenceClaimRef]
  selectionChanged: []
}>()
const mode = ref<'map' | 'page'>('map')
const article = ref<HTMLElement | null>(null)
const scene = ref<InstanceType<typeof GraphScene> | null>(null)
const filters = computed(() => /* 表单编辑状态模块持有的当前检索草稿。 */ props.state.filters.value)
const items = computed(() => /* 当前检索真正加载的摘要数量是唯一浏览数量来源。 */ props.state.items.value)
const entry = computed(() => /* 固定单页只读取 evidence.get 已接纳的条目。 */ props.state.entry.value)
const collectionOutcome = computed(() => /* 收录结果与随后浏览的条目分别读取，保持原收据语义。 */ props.state.collectionOutcome.value)
const collectionOutcomeTitle = computed(() => {
  // 原请求确认优先说明，是否已有条目保持为该次结果的独立事实。
  const outcome = collectionOutcome.value
  if (!outcome) return ''
  return outcome.replayed ? '原收录请求已确认' : outcome.existing ? '已有相同收录，返回已有条目' : '已收录新条目'
})
const relationNode = computed(() => /* 旁栏与单页共用状态模块接纳的固定邻域选择。 */ props.state.selectedRelationNode.value)
const layout = computed(() => /* 当前根只展开已保存的有界邻域，其他库摘要仍保留。 */ evidenceReadRelationScene(items.value, entry.value, props.state.relations.value, props.catalog))
const relationNotice = computed(() => /* 旧无快照和截断快照分别提示，绝不补取当前数据图。 */ evidenceReadRelationNotice(props.state.relations.value))
const selectedSceneId = computed(() => {
  // 根使用真实 entryId，邻域只使用快照 key 对应的复合展示身份。
  const snapshot = props.state.relations.value?.snapshot
  const selectedId = props.state.selectedId.value
  return selectedId && snapshot && relationNode.value
    ? evidenceReadRelationSceneKey(selectedId, relationNode.value.key, snapshot.rootKey) : selectedId
})
const presentation = computed(() => {
  // 所有单页正文来自固定 get 或固定 relations，邻域不套用库根判断。
  if (relationNode.value) return evidenceReadRelationPresentation(relationNode.value, props.catalog)
  return entry.value ? evidenceReadFixedPresentation(entry.value, props.catalog) : null
})
const pageUsesContext = computed<EvidenceUsesContext>(() => {
  // v-show保留两份详情组件，仅当前可见的固定单页根启用使用记录读取。
  return { ...props.usesContext, entryId: entry.value?.id ?? null,
    active: props.usesContext.active && props.active && mode.value === 'page' && relationNode.value === null && entry.value !== null }
})

function setMode(
  /* 新的浏览模式，选择身份继续由状态模块拥有。 */ value: 'map' | 'page',
): void {
  // 通知父页面切换右侧详情占位，组件自身保留场景实例与相机。
  mode.value = value
  emit('viewMode', value)
}

function openCollectionEntry(
  /* 已确认收录结果中用户明确点开的条目身份。 */ entryId: string,
): void {
  // 详情导航交给页面读取当前授权内容，不把收据中的管理状态当作实时详情。
  if (!props.active || props.state.busy.value || props.state.detailLoading.value) return
  emit('openCollectionEntry', entryId)
}

async function openPage(): Promise<void> {
  // 以当前选择打开固定快照单页，挂载后把焦点放到正文。
  const selectedId = props.state.selectedId.value
  const workspaceKey = props.workspaceKey
  const relationKey = props.state.selectedRelationKey.value
  if (!selectedId) return
  setMode('page')
  await nextTick()
  if (props.active && mode.value === 'page' && props.workspaceKey === workspaceKey && props.state.selectedId.value === selectedId && props.state.selectedRelationKey.value === relationKey) {
    article.value?.focus({ preventScroll: true })
  }
}

async function openSceneEntry(
  /* 公共场景双击或 Enter 所打开的真实库根或固定邻域展示身份。 */ sceneId: string,
): Promise<void> {
  // 先按实际节点表选择固定身份，再立即打开单页，慢读取不阻止加载状态显示。
  if (!layout.value.nodes.some((/* 当前实际场景节点。 */ item) => /* 双击不能打开场景外的任意身份。 */ item.id === sceneId)) return
  const reading = selectSceneEntry(sceneId)
  await openPage()
  await reading
}

async function selectSceneEntry(
  /* 场景单击的库根或固定邻域展示身份，null 取消根选择。 */ sceneId: string | null,
): Promise<void> {
  // 从快照实际节点表反查复合 key；邻域只改变本地固定选择，不发 get/current Map。
  if (sceneId === null) { await props.state.select(null); return }
  if (sceneId === props.state.selectedId.value) { props.state.selectRelation(null); return }
  const view = props.state.relations.value
  if (view?.snapshot) {
    const snapshot = view.snapshot
    const saved = snapshot.nodes.find((/* 当前根已经保存的真实节点。 */ node) =>
      /* 不拆解字符串猜身份，以完整复合 key 的投影反查端点。 */ node.key !== snapshot.rootKey && evidenceReadRelationSceneKey(view.entryId, node.key, snapshot.rootKey) === sceneId)
    if (saved) { props.state.selectRelation(saved.key); return }
  }
  if (items.value.some((/* 已加载的真实库条目。 */ item) => /* 只有库摘要身份才发起新根读取。 */ item.id === sceneId)) await props.state.select(sceneId)
}

async function returnToLibrary(): Promise<void> {
  // 返回已保留相机的库场景，并把键盘焦点还给相同选择。
  const workspaceKey = props.workspaceKey
  setMode('map')
  await nextTick()
  if (props.active && props.workspaceKey === workspaceKey && mode.value === 'map') await scene.value?.focusSelectedNode()
}

async function withdrawEntry(
  /* 当前固定条目的明确撤回理由。 */ reason: string,
): Promise<void> {
  // 用已选条目的版本提交撤回，成功结果仍留在固定单页可读。
  await props.state.withdraw(reason)
}

watch(() => /* 身份作用域变动时恢复库初始浏览模式。 */ props.workspaceKey, () => {
  // 防止新工作区继承上一工作区的单页模式。
  setMode('map')
})
watch(() => /* 详情被身份切换或显式清选择清除时不能留着旧单页。 */ props.state.selectedId.value, (/* 状态模块当前接纳的选择身份。 */ selectedId) => {
  // 空选择回到浏览，普通选择不强制改变当前浏览模式。
  if (selectedId === null && mode.value === 'page') setMode('map')
})
defineExpose({ openPage })
</script>

<template>
  <section class="evidence-library" aria-label="工作区证据库" :aria-busy="state.loading.value || state.busy.value">
    <form v-show="mode === 'map'" class="search-toolbar" aria-label="证据库筛选" @submit.prevent="state.search()">
      <label class="keyword">关键词<input v-model="filters.query" type="search" placeholder="检索原陈述"></label><label>固定判断<select v-model="filters.confidence"><option value="all">全部判断</option><option value="0">0 · 确定错误</option><option value="1">1 · 确定正确</option></select></label><label>主体<input v-model="filters.subject" placeholder="主体"></label><label>事件<input v-model="filters.event" placeholder="事件"></label><label class="history"><input v-model="filters.includeInactive" type="checkbox">包括历史条目</label><button type="submit" :disabled="state.loading.value">{{ state.loading.value ? '检索中…' : '检索' }}</button>
    </form>
    <div class="relations-status" :class="{ truncated: state.relations.value?.snapshot?.truncated }" aria-label="证据关系状态">
      <div class="relations-message" tabindex="0" aria-label="上下游读取说明">
        <p v-if="!state.selectedId.value">选择条目，查看收录时的上下游。</p>
        <p v-else-if="state.relationsLoading.value" role="status">正在读取收录时的上下游…</p>
        <p v-else-if="state.relationsError.value" class="relation-error" role="alert" :title="`${state.relationsError.value.code}: ${state.relationsError.value.message}`">{{ uiReadErrorMessage(state.relationsError.value.message) }}</p>
        <template v-else><p v-if="state.relations.value?.snapshot">已保存 {{ state.relations.value.snapshot.nodes.length }} 个节点 · {{ state.relations.value.snapshot.edges.length }} 条关系 · {{ state.relations.value.snapshot.capturedAt }}</p><p v-if="relationNotice">{{ relationNotice }}</p></template>
      </div>
      <button v-if="state.selectedId.value && state.relationsError.value && state.canRetryRelations.value" type="button" @click="state.retryRelations()">重新读取关系</button>
    </div>

    <div class="library-content">
      <div v-if="collectionOutcome || state.error.value" class="library-notices" role="region" aria-label="证据库提示" tabindex="0">
        <section v-if="collectionOutcome" class="collection-outcome" aria-label="本次收录结果">
          <header><strong role="status">{{ collectionOutcomeTitle }}</strong><button type="button" @click="state.clearCollectionOutcome()">关闭收录结果</button></header>
          <p v-if="collectionOutcome.replayed">{{ collectionOutcome.existing ? '该次返回已有条目' : '该次结果为新条目' }}</p>
          <button type="button" :disabled="state.busy.value || state.detailLoading.value" @click="openCollectionEntry(collectionOutcome.entry.id)">查看本次条目</button>
          <details v-if="collectionOutcome.conflictEntryIds.length"><summary>本次返回的相反判断（{{ collectionOutcome.conflictEntryIds.length }}项）</summary><div class="collection-conflicts"><button v-for="(entryId, index) in collectionOutcome.conflictEntryIds" :key="entryId" type="button" :aria-label="`查看相反判断条目 ${index + 1}`" :disabled="state.busy.value || state.detailLoading.value" @click="openCollectionEntry(entryId)">查看相反判断 {{ index + 1 }}</button></div></details>
          <p class="collection-state-note">条目的当前状态以打开详情后的结果为准。</p>
        </section>
        <div v-if="state.error.value" class="error-bar" role="alert"><p :title="`${state.error.value.code}: ${state.error.value.message}`">{{ uiReadErrorMessage(state.error.value.message) }}</p><button v-if="state.canRetry.value" type="button" :disabled="state.busy.value" @click="state.retry()">重试同一操作</button><button v-else type="button" @click="state.clearError">关闭</button></div>
      </div>
    <div v-show="mode === 'map'" class="map-body">
      <GraphScene ref="scene" :layout="layout" :scene-key="`evidence:${workspaceKey}`" :selected-id="selectedSceneId" :active="active && mode === 'map'" label="证据库数据图" :empty-label="state.loading.value ? '正在读取证据库…' : '没有匹配条目。可从事实详情收录。'" @select="selectSceneEntry" @open="openSceneEntry" />
      <footer class="loaded-status"><span>已加载 {{ items.length }} 条</span><span v-if="state.libraryRevision.value !== null" class="revision">库版本 {{ state.libraryRevision.value }}</span><button v-if="state.nextCursor.value" type="button" :disabled="state.loading.value" @click="state.loadMore()">{{ state.loading.value ? '读取中…' : '加载更多' }}</button><button v-else-if="state.libraryRevision.value === null && !state.loading.value && items.length" type="button" @click="state.search()">刷新列表</button><span v-else-if="state.libraryRevision.value !== null && items.length && !state.loading.value" class="end-label">本次检索已加载完毕</span></footer>
    </div>

    <section v-show="mode === 'page'" class="fixed-page" aria-label="证据固定单页">
      <header class="page-header"><div><small>证据库 · 固定快照<span v-if="relationNode"> · {{ evidenceReadRelationRole(relationNode.role) }}</span><span v-else-if="entry"> · {{ evidenceReadStatus(entry.status) }}</span></small><h1>{{ presentation?.heading || '正在读取条目' }}</h1></div><button type="button" @click="returnToLibrary">返回证据库数据图</button></header>
      <div class="page-columns"><article ref="article" class="fixed-article" tabindex="0" aria-label="收录时固定的节点全文"><p v-if="state.detailLoading.value && !relationNode" class="page-state" role="status">正在读取固定快照…</p><template v-else-if="presentation && (entry || relationNode)"><template v-if="relationNode"><div class="relation-role">{{ evidenceReadRelationRole(relationNode.role) }}</div><p class="snapshot-note">原节点版本 {{ relationNode.ref.revision }} · 保存于 {{ state.relations.value?.snapshot?.capturedAt }}</p></template><template v-else-if="entry"><div class="fixed-judgment" :class="{ false: entry.confidence === 0 }">{{ evidenceReadJudgment(entry.confidence) }}</div><p class="snapshot-note">原事实版本 {{ entry.claim.origin.revision }} · 收录于 {{ entry.collectedAt }}</p></template><DataPayloadView :fields="presentation.fields" /><EvidenceRelationDetails v-if="state.relations.value" :view="state.relations.value" :node-key="relationNode?.key ?? state.relations.value.snapshot?.rootKey ?? null" :catalog="catalog" /></template><p v-else class="page-state">{{ EvidencePresentationMessage.ENTRY_UNAVAILABLE }}</p></article><EvidenceEntryDetails :gateway="gateway" :uses-context="pageUsesContext" :entry="entry" :relation-node="relationNode" :catalog="catalog" :loading="state.detailLoading.value" :error="null" :can-edit="canEdit" :busy="state.busy.value || state.canRetry.value" :show-page-link="false" :show-content="false" :show-relations="false" @open-source="emit('openSource', $event)" @open-basis="emit('openBasis', $event)" @withdraw="withdrawEntry" @unauthorized="emit('unauthorized')" @open-consumer="emit('openConsumer', $event)" @selection-changed="emit('selectionChanged')" /></div>
    </section>
    </div>
  </section>
</template>

<style scoped>
.collection-outcome { display: grid; flex: none; gap: 8px; max-height: 220px; overflow: auto; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-related); font-size: 12px; line-height: 1.7; }
.collection-outcome>header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.collection-outcome button { justify-self: start; padding: 4px 8px; font-size: 11px; }
.collection-outcome summary { width: fit-content; cursor: pointer; color: var(--text-muted); }
.collection-conflicts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.collection-state-note { color: var(--text-muted); font-size: 11px; }
.relations-status{display:flex;align-items:center;flex-wrap:wrap;gap:8px 14px;min-height:30px;padding:6px 16px;border-bottom:1px solid var(--border);background:var(--bg-related);color:var(--text-muted);font-size:11px;line-height:1.7}.relations-status.truncated{background:var(--bg-warning);color:var(--warning)}.relations-status button{padding:3px 7px;font-size:11px}.relation-error{color:var(--danger);overflow-wrap:anywhere}.relation-role{width:fit-content;padding:6px 9px;border:1px solid var(--border-evidence);border-radius:var(--radius-evidence);color:var(--text-muted);background:var(--bg-related);font-size:12px;font-weight:650}
.evidence-library{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;overflow:hidden;background:var(--bg-viewport);color:var(--text)}.search-toolbar{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--border);background:var(--bg-panel)}.search-toolbar label{display:grid;gap:5px;min-width:100px;flex:1;color:var(--text-muted);font-size:10px}.search-toolbar .keyword{flex:2;min-width:160px}.search-toolbar input:not([type=checkbox]),.search-toolbar select{width:100%;min-height:30px;padding:5px 7px;font-size:11px}.search-toolbar .history{display:flex;align-items:center;gap:6px;flex:none;min-height:30px;font-size:11px}.search-toolbar button{min-height:30px;padding:5px 10px;font-size:11px}.map-body{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column}.loaded-status{display:flex;align-items:center;flex-wrap:wrap;gap:12px;min-height:38px;padding:6px 16px;border-top:1px solid var(--border);color:var(--text-muted);font-size:11px;background:var(--bg-panel)}.loaded-status button{margin-left:auto;padding:4px 9px;font-size:11px}.revision,.end-label{font-size:10px}.end-label{margin-left:auto}.error-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border);background:var(--bg-warning);color:var(--danger);font-size:12px;line-height:1.7}.error-bar p{flex:1;min-width:180px;overflow-wrap:anywhere}.error-bar button{padding:4px 7px;font-size:11px}.fixed-page{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;overflow:hidden}.page-header{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:62px;padding:9px 20px;border-bottom:1px solid var(--border)}.page-header>div{display:grid;gap:4px;min-width:0}.page-header small{color:var(--text-muted);font-size:11px}.page-header h1{overflow:hidden;font:600 18px/1.5 var(--content-font);text-overflow:ellipsis;white-space:nowrap}.page-header button{flex:none;padding:6px 9px;font-size:12px}.page-columns{display:grid;flex:1;min-height:0;grid-template-columns:minmax(0,1fr) minmax(260px,34%)}.fixed-article{overflow:auto;min-width:0;padding:var(--reader-padding);border-right:1px solid var(--border);outline:none}.fixed-article:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}.fixed-judgment{width:fit-content;padding:6px 9px;border:1px solid color-mix(in srgb,var(--success) 30%,var(--border));border-radius:var(--radius-evidence);color:var(--success);background:color-mix(in srgb,var(--success) 5%,var(--bg-panel));font-size:12px;font-weight:650}.fixed-judgment.false{border-color:color-mix(in srgb,var(--danger) 30%,var(--border));color:var(--danger);background:color-mix(in srgb,var(--danger) 5%,var(--bg-panel))}.snapshot-note,.page-state{margin:10px 0 22px;color:var(--text-muted);font-size:11px;line-height:1.8}.page-state{font-size:13px}@media(max-width:780px){.search-toolbar{gap:7px;padding:10px}.page-header{padding:9px 12px}.page-columns{grid-template-columns:minmax(0,1fr) minmax(210px,38%)}.revision{display:none}}
/* 后台读取、分页和提示内容不改变画布的可用几何；长说明在各自区域内滚动。 */
.library-content{position:relative;display:flex;flex:1;min-width:0;min-height:0;overflow:hidden}
.library-notices{position:absolute;z-index:5;bottom:54px;right:8px;width:min(460px,calc(100% - 16px));max-height:max(0px,min(220px,50%,calc(100% - 54px)));overflow:auto;border:1px solid var(--border);background:var(--bg-panel);box-shadow:0 3px 12px #00000012}
.library-notices .collection-outcome{max-height:none;overflow:visible}
.search-toolbar{flex:none}
.search-toolbar>button{flex:0 0 76px;width:76px;white-space:nowrap}
.relations-status{flex:none;height:38px;min-height:38px;flex-wrap:nowrap;overflow:hidden}
.relations-message{flex:1;min-width:0;max-height:100%;overflow:auto;overflow-wrap:anywhere}
.relations-status>button{flex:none;min-height:26px;white-space:nowrap}
.loaded-status{flex:0 0 46px;height:46px;min-height:46px;flex-wrap:nowrap;overflow:hidden}
.loaded-status>span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.loaded-status>button{flex:none;white-space:nowrap}
</style>
