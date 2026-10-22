<!-- 为真实来源边编辑原文行定位，草稿绑定打开时的来源内容版本。 -->
<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import type { DataTypeDefinition, JsonValue } from '../../../../contracts/data-definition'
import type { GraphNode, GraphSourceAnchor } from '../../../../contracts/graph'
import { messageFormat, RuntimeMessage } from '../../../../contracts/messages'
import { payloadReadPointer } from '../graph/data-payload'
import { readerReadFieldLabel, readerReadFields } from './reader-content'
import { readerCreateSourceAnchors, readerReadSourceLines } from './reader-sources'

const props = defineProps<{
  source: GraphNode
  definition?: DataTypeDefinition
  anchors: readonly GraphSourceAnchor[]
  busy: boolean
}>()

const emit = defineEmits<{
  save: [anchors: GraphSourceAnchor[]]
  cancel: []
}>()

interface SourceField {
  path: string
  label: string
  text: string | null
}

// 捕获 payload 避免来源刷新后将尚未提交的行号套到新版内容。
const originalSource: GraphNode = {
  ...props.source,
  payload: JSON.parse(JSON.stringify(props.source.payload)) as GraphNode['payload'],
}
const originalAnchors = props.anchors.map(anchor => ({ ...anchor }))
const fields: SourceField[] = []
const initialRanges = new Map<string, string>()
const drafts = reactive<Record<string, string>>({})

function editorAddField(path: string, label: string): void {
  if (fields.some(field => field.path === path)) return
  const value = payloadReadPointer(originalSource.payload, path)
  fields.push({ path, label, text: typeof value === 'string' ? value : null })
}

for (const field of readerReadFields(originalSource, props.definition)) {
  if (typeof field.value === 'string') editorAddField(field.path, field.label)
}
// 缺少类型定义时也允许给原始 payload 的文本字段定位。
function editorCollectText(value: JsonValue, path: string): void {
  if (typeof value === 'string') { editorAddField(path, readerReadFieldLabel(path, props.definition)); return }
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) editorCollectText(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
}
editorCollectText(originalSource.payload, '')
// 已有嵌套字段定位仍可编辑；不存在的字段需移除其定位后才能提交。
for (const anchor of originalAnchors) {
  editorAddField(anchor.path, readerReadFieldLabel(anchor.path, props.definition))
}
for (const field of fields) {
  const ranges = originalAnchors.filter(anchor => anchor.path === field.path)
    .map(anchor => anchor.startLine === anchor.endLine
      ? String(anchor.startLine) : `${anchor.startLine}-${anchor.endLine}`).join(', ')
  initialRanges.set(field.path, ranges)
  drafts[field.path] = ranges
}

const selectedPath = ref(originalAnchors[0]?.path ?? fields.find(field => field.text !== null)?.path ?? '')
const selectedField = computed(() => fields.find(field => field.path === selectedPath.value))
const sourceChanged = computed(() => props.source.id !== originalSource.id
  || props.source.revision !== originalSource.revision)
const locked = computed(() => props.busy || sourceChanged.value)
const lines = computed(() => selectedField.value?.text !== null && selectedField.value?.text !== undefined
  ? readerReadSourceLines(selectedField.value.text) : [])

const fieldValidations = computed(() => {
  // 每份行号草稿只解析一次，提交汇总与所选字段预览共享结果。
  return new Map<string, { anchors: readonly GraphSourceAnchor[]; error: string | null }>(fields.map((/* 打开编辑器时捕获的一个文本字段。 */ field) => {
    // 未修改的历史定位直接保留原版本，不按当前文本重新生成引用。
    const ranges = drafts[field.path]
    try {
      if (!ranges.trim()) return [field.path, { anchors: [], error: null }] as const
      if (field.text === null) throw new Error(messageFormat(RuntimeMessage.SOURCE_EDITOR_FIELD_UNAVAILABLE, field.label || '内容'))
      const anchors = ranges === initialRanges.get(field.path)
        ? originalAnchors.filter((/* 原来已经保存的定位。 */ anchor) => /* 只保留该字段的固定定位。 */ anchor.path === field.path)
        : readerCreateSourceAnchors(originalSource, field.path, ranges)
      return [field.path, { anchors, error: null }] as const
    } catch (error) {
      return [field.path, { anchors: [], error: error instanceof Error ? error.message : RuntimeMessage.SOURCE_EDITOR_INVALID_RANGES }] as const
    }
  }))
})
const validation = computed((): { anchors: GraphSourceAnchor[]; error: string | null } => {
  // 字段按原顺序汇总，任一错误都会阻止整个定位集合提交。
  const anchors: GraphSourceAnchor[] = []
  for (const result of fieldValidations.value.values()) {
    if (result.error) return { anchors: [], error: result.error }
    anchors.push(...result.anchors)
  }
  return { anchors, error: null }
})
const selectedValidation = computed(() => /* 尚无选中字段时没有预览或字段错误。 */
  fieldValidations.value.get(selectedPath.value) ?? { anchors: [], error: null })
