// 为注册数据类型生成可编辑初值，并按声明路径读取画布标题和摘要。
import type { DataSchema, DataTypeDefinition, DefinitionCatalog, DefinitionRef, JsonValue } from '../../../../contracts/data-definition'
import type { GraphNode } from '../../../../contracts/graph'
import { messageFormat, RuntimeMessage } from '../../../../contracts/messages'

/**
 * 浏览器支持 structuredClone；显式复制避免多个表单共享定义中的 default 对象。
 *
 * @param value 需要与定义默认值隔离的 JSON 数据。
 */
function payloadClone<T extends JsonValue>(value: T): T {
  return structuredClone(value)
}

/**
 * @param ref 需要稳定比较的精确定义引用。
 */
export function definitionKey(ref: DefinitionRef): string {
  return `${ref.id}@${ref.version}`
}

/**
 * @param catalog 工作区当前可用的不可变定义目录。
 * @param node 带精确类型版本的数据实例。
 */
export function payloadFindType(
  catalog: DefinitionCatalog | null | undefined,
  node: Pick<GraphNode, 'typeId' | 'typeVersion'>
): DataTypeDefinition | undefined {
  return catalog?.dataTypes.find(type => type.id === node.typeId && type.version === node.typeVersion)
}

/**
 * @param schema 可能包含本地引用的 schema。
 * @param root 引用所属的根 schema。
 */
export function payloadResolveSchema(
  /* 已发布定义中的字段 schema，引用格式已由服务端校验。 */ schema: DataSchema,
  /* 本地引用所属的根 schema，包含对应的 definitions。 */ root: DataSchema,
): DataSchema {
  // 解析已验证的本地引用；目标缺失时暴露定义错误，避免把引用字段显示成字符串。
  if (!schema.$ref) return schema
  const target = root.definitions?.[schema.$ref.slice('#/definitions/'.length)]
  if (!target) throw new Error(messageFormat(RuntimeMessage.SCHEMA_UNSUPPORTED_VALUE, schema.$ref))
  return target
}

/**
 * 未写 type 的 oneOf/$ref 由调用方先解析；普通字段统一投影为数组便于选择初值。
 *
 * @param schema 字段 schema 中的单个或可空类型声明。
 */
function payloadTypes(schema: DataSchema): string[] {
  return schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type]
}

/**
 * 优先使用显式默认值；否则递归构造最小 JSON 形状，不偷偷执行业务转换。
 *
 * @param schema 准备建立表单值的字段 schema。
 * @param root 本地引用所属根 schema。
 */
export function payloadCreateInitial(
  /* 已发布定义或递归表单建立的合法字段schema。 */ schema: DataSchema,
  /* 本地引用所属根定义，缺省时使用当前schema。 */ root: DataSchema = schema,
): JsonValue {
  // 按声明默认值或合法schema形状建立初值，不再静默跳过已发布的required字段。
  const resolved = payloadResolveSchema(schema, root)
  if (resolved.const !== undefined) return payloadClone(resolved.const)
  if (resolved.default !== undefined) return payloadClone(resolved.default)
  if (resolved.oneOf?.length) return payloadCreateInitial(resolved.oneOf[0], root)
  const types = payloadTypes(resolved)
  if (types.includes('null')) return null
  if (types.includes('object')) {
    // 未声明固定属性是合法对象schema，包括required为空数组的形态。
    const properties = resolved.properties
    if (!properties) return {}
    return Object.fromEntries((resolved.required ?? []).map(
      (/* 已发布schema保证存在的必填字段名，保持声明顺序。 */ name) =>
        /* 同名原型属性也建立为普通自有字段，不触发对象setter。 */ [name, payloadCreateInitial(properties[name], root)],
    ))
  }
  if (types.includes('array')) return []
  if (types.includes('boolean')) return false
  if (resolved.enum?.length) return payloadClone(resolved.enum[0])
  if (types.includes('integer') || types.includes('number')) return resolved.minimum ?? 0
  return ''
}

/**
 * 只实现确定属性/数组索引的 JSON Pointer；展示声明不执行查询表达式。
 *
 * @param payload 任意注册类型的 payload。
 * @param pointer presentation 中声明的 JSON Pointer。
 */
export function payloadReadPointer(
  /* 本次只读访问的 JSON 正文。 */ payload: JsonValue,
  /* 展示定义或来源锚点声明的可选路径，缺省时不读取字段。 */ pointer?: string,
): JsonValue | undefined {
  // 沿实际对象属性或数组下标读取字段，未声明路径和缺失字段均返回 undefined。
  if (!pointer) return undefined
  if (!pointer.startsWith('/')) return undefined
  let current: JsonValue | undefined = payload
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(key)) return undefined
      current = current[Number(key)]
    } else if (current !== null && typeof current === 'object') current = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined
    else return undefined
  }
  return current
}

/**
 * 标量直接显示，复杂值稳定转成紧凑 JSON；缺失或 null 不显示占位字符串。
 *
 * @param value 标题或摘要路径取得的 JSON 值。
 */
export function payloadFormatValue(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * @param payload 数据实例内容。
 * @param definition 类型展示时优先读取的字段顺序。
 */
function payloadReadFirstText(payload: JsonValue, definition?: DataTypeDefinition): string {
  if (payload === null || typeof payload !== 'object') return payloadFormatValue(payload)
  if (Array.isArray(payload)) return payloadFormatValue(payload)
  const ordered = (definition?.presentation?.fieldOrder ?? []).map(path => {
    // 字符串末段总是存在，空声明路径自然不形成字段名。
    return path.slice(path.lastIndexOf('/') + 1)
  })
  const names = [...ordered, ...Object.keys(payload)].filter((name, index, all) => !!name && all.indexOf(name) === index)
  for (const name of names) {
    const value = payload[name]
    if (typeof value === 'string' && value.trim()) return value
  }
  return payloadFormatValue(payload)
}

/**
 * @param node 通用数据实例。
 * @param definition 与实例精确版本匹配的类型定义。
 */
export function payloadReadNodeText(node: GraphNode, definition?: DataTypeDefinition): string {
  const summary = payloadFormatValue(payloadReadPointer(node.payload, definition?.presentation?.summaryPath))
  if (summary) return summary
  const title = payloadFormatValue(payloadReadPointer(node.payload, definition?.presentation?.titlePath))
  return title || payloadReadFirstText(node.payload, definition) || '空数据'
}
