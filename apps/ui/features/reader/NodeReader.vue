<!-- 单页阅读：完整呈现选中节点，并导航至真实的一跳关系。 -->
<script setup lang="ts">
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import type { EvidenceLibraryRef } from '../../../../contracts/evidence-library'
import type { DataTypeDefinition } from '../../../../contracts/data-definition'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { NodeIdentity } from '../graph/node-identity'
import { nodeReadOrigin, type OperationOriginOpen } from '../graph/node-origin'
import NodeProvenance from '../graph/NodeProvenance.vue'
import { payloadReadPointer } from '../graph/data-payload'
import type { WorkspaceReaderBookmark } from '../workspace/use-workspace-view'
import DataPayloadView from './DataPayloadView.vue'
import SourceAnchorEditor from './SourceAnchorEditor.vue'
import { uiReadErrorMessage } from '../../presentation/ui-labels'
import { readerFindDefinition, readerReadFieldLabel, readerReadFields, readerReadHeading, readerReadRelations, readerReadState } from './reader-content'
import { readerReadSourceNotes, readerReadLineMarkers, readerReadFocusStatus, type ReaderSourceFocus, type ReaderSourceNote, type ReaderSourceSave } from './reader-sources'

const props = defineProps<{
  active: boolean
  userId: string | null
  identity: NodeIdentity | null
  snapshot: GraphSnapshot | null
  catalog: Parameters<typeof readerFindDefinition>[1]
  bookmark: WorkspaceReaderBookmark | null
  loading: boolean
  errorMessage: string | null
  canEdit: boolean
  busy: boolean
  sourceFocus: ReaderSourceFocus | null
  libraryAvailable?: boolean
  historyAvailable?: boolean
}>()

const emit = defineEmits<{
  bookmark: [identity: NodeIdentity, value: WorkspaceReaderBookmark]
  openNode: [identity: NodeIdentity]
  returnToMap: []
  editNode: [identity: NodeIdentity]
  openSource: [focus: ReaderSourceFocus]
  saveSources: [request: ReaderSourceSave]
  openEvidence: [input: { workspaceId: string; ref: EvidenceLibraryRef }]
  openOperation: [input: OperationOriginOpen]
}>()

const articleScroll = ref<HTMLElement | null>(null)
const readerState = computed(() => readerReadState(props.active, props.loading, props.errorMessage, props.identity, props.snapshot))
const node = computed(() => /* 就绪状态已经持有与身份匹配的节点。 */ readerState.value.status === 'ready' ? readerState.value.node : null)
const definitionsInRuns = computed(() => props.snapshot?.runs ?? [])
const definition = computed((): DataTypeDefinition | undefined =>
  node.value ? readerFindDefinition(node.value, props.catalog, definitionsInRuns.value) : undefined)
const heading = computed(() => node.value ? readerReadHeading(node.value, definition.value) : '')
const fields = computed(() => {
  if (!node.value) return []
  const result = readerReadFields(node.value, definition.value)
  const paths = new Set(lineMarkers.value.map(marker => marker.path))
  if (visibleSourceFocus.value) paths.add(visibleSourceFocus.value.anchor.path)
  for (const path of paths) {
    if (result.some(field => field.path === path)) continue
    const value = payloadReadPointer(node.value.payload, path)
    if (typeof value !== 'string') continue
    const label = readerReadFieldLabel(path, definition.value)
    result.push({ key: path, path, label: `原文片段 · ${label}`, value, displayText: value, kind: 'text', primary: false })
  }
  return result
})
const relations = computed(() => {
  // 关系读取沿用同一份就绪图和身份，公开helper保留独立调用时的身份边界。
  const state = readerState.value
  return state.status === 'ready' ? readerReadRelations(state.snapshot, state.identity, props.catalog) : []
})
const sourceNotes = computed(() => {
  // 来源注释属于就绪状态中的固定节点。
  const state = readerState.value
  return state.status === 'ready' ? readerReadSourceNotes(state.snapshot, state.identity, props.catalog) : []
})
const childNotes = computed(() => {
  // 只为真实下游中已有定位范围的节点建立原文标记。
  const state = readerState.value
  return state.status === 'ready' ? readerReadSourceNotes(state.snapshot, state.identity, props.catalog, 'outgoing')
    .filter((/* 下游实际来源注释。 */ note) => /* 无定位范围不产生行标记。 */ note.ranges.length) : []
})
const lineMarkers = computed(() => readerReadLineMarkers(childNotes.value))
const visibleSourceFocus = computed(() => props.sourceFocus && props.identity
  && props.sourceFocus.target.workspaceId === props.identity.workspaceId && props.sourceFocus.target.mapId === props.identity.mapId
  && props.sourceFocus.target.nodeId === props.identity.nodeId ? props.sourceFocus : null)
