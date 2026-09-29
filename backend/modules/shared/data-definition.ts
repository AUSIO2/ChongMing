// 校验可注册数据定义，并把转换、Agent、工具和输入冻结为可持久化执行规格。
import { createHash } from 'node:crypto'

import type {
  AgentProjectionDefinition,
  DataInstanceRef,
  DataPresentationDefinition,
  DataReferenceDefinition,
  DataSchema,
  DataTypeDefinition,
  DefinitionCatalog,
  DefinitionCount,
  DefinitionPackage,
  DefinitionRef,
  ExecutionAgentDefinition,
  ExecutionSpec,
  JsonValue,
  PromptBinding,
  TransitionDefinition,
  TransitionInputPort,
  TransitionOutputPort,
  TransitionStageDefinition,
} from '../../../contracts/data-definition'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { GraphError } from './domain-error'

const DIALECT = 'http://json-schema.org/draft-07/schema#' as const
const MAX_SCHEMA_DEPTH = 32
const MAX_DEFINITIONS = 256
const MAX_STAGES = 64
const schemaKeys = new Set([
  '$schema', '$ref', 'type', 'properties', 'required', 'additionalProperties', 'definitions', 'items', 'enum', 'const',
  'oneOf', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'minimum', 'maximum', 'format', 'title',
  'description', 'default',
])

export interface DefinitionsFreezeInput {
  catalog: DefinitionCatalog
  transitionRef: DefinitionRef
  agents: readonly ExecutionAgentDefinition[]
  tools: ReadonlyArray<{ name: string; description: string }>
  inputs: Record<string, DataInstanceRef[]>
  context: Record<string, DataInstanceRef[]>
}

export interface PayloadReferenceValue {
  definition: DataReferenceDefinition
  value: string
}

function definitionFail(/* 能准确指出定义错误位置或原因的公开说明。 */ reason: string): never {
  // 用稳定错误码报告整包定义不一致，避免调用方继续使用部分目录。
  throw new GraphError(422, 'DEFINITION_INVALID', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, reason))
}

function definitionSchemaFail(/* 不受首版 schema 子集支持的关键字或形状说明。 */ reason: string): never {
  // 区分 schema 能力超出支持范围与普通引用错误，便于发布方修订定义。
  throw new GraphError(422, 'SCHEMA_UNSUPPORTED', messageFormat(RuntimeMessage.SCHEMA_UNSUPPORTED_VALUE, reason))
}

function definitionReadObject(/* 尚未确认为普通对象的定义字段值。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): Record<string, unknown> {
  // 将定义边界输入收窄为普通对象，并拒绝数组和 null。
  if (!value || typeof value !== 'object' || Array.isArray(value)) definitionFail(`${label} must be an object`)
  return value as Record<string, unknown>
}

function definitionCheckKeys(/* 已收窄的定义对象。 */ value: Record<string, unknown>, /* 此对象允许出现的字段集合。 */ allowed: readonly string[], /* 必须显式提供的字段集合。 */ required: readonly string[], /* 用于错误定位的定义字段路径。 */ label: string): void {
  // 拒绝定义中的未知字段及缺失必填字段，避免拼写错误被静默忽略。
  for (const key of Object.keys(value)) if (!allowed.includes(key)) definitionFail(`${label}.${key} is not allowed`)
  for (const key of required) if (!(key in value)) definitionFail(`${label}.${key} is required`)
}

function definitionReadArray(/* 尚未确认为数组的定义字段值。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): unknown[] {
  // 将定义边界输入收窄为数组，元素由所属结构继续解析。
  if (!Array.isArray(value)) definitionFail(`${label} must be an array`)
  return value
}

function definitionReadString(/* 尚未确认为非空文本的定义字段值。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): string {
  // 要求定义身份、名称和展示文字为非空字符串。
  if (typeof value !== 'string' || !value.trim()) definitionFail(`${label} must be a non-empty string`)
  return value
}

function definitionReadIdentifier(/* 尚未验证格式的定义或端口身份。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): string {
  // 接受带命名空间的稳定定义身份及短阶段名称，拒绝空白和协议分隔符。
  const id = definitionReadString(value, label)
  if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(id)) definitionFail(`${label} has an invalid identifier`)
  return id
}

function definitionReadReferenceId(/* 尚未验证格式的精确定义或 Agent 引用身份。 */ value: unknown, /* 用于错误定位的引用字段路径。 */ label: string): string {
  // 引用允许现有 UUID Agent 身份以数字开头，仍拒绝空白和协议分隔符。
  const id = definitionReadString(value, label)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(id)) definitionFail(`${label} has an invalid identifier`)
  return id
}

function definitionReadInteger(/* 尚未验证整数范围的定义数值。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string, /* 允许的最小整数。 */ minimum: number): number {
  // 要求版本、数量和槽位上限为给定下界以上的安全整数。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) definitionFail(`${label} must be an integer of at least ${minimum}`)
  return value
}

function definitionReadRef(/* 尚未解析为精确定义引用的字段值。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string, /* 引用版本的最小值；Agent 配置允许从零开始。 */ minimumVersion = 1): DefinitionRef {
  // 解析不可浮动的 id/version 引用，禁止省略或使用 latest。
  const ref = definitionReadObject(value, label)
  definitionCheckKeys(ref, ['id', 'version'], ['id', 'version'], label)
  return { id: definitionReadReferenceId(ref.id, `${label}.id`), version: definitionReadInteger(ref.version, `${label}.version`, minimumVersion) }
}

function definitionReadIdentity(/* 已通过所属定义字段白名单校验的完整对象。 */ value: Record<string, unknown>, /* 用于错误定位的定义字段路径。 */ label: string): DefinitionRef {
  // 从完整定义中读取不可变身份，不重新把其余合法业务字段误判为引用字段。
  return { id: definitionReadIdentifier(value.id, `${label}.id`), version: definitionReadInteger(value.version, `${label}.version`, 1) }
}

function definitionReadStringArray(/* 尚未验证元素和重复值的字符串数组。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): string[] {
  // 解析非空字符串数组并拒绝重复值，保留声明顺序。
  const result: string[] = []
  for (const [index, item] of definitionReadArray(value, label).entries()) result.push(definitionReadString(item, `${label}[${index}]`))
  if (new Set(result).size !== result.length) definitionFail(`${label} contains duplicate values`)
  return result
}

function definitionReadCount(/* 尚未解析的端口数量上下界。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): DefinitionCount {
  // 解析闭区间数量约束，并确保上限不小于下限。
  const count = definitionReadObject(value, label)
  definitionCheckKeys(count, ['min', 'max'], ['min', 'max'], label)
  const min = definitionReadInteger(count.min, `${label}.min`, 0)
  const max = definitionReadInteger(count.max, `${label}.max`, 0)
  if (max < min) definitionFail(`${label}.max must be at least min`)
  return { min, max }
}

function definitionReadJsonValue(/* 需要确认可稳定持久化的 schema 常量或默认值。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string, /* 当前递归深度，用于阻止无界结构。 */ depth = 0): JsonValue {
  // 复制 JSON 值并拒绝 undefined、非有限数字和过深对象。
  if (depth > MAX_SCHEMA_DEPTH) definitionFail(`${label} exceeds the supported depth`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (Array.isArray(value)) {
    const result: JsonValue[] = []
    for (const [index, item] of value.entries()) result.push(definitionReadJsonValue(item, `${label}[${index}]`, depth + 1))
    return result
  }
  const object = definitionReadObject(value, label)
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(object)) result[key] = definitionReadJsonValue(item, `${label}.${key}`, depth + 1)
  return result
}

