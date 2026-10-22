<!-- 图旁栏和固定单页共用的保存关系说明；来源正文只读关系包，不访问当前图。 -->
<script setup lang="ts">
import { computed, ref, watch } from 'vue'

import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { EvidenceRelationsView } from '../../../../contracts/evidence-library'
import { payloadReadPointer } from '../graph/data-payload'
import DataPayloadView from '../reader/DataPayloadView.vue'
import { readerFindDefinition, readerReadFieldLabel, type ReaderField } from '../reader/reader-content'
import { evidenceReadFixedSourceNotes, evidenceReadRelationDetails, evidenceReadRelationNotice, evidenceReadRelationPresentation } from './evidence-presentation'

const props = withDefaults(defineProps<{
  view: EvidenceRelationsView
  nodeKey?: string | null
  catalog?: DefinitionCatalog | null
}>(), { nodeKey: null, catalog: null })
const sourceChoice = ref<{ relationKey: string; rangeIndex: number } | null>(null)
const details = computed(() => /* 两种视图使用同一份关系说明，不从节点角色反推边类型。 */
  evidenceReadRelationDetails(props.view, props.nodeKey, props.catalog))
const notes = computed(() => /* 所有行定位仅从本包保存的真实后继边取得。 */ evidenceReadFixedSourceNotes(props.view, props.nodeKey))
const rows = computed(() => {
  // 一条真实边对应一行及可选脚注，不把平行关系合并。
  const byKey = new Map(notes.value.map((/* 当前节点相邻的来源脚注。 */ note) => /* 用原关系key配对。 */ [note.relationKey, note]))
  return details.value.map((/* 共用关系投影。 */ item) => /* 仅合并显示材料，不建立另一个关系状态。 */ ({ ...item, sourceNote: byKey.get(item.key) ?? null }))
})
const notice = computed(() => /* 旧无快照与已截断保持原有独立说明。 */ evidenceReadRelationNotice(props.view))
const focused = computed(() => {
  // 当前展开只保存边和范围索引，正文始终回到这份固定关系包读取。
  const choice = sourceChoice.value
  if (!choice) return null
  const note = notes.value.find((/* 当前仍可见的保存脚注。 */ item) => /* 切换条目后旧身份不能回填。 */ item.relationKey === choice.relationKey)
  const range = note?.ranges[choice.rangeIndex]
  return note && range ? { note, range } : null
})
const sourceFields = computed<ReaderField[]>(() => {
  // 缺少旧展示定义也保留被明确标注的字符串路径，不从其它字段猜原文。
  const reading = focused.value
  if (!reading) return []
  const source = reading.note.source.nodeSnapshot, path = reading.range.anchor.path
  const fields = evidenceReadRelationPresentation(reading.note.source, props.catalog).fields
  const value = payloadReadPointer(source.payload, path)
  if (typeof value === 'string' && !fields.some((/* 已按固定定义生成的字段。 */ field) => /* 同一路径不重复显示。 */ field.path === path)) {
    fields.push({ key: path, path, label: `定位原文 · ${readerReadFieldLabel(path, readerFindDefinition(source, props.catalog, []))}`,
      value, displayText: value, kind: 'text', primary: false })
  }
  return fields
})

function readFixedSource(
  /* 用户明确展开的一条保存关系。 */ relationKey: string,
  /* 该关系原有离散范围中的零起始位置。 */ rangeIndex: number,
): void {
  // 就地阅读固定来源，不切换当前Map、图节点或库根选择。
  const note = notes.value.find((/* 本包当前相邻来源。 */ item) => /* 只接受真实保存的关系身份。 */ item.relationKey === relationKey)
  if (note?.ranges[rangeIndex]) sourceChoice.value = { relationKey, rangeIndex }
}

watch(() => /* 正文展开只属于当前固定库根、摘要与保存节点。 */ JSON.stringify([
  props.view.workspaceId, props.view.entryId, props.view.contentDigest, props.nodeKey ?? props.view.snapshot?.rootKey ?? null,
]), () => {
  // 切换库根或邻域时关闭旧定位，不借相同nodeId继承另一版本的原文。
  sourceChoice.value = null
}, { flush: 'sync' })
</script>