const focusStatus = computed(() => readerReadFocusStatus(props.snapshot, visibleSourceFocus.value))
const editingEdgeId = ref<string | null>(null)
let editingRevision = -1
const pendingFocus = ref(false)
let restoreRevision = 0

/**
 * 记录当前节点全文栏的滚动位置，并限定书签身份属于当前登录和页面。
 *
 * @param event 正文 scroll 事件；该事件不把正文内容复制到导航状态。
 */
function readerCaptureBookmark(event: Event): void {
  const identity = props.identity
  const target = event.currentTarget
  if (!identity || !(target instanceof HTMLElement)) return
  emit('bookmark', identity, { scrollTop: target.scrollTop })
}

/**
 * 等节点内容挂载并恢复滚动位置后，把焦点还给正文阅读区。
 */
async function readerRestorePageState(): Promise<void> {
  readerCancelRestore()
  if (!props.active || readerState.value.status !== 'ready') return
  const identity = props.identity
  const bookmark = props.bookmark
  if (!identity) return
  const revision = ++restoreRevision
  await nextTick()
  if (!readerRestoreStillBelongs(identity, revision) || !articleScroll.value) return
  const maximumScroll = Math.max(0, articleScroll.value.scrollHeight - articleScroll.value.clientHeight)
  articleScroll.value.scrollTop = Math.min(bookmark?.scrollTop ?? 0, maximumScroll)
  const focus = visibleSourceFocus.value
  if (focus && focusStatus.value === 'current') {
    const row = articleScroll.value.querySelector<HTMLElement>(`[data-reader-path="${CSS.escape(focus.anchor.path)}"] [data-line-number="${focus.anchor.startLine}"]`)
    if (row) articleScroll.value.scrollTop += row.getBoundingClientRect().top - articleScroll.value.getBoundingClientRect().top - articleScroll.value.clientHeight * 0.25
  }
  if (pendingFocus.value) {
    articleScroll.value.focus({ preventScroll: true })
    pendingFocus.value = false
  }
}

/**
 * 丢弃失效节点、用户或视图的待恢复任务。
 */
function readerCancelRestore(): void {
  // 推进恢复代次，让等待 DOM 更新的旧任务失效。
  restoreRevision++
}

/**
 * 确认恢复请求仍属于显示中的同一个 Workspace/Map/Node。
 *
 * @param identity 恢复开始时绑定的完整节点身份。
 * @param revision 等待 DOM 更新前持有的恢复代次。
 */
function readerRestoreStillBelongs(identity: NodeIdentity, revision: number): boolean {
  return revision === restoreRevision && props.active && props.userId !== null
    && props.identity?.workspaceId === identity.workspaceId
    && props.identity.mapId === identity.mapId && props.identity.nodeId === identity.nodeId
    && readerState.value.status === 'ready'
}

/**
 * 把真实节点关系发给页面，由 WorkspacePage 核对 Map 身份后改变选择。
 *
 * @param identity 来自当前快照真实节点或关系索引的目标身份。
 */