function definitionReadSchema(/* 尚未解析的 draft-07 schema 子集。 */ value: unknown, /* 用于错误定位的 schema 路径。 */ label: string, /* 当前递归深度，用于限制复杂度。 */ depth = 0): DataSchema {
  // 严格解析首版 schema 子集；未知关键字和不支持的类型组合直接拒绝。
  if (depth > MAX_SCHEMA_DEPTH) definitionSchemaFail(`${label} exceeds maximum depth`)
  const input = definitionReadObject(value, label)
  for (const key of Object.keys(input)) if (!schemaKeys.has(key)) definitionSchemaFail(`${label}.${key}`)
  const schema: DataSchema = {}
  if (input.$schema !== undefined) {
    if (input.$schema !== DIALECT) definitionSchemaFail(`${label} uses another dialect`)
    schema.$schema = DIALECT
  }
  if (input.$ref !== undefined) {
    const ref = definitionReadString(input.$ref, `${label}.$ref`)
    if (!/^#\/definitions\/[a-zA-Z][a-zA-Z0-9._-]{0,127}$/.test(ref)) definitionSchemaFail(`${label} has a non-local reference`)
    schema.$ref = ref
  }
  if (input.type !== undefined) {
    const supported = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
    if (Array.isArray(input.type)) {
      const types = definitionReadStringArray(input.type, `${label}.type`)
      if (types.some(/* schema 类型集合中当前检查是否属于受支持基础值的名称。 */ type => /* 拒绝对象或数组的联合及未知 schema 类型。 */ !supported.includes(type) || type === 'object' || type === 'array')) definitionSchemaFail(`${label}.type union`)
      schema.type = types as DataSchema['type']
    } else {
      if (typeof input.type !== 'string' || !supported.includes(input.type)) definitionSchemaFail(`${label}.type`)
      schema.type = input.type as DataSchema['type']
    }
  }
  if (input.properties !== undefined) {
    const properties = definitionReadObject(input.properties, `${label}.properties`)
    schema.properties = {}
    for (const [name, child] of Object.entries(properties)) schema.properties[name] = definitionReadSchema(child, `${label}.properties.${name}`, depth + 1)
  }
  if (input.required !== undefined) schema.required = definitionReadStringArray(input.required, `${label}.required`)
  if (input.additionalProperties !== undefined) schema.additionalProperties = typeof input.additionalProperties === 'boolean'
    ? input.additionalProperties : definitionReadSchema(input.additionalProperties, `${label}.additionalProperties`, depth + 1)
  if (input.definitions !== undefined) {
    const definitions = definitionReadObject(input.definitions, `${label}.definitions`)
    schema.definitions = {}
    for (const [name, child] of Object.entries(definitions)) schema.definitions[name] = definitionReadSchema(child, `${label}.definitions.${name}`, depth + 1)
  }
  if (input.items !== undefined) schema.items = definitionReadSchema(input.items, `${label}.items`, depth + 1)
  if (input.enum !== undefined) {
    schema.enum = []
    for (const [index, item] of definitionReadArray(input.enum, `${label}.enum`).entries()) schema.enum.push(definitionReadJsonValue(item, `${label}.enum[${index}]`))
    if (!schema.enum.length) definitionSchemaFail(`${label}.enum is empty`)
  }
  if (input.const !== undefined) schema.const = definitionReadJsonValue(input.const, `${label}.const`)
  if (input.oneOf !== undefined) {
    schema.oneOf = []
    for (const [index, child] of definitionReadArray(input.oneOf, `${label}.oneOf`).entries()) schema.oneOf.push(definitionReadSchema(child, `${label}.oneOf[${index}]`, depth + 1))
    if (schema.oneOf.length < 2 || schema.oneOf.length > 8) definitionSchemaFail(`${label}.oneOf must contain 2 to 8 variants`)
  }
  for (const key of ['minItems', 'maxItems', 'minLength', 'maxLength'] as const) {
    if (input[key] !== undefined) schema[key] = definitionReadInteger(input[key], `${label}.${key}`, 0)
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (input[key] !== undefined) {
      if (typeof input[key] !== 'number' || !Number.isFinite(input[key])) definitionSchemaFail(`${label}.${key}`)
      schema[key] = input[key]
    }
  }
  if (input.uniqueItems !== undefined) {
    if (typeof input.uniqueItems !== 'boolean') definitionSchemaFail(`${label}.uniqueItems`)
    schema.uniqueItems = input.uniqueItems
  }
  if (input.format !== undefined) {
    if (input.format !== 'date-time' && input.format !== 'uri' && input.format !== 'uuid') definitionSchemaFail(`${label}.format`)
    schema.format = input.format
  }
  for (const key of ['title', 'description'] as const) if (input[key] !== undefined) schema[key] = definitionReadString(input[key], `${label}.${key}`)
  if (input.default !== undefined) schema.default = definitionReadJsonValue(input.default, `${label}.default`)
  return schema
}

function definitionReadPointer(/* 尚未验证的 payload JSON Pointer。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): string {
  // 仅接受对象属性和显式星号集合成员组成的 JSON Pointer 子集。
  const pointer = definitionReadString(value, label)
  if (!/^\/(?:\*|[^/~]|~[01])+(?:\/(?:\*|[^/~]|~[01])+)*$/.test(pointer)) definitionFail(`${label} is not a supported payload pointer`)
  return pointer
}

function definitionReadPresentation(/* 尚未解析的可选展示声明。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): DataPresentationDefinition {
  // 解析声明式展示字段，不允许携带脚本或任意组件配置。
  const input = definitionReadObject(value, label)
  definitionCheckKeys(input, ['titlePath', 'summaryPath', 'fieldOrder', 'fieldLabels', 'enumLabels'], [], label)
  const result: DataPresentationDefinition = {}
  if (input.titlePath !== undefined) result.titlePath = definitionReadPointer(input.titlePath, `${label}.titlePath`)
  if (input.summaryPath !== undefined) result.summaryPath = definitionReadPointer(input.summaryPath, `${label}.summaryPath`)
  if (input.fieldOrder !== undefined) result.fieldOrder = definitionReadStringArray(input.fieldOrder, `${label}.fieldOrder`)
  if (input.fieldLabels !== undefined) {
    result.fieldLabels = {}
    for (const [path, text] of Object.entries(definitionReadObject(input.fieldLabels, `${label}.fieldLabels`))) result.fieldLabels[path] = definitionReadString(text, `${label}.fieldLabels.${path}`)
  }
  if (input.enumLabels !== undefined) {
    result.enumLabels = {}
    for (const [path, labels] of Object.entries(definitionReadObject(input.enumLabels, `${label}.enumLabels`))) {
      const parsed: Record<string, string> = {}
      for (const [key, text] of Object.entries(definitionReadObject(labels, `${label}.enumLabels.${path}`))) parsed[key] = definitionReadString(text, `${label}.enumLabels.${path}.${key}`)
      result.enumLabels[path] = parsed
    }
  }
  return result
}

function definitionReadReferences(/* 尚未解析的 payload 引用声明数组。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): DataReferenceDefinition[] {
  // 解析资产与节点引用规则，并要求节点目标包含精确类型集合。
  const result: DataReferenceDefinition[] = []
  for (const [index, item] of definitionReadArray(value, label).entries()) {
    const path = `${label}[${index}]`
    const input = definitionReadObject(item, path)
    definitionCheckKeys(input, ['path', 'target', 'when'], ['path', 'target'], path)
    const targetInput = definitionReadObject(input.target, `${path}.target`)
    let target: DataReferenceDefinition['target']
    if (targetInput.kind === 'asset') {
      definitionCheckKeys(targetInput, ['kind'], ['kind'], `${path}.target`)
      target = { kind: 'asset' }
    } else if (targetInput.kind === 'node') {
      definitionCheckKeys(targetInput, ['kind', 'types'], ['kind', 'types'], `${path}.target`)
      const types: DefinitionRef[] = []
      for (const [typeIndex, ref] of definitionReadArray(targetInput.types, `${path}.target.types`).entries()) types.push(definitionReadRef(ref, `${path}.target.types[${typeIndex}]`))
      if (!types.length) definitionFail(`${path}.target.types must not be empty`)
      target = { kind: 'node', types }
    } else definitionFail(`${path}.target.kind is invalid`)
    let when: DataReferenceDefinition['when']
    if (input.when !== undefined) {
      const condition = definitionReadObject(input.when, `${path}.when`)
      definitionCheckKeys(condition, ['path', 'equals'], ['path', 'equals'], `${path}.when`)
      when = { path: definitionReadPointer(condition.path, `${path}.when.path`), equals: definitionReadJsonValue(condition.equals, `${path}.when.equals`) }
    }
    result.push({ path: definitionReadPointer(input.path, `${path}.path`), target, ...(when ? { when } : {}) })
  }
  return result
}

function definitionReadProjection(/* 尚未解析的模型字段投影声明。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): AgentProjectionDefinition {
  // 解析模型字段白名单和字典项布尔过滤声明。
  const input = definitionReadObject(value, label)
  definitionCheckKeys(input, ['include', 'mapEntryFilters'], ['include', 'mapEntryFilters'], label)
  const include = definitionReadStringArray(input.include, `${label}.include`).map(/* 当前需要验证为具体字段路径的投影项。 */ path => /* 禁止通配投影直接暴露整个动态集合。 */ definitionReadPointer(path, `${label}.include`))
  if (include.some(/* 当前检查是否含星号集合展开的投影路径。 */ path => /* 投影入口必须是具体字段，集合过滤另行声明。 */ path.split('/').includes('*'))) definitionFail(`${label}.include cannot use *`)
  const mapEntryFilters: AgentProjectionDefinition['mapEntryFilters'] = []
  for (const [index, item] of definitionReadArray(input.mapEntryFilters, `${label}.mapEntryFilters`).entries()) {
    const path = `${label}.mapEntryFilters[${index}]`
    const filter = definitionReadObject(item, path)
    definitionCheckKeys(filter, ['path', 'visibleWhen'], ['path', 'visibleWhen'], path)
    mapEntryFilters.push({ path: definitionReadPointer(filter.path, `${path}.path`), visibleWhen: definitionReadIdentifier(filter.visibleWhen, `${path}.visibleWhen`) })
  }
  return { include, mapEntryFilters }
}

