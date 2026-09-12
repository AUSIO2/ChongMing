<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { GraphNode, GraphNodeData, GraphSnapshot } from '../../../contracts/graph'
import { GRAPH_KIND_LABELS, graphReadNodeText, graphReadScore } from './graph-layout'

const props = defineProps<{ snapshot: GraphSnapshot; selectedId: string | null; canEdit: boolean; busy: boolean }>()
const emit = defineEmits<{
  save: [input: { expectedRevision: number; nodeId: string; data: GraphNodeData }]
  remove: [input: { expectedRevision: number; nodeId: string }]
  verify: [input: { targetId: string; mode: 'auto' | 'human-in-loop' }]
  linkSources: [input: { expectedRevision: number; claimId: string; newsIds: string[] }]
}>()

interface EditorDraft {
  nodeId: string; kind: 'news' | 'claim'; content: string; category: string
  context: Array<{ id: string; key: string; value: string; visibleToAI: boolean }>
}
type VerificationNode = GraphNode & { data: Extract<GraphNodeData, { kind: 'verification' }> }
const selected = computed(() => props.snapshot.nodes.find(node => node.id === props.selectedId) ?? null)
const activeRun = computed(() => !!props.snapshot.run && ['running', 'waiting'].includes(props.snapshot.run.status))
const editable = computed(() => props.canEdit && !props.busy && !activeRun.value && !!selected.value)
const editor = ref<EditorDraft | null>(null)
const baseContent = ref('')
const contentRevision = ref(0)
const sourceIds = ref<string[]>([])
const baseSources = ref('[]')
const sourceRevision = ref(0)
const pendingContent = ref<string | null>(null)
const pendingSources = ref<string | null>(null)
const mode = ref<'auto' | 'human-in-loop'>('human-in-loop')
const news = computed(() => props.snapshot.nodes.filter(node => node.data.kind === 'news'))
const sortedSources = computed(() => JSON.stringify([...sourceIds.value].sort()))
const sourcesDirty = computed(() => sortedSources.value !== baseSources.value)
const serializedContent = computed(() => JSON.stringify(inspectorReadData()))
const contentDirty = computed(() => !!editor.value && serializedContent.value !== baseContent.value)
const dirty = computed(() => contentDirty.value || sourcesDirty.value)
const versionChanged = computed(() => (contentDirty.value && contentRevision.value !== props.snapshot.revision)
  || (sourcesDirty.value && sourceRevision.value !== props.snapshot.revision))