function readerOpenRelation(identity: NodeIdentity): void {
  const current = props.identity
  if (!current || current.workspaceId !== identity.workspaceId || current.mapId !== identity.mapId) return
  if (props.snapshot?.nodes.some(item => item.id === identity.nodeId)) emit('openNode', identity)
}
function readerScrollFootnote(number: number): void {
  const target = articleScroll.value?.querySelector<HTMLElement>(`[data-source-footnote="${number}"]`)
  target?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  target?.focus({ preventScroll: true })
}
function readerEditSources(note: ReaderSourceNote): void {
  editingRevision = note.edgeRevision
  editingEdgeId.value = note.edgeId
}
function readerSaveSources(note: ReaderSourceNote, anchors: ReaderSourceSave['sourceAnchors']): void {
  if (!props.identity || props.busy) return
  emit('saveSources', { mapId: props.identity.mapId, edgeId: note.edgeId, expectedEdgeRevision: editingRevision, sourceAnchors: anchors })
}
watch(() => sourceNotes.value, notes => {
  const note = notes.find(item => item.edgeId === editingEdgeId.value)
  if (!note || note.edgeRevision !== editingRevision) editingEdgeId.value = null
})
watch(() => props.identity, () => { editingEdgeId.value = null })

/**
 * 将单页打开时保存的节点焦点交给正文；缺失或错误页面不抢焦点。
 */
function readerFocusPage(): void {
  if (readerState.value.status !== 'ready') return
  articleScroll.value?.focus({ preventScroll: true })
}

function readerHandleKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return
  const target = event.target
  if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
  event.preventDefault()
  emit('returnToMap')
}

// 正文位置仅随当前页面身份读取，旧用户/Map的书签不会套到新内容上。
watch(() => [props.active, props.userId, props.identity?.workspaceId ?? null,
  props.identity?.mapId ?? null, props.identity?.nodeId ?? null, props.sourceFocus,
  readerState.value.status] as const, () => { void readerRestorePageState() }, { flush: 'post', immediate: true })

// 页面由 Map 聚焦进入后只恢复正文焦点；普通在 Map 切换不让隐藏组件抢焦点。
watch(() => props.active, (active, previous) => {
  if (active && !previous) readerFocusPage()
})

onScopeDispose(readerCancelRestore)
</script>