function definitionReadDataType(/* 尚未解析的数据类型定义。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): DataTypeDefinition {
  // 解析一个数据类型版本及其 schema、后继、引用、展示和模型投影声明。
  const input = definitionReadObject(value, label)
  definitionCheckKeys(input, ['id', 'version', 'title', 'description', 'schema', 'successorTypes', 'presentation', 'references', 'agentProjection'],
    ['id', 'version', 'title', 'schema', 'successorTypes', 'references', 'agentProjection'], label)
  const successorTypes: DefinitionRef[] = []
  for (const [index, ref] of definitionReadArray(input.successorTypes, `${label}.successorTypes`).entries()) successorTypes.push(definitionReadRef(ref, `${label}.successorTypes[${index}]`))
  return {
    ...definitionReadIdentity(input, label), title: definitionReadString(input.title, `${label}.title`),
    ...(input.description === undefined ? {} : { description: definitionReadString(input.description, `${label}.description`) }),
    schema: definitionReadSchema(input.schema, `${label}.schema`), successorTypes,
    ...(input.presentation === undefined ? {} : { presentation: definitionReadPresentation(input.presentation, `${label}.presentation`) }),
    references: definitionReadReferences(input.references, `${label}.references`),
    agentProjection: definitionReadProjection(input.agentProjection, `${label}.agentProjection`),
  }
}

function definitionReadInputPort(/* 尚未解析的结构输入或上下文端口。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): TransitionInputPort {
  // 解析命名输入端口、精确类型和数量区间。
  const input = definitionReadObject(value, label)
  definitionCheckKeys(input, ['name', 'inputType', 'count'], ['name', 'inputType', 'count'], label)
  return { name: definitionReadIdentifier(input.name, `${label}.name`), inputType: definitionReadRef(input.inputType, `${label}.inputType`), count: definitionReadCount(input.count, `${label}.count`) }
}

function definitionReadOutputPort(/* 尚未解析的正式输出端口。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): TransitionOutputPort {
  // 解析输出类型、数量和带来源类别的结构锚点。
  const input = definitionReadObject(value, label)
  definitionCheckKeys(input, ['name', 'outputType', 'count', 'successorOf'], ['name', 'outputType', 'count', 'successorOf'], label)
  const successorOf: TransitionOutputPort['successorOf'] = []
  for (const [index, item] of definitionReadArray(input.successorOf, `${label}.successorOf`).entries()) {
    const path = `${label}.successorOf[${index}]`
    const anchor = definitionReadObject(item, path)
    definitionCheckKeys(anchor, ['source', 'port'], ['source', 'port'], path)
    if (anchor.source !== 'input' && anchor.source !== 'output') definitionFail(`${path}.source is invalid`)
    successorOf.push({ source: anchor.source, port: definitionReadIdentifier(anchor.port, `${path}.port`) })
  }
  if (!successorOf.length) definitionFail(`${label}.successorOf must not be empty`)
  return { name: definitionReadIdentifier(input.name, `${label}.name`), outputType: definitionReadRef(input.outputType, `${label}.outputType`), count: definitionReadCount(input.count, `${label}.count`), successorOf }
}

function definitionReadPromptBinding(/* 尚未解析的提示词变量绑定。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): PromptBinding {
  // 按来源种类解析声明式变量绑定，禁止任意表达式和未声明字段读取。
  const input = definitionReadObject(value, label)
  if (input.source === 'input' || input.source === 'context') {
    definitionCheckKeys(input, ['source', 'port', 'path', 'format', 'required'], ['source', 'port', 'format'], label)
    if (input.format !== 'text' && input.format !== 'json' && input.format !== 'text-lines') definitionFail(`${label}.format is invalid`)
    if (input.required !== undefined && typeof input.required !== 'boolean') definitionFail(`${label}.required must be boolean`)
    return { source: input.source, port: definitionReadIdentifier(input.port, `${label}.port`),
      ...(input.path === undefined ? {} : { path: definitionReadPointer(input.path, `${label}.path`) }), format: input.format,
      ...(input.required === undefined ? {} : { required: input.required }) }
  }
  if (input.source === 'stage') {
    definitionCheckKeys(input, ['source', 'stageId', 'format'], ['source', 'stageId', 'format'], label)
    if (input.format !== 'json' && input.format !== 'text-lines') definitionFail(`${label}.format is invalid`)
    return { source: 'stage', stageId: definitionReadIdentifier(input.stageId, `${label}.stageId`), format: input.format }
  }
  if (input.source === 'agents') {
    definitionCheckKeys(input, ['source', 'format'], ['source', 'format'], label)
    if (input.format !== 'json') definitionFail(`${label}.format is invalid`)
    return { source: 'agents', format: 'json' }
  }
  if (input.source === 'source-text') {
    definitionCheckKeys(input, ['source', 'port', 'path'], ['source', 'port', 'path'], label)
    return { source: 'source-text', port: definitionReadIdentifier(input.port, `${label}.port`), path: definitionReadPointer(input.path, `${label}.path`) }
  }
  return definitionFail(`${label}.source is invalid`)
}

function definitionReadStage(/* 尚未解析的转换阶段模板。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): TransitionStageDefinition {
  // 解析有限 Agent 阶段、依赖、输出合同、提示词绑定和可选动态槽位范围。
  const input = definitionReadObject(value, label)
  definitionCheckKeys(input, ['id', 'kind', 'agentRef', 'dependsOn', 'ready', 'resultMode', 'outputPorts', 'promptBindings', 'plan'],
    ['id', 'kind', 'agentRef', 'dependsOn', 'ready', 'resultMode', 'outputPorts'], label)
  if (input.kind !== 'agent' || input.ready !== 'all-dependencies') definitionFail(`${label} uses an unsupported stage kind or readiness rule`)
  if (input.resultMode !== 'outputs' && input.resultMode !== 'selection' && input.resultMode !== 'plan') definitionFail(`${label}.resultMode is invalid`)
  const outputPorts: TransitionStageDefinition['outputPorts'] = []
  for (const [index, item] of definitionReadArray(input.outputPorts, `${label}.outputPorts`).entries()) {
    const path = `${label}.outputPorts[${index}]`
    const port = definitionReadObject(item, path)
    definitionCheckKeys(port, ['port', 'count'], ['port', 'count'], path)
    outputPorts.push({ port: definitionReadIdentifier(port.port, `${path}.port`), count: definitionReadCount(port.count, `${path}.count`) })
  }
  const promptBindings: Record<string, PromptBinding> = {}
  if (input.promptBindings !== undefined) for (const [name, binding] of Object.entries(definitionReadObject(input.promptBindings, `${label}.promptBindings`))) {
    promptBindings[definitionReadIdentifier(name, `${label}.promptBindings key`)] = definitionReadPromptBinding(binding, `${label}.promptBindings.${name}`)
  }
  let plan: TransitionStageDefinition['plan']
  if (input.plan !== undefined) {
    const value = definitionReadObject(input.plan, `${label}.plan`)
    definitionCheckKeys(value, ['stageIds', 'agentRefs', 'maxSlots'], ['stageIds', 'agentRefs', 'maxSlots'], `${label}.plan`)
    const agentRefs: DefinitionRef[] = []
    for (const [index, ref] of definitionReadArray(value.agentRefs, `${label}.plan.agentRefs`).entries()) agentRefs.push(definitionReadRef(ref, `${label}.plan.agentRefs[${index}]`, 0))
    plan = { stageIds: definitionReadStringArray(value.stageIds, `${label}.plan.stageIds`), agentRefs, maxSlots: definitionReadInteger(value.maxSlots, `${label}.plan.maxSlots`, 1) }
  }
  return {
    id: definitionReadIdentifier(input.id, `${label}.id`), kind: 'agent', agentRef: definitionReadRef(input.agentRef, `${label}.agentRef`, 0),
    dependsOn: definitionReadStringArray(input.dependsOn, `${label}.dependsOn`), ready: 'all-dependencies', resultMode: input.resultMode,
    outputPorts, ...(Object.keys(promptBindings).length ? { promptBindings } : {}), ...(plan ? { plan } : {}),
  }
}

function definitionReadTransition(/* 尚未解析的转换定义。 */ value: unknown, /* 用于错误定位的定义字段路径。 */ label: string): TransitionDefinition {
  // 解析一个转换版本的端口、数量、阶段依赖、审核和候选发布声明。
  const input = definitionReadObject(value, label)
  definitionCheckKeys(input, ['id', 'version', 'title', 'description', 'ports', 'cardinality', 'group', 'execution', 'review', 'publication'],
    ['id', 'version', 'title', 'ports', 'cardinality', 'group', 'execution', 'review'], label)
  if (input.cardinality !== '1:1' && input.cardinality !== '1:N' && input.cardinality !== 'N:1' && input.cardinality !== 'N:M') definitionFail(`${label}.cardinality is invalid`)
  const ports = definitionReadObject(input.ports, `${label}.ports`)
  definitionCheckKeys(ports, ['input', 'context', 'output'], ['input', 'context', 'output'], `${label}.ports`)
  const readInputs = (/* 尚未解析的同类端口数组。 */ value: unknown, /* 端口数组的错误字段路径。 */ path: string): TransitionInputPort[] => {
    // 按声明顺序解析一组结构输入或只读上下文端口。
    const result: TransitionInputPort[] = []
    for (const [index, item] of definitionReadArray(value, path).entries()) result.push(definitionReadInputPort(item, `${path}[${index}]`))
    return result
  }
  const output: TransitionOutputPort[] = []
  for (const [index, item] of definitionReadArray(ports.output, `${label}.ports.output`).entries()) output.push(definitionReadOutputPort(item, `${label}.ports.output[${index}]`))
  const group = definitionReadObject(input.group, `${label}.group`)
  definitionCheckKeys(group, ['mode', 'ready'], ['mode', 'ready'], `${label}.group`)
  if (group.mode !== 'explicit-members' || group.ready !== 'sealed-all-required') definitionFail(`${label}.group is unsupported`)
  const execution = definitionReadObject(input.execution, `${label}.execution`)
  definitionCheckKeys(execution, ['stages', 'resultStage'], ['stages', 'resultStage'], `${label}.execution`)
  const stages: TransitionStageDefinition[] = []
  for (const [index, item] of definitionReadArray(execution.stages, `${label}.execution.stages`).entries()) stages.push(definitionReadStage(item, `${label}.execution.stages[${index}]`))
  const review = definitionReadObject(input.review, `${label}.review`)
  definitionCheckKeys(review, ['mode', 'at', 'onReject'], ['mode', 'at', 'onReject'], `${label}.review`)
  if ((review.mode !== 'none' && review.mode !== 'required') || review.at !== 'result' || review.onReject !== 'fail') definitionFail(`${label}.review is unsupported`)
  let publication: TransitionDefinition['publication']
  if (input.publication !== undefined) {
    const value = definitionReadObject(input.publication, `${label}.publication`)
    definitionCheckKeys(value, ['includeReferencedCandidates', 'candidateStages'], ['includeReferencedCandidates'], `${label}.publication`)
    if (typeof value.includeReferencedCandidates !== 'boolean') definitionFail(`${label}.publication.includeReferencedCandidates must be boolean`)
    publication = { includeReferencedCandidates: value.includeReferencedCandidates,
      ...(value.candidateStages === undefined ? {} : { candidateStages: definitionReadStringArray(value.candidateStages, `${label}.publication.candidateStages`) }) }
  }
  return {
    ...definitionReadIdentity(input, label), title: definitionReadString(input.title, `${label}.title`),
    ...(input.description === undefined ? {} : { description: definitionReadString(input.description, `${label}.description`) }),
    ports: { input: readInputs(ports.input, `${label}.ports.input`), context: readInputs(ports.context, `${label}.ports.context`), output },
    cardinality: input.cardinality, group: { mode: 'explicit-members', ready: 'sealed-all-required' },
    execution: { stages, resultStage: definitionReadIdentifier(execution.resultStage, `${label}.execution.resultStage`) },
    review: { mode: review.mode as 'none' | 'required', at: 'result', onReject: 'fail' }, ...(publication ? { publication } : {}),
  }
}

