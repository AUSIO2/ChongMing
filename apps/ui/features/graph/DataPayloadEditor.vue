<script setup lang="ts">
// 注册类型 payload 的递归表单；只渲染协议首版支持的声明式 JSON Schema 子集。
import { computed } from 'vue'
import type { DataReferenceDefinition, DataSchema, DefinitionCatalog, JsonValue } from '../../../../contracts/data-definition'
import type { GraphNode } from '../../../../contracts/graph'
import { payloadCreateInitial, payloadResolveSchema } from './data-payload'
import { payloadReadFieldLabel, payloadReadValueLabel } from './payload-labels'
import { graphReadNodeText, graphReadNodeType } from './graph-layout'

defineOptions({ name: 'DataPayloadEditor' })
const props = withDefaults(defineProps<{
  schema: DataSchema
  modelValue: JsonValue
  label?: string
  disabled?: boolean
  rootSchema?: DataSchema
  path?: string
  fieldLabels?: Record<string, string>
  enumLabels?: Record<string, Record<string, string>>
  references?: readonly DataReferenceDefinition[]
  nodes?: readonly GraphNode[]
  catalog?: DefinitionCatalog | null
}>(), {
  path: '',
  references: () => /* 未提供引用声明时保留原基础表单。 */ [],
  nodes: () => /* 只有父页面显式提供的当前图节点才作为候选。 */ [],
  catalog: null,
})
const emit = defineEmits<{ 'update:modelValue': [value: JsonValue] }>()
const root = computed(() => props.rootSchema ?? props.schema)

/**
 * @param schema 可能引用当前类型 definitions 的字段 schema。
 */