<template>
  <section class="node-reader" aria-label="单页阅读" @keydown="readerHandleKeydown">
    <template v-if="readerState.status === 'ready'">
      <header class="reader-header">
        <div class="reader-header-copy">
          <span class="reader-kicker" :title="`类型标识：${readerState.node.typeId} · 版本 ${readerState.node.typeVersion}`">{{ definition?.title ?? '数据节点' }} · 版本 {{ readerState.node.typeVersion }} · {{ nodeReadOrigin(readerState.node) }}</span>
          <h1 class="reader-heading">{{ heading }}</h1>
        </div>
        <div class="reader-actions">
          <button class="quiet-action" type="button" @click="emit('returnToMap')">返回关系图</button>
          <button class="quiet-action" type="button" :disabled="!canEdit" @click="emit('editNode', readerState.identity)">在关系图中编辑</button>
        </div>
      </header>

      <div class="reader-columns">
        <section class="reader-article-pane" aria-label="节点完整内容">
          <div ref="articleScroll" class="reader-article-scroll" tabindex="0"
            :aria-label="`${heading} 完整内容`" @scroll.passive="readerCaptureBookmark">
            <p v-if="focusStatus === 'current'" class="source-focus-notice">已定位到来源的{{ visibleSourceFocus?.anchor.startLine === visibleSourceFocus?.anchor.endLine ? `第 ${visibleSourceFocus?.anchor.startLine} 行` : `第 ${visibleSourceFocus?.anchor.startLine}–${visibleSourceFocus?.anchor.endLine} 行` }}。</p>
            <div v-else-if="visibleSourceFocus && focusStatus" class="source-focus-notice stale" role="status"><p>原文版本已变化或定位不可用，以下是标注时的摘录。</p><blockquote>{{ visibleSourceFocus.anchor.quote }}</blockquote></div>
            <p v-if="!fields.length" class="reader-empty-text">这份数据没有可显示的字段。</p>
            <DataPayloadView v-else :fields="fields" :markers="lineMarkers" :focus="focusStatus === 'current' ? visibleSourceFocus?.anchor : null" :source-note-numbers="sourceNotes.map(note => note.number)" @footnote="readerScrollFootnote" @open-node="readerOpenRelation" />

            <NodeProvenance :node="readerState.node" :workspace-id="readerState.identity.workspaceId" :map-id="readerState.identity.mapId" :history-available="historyAvailable === true" @open-operation="emit('openOperation', $event)" />

            <section class="source-footnotes" aria-label="所用固定证据">
              <h2>所用固定证据</h2>
              <p v-if="!readerState.node.libraryClaimRefs?.length" class="source-unlocated">尚未引用固定证据。</p>
              <p v-if="!libraryAvailable" class="source-unlocated">当前服务未提供证据库；已有引用和理由保留。</p>
              <article v-for="(reference, index) in readerState.node.libraryClaimRefs" :key="`${reference.entryId}:${reference.contentDigest}`" class="source-footnote">
                <header><strong :title="`固定条目：${reference.entryId} · 内容摘要：${reference.contentDigest}`">固定证据 {{ index + 1 }}</strong><button type="button" :aria-label="`查看固定证据 ${index + 1}`" :disabled="!libraryAvailable || busy" @click="emit('openEvidence', { workspaceId: readerState.identity.workspaceId, ref: { entryId: reference.entryId, contentDigest: reference.contentDigest } })">查看固定证据</button></header>
                <p class="evidence-reason">{{ reference.reason }}</p>
              </article>
            </section>

            <section v-if="sourceNotes.length" class="source-footnotes" aria-label="来源脚注">
              <h2>来源脚注</h2>
              <article v-for="note in sourceNotes" :key="note.edgeId" class="source-footnote" :data-source-footnote="note.number" tabindex="-1">
                <header><span class="footnote-number">[{{ note.number }}]</span><strong>{{ note.sourceTitle }}</strong><button v-if="canEdit && note.sourceNode" type="button" :disabled="busy" @click="readerEditSources(note)">标注原文行号</button></header>
                <template v-if="note.ranges.length">
                  <div v-for="(range, index) in note.ranges" :key="index" class="source-range">
                    <div class="source-range-meta"><span>{{ range.label }}</span><span>原文版本 {{ range.anchor.sourceRevision }}</span><button type="button" :disabled="!note.sourceNode" @click="emit('openSource', { target: note.source, anchor: range.anchor })">查看原文 ↗</button></div>
                    <blockquote>{{ range.anchor.quote || '（空行）' }}</blockquote>
                    <p v-if="range.status === 'stale'" class="source-version-warning">原文已更新；保留的是标注时的摘录。</p>
                    <p v-else-if="range.status !== 'current'" class="source-version-warning">定位当前不可用，摘录未应用到当前正文。</p>
                  </div>
                </template>
                <p v-else class="source-unlocated">已记录来源节点，尚未标注具体行。<button v-if="note.sourceNode" type="button" @click="readerOpenRelation(note.source)">阅读来源</button></p>
                <SourceAnchorEditor v-if="editingEdgeId === note.edgeId && note.sourceNode" :key="`${note.edgeId}:${editingRevision}`" :source="note.sourceNode" :definition="note.sourceDefinition" :anchors="note.ranges.map(range => range.anchor)" :busy="busy" @cancel="editingEdgeId = null" @save="readerSaveSources(note, $event)" />
              </article>
            </section>

            <section v-if="childNotes.length" class="source-footnotes child-footnotes" aria-label="由原文提取的节点">
              <h2>由原文提取</h2>
              <article v-for="note in childNotes" :key="note.edgeId" class="child-footnote"><button type="button" @click="readerOpenRelation(note.child)"><span class="footnote-number">[{{ note.number }}]</span>{{ note.childTitle }}</button><p>{{ note.ranges.map(range => range.label).join('、') }}</p><small>{{ note.childSummary }}</small></article>
            </section>
          </div>
        </section>

        <aside class="reader-related-pane" aria-label="关联材料">
          <header class="related-header">
            <h2>关联材料</h2><span>{{ relations.length }}</span>
          </header>
          <div class="related-scroll">
            <p v-if="!relations.length" class="reader-related-empty">此节点没有已登记的一跳关系。</p>
            <article v-for="relation in relations" :key="relation.key" class="related-entry">
              <div class="related-entry-meta">
                <span>{{ relation.label }}</span><span>{{ relation.kind === 'successor' ? '结构关系' : '引用关系' }}</span>
              </div>
              <p v-if="relation.path" class="related-entry-path" :title="`字段路径：${relation.path}`">引用字段：{{ readerReadFieldLabel(relation.path, definition) }}</p>
              <button v-if="relation.available" class="related-node-link" type="button"
                @click="readerOpenRelation(relation.target)">{{ relation.title }}</button>
              <p v-else class="related-unavailable">关联目标暂不可用：{{ relation.target.nodeId }}</p>
            </article>
          </div>
        </aside>
      </div>
    </template>

    <section v-else-if="readerState.status === 'loading'" class="reader-state" role="status">
      <h1>正在读取单页</h1><p>等待当前数据图的节点快照。</p>
      <button class="quiet-action" type="button" @click="emit('returnToMap')">返回关系图</button>
    </section>
    <section v-else-if="readerState.status === 'empty'" class="reader-state" aria-label="空数据图">
      <h1>这张数据图还是空的</h1><p>添加一份数据后，就可以在这里阅读完整内容与关联材料。</p>
      <button class="quiet-action" type="button" @click="emit('returnToMap')">返回关系图</button>
    </section>
    <section v-else-if="readerState.status === 'missing'" class="reader-state" role="status">
      <h1>这个节点当前不可用</h1><p>所选节点已不在当前数据图的快照中。</p>
      <button class="quiet-action" type="button" @click="emit('returnToMap')">返回关系图</button>
    </section>
    <section v-else-if="readerState.status === 'error'" class="reader-state" role="alert">
      <h1>无法读取单页</h1><p :title="errorMessage ?? undefined">{{ errorMessage ? uiReadErrorMessage(errorMessage) : '当前数据不可用。' }}</p>
      <button class="quiet-action" type="button" @click="emit('returnToMap')">返回关系图</button>
    </section>
    <section v-else class="reader-state" aria-label="等待选择节点">
      <h1>从关系图选择一份数据</h1><p>单页展示选中节点及其真实关联材料。</p>
      <button class="quiet-action" type="button" @click="emit('returnToMap')">返回关系图</button>
    </section>
  </section>
