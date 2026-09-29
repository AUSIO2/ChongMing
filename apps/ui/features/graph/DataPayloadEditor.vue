<script setup lang="ts">
// 注册类型 payload 的递归表单；只渲染协议首版支持的声明式 JSON Schema 子集。
import { computed } from 'vue'
import type { DataSchema, JsonValue } from '../../../../contracts/data-definition'
import { payloadCreateInitial, payloadResolveSchema } from './data-payload'

defineOptions({ name: 'DataPayloadEditor' })
const props = defineProps<{ schema: DataSchema; modelValue: JsonValue; label?: string; disabled?: boolean; rootSchema?: DataSchema }>()
const emit = defineEmits<{ 'update:modelValue': [value: JsonValue] }>()
const root = computed(() => props.rootSchema ?? props.schema)

function editorResolveSchema(/* 可能引用当前类型 definitions 的字段 schema。 */ schema: DataSchema): DataSchema {
  return payloadResolveSchema(schema, root.value)
}

const resolved = computed(() => editorResolveSchema(props.schema))
const nullable = computed(() => Array.isArray(resolved.value.type) && resolved.value.type.includes('null'))
const type = computed(() => {
  const value = resolved.value.type
  if (Array.isArray(value)) return value.find(item => item !== 'null') ?? 'null'
  return value ?? (resolved.value.oneOf ? 'oneOf' : 'string')
})
const objectValue = computed<Record<string, JsonValue>>(() => props.modelValue && typeof props.modelValue === 'object' && !Array.isArray(props.modelValue)
  ? props.modelValue as Record<string, JsonValue> : {})
const arrayValue = computed<JsonValue[]>(() => Array.isArray(props.modelValue) ? props.modelValue : [])
const knownFields = computed(() => Object.entries(resolved.value.properties ?? {}))
const dynamicFields = computed(() => Object.keys(objectValue.value).filter(key => !resolved.value.properties?.[key]))

function editorUpdateObject(/* 被修改的对象属性名。 */ key: string, /* 新的 JSON 字段值。 */ value: JsonValue): void {
  // 复制当前对象再更新单字段，避免递归组件直接修改父级传入的对象。
  emit('update:modelValue', { ...objectValue.value, [key]: value })
}
function editorRemoveObject(/* 待删除的可扩展字典键。 */ key: string): void {
  // required 的固定字段不会进入此操作；动态字典项可由用户显式移除。
  const next = { ...objectValue.value }
  delete next[key]
  emit('update:modelValue', next)
}
function editorAddObject(): void {
  // 为 additionalProperties schema 建立不冲突的稳定临时键，用户随后可以重命名。
  let index = 1, key = 'field'
  while (Object.prototype.hasOwnProperty.call(objectValue.value, key)) key = `field${++index}`
  const child = typeof resolved.value.additionalProperties === 'object' ? resolved.value.additionalProperties : { type: 'string' as const }
  editorUpdateObject(key, payloadCreateInitial(editorResolveSchema(child), root.value))
}
function editorRenameObject(/* 原字典键。 */ oldKey: string, /* 用户输入的新字典键。 */ nextKey: string): void {
  // 空名称或与另一项冲突时保持旧键，由服务端 schema 继续完成最终校验。
  const key = nextKey.trim()
  if (!key || (key !== oldKey && Object.prototype.hasOwnProperty.call(objectValue.value, key))) return
  const next = { ...objectValue.value }
  const value = next[oldKey]
  delete next[oldKey]
  next[key] = value
  emit('update:modelValue', next)
}
function editorUpdateArray(/* 被修改的数组位置。 */ index: number, /* 新的元素值。 */ value: JsonValue): void {
  // 数组更新复制容器，保持 Vue 单向数据流。
  const next = [...arrayValue.value]
  next[index] = value
  emit('update:modelValue', next)
}
function editorAddArray(): void {
  // 达到定义上限时停止添加；最终 min/max 仍由服务端校验。
  if (resolved.value.maxItems !== undefined && arrayValue.value.length >= resolved.value.maxItems) return
  emit('update:modelValue', [...arrayValue.value, payloadCreateInitial(editorResolveSchema(resolved.value.items ?? { type: 'string' }), root.value)])
}
function editorReadScalar(/* 原生表单输入事件。 */ event: Event): JsonValue {
  // 按 schema 类型转换原生字符串；不做隐式业务默认或复杂对象解析。
  const input = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  if (type.value === 'boolean') return (input as HTMLInputElement).checked
  if (type.value === 'number' || type.value === 'integer') return input.value === '' ? 0 : Number(input.value)
  return input.value
}
function editorSelectVariant(/* oneOf 当前选择的零基位置。 */ index: number): void {
  // 切换判别联合会建立该分支的最小新值，避免残留另一分支的非法字段。
  const variant = resolved.value.oneOf?.[index]
  if (variant) emit('update:modelValue', payloadCreateInitial(editorResolveSchema(variant), root.value))
}
const selectedVariant = computed(() => {
  const variants = resolved.value.oneOf ?? []
  const value = props.modelValue
  const index = variants.findIndex(variant => Object.entries(variant.properties ?? {}).every(([key, field]) => field.const === undefined
    || (value !== null && typeof value === 'object' && !Array.isArray(value) && value[key] === field.const)))
  return index < 0 ? 0 : index
})
</script>