const selectedOriginalAnchors = computed(() => originalAnchors.filter(anchor => anchor.path === selectedPath.value))
const unchangedOldVersion = computed(() => drafts[selectedPath.value] === initialRanges.get(selectedPath.value)
  && selectedOriginalAnchors.value.some(anchor => anchor.sourceRevision !== originalSource.revision))
const selectedPreview = computed(() => unchangedOldVersion.value
  ? selectedOriginalAnchors.value : selectedValidation.value.anchors)
const selectedLineNumbers = computed(() => {
  const numbers = new Set<number>()
  if (unchangedOldVersion.value) return numbers
  for (const anchor of selectedValidation.value.anchors) {
    for (let number = anchor.startLine; number <= anchor.endLine; number++) numbers.add(number)
  }
  return numbers
})

function editorSave(): void {
  if (locked.value || validation.value.error) return
  emit('save', validation.value.anchors.map(anchor => ({ ...anchor })))
}

function editorClearField(): void {
  if (locked.value || !selectedField.value) return
  drafts[selectedField.value.path] = ''
}
function editorHandleEscape(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return
  event.preventDefault(); event.stopPropagation()
  if (!props.busy) emit('cancel')
}
</script>

<template>
  <form class="source-anchor-editor" aria-label="标记原文来源" @submit.prevent="editorSave" @keydown="editorHandleEscape">
    <header class="source-editor-header">
      <h3>标记原文来源</h3>
      <span>原文版本 {{ originalSource.revision }}</span>
    </header>
    <p class="source-editor-help">按原文换行定位。例如 1, 3 表示第 1、3 行，5-7 表示第 5 至 7 行；页面自动折行不计入行号。</p>

    <p v-if="sourceChanged" class="source-editor-warning" role="alert">来源节点已更新。请关闭并重新打开标记窗口，再对新版原文定位。</p>
    <p v-if="!fields.length" class="source-editor-warning" role="status">来源节点没有可供定位的文本字段。</p>

    <template v-if="fields.length">
      <div class="source-editor-controls">
        <label class="source-editor-control">
          <span>原文字段</span>
          <select v-model="selectedPath" :disabled="locked" aria-label="原文字段">
            <option v-for="field in fields" :key="field.path" :value="field.path">
              {{ field.label }}{{ field.text === null ? '（已不可用）' : '' }}
            </option>
          </select>
        </label>
        <label class="source-editor-control source-ranges-control">
          <span>来源行号</span>
          <input v-model="drafts[selectedPath]" type="text" placeholder="例如 1, 3, 5-7"
            :disabled="locked || selectedField?.text === null" :aria-invalid="!!selectedValidation.error"
            aria-describedby="source-ranges-help" autocomplete="off" />
        </label>
        <button type="button" :disabled="locked || !drafts[selectedPath]?.trim()" @click="editorClearField">清除该字段定位</button>
      </div>
      <p id="source-ranges-help" class="source-editor-help">可逐个选择字段；保存时会提交全部字段的定位。留空可移除该字段定位。</p>
      <p v-if="selectedField?.text === null" class="source-editor-warning" role="alert">该字段已不存在或不再是文本。请清除它的定位后保存。</p>
      <p v-if="unchangedOldVersion" class="source-editor-warning" role="status">已有定位来自较早的原文版本。下方保留原始摘录；调整行号后会重新绑定当前版本。</p>
      <p v-if="validation.error" class="source-editor-error" role="alert">{{ validation.error }}</p>

      <section v-if="selectedField?.text !== null" class="source-editor-original" aria-label="带行号原文">
        <div v-for="line in lines" :key="line.number" class="source-original-line"
          :class="{ 'source-original-line-selected': selectedLineNumbers.has(line.number) }">
          <span class="source-line-number" aria-hidden="true">{{ line.number }}</span>
          <span class="source-line-text">{{ line.text || '\u00a0' }}</span>
        </div>
      </section>

      <section class="source-editor-preview" aria-label="来源摘录预览">
        <h4>来源摘录</h4>
        <p v-if="!selectedPreview.length" class="source-editor-help">填写行号后会显示对应摘录。</p>
        <article v-for="(anchor, index) in selectedPreview" :key="`${anchor.path}:${index}`" class="source-preview-entry">
          <span class="source-preview-location">第 {{ anchor.startLine }}{{ anchor.endLine !== anchor.startLine ? `–${anchor.endLine}` : '' }} 行 · 原文版本 {{ anchor.sourceRevision }}</span>
          <blockquote>{{ anchor.quote }}</blockquote>
        </article>
      </section>
    </template>

    <footer class="source-editor-actions">
      <span class="source-editor-count">{{ validation.error ? '定位需要修正' : `${validation.anchors.length} 处来源定位` }}</span>
      <button type="button" :disabled="busy" @click="emit('cancel')">取消</button>
      <button class="primary" type="submit" :disabled="locked || !!validation.error || !fields.length">{{ busy ? '保存中…' : '保存来源' }}</button>
    </footer>
  </form>
