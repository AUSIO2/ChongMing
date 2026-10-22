<!-- 只读数据字段：按精确定义的路径和展示标签呈现完整 payload。 -->
<script setup lang="ts">
import { computed } from 'vue'
import type { GraphSourceAnchor } from '../../../../contracts/graph'
import type { NodeIdentity } from '../graph/node-identity'
import type { ReaderField } from './reader-content'
import { readerReadSourceLines, type ReaderLineMarker } from './reader-sources'

const props = withDefaults(defineProps<{
  fields: readonly ReaderField[]
  emptyLabel?: string
  markers?: readonly ReaderLineMarker[]
  focus?: GraphSourceAnchor | null
  sourceNoteNumbers?: readonly number[]
}>(), { emptyLabel: '这份数据没有可显示的字段。', markers: () => [], focus: null, sourceNoteNumbers: () => [] })
const emit = defineEmits<{ footnote: [number: number]; openNode: [identity: NodeIdentity] }>()
const firstText = computed(() => /* 主正文已保证字符串；没有主正文时才选择普通字符串字段。 */
  props.fields.find((/* 已由正文投影建立类型关系的字段。 */ field) => /* 主正文无需重复检查值类型。 */ field.primary)?.key
  ?? props.fields.find((/* 非主正文也可能是可承载脚注的字符串。 */ field) => /* 保留真实字符串的后备位置。 */ typeof field.value === 'string')?.key)
const markerIndex = computed(() => {
  const index = new Map<string, ReaderLineMarker[]>()
  for (const marker of props.markers) {
    const key = JSON.stringify([marker.path, marker.line])
    index.set(key, [...(index.get(key) ?? []), marker])
  }
  return index
})
function showLines(field: ReaderField): boolean {
  return typeof field.value === 'string' && (props.focus?.path === field.path || props.markers.some(marker => marker.path === field.path))
}
function lineMarkers(path: string, line: number): ReaderLineMarker[] {
  return markerIndex.value.get(JSON.stringify([path, line])) ?? []
}
function lineHighlighted(path: string, line: number): boolean {
  return props.focus?.path === path && line >= props.focus.startLine && line <= props.focus.endLine
}
</script>

<template>
  <p v-if="!fields.length" class="reader-no-fields">{{ emptyLabel }}</p>
  <dl v-else class="reader-fields">
    <div v-for="field in fields" :key="field.key" class="reader-field">
      <dt>{{ field.label }}</dt>
      <dd v-if="showLines(field)" class="reader-field-text reader-lined-text" :data-reader-path="field.path">
        <span v-for="line in readerReadSourceLines(field.value as string)" :key="line.number" class="reader-text-line"
          :class="{ highlighted: lineHighlighted(field.path, line.number), cited: lineMarkers(field.path, line.number).length }" :data-line-number="line.number">
          <span class="line-number" aria-hidden="true">{{ line.number }}</span>
          <span class="line-content">{{ line.text || '\u200b' }}<sup v-for="marker in lineMarkers(field.path, line.number)" :key="marker.key" class="line-note"><button type="button" :aria-label="`查看由第 ${line.number} 行提取的${marker.title}`" @click="emit('openNode', marker.target)">[{{ marker.number }}]</button></sup></span>
        </span>
      </dd>
      <dd v-else-if="field.kind === 'text'" class="reader-field-text">{{ field.displayText }}</dd>
      <dd v-else><pre class="reader-field-value">{{ field.displayText }}</pre></dd>
      <dd v-if="sourceNoteNumbers.length && field.key === firstText" class="field-source-notes">来源<sup v-for="number in sourceNoteNumbers" :key="number"><button type="button" :aria-label="`查看来源脚注 ${number}`" @click="emit('footnote', number)">[{{ number }}]</button></sup></dd>
    </div>
  </dl>
</template>

<style scoped>
/* 字段名使用中性色，长文本使用书页字号，嵌套 JSON 独立滚动。 */
.reader-fields { display: grid; gap: 18px; min-width: 0; }
.reader-field { display: grid; gap: 6px; min-width: 0; }
.reader-field dt { color: var(--text-muted); font-size: 12px; font-weight: 600; }
.reader-field dd { min-width: 0; margin: 0; }
.reader-field-text { color: var(--text); font-family: var(--content-font); font-size: var(--reader-body-size); line-height: var(--reader-body-line-height); overflow-wrap: anywhere; white-space: pre-wrap; }
.reader-field-value { max-width: 100%; overflow: auto; padding: 12px; border-radius: var(--radius-reader-card); background: var(--bg-related); color: var(--text); font: 13px/1.7 var(--ui-font); tab-size: 2; white-space: pre-wrap; overflow-wrap: anywhere; }
.reader-no-fields { color: var(--text-muted); font-size: 13px; line-height: 1.7; }
.reader-lined-text { display:block; margin-left:-18px!important; }
.reader-text-line { display:grid; grid-template-columns:22px minmax(0,1fr); gap:8px; padding:0 4px; border-left:2px solid transparent; }
.line-number { color:var(--text-dim); font:10px/3.4 var(--ui-font); text-align:right; user-select:none; }
.line-content { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }
.reader-text-line.cited { border-left-color:var(--border-evidence); }
.reader-text-line.highlighted { border-left-color:var(--accent); background:var(--accent-soft); border-radius:0; }
.line-note button,.field-source-notes button { padding:0 3px; border:0; background:transparent; color:var(--accent); font:11px/1.4 var(--ui-font); border-radius:var(--radius-control); }
.line-note button:hover,.field-source-notes button:hover { background:var(--accent-soft); }
.field-source-notes { display:flex; align-items:baseline; gap:5px; color:var(--text-muted); font-size:11px; }
</style>