export function definitionsReadPackage(/* 来自 JSON 资源或 definition.publish、尚未校验的完整包。 */ value: unknown): DefinitionPackage {
  // 严格解析完整定义包，引用一致性由目录校验在所有包登记后统一检查。
  const input = definitionReadObject(value, 'package')
  definitionCheckKeys(input, ['id', 'version', 'title', 'description', 'schemaDialect', 'dataTypes', 'transitions', 'dependencies'],
    ['id', 'version', 'title', 'schemaDialect', 'dataTypes', 'transitions', 'dependencies'], 'package')
  if (input.schemaDialect !== DIALECT) definitionSchemaFail('package.schemaDialect')
  const dataTypes: DataTypeDefinition[] = []
  for (const [index, item] of definitionReadArray(input.dataTypes, 'package.dataTypes').entries()) dataTypes.push(definitionReadDataType(item, `package.dataTypes[${index}]`))
  const transitions: TransitionDefinition[] = []
  for (const [index, item] of definitionReadArray(input.transitions, 'package.transitions').entries()) transitions.push(definitionReadTransition(item, `package.transitions[${index}]`))
  const dependencies = definitionReadObject(input.dependencies, 'package.dependencies')
  definitionCheckKeys(dependencies, ['packages', 'agents'], ['packages', 'agents'], 'package.dependencies')
  const packageRefs: DefinitionRef[] = [], agentRefs: DefinitionRef[] = []
  for (const [index, ref] of definitionReadArray(dependencies.packages, 'package.dependencies.packages').entries()) packageRefs.push(definitionReadRef(ref, `package.dependencies.packages[${index}]`))
  for (const [index, ref] of definitionReadArray(dependencies.agents, 'package.dependencies.agents').entries()) agentRefs.push(definitionReadRef(ref, `package.dependencies.agents[${index}]`, 0))
  return {
    ...definitionReadIdentity(input, 'package'), title: definitionReadString(input.title, 'package.title'),
    ...(input.description === undefined ? {} : { description: definitionReadString(input.description, 'package.description') }),
    schemaDialect: DIALECT, dataTypes, transitions, dependencies: { packages: packageRefs, agents: agentRefs },
  }
}

function definitionRefKey(/* 需要转换为目录键的精确定义引用。 */ ref: DefinitionRef): string {
  // 用分隔符组合身份和整数版本，目录查找不依赖对象身份。
  return `${ref.id}\u0000${ref.version}`
}

function definitionCanonical(/* 需要稳定摘要的 JSON 兼容值。 */ value: unknown): string {
  // 递归排序对象键并保留数组顺序，生成与属性插入顺序无关的规范文本。
  if (Array.isArray(value)) return `[${value.map(/* 当前需要递归规范化的数组成员。 */ item => /* 保留数组声明顺序并规范化成员。 */ definitionCanonical(item)).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort((/* 左侧对象字段名和值。 */ left, /* 右侧对象字段名和值。 */ right) => /* 按字段名固定对象序列化顺序。 */ left[0].localeCompare(right[0]))
    return `{${entries.map((/* 当前要规范化的对象字段名和值。 */ [key, item]) => /* 拼接 JSON 字段名和递归规范值。 */ `${JSON.stringify(key)}:${definitionCanonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

export function definitionsDigest(/* 需要生成不可变内容摘要的定义包或执行规格主体。 */ value: unknown): string {
  // 计算规范 JSON 的 SHA-256，供版本冲突、缓存和执行规格绑定使用。
  return createHash('sha256').update(definitionCanonical(value)).digest('hex')
}

function definitionResolve<T extends DefinitionRef>(/* 按精确身份索引的定义目录。 */ catalog: ReadonlyMap<string, T>, /* 需要解析的精确引用。 */ ref: DefinitionRef): T {
  // 从目录解析精确版本，不允许回落到相同 id 的其他版本。
  const value = catalog.get(definitionRefKey(ref))
  if (!value) throw new GraphError(404, 'DEFINITION_NOT_FOUND', messageFormat(RuntimeMessage.DEFINITION_NOT_FOUND_VALUE, ref.id, ref.version))
  return value
}

function definitionResolveAgent(/* 按精确配置版本索引的冻结 Agent 目录。 */ catalog: ReadonlyMap<string, ExecutionAgentDefinition>, /* 需要解析的 Agent 身份和配置版本。 */ ref: DefinitionRef): ExecutionAgentDefinition {
  // 从冻结 Agent 目录读取精确配置版本，不使用当前最新同名配置替代。
  const value = catalog.get(definitionRefKey(ref))
  if (!value) throw new GraphError(404, 'DEFINITION_NOT_FOUND', messageFormat(RuntimeMessage.DEFINITION_NOT_FOUND_VALUE, ref.id, ref.version))
  return value
}

function definitionValidateUniqueRefs(/* 需要保证精确身份不重复的一组引用。 */ refs: readonly DefinitionRef[], /* 用于错误定位的集合名称。 */ label: string): void {
  // 拒绝同一集合内重复精确引用，避免目录摘要或依赖语义含混。
  const keys = refs.map(/* 当前需要转换为查重键的精确引用。 */ ref => /* 使用 id/version 组合形成稳定键。 */ definitionRefKey(ref))
  if (new Set(keys).size !== keys.length) definitionFail(`${label} contains duplicate references`)
}

function definitionPointerParts(/* 已通过格式检查的 JSON Pointer。 */ pointer: string): string[] {
  // 解码 JSON Pointer 转义，供 schema 路径与 payload 字段遍历使用。
  return pointer.slice(1).split('/').map(/* 当前需要解码的 Pointer 段。 */ part => /* 还原斜线和波浪号转义。 */ part.replace(/~1/g, '/').replace(/~0/g, '~'))
}

function definitionValuesAt(/* 已通过 schema 校验的 payload 或其子值。 */ value: JsonValue, /* 需要从 payload 根解析的 JSON Pointer。 */ pointer: string): JsonValue[] {
  // 从 payload 根按属性和星号集合成员读取全部值；星号同时支持数组及字典。
  const visit = (/* 当前 Pointer 段对应的 JSON 值。 */ current: JsonValue, /* 尚未消费的 Pointer 段。 */ parts: string[]): JsonValue[] => {
    // 递归展开一个属性或集合层，缺失字段返回空集合。
    if (!parts.length) return [current]
    if (current === null || typeof current !== 'object') return []
    const [head, ...rest] = parts
    if (head === '*') {
      const children = Array.isArray(current) ? current : Object.values(current)
      const result: JsonValue[] = []
      for (const child of children) result.push(...visit(child, rest))
      return result
    }
    if (Array.isArray(current) || !(head in current)) return []
    return visit(current[head], rest)
  }
  return visit(value, definitionPointerParts(pointer))
}

function definitionSchemaAt(/* 要从中解析字段路径的根 schema。 */ root: DataSchema, /* 已声明的 payload 字段路径。 */ pointer: string): DataSchema[] {
  // 沿属性、数组或字典成员路径解析可能的 schema 分支，返回所有 oneOf 候选。
  const visit = (/* 当前正在解析的 schema 节点。 */ schema: DataSchema, /* 尚未消费的 Pointer 段。 */ parts: string[], /* 本地引用与分支遍历深度。 */ depth: number): DataSchema[] => {
    // 解析一个 schema 节点及其剩余路径，并限制递归深度。
    if (depth > MAX_SCHEMA_DEPTH) definitionSchemaFail('schema reference depth')
    if (schema.$ref) {
      const child = root.definitions?.[schema.$ref.slice('#/definitions/'.length)]
      if (!child) definitionSchemaFail(`unresolved ${schema.$ref}`)
      return visit(child, parts, depth + 1)
    }
    if (!parts.length) return [schema]
    if (schema.oneOf) {
      const result: DataSchema[] = []
      for (const branch of schema.oneOf) result.push(...visit(branch, parts, depth + 1))
      return result
    }
    const [head, ...rest] = parts
    const next = head === '*' ? schema.items ?? (typeof schema.additionalProperties === 'object' ? schema.additionalProperties : undefined) : schema.properties?.[head]
    return next ? visit(next, rest, depth + 1) : []
  }
  return visit(root, definitionPointerParts(pointer), 0)
}

function definitionValidateSchema(/* 需要检查本地引用、字段组合和 oneOf 判别的 schema。 */ schema: DataSchema, /* 用于错误定位的数据类型身份。 */ label: string): void {
  // 验证 schema 子集内部关系，拒绝递归引用、无判别 oneOf 和矛盾边界。
  const visiting = new Set<string>(), checked = new Set<string>()
  const scan = (/* 当前需要递归检查的 schema 节点。 */ current: DataSchema, /* 当前 schema 字段路径。 */ path: string): void => {
    // 核对关键字与类型配合，并遍历所有子 schema。
    if (current.$ref) visitRef(current.$ref.slice('#/definitions/'.length), path)
    if (current.required && !current.properties) definitionSchemaFail(`${path}.required without properties`)
    if (current.required) for (const name of current.required) if (!current.properties?.[name]) definitionSchemaFail(`${path}.required.${name}`)
    if (current.minItems !== undefined && current.maxItems !== undefined && current.minItems > current.maxItems) definitionSchemaFail(`${path} item bounds`)
    if (current.minLength !== undefined && current.maxLength !== undefined && current.minLength > current.maxLength) definitionSchemaFail(`${path} length bounds`)
    if (current.minimum !== undefined && current.maximum !== undefined && current.minimum > current.maximum) definitionSchemaFail(`${path} numeric bounds`)
    if (current.properties) for (const [name, child] of Object.entries(current.properties)) scan(child, `${path}.properties.${name}`)
    if (typeof current.additionalProperties === 'object') scan(current.additionalProperties, `${path}.additionalProperties`)
    if (current.items) scan(current.items, `${path}.items`)
    if (current.oneOf) {
      const tags: string[] = []
      for (const [index, branch] of current.oneOf.entries()) {
        scan(branch, `${path}.oneOf[${index}]`)
        const tag = branch.properties?.kind?.const
        if (typeof tag !== 'string' || !branch.required?.includes('kind')) definitionSchemaFail(`${path}.oneOf requires a kind const discriminator`)
        tags.push(tag)
      }
      if (new Set(tags).size !== tags.length) definitionSchemaFail(`${path}.oneOf repeats a discriminator`)
    }
  }
  const visitRef = (/* 本地 definitions 中需要检查的名称。 */ name: string, /* 引用出现的 schema 路径。 */ path: string): void => {
    // 深度优先检查本地引用并拒绝递归环。
    if (visiting.has(name)) definitionSchemaFail(`${path} contains a recursive reference`)
    if (checked.has(name)) return
    const target = schema.definitions?.[name]
    if (!target) definitionSchemaFail(`${path} references missing definition ${name}`)
    visiting.add(name); scan(target, `${label}.definitions.${name}`); visiting.delete(name); checked.add(name)
  }
  scan(schema, label)
  for (const name of Object.keys(schema.definitions ?? {})) visitRef(name, label)
}

function definitionValidateType(/* 已登记、准备检查路径和类型引用的数据类型。 */ type: DataTypeDefinition, /* 全部可用数据类型目录。 */ types: ReadonlyMap<string, DataTypeDefinition>): void {
  // 校验类型 schema、精确后继、真实引用和模型投影的字段路径。
  definitionValidateSchema(type.schema, `${type.id}@${type.version}`)
  definitionValidateUniqueRefs(type.successorTypes, `${type.id}.successorTypes`)
  for (const ref of type.successorTypes) definitionResolve(types, ref)
  for (const reference of type.references) {
    const referenceSchemas = definitionSchemaAt(type.schema, reference.path)
    if (!referenceSchemas.length) definitionFail(`${type.id} reference path ${reference.path} is absent from schema`)
    if (referenceSchemas.some(/* 当前检查真实引用字段是否严格保存字符串身份。 */ schema => /* 资产和节点引用不接受数值、对象或可空值。 */ schema.type !== 'string')) definitionFail(`${type.id} reference path ${reference.path} must contain strings`)
    if (reference.when && !definitionSchemaAt(type.schema, reference.when.path).length) definitionFail(`${type.id} reference condition ${reference.when.path} is absent from schema`)
    if (reference.target.kind === 'node') for (const ref of reference.target.types) definitionResolve(types, ref)
  }
  for (const pointer of type.agentProjection.include) if (!definitionSchemaAt(type.schema, pointer).length) definitionFail(`${type.id} projection path ${pointer} is absent from schema`)
  for (const filter of type.agentProjection.mapEntryFilters) {
    if (!type.agentProjection.include.some(/* 当前与字典过滤路径比较的投影白名单项。 */ pointer => /* 过滤只能缩小已经允许的投影字段。 */ filter.path === pointer || filter.path.startsWith(`${pointer}/`))) definitionFail(`${type.id} filter ${filter.path} is outside projection`)
    if (!definitionSchemaAt(type.schema, `${filter.path}/*/${filter.visibleWhen}`).some(/* 当前检查是否为布尔可见性字段的 schema 候选。 */ field => /* 可见性判别必须明确声明 boolean。 */ field.type === 'boolean')) definitionFail(`${type.id} filter ${filter.path} has no boolean discriminator`)
  }
  for (const pointer of [type.presentation?.titlePath, type.presentation?.summaryPath, ...(type.presentation?.fieldOrder ?? [])]) {
    if (pointer && !definitionSchemaAt(type.schema, pointer).length) definitionFail(`${type.id} presentation path ${pointer} is absent from schema`)
  }
}