function editorResolveSchema(schema: DataSchema): DataSchema {
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
const dynamicFields = computed(() => {
  // schema字典只声明自有字段，原型同名的正文仍属于可编辑扩展项。
  const properties = resolved.value.properties
  return Object.keys(objectValue.value).filter((/* 当前正文的自有键。 */ key) =>
    /* 未发布为固定字段的键继续显示为动态字段。 */ !properties || !Object.prototype.hasOwnProperty.call(properties, key))
})
const displayLabel = computed(() => props.label || (resolved.value.title ? payloadReadFieldLabel(props.path, props.fieldLabels, resolved.value.title) : ''))
const nodeReference = computed(() => {
  // 只有已声明的节点引用数组使用选择控件，资产引用和普通数组继续使用原表单。
  if (type.value !== 'array') return null
  const current = `${props.path}/*`.split('/')
  const declaration = props.references.find((
    /* 精确数据类型发布的一项引用声明。 */ reference,
  ) => {
    // 数组内的数字索引可以匹配声明通配符，其他JSON Pointer段保持精确。
    const pattern = reference.path.split('/')
    return reference.target.kind === 'node' && pattern.length === current.length && pattern.every((
      /* 声明路径中的完整片段。 */ segment,
      /* 该片段在当前表单路径中的位置。 */ index,
    ) => /* 通配符只匹配一个片段，不把相邻字段解释成同一引用。 */ segment === '*' || segment === current[index])
  })
  return declaration?.target.kind === 'node' ? declaration.target : null
})
const referenceLabel = computed(() =>
  /* 引用组用字段中文名供阅读和辅助技术识别，不将UUID当作表单标题。 */
  displayLabel.value || payloadReadFieldLabel(props.path, props.fieldLabels, resolved.value.title))
const referenceNodes = computed(() => props.nodes.filter((
  /* 父页面只提供当前图中的真实节点。 */ node,
) => /* 节点身份和版本均需匹配字段声明的目标类型。 */ nodeReference.value?.types.some((
  /* 这项引用允许的一个精确目标类型。 */ target,
) => /* 同名不同版本的节点不出现在可新增引用列表中。 */ target.id === node.typeId && target.version === node.typeVersion)))
const unavailableReferences = computed(() => {
  // 历史目标丢失或类型不匹配时仍保留原值，由用户明确取消，不在渲染时过滤payload。
  const available = new Set(referenceNodes.value.map((
    /* 当前图中符合精确类型的节点。 */ node,
  ) => /* 只用于区分旧引用和可选择节点。 */ node.id))
  return arrayValue.value.flatMap((
    /* 当前payload中已经保存的一个引用值。 */ value,
    /* 旧引用在数组中的实际位置，用于显式移除。 */ index,
  ) => {
    // 合法目标在普通选项中显示，其他值单独保留为可取消的历史引用。
    if (typeof value === 'string' && available.has(value)) return []
    const node = typeof value === 'string' ? props.nodes.find((
      /* 当前图中仍存在的节点。 */ item,
    ) => /* 找出类型已不符合声明的旧目标。 */ item.id === value) : undefined
    let label = `历史引用格式不可用（第 ${index + 1} 项）`
    if (typeof value === 'string') label = `目标节点已不可用（第 ${index + 1} 项）`
    if (node) label = `${editorReadNodeLabel(node)}（类型不匹配）`
    return [{ index, label, identity: typeof value === 'string' ? value : undefined }]
  })
})
function editorFieldPath(key: string): string { return `${props.path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}` }

function editorReadNodeLabel(
  /* 真实图节点，用类型标题与正文摘要区分引用目标。 */ node: GraphNode,
): string {
  // 保持选项单行可读，选择值仍保存节点身份，正文不会写进引用数组。
  let summary = graphReadNodeText(node, props.catalog).replace(/\s+/g, ' ').trim()
  if (!summary) summary = '未填写正文'
  if (summary.length > 96) summary = `${summary.slice(0, 96)}…`
  return `${graphReadNodeType(node, props.catalog)} · ${summary}`
}

function editorToggleReference(
  /* 用户明确勾选或取消的图内节点身份。 */ nodeId: string,
  /* 原生checkbox事件，只读取checked状态。 */ event: Event,
): void {
  // 更新数组副本并保留其他旧引用，不生成显式reference边或改写父级props。
  if (props.disabled || !(event.currentTarget instanceof HTMLInputElement)) return
  const selected = arrayValue.value.includes(nodeId)
  if (event.currentTarget.checked) {
    if (selected || resolved.value.maxItems !== undefined && arrayValue.value.length >= resolved.value.maxItems) return
    emit('update:modelValue', [...arrayValue.value, nodeId])
    return
  }
  emit('update:modelValue', arrayValue.value.filter((
    /* 原数组中需要保留的引用或历史值。 */ value,
  ) => /* 用户只取消当前目标，不静默删除其他异常引用。 */ value !== nodeId))
}

function editorRemoveReference(
  /* 用户明确取消的历史引用数组位置。 */ index: number,
): void {
  // 只移除已展示的这一项，不因目标失效顺带清除其他保存值。
  if (props.disabled) return
  emit('update:modelValue', arrayValue.value.filter((
    /* 当前数组中已经保存的值。 */ _value,
    /* 当前值的原始数组位置。 */ itemIndex,
  ) => /* 其他项即使失效也保持到用户确认取消。 */ itemIndex !== index))
}

/**
 * 复制当前对象再更新单字段，避免递归组件直接修改父级传入的对象。
 *
 * @param key 被修改的对象属性名。
 * @param value 新的 JSON 字段值。
 */
function editorUpdateObject(key: string, value: JsonValue): void {
  emit('update:modelValue', { ...objectValue.value, [key]: value })
}
/**
 * required 的固定字段不会进入此操作；动态字典项可由用户显式移除。
 *
 * @param key 待删除的可扩展字典键。
 */
function editorRemoveObject(key: string): void {
  const next = { ...objectValue.value }
  delete next[key]
  emit('update:modelValue', next)
}
function editorAddObject(/* 添加按钮已选中的动态字段声明。 */ child: DataSchema): void {
  // 为 additionalProperties schema 建立不冲突的稳定临时键，用户随后可以重命名。
  let index = 1, key = '字段1'
  while (Object.prototype.hasOwnProperty.call(objectValue.value, key)) key = `字段${++index}`
  editorUpdateObject(key, payloadCreateInitial(editorResolveSchema(child), root.value))
}
/**
 * 空名称或与另一项冲突时保持旧键，由服务端 schema 继续完成最终校验。
 *
 * @param oldKey 原字典键。
 * @param nextKey 用户输入的新字典键。
 */
function editorRenameObject(/* 正文中实际存在的动态键。 */ oldKey: string, /* 用户输入的新名称。 */ nextKey: string): void {
  // 重命名自有字段并保留原值，计算属性不会触发__proto__继承setter。
  const key = nextKey.trim()
  if (!key || (key !== oldKey && Object.prototype.hasOwnProperty.call(objectValue.value, key))) return
  const next = { ...objectValue.value }
  const value = next[oldKey]
  delete next[oldKey]
  emit('update:modelValue', { ...next, [key]: value })
}
/**
 * 数组更新复制容器，保持 Vue 单向数据流。
 *
 * @param index 被修改的数组位置。
 * @param value 新的元素值。
 */
function editorUpdateArray(index: number, value: JsonValue): void {
  const next = [...arrayValue.value]
  next[index] = value
  emit('update:modelValue', next)
}
function editorAddArray(): void {
  // 达到定义上限时停止添加；最终 min/max 仍由服务端校验。
  if (resolved.value.maxItems !== undefined && arrayValue.value.length >= resolved.value.maxItems) return
  emit('update:modelValue', [...arrayValue.value, payloadCreateInitial(editorResolveSchema(resolved.value.items ?? { type: 'string' }), root.value)])
}
/**
 * 按 schema 类型转换原生字符串；不做隐式业务默认或复杂对象解析。
 *
 * @param event 原生表单输入事件。
 */
function editorReadScalar(event: Event): JsonValue {
  const input = event.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  if (type.value === 'boolean') return (input as HTMLInputElement).checked
  if (type.value === 'number' || type.value === 'integer') return input.value === '' ? 0 : Number(input.value)
  return input.value
}
function editorEnumValueMatches(
  /* 发布枚举中一个保留原JSON类型的值。 */ candidate: JsonValue,
  /* 正文当前已经保存的JSON值。 */ value: JsonValue,
): boolean {
  // 按JSON值比较枚举，数字和字符串不同，对象键顺序不影响相等性。
  if (candidate === value) return true
  if (candidate === null || value === null || typeof candidate !== 'object' || typeof value !== 'object') return false
  if (Array.isArray(candidate)) return Array.isArray(value) && candidate.length === value.length
    && candidate.every((/* 枚举数组元素。 */ item, /* 相同位置的正文元素。 */ index) =>
      /* 数组顺序属于枚举值本身。 */ editorEnumValueMatches(item, value[index]))
  if (Array.isArray(value)) return false
  const keys = Object.keys(candidate)
  return keys.length === Object.keys(value).length && keys.every((/* 枚举对象的自有键。 */ key) =>
    /* 不读取正文的继承属性，且保留每个子值的类型。 */ Object.prototype.hasOwnProperty.call(value, key)
      && editorEnumValueMatches(candidate[key], value[key]))
}
/**
 * 切换判别联合会建立该分支的最小新值，避免残留另一分支的非法字段。
 *
 * @param index oneOf 当前选择的零基位置。
 */
function editorSelectVariant(index: number): void {
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
  <fieldset class="data-field" :class="{ 'field-root': !displayLabel, 'field-boolean': type === 'boolean' }" :disabled="disabled"
    :role="nodeReference ? 'group' : undefined" :aria-label="nodeReference ? referenceLabel : undefined">
    <legend v-if="displayLabel && type !== 'boolean'">{{ displayLabel }}</legend>
    <label v-if="nullable" class="nullable-toggle"><input type="checkbox" :checked="modelValue === null"
      @change="emit('update:modelValue', ($event.target as HTMLInputElement).checked ? null : payloadCreateInitial({ ...resolved, type: Array.isArray(resolved.type) ? resolved.type.find(item => item !== 'null') : resolved.type }, root))"> 空值</label>

    <template v-if="modelValue !== null">
      <output v-if="resolved.const !== undefined">{{ payloadReadValueLabel(path, resolved.const, enumLabels) }}</output>
      <select v-else-if="resolved.enum" :value="resolved.enum.findIndex(item => editorEnumValueMatches(item, modelValue))" @change="emit('update:modelValue', resolved.enum[Number(($event.target as HTMLSelectElement).value)])">
        <option v-for="(item, index) in resolved.enum" :key="index" :value="index">{{ payloadReadValueLabel(path, item, enumLabels) }}</option>
      </select>
      <template v-else-if="type === 'oneOf'">
        <select :value="selectedVariant" @change="editorSelectVariant(Number(($event.target as HTMLSelectElement).value))">
          <option v-for="(variant, index) in resolved.oneOf" :key="index" :value="index">{{ variant.title || (variant.properties?.kind?.const !== undefined ? payloadReadValueLabel(editorFieldPath('kind'), variant.properties.kind.const, enumLabels) : `选项 ${index + 1}`) }}</option>
        </select>
        <DataPayloadEditor :schema="resolved.oneOf![selectedVariant]" :root-schema="root" :model-value="modelValue" :disabled="disabled" :path="path" :field-labels="fieldLabels" :enum-labels="enumLabels" :references="references" :nodes="nodes" :catalog="catalog"
          @update:model-value="emit('update:modelValue', $event)" />
      </template>
      <template v-else-if="type === 'object'">
        <DataPayloadEditor v-for="([key, field]) in knownFields" :key="key" :schema="field" :root-schema="root"
          :label="payloadReadFieldLabel(editorFieldPath(key), fieldLabels, field.title)" :path="editorFieldPath(key)" :field-labels="fieldLabels" :enum-labels="enumLabels" :references="references" :nodes="nodes" :catalog="catalog" :model-value="Object.prototype.hasOwnProperty.call(objectValue, key) ? objectValue[key] : payloadCreateInitial(editorResolveSchema(field), root)" :disabled="disabled"
          @update:model-value="editorUpdateObject(key, $event)" />
        <div v-for="key in dynamicFields" :key="key" class="dynamic-field">
          <div class="dynamic-field-header"><input :value="key" aria-label="字段名称" placeholder="字段名称" @change="editorRenameObject(key, ($event.target as HTMLInputElement).value)"><button class="remove-field" type="button" @click="editorRemoveObject(key)">移除</button></div>
          <DataPayloadEditor :schema="typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : { type: 'string' }"
            :root-schema="root" :model-value="objectValue[key]" :disabled="disabled" :path="editorFieldPath(key)" :field-labels="fieldLabels" :enum-labels="enumLabels" :references="references" :nodes="nodes" :catalog="catalog" @update:model-value="editorUpdateObject(key, $event)" />
        </div>
        <button v-if="typeof resolved.additionalProperties === 'object'" class="add-field" type="button" @click="editorAddObject(resolved.additionalProperties)">＋ 添加字段</button>
      </template>
      <template v-else-if="type === 'array' && nodeReference">
        <p v-if="!referenceNodes.length" class="reference-note">当前图没有符合字段类型的可选节点。</p>
        <label v-for="node in referenceNodes" :key="node.id" class="reference-choice">
          <input type="checkbox" :checked="arrayValue.includes(node.id)"
            :disabled="disabled || (!arrayValue.includes(node.id) && resolved.maxItems !== undefined && arrayValue.length >= resolved.maxItems)"
            @change="editorToggleReference(node.id, $event)">
          <span>{{ editorReadNodeLabel(node) }}</span>
        </label>
        <div v-for="item in unavailableReferences" :key="`old:${item.index}`" class="reference-choice reference-unavailable" :title="item.identity">
          <span>{{ item.label }}</span>
          <button type="button" :disabled="disabled" @click="editorRemoveReference(item.index)">移除旧引用</button>
        </div>
      </template>
      <template v-else-if="type === 'array'">
        <div v-for="(item, index) in arrayValue" :key="index" class="array-field">
          <div class="array-field-header"><span>第 {{ index + 1 }} 项</span><button class="remove-field" type="button" @click="emit('update:modelValue', arrayValue.filter((_, itemIndex) => itemIndex !== index))">移除</button></div>
          <DataPayloadEditor :schema="resolved.items || { type: 'string' }" :root-schema="root" :model-value="item" :disabled="disabled"
            :path="editorFieldPath(String(index))" :field-labels="fieldLabels" :enum-labels="enumLabels" :references="references" :nodes="nodes" :catalog="catalog"
            @update:model-value="editorUpdateArray(index, $event)" />
        </div>
        <button type="button" :disabled="resolved.maxItems !== undefined && arrayValue.length >= resolved.maxItems" @click="editorAddArray">添加一项</button>
      </template>
      <label v-else-if="type === 'boolean'" class="boolean-field"><input type="checkbox" :checked="modelValue === true" @change="emit('update:modelValue', editorReadScalar($event))">{{ displayLabel || '启用' }}</label>
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
.data-field { display:grid; gap:10px; width:100%; min-width:0; min-inline-size:0; max-width:100%; padding:10px 0 0; border:0; border-top:1px solid var(--border-subtle); border-radius:0; }
.data-field.field-root { padding:0; border:0; background:transparent; }
.data-field.field-boolean { padding:5px 0; border:0; }
.data-field > legend { max-width:100%; padding:0 5px; color:var(--text-muted); font-size:12px; font-weight:600; overflow-wrap:anywhere; }
.dynamic-field,.array-field { display:flex; min-width:0; flex-direction:column; gap:10px; padding:10px; border:1px solid var(--border-subtle); border-radius:0; background:transparent; }
.dynamic-field-header { display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; gap:8px; min-width:0; }
.array-field-header { display:flex; align-items:center; justify-content:space-between; gap:8px; color:var(--text-muted); font-size:11px; }
.dynamic-field-header input { min-width:0; padding:7px 9px; min-height:34px; border-radius:var(--radius-control); }
.remove-field { flex:none; min-height:28px; padding:3px 6px; border-color:transparent; background:transparent; color:var(--text-muted); font-size:11px; white-space:nowrap; }
.remove-field:hover:not(:disabled) { color:var(--danger); border-color:var(--border); }
.add-field { width:100%; min-height:32px; font-size:12px; }
.nullable-toggle,.boolean-field { display:flex; gap:8px; align-items:center; color:var(--text-muted); font-size:12px; line-height:1.7; }
.reference-choice { display:flex; align-items:flex-start; gap:8px; min-width:0; font-size:12px; line-height:1.7; }
.reference-choice input { flex:none; margin-top:4px; }
.reference-choice span { min-width:0; overflow-wrap:anywhere; }
.reference-note,.reference-unavailable { color:var(--text-muted); font-size:12px; line-height:1.7; }
.reference-unavailable { justify-content:space-between; }
.reference-unavailable button { flex:none; min-height:28px; padding:3px 6px; font-size:11px; }
input:not([type='checkbox']),select,textarea { min-width:0; max-width:100%; font-size:13px; line-height:1.6; border-radius:var(--radius-control); }
textarea { min-height:100px; padding:8px 10px; resize:vertical; }
</style>