<template>
  <fieldset class="data-field" :disabled="disabled">
    <legend v-if="label || resolved.title">{{ label || resolved.title }}</legend>
    <label v-if="nullable" class="nullable-toggle"><input type="checkbox" :checked="modelValue === null"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked ? null : payloadCreateInitial({ ...resolved, type: Array.isArray(resolved.type) ? resolved.type.find(item => item !== 'null') : resolved.type }, root))"> 空值</label>

    <template v-if="modelValue !== null">
      <output v-if="resolved.const !== undefined">{{ String(resolved.const) }}</output>
      <select v-else-if="resolved.enum" :value="String(modelValue)" @change="emit('update:modelValue', resolved.enum!.find(item => String(item) === ($event.target as HTMLSelectElement).value) ?? null)">
        <option v-for="item in resolved.enum" :key="JSON.stringify(item)" :value="String(item)">{{ item === null ? '空值' : String(item) }}</option>
      </select>
      <template v-else-if="type === 'oneOf'">
        <select :value="selectedVariant" @change="editorSelectVariant(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="(variant, index) in resolved.oneOf" :key="index" :value="index">{{ variant.title || variant.properties?.kind?.const || `选项 ${index + 1}` }}</option>
        </select>
        <DataPayloadEditor :schema="resolved.oneOf![selectedVariant]" :root-schema="root" :model-value="modelValue" :disabled="disabled"
          @update:model-value="emit('update:modelValue', $event)" />
      </template>
      <template v-else-if="type === 'object'">
        <DataPayloadEditor v-for="([key, field]) in knownFields" :key="key" :schema="field" :root-schema="root"
          :label="field.title || key" :model-value="objectValue[key] ?? payloadCreateInitial(editorResolveSchema(field), root)" :disabled="disabled"
          @update:model-value="editorUpdateObject(key, $event)" />
        <div v-for="key in dynamicFields" :key="key" class="dynamic-field">
          <input :value="key" aria-label="字段名称" @change="editorRenameObject(key, ($event.target as HTMLInputElement).value)">
          <DataPayloadEditor :schema="typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : { type: 'string' }"
            :root-schema="root" :model-value="objectValue[key]" :disabled="disabled" @update:model-value="editorUpdateObject(key, $event)" />
          <button type="button" @click="editorRemoveObject(key)">移除字段</button>
        </div>
        <button v-if="typeof resolved.additionalProperties === 'object'" type="button" @click="editorAddObject">添加字段</button>
      </template>
      <template v-else-if="type === 'array'">
        <div v-for="(item, index) in arrayValue" :key="index" class="array-field">
          <DataPayloadEditor :schema="resolved.items || { type: 'string' }" :root-schema="root" :model-value="item" :disabled="disabled"
            @update:model-value="editorUpdateArray(index, $event)" />
          <button type="button" @click="emit('update:modelValue', arrayValue.filter((_, itemIndex) => itemIndex !== index))">移除</button>
        </div>
        <button type="button" :disabled="resolved.maxItems !== undefined && arrayValue.length >= resolved.maxItems" @click="editorAddArray">添加一项</button>
      </template>
      <label v-else-if="type === 'boolean'" class="boolean-field"><input type="checkbox" :checked="modelValue === true" @change="emit('update:modelValue', editorReadScalar($event))"> 是</label>
      <input v-else-if="type === 'number' || type === 'integer'" type="number" :step="type === 'integer' ? 1 : 'any'" :min="resolved.minimum" :max="resolved.maximum"
        :value="typeof modelValue === 'number' ? modelValue : ''" @input="emit('update:modelValue', editorReadScalar($event))">
      <textarea v-else-if="resolved.maxLength === undefined || resolved.maxLength > 120" :maxlength="resolved.maxLength" :value="typeof modelValue === 'string' ? modelValue : ''"
        @input="emit('update:modelValue', editorReadScalar($event))" />
      <input v-else type="text" :maxlength="resolved.maxLength" :value="typeof modelValue === 'string' ? modelValue : ''"
        @input="emit('update:modelValue', editorReadScalar($event))">
    </template>
    <small v-if="resolved.description">{{ resolved.description }}</small>
  </fieldset>
</template>

<style scoped>
.data-field { display: grid; gap: 7px; min-width: 0; padding: 9px; border: 1px solid var(--border); border-radius: 8px; }
.data-field > legend { padding: 0 4px; font-size: 12px; font-weight: 700; }
.dynamic-field,.array-field { display: grid; gap: 6px; grid-template-columns: minmax(100px, .35fr) minmax(0, 1fr) auto; align-items: start; }
.nullable-toggle,.boolean-field { display: flex; gap: 6px; align-items: center; }
textarea { min-height: 72px; resize: vertical; }
</style>