function definitionCountTotals(/* 要汇总最小和最大数量的端口集合。 */ ports: ReadonlyArray<{ count: DefinitionCount }>): DefinitionCount {
  // 汇总多端口的数量区间，用于核对转换 cardinality。
  let min = 0, max = 0
  for (const port of ports) { min += port.count.min; max += port.count.max }
  return { min, max }
}

function definitionIsSourceLocatorSchema(/* source-text 路径解析到的候选 schema。 */ schema: DataSchema): boolean {
  // 确认字段是由 kind 唯一判别的 asset/url 联合，并具备受限读取所需字段。
  const branches = schema.oneOf ?? []
  const asset = branches.find(/* 当前判断是否为资产定位分支的 schema。 */ branch => /* 用 kind 常量识别资产分支。 */ branch.properties?.kind?.const === 'asset')
  const url = branches.find(/* 当前判断是否为 URL 定位分支的 schema。 */ branch => /* 用 kind 常量识别 URL 分支。 */ branch.properties?.kind?.const === 'url')
  return !!asset && !!url && asset.required?.includes('kind') === true && asset.required.includes('assetId') && asset.required.includes('mediaType')
    && asset.properties?.assetId?.type === 'string' && asset.properties.mediaType?.type === 'string'
    && url.required?.includes('kind') === true && url.required.includes('url') && url.properties?.url?.type === 'string' && url.properties.url.format === 'uri'
}