</template>

<style scoped>
.evidence-reason{white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.8;font-family:var(--content-font)}
/* Map 与单页使用同一暖纸主题，以排版和区块职责区分整体/局部视图。 */
.node-reader { display: flex; width: 100%; height: 100%; min-width: 0; min-height: 0; flex-direction: column; overflow: hidden; background: var(--bg-viewport); color: var(--text); }
.reader-header { display: flex; min-height: var(--reader-head-height); align-items: center; justify-content: space-between; gap: 16px; padding: 8px 20px; border-bottom: 1px solid var(--border); background: var(--bg-viewport); }
.reader-header-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.reader-kicker { overflow: hidden; color: var(--text-muted); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
.reader-heading { overflow: hidden; color: var(--text); font-family: var(--content-font); font-size: 18px; font-weight: 600; line-height: 1.4; text-overflow: ellipsis; white-space: nowrap; }
.reader-actions { display: flex; flex: none; flex-wrap: wrap; gap: 8px; }
.quiet-action { min-height: 34px; padding: 6px 10px; border-color: var(--border); background: var(--bg-input); color: var(--text); font-size: 13px; }
.quiet-action:hover:not(:disabled), .related-node-link:hover:not(:disabled) { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.reader-columns { display: grid; min-height: 0; flex: 1; grid-template-columns: minmax(0, 60%) minmax(0, 1fr); }
.reader-article-pane { min-width: 0; min-height: 0; border-right: 1px solid var(--border); background: var(--bg-viewport); }
.reader-article-scroll { width: 100%; height: 100%; overflow: auto; padding: var(--reader-padding); overscroll-behavior: contain; }
.reader-article-scroll:focus-visible { outline-offset: -2px; }
.reader-related-pane { display: flex; min-width: 0; min-height: 0; flex-direction: column; background: var(--bg-related); }
.related-header { display: flex; height: 48px; min-height: 48px; align-items: center; justify-content: space-between; padding: 0 18px; border-bottom: 1px solid var(--border); }
.related-header h2 { font-size: 14px; font-weight: 600; }
.related-header>span { color: var(--text-muted); font-size: 12px; }
.related-scroll { min-height: 0; flex: 1; overflow: auto; padding: var(--related-padding); overscroll-behavior: contain; }
.related-scroll>p, .reader-empty-text { color: var(--text-muted); font-size: 13px; line-height: 1.8; }
.related-entry { display: grid; gap: 7px; min-width: 0; padding: 12px 0; border-bottom: 1px solid var(--border); }
.related-entry-meta { display: flex; flex-wrap: wrap; gap: 8px; color: var(--text-muted); font-size: 12px; }
.related-entry-meta>span+span::before { margin-right: 8px; color: var(--border); content: '·'; }
.related-entry-path { color: var(--text-muted); font: 12px/1.5 var(--ui-font); overflow-wrap: anywhere; }
.related-node-link { width: fit-content; max-width: 100%; min-width: 0; padding: 4px 6px; border-color: transparent; background: transparent; text-align: left; white-space: normal; overflow-wrap: anywhere; }
.related-unavailable { color: var(--text-muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.reader-state { display: flex; min-width: 0; min-height: 0; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; }
.reader-state h1 { color: var(--text); font-family: var(--content-font); font-size: 24px; font-weight: 500; }
.reader-state p { max-width: 42rem; color: var(--text-muted); font-size: 14px; line-height: 1.8; overflow-wrap: anywhere; }
.reader-state [role='alert'] { color: var(--danger); }
.source-footnotes { margin-top:28px; padding-top:18px; border-top:1px solid var(--border-evidence); }
.source-footnotes h2 { margin-bottom:12px; color:var(--text-muted); font-size:13px; font-weight:600; }
.source-footnote { display:grid; gap:10px; padding:13px 0; border-bottom:1px solid var(--border); outline:none; }
.source-footnote:focus-visible { outline:1px solid var(--accent); outline-offset:4px; }
.source-footnote>header { display:flex; align-items:baseline; flex-wrap:wrap; gap:8px; }
.source-footnote strong { font-size:13px; font-weight:600; }
.footnote-number { margin-right:5px; color:var(--accent); font:11px var(--ui-font); }
.source-footnote button,.child-footnote button { padding:3px 5px; border:0; background:transparent; color:var(--accent); font-size:11px; text-align:left; }
.source-footnote>header button { margin-left:auto; }
.source-range { display:grid; gap:6px; padding:10px 12px; border-left:2px solid var(--border-evidence); background:var(--bg-related); }
.source-range-meta { display:flex; flex-wrap:wrap; align-items:baseline; gap:8px; color:var(--text-muted); font-size:11px; }
.source-range blockquote,.source-focus-notice blockquote { white-space:pre-wrap; overflow-wrap:anywhere; font:var(--reader-quote-size)/var(--reader-quote-line-height) var(--content-font); }
.source-version-warning,.source-unlocated { color:var(--text-muted); font-size:11px; line-height:1.7; }
.source-focus-notice { margin-bottom:14px; padding:9px 11px; border-left:2px solid var(--accent); background:var(--accent-soft); color:var(--accent); font-size:11px; line-height:1.7; }
.source-focus-notice.stale { color:var(--warning); background:var(--bg-warning); }
.source-focus-notice blockquote { margin-top:7px; }
.child-footnote { display:grid; gap:4px; padding:10px 0; border-bottom:1px solid var(--border); }
.child-footnote p,.child-footnote small { color:var(--text-muted); font-size:11px; line-height:1.7; white-space:pre-wrap; overflow-wrap:anywhere; }
@media (max-width: 1150px) {
  .reader-header { padding-right: 16px; padding-left: 16px; }
  .related-header { padding-right: 16px; padding-left: 16px; }
}
@media (max-width: 760px) {
  .reader-columns { grid-template-columns: minmax(0, 55%) minmax(0, 1fr); }
  .reader-actions { gap: 5px; }
  .quiet-action { padding-right: 7px; padding-left: 7px; }
}
</style>