<template>
  <section class="fixed-relations" aria-label="固定关系说明">
    <header><h3>固定关系说明</h3><span v-if="view.snapshot">收录时保存 · {{ view.snapshot.capturedAt }}</span></header>
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="view.snapshot && !rows.length" class="notice">当前固定节点没有已保存的关联关系。</p>
    <details v-for="item in rows" :key="item.key" class="relation">
      <summary>{{ item.title }} · {{ item.fromTitle }} → {{ item.toTitle }}</summary>
      <dl>
        <div><dt>来源</dt><dd>{{ item.from.ref.mapId }} / {{ item.from.ref.nodeId }} · 原版本 {{ item.from.ref.revision }}</dd></div>
        <div><dt>目标</dt><dd>{{ item.to.ref.mapId }} / {{ item.to.ref.nodeId }} · 原版本 {{ item.to.ref.revision }}</dd></div>
        <template v-if="item.relation.kind === 'graph'">
          <div><dt>原边种类</dt><dd>{{ item.relation.edge.kind === 'successor' ? '结构后继' : '图中引用' }}</dd></div>
          <div><dt>原标签</dt><dd>{{ item.relation.edge.label === undefined ? '未保存标签' : item.relation.edge.label || '（空标签）' }}</dd></div>
          <div><dt>原边身份</dt><dd>{{ item.relation.edge.id }} · 边版本 {{ item.relation.edge.revision }}</dd></div>
        </template>
        <template v-else-if="item.relation.kind === 'payload'">
          <div><dt>引用字段</dt><dd>{{ item.fieldLabel }}</dd></div>
          <div><dt>原字段路径</dt><dd><code>{{ item.relation.path }}</code></dd></div>
        </template>
        <div v-else><dt>依据位置</dt><dd>原收录依据第 {{ item.basisNumber }} 项</dd></div>
        <div><dt>关系身份</dt><dd><code>{{ item.key }}</code></dd></div>
      </dl>
      <section v-if="item.sourceNote" class="source-note" :aria-label="`固定来源脚注 ${item.sourceNote.number}`">
        <h4>来源脚注 [{{ item.sourceNote.number }}]</h4>
        <p v-if="!item.sourceNote.ranges.length" class="notice">已保存来源关系，尚未标注具体行。</p>
        <article v-for="(range, index) in item.sourceNote.ranges" :key="`${range.anchor.path}:${range.anchor.startLine}:${range.anchor.endLine}:${index}`" class="source-range">
          <p>{{ range.label }} · 标注版本 {{ range.anchor.sourceRevision }} · <code>{{ range.anchor.path }}</code></p>
          <blockquote>{{ range.anchor.quote || '（空行）' }}</blockquote>
          <p class="notice">{{ range.status === 'current' ? '定位与收录时保存的正文一致。' : range.status === 'stale' ? '此标注早于保存的来源版本，仅保留原摘录。' : '此定位与保存正文不匹配，仅保留原摘录。' }}</p>
          <button type="button" :aria-label="`阅读固定来源 ${range.label}`" @click="readFixedSource(item.key, index)">阅读固定来源 {{ range.label }}</button>
        </article>
      </section>
      <section v-if="focused && focused.note.relationKey === item.key" class="fixed-source" aria-label="收录时固定来源正文">
        <header><h4>收录时固定来源 · 原版本 {{ focused.note.source.ref.revision }}</h4><button type="button" @click="sourceChoice = null">收起原文</button></header>
        <p class="notice">{{ focused.range.status === 'current' ? '仅高亮与保存版本及摘录完全一致的行。' : '原定位不匹配，以下保存正文不作行高亮。' }}</p>
        <DataPayloadView :fields="sourceFields" :focus="focused.range.status === 'current' ? focused.range.anchor : null" />
      </section>
    </details>
  </section>
</template>

<style scoped>
.fixed-relations{display:grid;gap:10px;min-width:0;padding:16px 0;border-top:1px solid var(--border)}header{display:flex;align-items:start;justify-content:space-between;gap:10px;flex-wrap:wrap}h3{font-size:13px}h4{font-size:12px}header>span,.notice{font-size:11px;line-height:1.8;color:var(--text-muted)}.relation{min-width:0;border-left:2px solid var(--border);padding-left:10px}.relation>summary{font-size:12px;line-height:1.8;cursor:pointer}.relation>dl{display:grid;gap:7px;padding:10px 0}.relation>dl>div{display:grid;grid-template-columns:70px minmax(0,1fr);gap:7px;font-size:11px;line-height:1.8}.relation dt{color:var(--text-muted)}.relation dd{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}code{font-size:10px;overflow-wrap:anywhere}.source-note{display:grid;gap:8px;padding:10px 0}.source-range{display:grid;gap:6px;font-size:11px;line-height:1.8}.source-range blockquote{margin:0;padding:7px 10px;border-left:2px solid var(--border-evidence);background:var(--bg-related);white-space:pre-wrap;overflow-wrap:anywhere}.source-range>button{justify-self:start;font-size:11px;padding:4px 7px}.fixed-source{display:grid;gap:10px;padding:12px;border:1px solid var(--border);min-width:0}.fixed-source button{font-size:11px;padding:3px 6px}
</style>