function definitionValidateTransition(/* 已登记、准备检查端口与阶段关系的转换。 */ transition: TransitionDefinition, /* 全部可用数据类型目录。 */ types: ReadonlyMap<string, DataTypeDefinition>, /* 可用 Agent 精确版本目录。 */ agents: ReadonlyMap<string, ExecutionAgentDefinition>): void {
  // 校验转换端口、数量关系、后继许可、输出锚点 DAG、阶段 DAG 及 Agent 绑定。
  const { input, context, output } = transition.ports
  if (!input.length || !output.length) definitionFail(`${transition.id} requires input and output ports`)
  const portNames = [...input, ...context, ...output].map(/* 当前需要提取名称查重的转换端口。 */ port => /* 返回端口稳定名称。 */ port.name)
  if (new Set(portNames).size !== portNames.length) definitionFail(`${transition.id} repeats a port name`)
  for (const port of [...input, ...context]) definitionResolve(types, port.inputType)
  for (const port of output) definitionResolve(types, port.outputType)
  const inputCounts = definitionCountTotals(input), outputCounts = definitionCountTotals(output)
  if (inputCounts.min < 1) definitionFail(`${transition.id} must require a structural input`)
  if (transition.cardinality.startsWith('1:') ? inputCounts.min !== 1 || inputCounts.max !== 1 : inputCounts.max < 2) definitionFail(`${transition.id} input count conflicts with cardinality`)
  if (transition.cardinality.endsWith(':1') ? outputCounts.min !== 1 || outputCounts.max !== 1 : outputCounts.max < 2) definitionFail(`${transition.id} output count conflicts with cardinality`)
  const outputByName = new Map(output.map(/* 当前要建立名称索引的输出端口。 */ port => /* 将输出端口名称映射到定义。 */ [port.name, port]))
  const visitOutput = (/* 需要检查同批输出锚点的输出端口名。 */ name: string, /* 当前深度优先路径中的输出端口。 */ visiting: Set<string>, /* 已完成检查的输出端口集合。 */ visited: Set<string>): void => {
    // 深度优先检查同批输出锚点无环，并核对每条锚点的后继许可。
    if (visiting.has(name)) definitionFail(`${transition.id} output successor anchors form a cycle`)
    if (visited.has(name)) return
    const port = outputByName.get(name)
    if (!port) definitionFail(`${transition.id} refers to unknown output port ${name}`)
    visiting.add(name)
    for (const anchor of port.successorOf) {
      const anchorRef = anchor.source === 'input'
        ? input.find(/* 当前与结构锚点名称匹配的输入端口。 */ candidate => /* 定位声明的输入锚点。 */ candidate.name === anchor.port)?.inputType
        : outputByName.get(anchor.port)?.outputType
      if (!anchorRef) definitionFail(`${transition.id} refers to unknown ${anchor.source} anchor ${anchor.port}`)
      const anchorType = definitionResolve(types, anchorRef)
      if (!anchorType.successorTypes.some(/* 当前与输出类型精确比较的允许后继引用。 */ ref => /* 要求身份和版本都在许可中。 */ definitionRefKey(ref) === definitionRefKey(port.outputType))) definitionFail(`${transition.id} output ${port.name} is not an allowed successor of ${anchor.port}`)
      if (anchor.source === 'output') visitOutput(anchor.port, visiting, visited)
    }
    visiting.delete(name); visited.add(name)
  }
  const checkedOutputs = new Set<string>()
  for (const port of output) visitOutput(port.name, new Set(), checkedOutputs)
  if (!transition.execution.stages.length || transition.execution.stages.length > MAX_STAGES) definitionFail(`${transition.id} has an invalid stage count`)
  const stages = new Map(transition.execution.stages.map(/* 当前要建立身份索引的阶段模板。 */ stage => /* 将阶段身份映射到定义。 */ [stage.id, stage]))
  if (stages.size !== transition.execution.stages.length) definitionFail(`${transition.id} repeats a stage id`)
  const visitStage = (/* 需要检查依赖闭包的阶段身份。 */ id: string, /* 当前深度优先路径中的阶段集合。 */ visiting: Set<string>, /* 已完成检查的阶段集合。 */ visited: Set<string>): void => {
    // 深度优先检查阶段依赖存在且无环。
    if (visiting.has(id)) definitionFail(`${transition.id} stage dependencies form a cycle`)
    if (visited.has(id)) return
    const stage = stages.get(id)
    if (!stage) definitionFail(`${transition.id} refers to unknown stage ${id}`)
    visiting.add(id)
    for (const dependency of stage.dependsOn) visitStage(dependency, visiting, visited)
    visiting.delete(id); visited.add(id)
  }
  const visited = new Set<string>()
  visitStage(transition.execution.resultStage, new Set(), visited)
  if (visited.size !== stages.size) definitionFail(`${transition.id} contains a stage outside the result dependency closure`)
  const plannedTargets = new Map<string, string>()
  for (const stage of transition.execution.stages) {
    const stageAgent = definitionResolveAgent(agents, stage.agentRef)
    if ((stage.resultMode === 'plan') !== !!stage.plan) definitionFail(`${transition.id}.${stage.id} plan contract does not match resultMode`)
    const names = stage.outputPorts.map(/* 当前要提取名称查重的阶段输出声明。 */ port => /* 返回其 Operation 输出端口名。 */ port.port)
    if (new Set(names).size !== names.length) definitionFail(`${transition.id}.${stage.id} repeats an output port`)
    for (const declared of stage.outputPorts) if (!outputByName.has(declared.port)) definitionFail(`${transition.id}.${stage.id} refers to unknown output port ${declared.port}`)
    if (stage.resultMode !== 'plan' && !stage.outputPorts.length) definitionFail(`${transition.id}.${stage.id} requires an output contract`)
    if (stage.plan) {
      const dependsOnPlanner = (/* 计划将动态实例化的目标阶段身份。 */ stageId: string, /* 已遍历的阶段集合，防止重复搜索。 */ checked: Set<string>): boolean => {
        // 检查目标阶段的依赖闭包是否包含当前 planner，确保计划先于目标执行。
        if (checked.has(stageId)) return false
        checked.add(stageId)
        const target = stages.get(stageId)
        if (!target) return false
        return target.dependsOn.includes(stage.id) || target.dependsOn.some(/* 当前继续向上检查的目标阶段依赖。 */ dependency => /* 递归确认依赖链最终包含 planner。 */ dependsOnPlanner(dependency, checked))
      }
      for (const stageId of stage.plan.stageIds) {
        if (!stages.has(stageId) || stageId === stage.id || !dependsOnPlanner(stageId, new Set())) definitionFail(`${transition.id}.${stage.id} plans an unrelated stage`)
        if (plannedTargets.has(stageId)) definitionFail(`${transition.id}.${stageId} is controlled by multiple plan stages`)
        plannedTargets.set(stageId, stage.id)
      }
      for (const ref of stage.plan.agentRefs) definitionResolveAgent(agents, ref)
      if (!stage.plan.agentRefs.length) definitionFail(`${transition.id}.${stage.id} plan has no allowed Agent`)
    }
    for (const binding of Object.values(stage.promptBindings ?? {})) {
      if (binding.source === 'input' || binding.source === 'context') {
        const available = binding.source === 'input' ? input : context
        const boundPort = available.find(/* 当前与提示词绑定名称比较的输入端口。 */ port => /* 定位变量获准读取的精确端口。 */ port.name === binding.port)
        if (!boundPort) definitionFail(`${transition.id}.${stage.id} binds unknown ${binding.source} ${binding.port}`)
        if (binding.path) {
          const bindingPath = binding.path
          const boundType = definitionResolve(types, boundPort.inputType)
          if (!definitionSchemaAt(boundType.schema, bindingPath).length) definitionFail(`${transition.id}.${stage.id} binds missing field ${bindingPath}`)
          if (!boundType.agentProjection.include.some(/* 当前与变量字段路径比较的模型投影入口。 */ pointer => /* 变量只能读取白名单字段本身或其子字段。 */ bindingPath === pointer || bindingPath.startsWith(`${pointer}/`))) definitionFail(`${transition.id}.${stage.id} binding crosses the Agent projection`)
        }
      }
      if (binding.source === 'stage' && !stage.dependsOn.includes(binding.stageId)) definitionFail(`${transition.id}.${stage.id} reads a non-dependency stage`)
      if (binding.source === 'agents' && !stage.plan) definitionFail(`${transition.id}.${stage.id} exposes an Agent directory outside a plan stage`)
      if (binding.source === 'source-text') {
        const sourcePort = [...input, ...context].find(/* 当前与来源正文绑定端口比较的输入。 */ port => /* 定位显式声明的来源输入端口。 */ port.name === binding.port)
        if (!sourcePort) definitionFail(`${transition.id}.${stage.id} binds unknown source port`)
        const sourceType = definitionResolve(types, sourcePort.inputType)
        if (!sourceType.agentProjection.include.some(/* 当前与来源字段路径比较的模型投影入口。 */ pointer => /* 来源定位也必须位于 Agent 白名单内。 */ binding.path === pointer || binding.path.startsWith(`${pointer}/`))) definitionFail(`${transition.id}.${stage.id} source-text crosses the Agent projection`)
        if (!definitionSchemaAt(sourceType.schema, binding.path).some(/* 当前判断是否为受支持来源定位联合的 schema。 */ candidate => /* 只接受显式 asset/url 判别联合。 */ definitionIsSourceLocatorSchema(candidate))) definitionFail(`${transition.id}.${stage.id} source-text path is not an asset/url locator`)
      }
    }
    if (stageAgent.profile.promptVars?.some(/* 当前检查 Agent 请求的提示词变量是否由阶段绑定提供。 */ name => /* 防止执行时再从业务类型名称猜测缺失变量。 */ !(name in (stage.promptBindings ?? {})))) definitionFail(`${transition.id}.${stage.id} Agent uses an undeclared prompt variable`)
  }
  const resultStage = stages.get(transition.execution.resultStage)!
  const expected = new Map(output.map(/* 当前正式输出端口及其总数量约束。 */ port => /* 建立结果阶段必须匹配的端口数量索引。 */ [port.name, port.count]))
  if (!transition.publication?.includeReferencedCandidates) {
    if (resultStage.outputPorts.length !== expected.size || resultStage.outputPorts.some(/* 当前核对结果阶段单个输出端口。 */ port => {
      // 普通发布要求最终阶段逐端口使用 Operation 的总数量约束。
      const count = expected.get(port.port); return !count || count.min !== port.count.min || count.max !== port.count.max
    })) definitionFail(`${transition.id} result stage must match operation output counts`)
  } else {
    for (const port of resultStage.outputPorts) {
      const count = expected.get(port.port)
      if (!count || count.min !== port.count.min || count.max !== port.count.max) definitionFail(`${transition.id} result stage has invalid root output counts`)
    }
  }
  if (transition.publication?.includeReferencedCandidates) {
    if (!transition.publication.candidateStages?.length) definitionFail(`${transition.id} must declare candidate stages for referenced publication`)
    for (const id of transition.publication.candidateStages) if (!stages.has(id) || id === transition.execution.resultStage || !visited.has(id)) definitionFail(`${transition.id} has an invalid publication candidate stage`)
    const supplied = new Set([...resultStage.outputPorts.map(/* 当前由结果阶段直接提供的根输出端口。 */ port => /* 返回根输出端口名。 */ port.port)])
    for (const id of transition.publication.candidateStages) for (const port of stages.get(id)!.outputPorts) supplied.add(port.port)
    for (const port of output) if (!supplied.has(port.name)) definitionFail(`${transition.id} has no publishing stage for output ${port.name}`)
  } else if (transition.publication?.candidateStages?.length) definitionFail(`${transition.id} declares candidate stages while candidate publication is disabled`)
}