const missingSources = computed(() => sourceIds.value.filter(id => !news.value.some(node => node.id === id)))
const contentError = computed(() => {
  const draft = editor.value
  if (!draft) return ''
  if (!draft.content.trim()) return '正文不能为空。'
  if (draft.kind === 'news') {
    const keys = draft.context.map(field => field.key.trim())
    if (keys.some(key => !key)) return '请为每个上下文字段填写名称。'
    if (new Set(keys).size !== keys.length) return '上下文字段名称不能重复。'
  }
  return ''
})
const results = computed(() => {
  const ids = new Set(props.snapshot.edges.filter(edge => edge.kind === 'verifies' && edge.to === selected.value?.id).map(edge => edge.from))
  return props.snapshot.nodes.filter((node): node is VerificationNode => node.data.kind === 'verification' && ids.has(node.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
})

function inspectorReadData(): GraphNodeData | null {
  const draft = editor.value
  if (!draft) return null
  return draft.kind === 'claim'
    ? { kind: 'claim', content: draft.content, category: draft.category.trim() || null }
    : { kind: 'news', content: draft.content, context: Object.fromEntries(draft.context.map(field => [field.key.trim(), { value: field.value, visibleToAI: field.visibleToAI }])) }
}
function inspectorReadSources(): string[] {
  return [...new Set(props.snapshot.edges.filter(edge => edge.kind === 'mentions' && edge.to === selected.value?.id).map(edge => edge.from))].sort()
}
function inspectorLoadContent(): void {
  const node = selected.value
  if (node?.data.kind === 'news' || node?.data.kind === 'claim') {
    const data = node.data
    editor.value = { nodeId: node.id, kind: data.kind, content: data.content, category: data.kind === 'claim' ? data.category ?? '' : '',
      context: data.kind === 'news' ? Object.entries(data.context).map(([key, field]) => ({ id: crypto.randomUUID(), key, ...field })) : [] }
  } else editor.value = null
  baseContent.value = JSON.stringify(inspectorReadData())
  contentRevision.value = props.snapshot.revision
  pendingContent.value = null
}
function inspectorLoadSources(): void {
  sourceIds.value = selected.value?.data.kind === 'claim' ? inspectorReadSources() : []
  baseSources.value = JSON.stringify(sourceIds.value)
  sourceRevision.value = props.snapshot.revision
  pendingSources.value = null
}
function inspectorReloadDraft(): void { inspectorLoadContent(); inspectorLoadSources() }
function inspectorAdoptVersion(): void {
  if (!selected.value) return
  contentRevision.value = props.snapshot.revision
  sourceRevision.value = props.snapshot.revision
}
watch(() => [props.snapshot.mapId, props.selectedId, props.snapshot.revision] as const, (current, previous) => {
  if (!previous || current[0] !== previous[0] || current[1] !== previous[1]) { inspectorReloadDraft(); return }
  const data = selected.value?.data
  if (!contentDirty.value || (pendingContent.value !== null && pendingContent.value === serializedContent.value && JSON.stringify(data) === pendingContent.value)) inspectorLoadContent()
  const currentSources = JSON.stringify(inspectorReadSources())
  if (!sourcesDirty.value || (pendingSources.value !== null && pendingSources.value === sortedSources.value && currentSources === pendingSources.value)) inspectorLoadSources()
}, { immediate: true })

function inspectorSaveNode(): void {
  const data = inspectorReadData()
  if (!editor.value || !data || !editable.value || contentError.value || versionChanged.value) return
  pendingContent.value = JSON.stringify(data)
  emit('save', { expectedRevision: contentRevision.value, nodeId: editor.value.nodeId, data })
}
function inspectorSaveSources(): void {
  if (selected.value?.data.kind !== 'claim' || !editable.value || versionChanged.value || missingSources.value.length) return
  pendingSources.value = sortedSources.value
  emit('linkSources', { expectedRevision: sourceRevision.value, claimId: selected.value.id, newsIds: [...sourceIds.value].sort() })
}
function inspectorAddContext(): void {
  editor.value?.context.push({ id: crypto.randomUUID(), key: '', value: '', visibleToAI: true })
}
function inspectorRemoveNode(): void {
  if (!selected.value || !editable.value || dirty.value || versionChanged.value) return
  emit('remove', { expectedRevision: contentRevision.value, nodeId: selected.value.id })
}
</script>

<template>
  <section class="node-inspector" aria-label="节点详情">
    <header class="inspector-header"><h2>{{ selected ? GRAPH_KIND_LABELS[selected.data.kind] : '节点详情' }}</h2><span v-if="dirty" class="draft-tag">未保存</span></header>
    <div v-if="!selected && !editor" class="inspector-empty">选择一个节点，查看正文、来源与核查结果。</div>
    <div v-else class="inspector-content">
      <div v-if="versionChanged || (!selected && editor)" class="conflict-notice" role="status">
        <strong>{{ selected ? '服务器数据已变化，草稿已保留。' : '这个节点已不在当前图中，草稿已保留。' }}</strong>
        <p>重新载入会丢弃草稿；采用当前版本会保留你的输入，供你确认后再次保存。</p>
        <div class="button-row">
          <button type="button" :disabled="busy" @click="inspectorReloadDraft">重新载入</button>
          <button v-if="selected" type="button" :disabled="busy || !canEdit" @click="inspectorAdoptVersion">保留草稿，采用当前版本</button>
        </div>
      </div>
      <p v-if="activeRun" class="context-note">核查进行期间，正文与来源保持固定；请在核查与审核区域处理待审事项。</p>
      <p v-else-if="!canEdit" class="context-note">当前为只读权限。</p>
      <form v-if="editor" class="node-form" @submit.prevent="inspectorSaveNode">
        <label class="field"><span>{{ editor.kind === 'claim' ? '可核查陈述' : '新闻正文' }}</span>
          <textarea v-model="editor.content" :readonly="!editable" rows="6" :aria-label="editor.kind === 'claim' ? '可核查陈述' : '新闻正文'" />
        </label>
        <label v-if="editor.kind === 'claim'" class="field"><span>类别 <small>可选</small></span>
          <input v-model="editor.category" :readonly="!editable" placeholder="如：数据、引述、因果" aria-label="事实类别">
        </label>
        <div v-if="editor.kind === 'news'" class="context-section">
          <div class="section-title"><h3>上下文</h3><button v-if="canEdit" type="button" :disabled="!editable" @click="inspectorAddContext">添加字段</button></div>
          <p class="context-note">例如发布时间、发布者和背景信息。仅勾选的字段会提供给智能体。</p>
          <div v-for="(field, index) in editor.context" :key="field.id" class="context-field">
            <div class="context-field-head"><input v-model="field.key" :readonly="!editable" placeholder="字段名称" :aria-label="`上下文字段 ${index + 1} 名称`"><button v-if="canEdit" type="button" :disabled="!editable" :aria-label="`移除上下文字段 ${index + 1}`" @click="editor.context.splice(index, 1)">×</button></div>
            <textarea v-model="field.value" :readonly="!editable" rows="2" :aria-label="`上下文字段 ${index + 1} 内容`" />
            <label class="check-row"><input v-model="field.visibleToAI" type="checkbox" :disabled="!editable">提供给智能体</label>
          </div>
        </div>
        <p v-if="contentError && contentDirty" class="field-error" role="alert">{{ contentError }}</p>
        <div v-if="canEdit" class="button-row">
          <button class="primary" type="submit" :disabled="!editable || !contentDirty || !!contentError || versionChanged">保存正文</button>
          <button type="button" :disabled="busy || !contentDirty" @click="inspectorLoadContent">恢复已保存内容</button>
        </div>
      </form>

      <section v-if="selected?.data.kind === 'claim'" class="detail-section">
        <div class="section-title"><h3>关联新闻</h3><span>{{ sourceIds.length }} 篇</span></div>
        <p v-if="!news.length" class="context-note">可以先独立核查，也可以新建新闻后补充来源。</p>
        <div class="source-list">
          <label v-for="item in news" :key="item.id" class="source-choice">
            <input v-model="sourceIds" type="checkbox" :value="item.id" :disabled="!editable">
            <span>{{ graphReadNodeText(item) }}</span>
          </label>
        </div>
        <p v-if="missingSources.length" class="field-error">有来源已不存在。<button type="button" @click="sourceIds = sourceIds.filter(id => !missingSources.includes(id))">移除不可用来源</button></p>
        <div v-if="canEdit" class="button-row"><button type="button" :disabled="!editable || !sourcesDirty || versionChanged || !!missingSources.length" @click="inspectorSaveSources">保存来源关联</button><button type="button" :disabled="busy || !sourcesDirty" @click="inspectorLoadSources">恢复来源关联</button></div>
      </section>

      <section v-if="selected?.data.kind === 'claim' && canEdit" class="detail-section verify-section">
        <h3>核查这条事实</h3>
        <label class="field"><span>处理方式</span><select v-model="mode" :disabled="busy || activeRun"><option value="human-in-loop">人工审核角度与结论</option><option value="auto">自动路由并保存结论</option></select></label>
        <p v-if="dirty" class="context-note">请先保存正文和来源草稿，再开始核查。</p>
        <button class="primary verify-button" type="button" :disabled="!editable || dirty" @click="emit('verify', { targetId: selected.id, mode })">{{ results.length ? '重新核查' : '开始核查' }}</button>
      </section>

      <section v-if="selected?.data.kind === 'source' || selected?.data.kind === 'evidence'" class="detail-section">
        <p v-if="selected.data.kind === 'evidence'" class="prose">{{ selected.data.content }}</p>
        <p v-else class="prose">{{ selected.data.label || '来源资料' }}</p>
        <label class="field"><span>{{ selected.data.locator.kind === 'url' ? '来源地址' : '来源文件' }}</span><p class="locator">{{ selected.data.locator.kind === 'url' ? selected.data.locator.url : `已上传 · ${selected.data.locator.mediaType}` }}</p></label>
        <p class="context-note">此类资料在本次工作台中只读。</p>
      </section>

      <section v-if="selected?.data.kind === 'verification'" class="detail-section">
        <div class="result-heading"><strong :class="`score-${String(selected.data.score).replace('.', '_')}`">{{ graphReadScore(selected.data.score) }}</strong><span>已保存结论</span></div>
        <p v-if="selected.validity === 'stale'" class="context-note">这份历史结论需要复核。</p>
        <p class="prose">{{ selected.data.reason }}</p>
        <h3>各角度意见 · {{ selected.data.opinions.length }}</h3>
        <details v-for="opinion in selected.data.opinions" :key="opinion.id" class="opinion-card">
          <summary><span>{{ opinion.angle }}</span><strong :class="`score-${String(opinion.score).replace('.', '_')}`">{{ graphReadScore(opinion.score) }}</strong></summary>
          <p class="opinion-agent">{{ opinion.agentName }}</p><p class="prose">{{ opinion.reason }}</p>
          <p v-if="opinion.tools.length" class="context-note">工具范围：{{ opinion.tools.join('、') }}</p>
        </details>
      </section>

      <section v-if="results.length" class="detail-section">
        <h3>关联结论 · {{ results.length }}</h3>
        <details v-for="(result, index) in results" :key="result.id" class="opinion-card" :open="index === 0">
          <summary><span>{{ index === 0 ? '最近一次核查' : '历史核查' }}</span><strong :class="`score-${String(result.data.score).replace('.', '_')}`">{{ graphReadScore(result.data.score) }}</strong></summary>
          <p v-if="result.validity === 'stale'" class="context-note">需要复核</p><p class="prose">{{ result.data.reason }}</p>
          <div v-for="opinion in result.data.opinions" :key="opinion.id" class="compact-opinion"><strong>{{ opinion.angle }} · {{ graphReadScore(opinion.score) }}</strong><p>{{ opinion.agentName }}</p><p class="prose">{{ opinion.reason }}</p></div>
        </details>
      </section>
      <footer v-if="selected && canEdit" class="inspector-footer"><button class="danger-button" type="button" :disabled="!editable || dirty || versionChanged" :title="dirty ? '请先保存或恢复草稿' : '删除这个节点，保留其他共享数据'" @click="inspectorRemoveNode">删除节点</button></footer>
    </div>
  </section>
</template>

<style scoped>
.node-inspector { min-width: 0; background: var(--bg-panel); }
.inspector-header { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border-subtle); }
h2 { font-size: 14px; font-weight: 600; }h3 { font-size: 12px; font-weight: 600; }
.draft-tag { color: var(--warning); font-size: 11px; }.inspector-empty { padding: 22px 16px; color: var(--text-muted); line-height: 1.7; }
.inspector-content { padding: 12px 14px; }.node-form { display: grid; gap: 12px; }
.field { display: grid; gap: 6px; font-size: 12px; }.field > span { color: var(--text-muted); }.field small { color: var(--text-dim); font-weight: 400; }
.field textarea { font: 14px/1.6 var(--content-font); padding: 8px; min-height: 100px; }.field input, .field select { padding: 6px 8px; min-height: 30px; }
input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.button-row { display: flex; flex-wrap: wrap; gap: 6px; }.button-row button, .detail-section > button { min-height: 28px; }
.detail-section { border-top: 1px solid var(--border-subtle); margin-top: 16px; padding-top: 14px; display: grid; gap: 10px; }
.section-title { display: flex; align-items: center; justify-content: space-between; gap: 8px; }.section-title > span { color: var(--text-muted); }
.context-note { font-size: 11px; color: var(--text-muted); line-height: 1.6; margin-bottom: 5px; }.context-section { display: grid; gap: 8px; }
.context-field { display: grid; gap: 6px; padding: 9px; border: 1px solid var(--border-subtle); background: var(--bg-input); border-radius: 4px; }
.context-field-head { display: flex; gap: 5px; }.context-field textarea { line-height: 1.5; padding: 5px; }.check-row { display: flex; align-items: center; gap: 6px; font-size: 11px; }
.source-list { max-height: 210px; overflow: auto; display: grid; gap: 5px; }.source-choice { display: flex; align-items: flex-start; gap: 8px; padding: 8px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--bg-input); cursor: pointer; }
.source-choice span { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; font: 12px/1.5 var(--content-font); }.source-choice input { margin-top: 2px; }
.field-error { color: var(--danger); font-size: 11px; line-height: 1.5; }.verify-button { width: 100%; min-height: 32px; }
.prose { white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.65 var(--content-font); }.locator { overflow-wrap: anywhere; line-height: 1.6; }
.result-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }.result-heading strong { font-size: 22px; }.result-heading span { color: var(--text-muted); }
.opinion-card { border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--flow-node-bg); padding: 9px; }.opinion-card summary { display: flex; justify-content: space-between; gap: 8px; cursor: pointer; line-height: 1.5; }.opinion-card summary span { flex: 1; }.opinion-card summary strong { flex-shrink: 0; }.opinion-card > .prose { margin-top: 8px; }.opinion-agent { color: var(--text-muted); margin: 8px 0 5px; }
.compact-opinion { margin-top: 10px; border-top: 1px solid var(--border-subtle); padding-top: 8px; line-height: 1.6; }.compact-opinion > p:not(.prose) { color: var(--text-muted); margin-bottom: 4px; }
.conflict-notice { padding: 10px; margin-bottom: 12px; border: 1px solid var(--warning); background: #fff8e9; line-height: 1.6; }.conflict-notice p { margin: 5px 0 8px; font-size: 11px; }
.inspector-footer { border-top: 1px solid var(--border-subtle); margin-top: 18px; padding-top: 12px; }.danger-button { color: var(--danger); background: transparent; }
</style>