</template>

<style scoped>
.source-anchor-editor { display: flex; flex-direction: column; gap: 12px; min-width: 0; padding: 16px; border: 1px solid var(--border-evidence); border-radius: var(--radius-reader-card); background: var(--bg-panel); }
.source-editor-header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.source-editor-header h3 { font-size: var(--ui-font-size-md); }
.source-editor-header > span, .source-editor-help, .source-editor-count { color: var(--text-muted); font-size: 12px; line-height: 1.7; }
.source-editor-controls { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; }
.source-editor-control { display: flex; flex: 1 1 150px; min-width: 0; flex-direction: column; gap: 5px; }
.source-editor-control > span { color: var(--text-muted); font-size: 12px; }
.source-ranges-control { flex-grow: 2; }
.source-editor-control select, .source-editor-control input { width: 100%; min-width: 0; min-height: 34px; }
.source-editor-warning, .source-editor-error { padding: 9px 12px; border-radius: var(--radius-evidence); font-size: 12px; line-height: 1.8; overflow-wrap: anywhere; }
.source-editor-warning { background: var(--bg-warning); color: var(--warning); }
.source-editor-error { background: var(--accent-soft); color: var(--danger); }
.source-editor-original { max-height: min(38vh, 320px); min-height: 50px; overflow: auto; background: var(--bg-viewport); border: 1px solid var(--border); border-radius: var(--radius-evidence); padding: 8px 0; }
.source-original-line { display: grid; grid-template-columns: 42px minmax(0, 1fr); gap: 10px; padding: 2px 12px 2px 0; }
.source-original-line-selected { background: var(--accent-soft); }
.source-line-number { color: var(--text-muted); font: 12px/1.85 var(--ui-font); text-align: right; user-select: none; }
.source-line-text { font: 14px/1.85 var(--content-font); white-space: pre-wrap; overflow-wrap: anywhere; }
.source-editor-preview { display: flex; flex-direction: column; gap: 8px; }
.source-editor-preview h4 { font-size: 12px; color: var(--text-muted); font-weight: 600; }
.source-preview-entry { min-width: 0; padding: 10px 12px; background: var(--bg-evidence); border: 1px solid var(--border-evidence); border-radius: var(--radius-evidence); }
.source-preview-location { color: var(--text-muted); font-size: 12px; }
.source-preview-entry blockquote { margin-top: 5px; white-space: pre-wrap; overflow-wrap: anywhere; font: var(--reader-quote-size)/var(--reader-quote-line-height) var(--content-font); }
.source-editor-actions { display: flex; justify-content: flex-end; align-items: center; flex-wrap: wrap; gap: 8px; }
.source-editor-count { margin-right: auto; }
</style>