export function definitionsValidateCatalog(/* 需要共同解析引用和版本冲突的完整发布包集合。 */ packages: readonly DefinitionPackage[], /* 可被阶段精确引用的 Agent 配置版本。 */ agents: readonly ExecutionAgentDefinition[] = [], /* 此目录所属工作区的公开版本。 */ revision = 0): DefinitionCatalog {
  // 先登记所有包、类型、转换和 Agent，再校验前向引用并生成带摘要的目录快照。
  if (packages.length > MAX_DEFINITIONS) definitionFail('catalog contains too many packages')
  const packageMap = new Map<string, DefinitionPackage>(), types = new Map<string, DataTypeDefinition>(), transitions = new Map<string, TransitionDefinition>()
  const typeOwners = new Map<string, string>()
  const agentMap = new Map<string, ExecutionAgentDefinition>()
  for (const agent of agents) {
    const key = definitionRefKey(agent.ref)
    if (agentMap.has(key)) definitionFail(`Agent ${agent.ref.id}@${agent.ref.version} is duplicated`)
    agentMap.set(key, structuredClone(agent))
  }
  for (const source of packages) {
    const item = definitionsReadPackage(source)
    const key = definitionRefKey(item)
    const prior = packageMap.get(key)
    if (prior && definitionsDigest(prior) !== definitionsDigest(item)) throw new GraphError(409, 'DEFINITION_VERSION_CONFLICT', messageFormat(RuntimeMessage.DEFINITION_VERSION_CONFLICT_VALUE, item.id, item.version))
    if (prior) continue
    packageMap.set(key, item)
    for (const type of item.dataTypes) {
      const typeKey = definitionRefKey(type), existing = types.get(typeKey)
      if (existing && definitionsDigest(existing) !== definitionsDigest(type)) throw new GraphError(409, 'DEFINITION_VERSION_CONFLICT', messageFormat(RuntimeMessage.DEFINITION_VERSION_CONFLICT_VALUE, type.id, type.version))
      if (existing) definitionFail(`data type ${type.id}@${type.version} is published by more than one package`)
      types.set(typeKey, type)
      typeOwners.set(typeKey, key)
    }
    for (const transition of item.transitions) {
      const transitionKey = definitionRefKey(transition), existing = transitions.get(transitionKey)
      if (existing && definitionsDigest(existing) !== definitionsDigest(transition)) throw new GraphError(409, 'DEFINITION_VERSION_CONFLICT', messageFormat(RuntimeMessage.DEFINITION_VERSION_CONFLICT_VALUE, transition.id, transition.version))
      if (existing) definitionFail(`transition ${transition.id}@${transition.version} is published by more than one package`)
      transitions.set(transitionKey, transition)
    }
  }
  for (const item of packageMap.values()) {
    definitionValidateUniqueRefs(item.dependencies.packages, `${item.id}.dependencies.packages`)
    definitionValidateUniqueRefs(item.dependencies.agents, `${item.id}.dependencies.agents`)
    for (const ref of item.dependencies.packages) definitionResolve(packageMap, ref)
    for (const ref of item.dependencies.agents) definitionResolveAgent(agentMap, ref)
    const ownKey = definitionRefKey(item), allowedPackages = new Set([ownKey, ...item.dependencies.packages.map(definitionRefKey)])
    const requireTypeDependency = (/* 当前包引用的精确数据类型。 */ ref: DefinitionRef, /* 错误定位说明。 */ label: string) => {
      // 每条跨包类型引用必须出现在当前包的直接精确依赖中，保证导出闭包完整。
      const owner = typeOwners.get(definitionRefKey(ref))
      if (!owner || !allowedPackages.has(owner)) definitionFail(`${item.id} omits package dependency for ${label} ${ref.id}@${ref.version}`)
    }
    for (const type of item.dataTypes) {
      for (const ref of type.successorTypes) requireTypeDependency(ref, `${type.id}.successorTypes`)
      for (const reference of type.references) if (reference.target.kind === 'node') {
        for (const ref of reference.target.types) requireTypeDependency(ref, `${type.id}.references`)
      }
    }
    for (const transition of item.transitions) {
      for (const port of [...transition.ports.input, ...transition.ports.context]) requireTypeDependency(port.inputType, `${transition.id}.${port.name}`)
      for (const port of transition.ports.output) requireTypeDependency(port.outputType, `${transition.id}.${port.name}`)
    }
    for (const type of item.dataTypes) definitionValidateType(type, types)
    for (const transition of item.transitions) {
      for (const stage of transition.execution.stages) if (!item.dependencies.agents.some(/* 当前与阶段 Agent 比较的包依赖。 */ ref => /* 要求阶段绑定已列入包的精确 Agent 依赖。 */ definitionRefKey(ref) === definitionRefKey(stage.agentRef))) definitionFail(`${item.id} omits Agent dependency ${stage.agentRef.id}@${stage.agentRef.version}`)
      for (const stage of transition.execution.stages) for (const ref of stage.plan?.agentRefs ?? []) if (!item.dependencies.agents.some(/* 当前与计划候选 Agent 比较的包依赖。 */ dependency => /* 要求每个动态候选都列入精确 Agent 依赖。 */ definitionRefKey(dependency) === definitionRefKey(ref))) definitionFail(`${item.id} omits planned Agent dependency ${ref.id}@${ref.version}`)
      definitionValidateTransition(transition, types, agentMap)
    }
  }
  return {
    revision,
    packages: [...packageMap.values()].map(/* 当前需要投影引用和摘要的不可变包。 */ item => /* 为目录缓存生成包引用及稳定摘要。 */ ({ ref: { id: item.id, version: item.version }, digest: definitionsDigest(item) })),
    index: [...packageMap.values()].flatMap(/* 当前需要建立定义到发布包索引的不可变包。 */ item => {
      // 为包内每个类型和转换记录精确来源，供客户端按包缓存及导出依赖闭包。
      const packageRef = { id: item.id, version: item.version }
      return [...item.dataTypes.map(/* 当前要加入索引的数据类型。 */ type => /* 记录类型与所属发布包。 */ ({ kind: 'dataType' as const, ref: { id: type.id, version: type.version }, packageRef })),
        ...item.transitions.map(/* 当前要加入索引的转换。 */ transition => /* 记录转换与所属发布包。 */ ({ kind: 'transition' as const, ref: { id: transition.id, version: transition.version }, packageRef }))]
    }),
    dataTypes: structuredClone([...types.values()]), transitions: structuredClone([...transitions.values()]),
  }
}

export function definitionsReadType(/* 已通过完整发布校验的定义目录。 */ catalog: DefinitionCatalog, /* 需要读取的精确数据类型版本。 */ ref: DefinitionRef): DataTypeDefinition {
  // 从目录读取独立类型副本，未知版本明确失败而不回落。
  const types = new Map(catalog.dataTypes.map(/* 当前需要建立精确身份索引的数据类型。 */ type => /* 将类型精确身份映射到定义。 */ [definitionRefKey(type), type]))
  return structuredClone(definitionResolve(types, ref))
}

export function definitionsReadTransition(/* 已通过完整发布校验的定义目录。 */ catalog: DefinitionCatalog, /* 需要读取的精确转换版本。 */ ref: DefinitionRef): TransitionDefinition {
  // 从目录读取独立转换副本，未知版本明确失败而不回落。
  const transitions = new Map(catalog.transitions.map(/* 当前需要建立精确身份索引的转换。 */ transition => /* 将转换精确身份映射到定义。 */ [definitionRefKey(transition), transition]))
  return structuredClone(definitionResolve(transitions, ref))
}

function definitionValueMatchesType(/* 已解析 schema 的 type 声明。 */ type: DataSchema['type'], /* 需要核对基础类型的 payload 值。 */ value: unknown): boolean {
  // 按 JSON Schema 基础类型判断值，不进行字符串或数字强制转换。
  if (!type) return true
  const types = Array.isArray(type) ? type : [type]
  return types.some(/* 当前与 payload 基础类型比较的 schema 类型。 */ item => {
    // 判断一个 schema 类型是否与实际 JSON 值精确匹配。
    if (item === 'null') return value === null
    if (item === 'array') return Array.isArray(value)
    if (item === 'object') return !!value && typeof value === 'object' && !Array.isArray(value)
    if (item === 'integer') return typeof value === 'number' && Number.isSafeInteger(value)
    return typeof value === item
  })
}

function definitionValidateValue(/* 当前字段或本地引用解析后的 schema。 */ schema: DataSchema, /* schema 所属根定义，用于解析本地引用。 */ root: DataSchema, /* 需要验证且不会被转换的 payload 值。 */ value: unknown, /* 用于错误定位的 payload 字段路径。 */ path: string, /* 当前 schema 递归深度。 */ depth = 0): void {
  // 按受支持 schema 子集验证 payload，任何不匹配都以稳定 PAYLOAD_INVALID 失败。
  const fail = (/* 当前值违反的 schema 规则说明。 */ reason: string): never => {
    // 报告 payload 路径和失败规则，不回显可能包含私有内容的实际值。
    throw new GraphError(422, 'PAYLOAD_INVALID', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, `${path} ${reason}`))
  }
  if (depth > MAX_SCHEMA_DEPTH) return fail('exceeds schema depth')
  if (schema.$ref) {
    const target = root.definitions?.[schema.$ref.slice('#/definitions/'.length)]
    if (!target) return fail('uses an unresolved schema reference')
    return definitionValidateValue(target, root, value, path, depth + 1)
  }
  if (schema.oneOf) {
    let matches = 0
    for (const branch of schema.oneOf) {
      try { definitionValidateValue(branch, root, value, path, depth + 1); matches += 1 } catch (error) { if (!(error instanceof GraphError && error.code === 'PAYLOAD_INVALID')) throw error }
    }
    if (matches !== 1) return fail('must match exactly one oneOf branch')
  }
  if (!definitionValueMatchesType(schema.type, value)) return fail('has the wrong type')
  if (schema.enum && !schema.enum.some(/* 当前与 payload 比较的枚举成员。 */ item => /* 用规范 JSON 判断结构枚举相等。 */ definitionCanonical(item) === definitionCanonical(value))) return fail('is outside enum')
  if (schema.const !== undefined && definitionCanonical(schema.const) !== definitionCanonical(value)) return fail('does not match const')
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) return fail('is shorter than minLength')
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return fail('is longer than maxLength')
    if (schema.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value)))) return fail('is not date-time')
    if (schema.format === 'uri') { try { new URL(value) } catch { return fail('is not a URI') } }
    if (schema.format === 'uuid' && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) return fail('is not a UUID')
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('must be finite')
    if (schema.minimum !== undefined && value < schema.minimum) return fail('is below minimum')
    if (schema.maximum !== undefined && value > schema.maximum) return fail('is above maximum')
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return fail('has fewer than minItems')
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return fail('has more than maxItems')
    if (schema.uniqueItems && new Set(value.map(/* 当前需要规范化以检查重复的数组项。 */ item => /* 生成结构值稳定比较文本。 */ definitionCanonical(item))).size !== value.length) return fail('contains duplicate items')
    if (schema.items) for (const [index, item] of value.entries()) definitionValidateValue(schema.items, root, item, `${path}[${index}]`, depth + 1)
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>
    for (const name of schema.required ?? []) if (!(name in object)) return fail(`is missing ${name}`)
    for (const [name, item] of Object.entries(object)) {
      const child = schema.properties?.[name]
      if (child) definitionValidateValue(child, root, item, `${path}.${name}`, depth + 1)
      else if (schema.additionalProperties === false) return fail(`does not allow ${name}`)
      else if (typeof schema.additionalProperties === 'object') definitionValidateValue(schema.additionalProperties, root, item, `${path}.${name}`, depth + 1)
    }
  }
}

export function definitionsValidatePayload(/* 已通过完整发布校验的定义目录。 */ catalog: DefinitionCatalog, /* payload 声明使用的精确数据类型。 */ typeRef: DefinitionRef, /* 来自客户端或 Agent、尚未验证的实例内容。 */ payload: unknown): JsonValue {
  // 根据精确类型 schema 验证实例并返回独立 JSON 副本，绝不改写默认值或删除字段。
  const type = definitionsReadType(catalog, typeRef)
  const value = definitionReadJsonValue(payload, 'payload')
  definitionValidateValue(type.schema, type.schema, value, 'payload')
  return value
}

export function definitionsReadPayloadReferences(/* 已通过完整发布校验的定义目录。 */ catalog: DefinitionCatalog, /* payload 声明使用的精确数据类型。 */ typeRef: DefinitionRef, /* 来自客户端、Agent 或导入包的实例内容。 */ payload: unknown): PayloadReferenceValue[] {
  // 先验证完整 payload，再按类型定义从根路径展开资产和节点引用及其根路径条件。
  const type = definitionsReadType(catalog, typeRef)
  const value = definitionsValidatePayload(catalog, typeRef, payload)
  const result: PayloadReferenceValue[] = []
  for (const reference of type.references) {
    if (reference.when && !definitionValuesAt(value, reference.when.path).some(/* 当前与引用条件常量比较的根路径值。 */ item => /* 用规范 JSON 比较条件值，不执行类型转换。 */ definitionCanonical(item) === definitionCanonical(reference.when?.equals))) continue
    for (const item of definitionValuesAt(value, reference.path)) {
      if (typeof item !== 'string') throw new GraphError(422, 'PAYLOAD_INVALID', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, `${reference.path} must contain a string reference`))
      result.push({ definition: structuredClone(reference), value: item })
    }
  }
  return result
}

function definitionValidateBindings(/* 某类端口的冻结数据绑定。 */ actual: Record<string, DataInstanceRef[]>, /* 转换声明的对应端口集合。 */ ports: readonly TransitionInputPort[], /* 用于错误定位的输入种类名称。 */ label: string): Record<string, DataInstanceRef[]> {
  // 要求每个声明端口恰有一组满足数量和精确类型的冻结引用，且没有额外端口。
  const allowed = new Set(ports.map(/* 当前提取名称建立允许集合的输入端口。 */ port => /* 返回端口名称。 */ port.name))
  for (const name of Object.keys(actual)) if (!allowed.has(name)) definitionFail(`${label} contains unknown port ${name}`)
  const result: Record<string, DataInstanceRef[]> = {}
  for (const port of ports) {
    const refs = actual[port.name] ?? []
    if (refs.length < port.count.min || refs.length > port.count.max) throw new GraphError(422, 'OUTPUT_CARDINALITY', messageFormat(RuntimeMessage.OUTPUT_CARDINALITY_VALUE, `${label}.${port.name}`))
    const ids = new Set<string>()
    for (const ref of refs) {
      if (definitionRefKey(ref.type) !== definitionRefKey(port.inputType)) definitionFail(`${label}.${port.name} contains another data type`)
      if (!Number.isSafeInteger(ref.revision) || ref.revision < 0 || !ref.id) definitionFail(`${label}.${port.name} contains an invalid data reference`)
      if (ids.has(ref.id)) definitionFail(`${label}.${port.name} repeats data ${ref.id}`)
      ids.add(ref.id)
    }
    result[port.name] = structuredClone(refs)
  }
  return result
}

export function definitionsFreezeExecution(/* 已验证目录、精确转换、Agent/工具目录和本次封闭输入。 */ input: DefinitionsFreezeInput): ExecutionSpec {
  // 解析并复制本次 Operation 的完整执行闭包，再计算不包含自身哈希字段的稳定 specHash。
  const transition = definitionsReadTransition(input.catalog, input.transitionRef)
  const types = new Map(input.catalog.dataTypes.map(/* 当前要建立精确身份索引的数据类型。 */ type => /* 将类型精确身份映射到定义。 */ [definitionRefKey(type), type]))
  const agents = new Map(input.agents.map(/* 当前要建立精确身份索引的 Agent。 */ agent => /* 将 Agent 精确身份映射到冻结配置。 */ [definitionRefKey(agent.ref), agent]))
  const tools = new Map(input.tools.map(/* 当前要建立名称索引的共享工具。 */ tool => /* 将工具名称映射到声明。 */ [tool.name, tool]))
  const inputs = definitionValidateBindings(input.inputs, transition.ports.input, 'inputs')
  const context = definitionValidateBindings(input.context, transition.ports.context, 'context')
  const dataTypes = new Map<string, DataTypeDefinition>()
  for (const port of [...transition.ports.input, ...transition.ports.context]) dataTypes.set(definitionRefKey(port.inputType), structuredClone(definitionResolve(types, port.inputType)))
  for (const port of transition.ports.output) dataTypes.set(definitionRefKey(port.outputType), structuredClone(definitionResolve(types, port.outputType)))
  const stages: ExecutionSpec['stages'] = []
  for (const stage of transition.execution.stages) {
    const agent = structuredClone(definitionResolveAgent(agents, stage.agentRef))
    const stageTools: Array<{ name: string; description: string }> = []
    for (const name of agent.profile.tools) {
      const tool = tools.get(name)
      if (!tool) definitionFail(`${stage.id} Agent refers to unavailable tool ${name}`)
      stageTools.push(structuredClone(tool))
    }
    const outputPorts = new Map(transition.ports.output.map(/* 当前要建立名称索引的转换输出端口。 */ port => /* 将端口名称映射到完整定义。 */ [port.name, port]))
    const contractPorts = stage.outputPorts.map(/* 当前阶段声明的一个输出端口及数量。 */ declared => {
      // 将阶段端口与精确类型 schema 及结构锚点组合成冻结输出合同。
      const port = outputPorts.get(declared.port)
      if (!port) return definitionFail(`${stage.id} refers to unknown output port ${declared.port}`)
      const type = definitionResolve(types, port.outputType)
      return { port: port.name, type: structuredClone(port.outputType), count: structuredClone(declared.count), schema: structuredClone(type.schema),
        references: structuredClone(type.references), successorOf: structuredClone(port.successorOf) }
    })
    let plan: ExecutionSpec['stages'][number]['plan']
    if (stage.plan) {
      const planAgents: ExecutionAgentDefinition[] = []
      for (const ref of stage.plan.agentRefs) planAgents.push(structuredClone(definitionResolveAgent(agents, ref)))
      const planTools = new Map<string, { name: string; description: string }>()
      for (const candidate of planAgents) for (const name of candidate.profile.tools) {
        const tool = tools.get(name)
        if (!tool) definitionFail(`${stage.id} planned Agent refers to unavailable tool ${name}`)
        planTools.set(name, structuredClone(tool))
      }
      plan = { stageIds: [...stage.plan.stageIds], agents: planAgents, tools: [...planTools.values()], maxSlots: stage.plan.maxSlots }
    }
    stages.push({ id: stage.id, dependsOn: [...stage.dependsOn], agent, tools: stageTools,
      promptBindings: structuredClone(stage.promptBindings ?? {}), outputContract: { mode: stage.resultMode, ports: contractPorts }, ...(plan ? { plan } : {}) })
  }
  const body: Omit<ExecutionSpec, 'specHash'> = {
    transition, dataTypes: [...dataTypes.values()], inputs, context, stages, resultStage: transition.execution.resultStage,
    review: structuredClone(transition.review), definitionDigests: input.catalog.packages.map(/* 当前收集到执行闭包摘要中的发布包。 */ item => /* 保留目录给出的不可变包摘要。 */ item.digest),
  }
  return { ...body, specHash: definitionsDigest(body) }
}
