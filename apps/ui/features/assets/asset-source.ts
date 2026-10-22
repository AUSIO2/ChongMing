// 资产来源快捷构造：只固定明确选择的实际位置，不复制后端Schema或引用权限校验。
import type { Asset } from '../../../../contracts/control'
import type { DataReferenceDefinition, DataSchema, DataTypeDefinition, DefinitionCatalog, DefinitionRef, JsonValue } from '../../../../contracts/data-definition'
import type { GraphPayload } from '../../../../contracts/graph'
import { payloadCreateInitial, payloadReadPointer, payloadResolveSchema } from '../graph/data-payload'

export interface AssetSourceChoice {
  typeRef: DefinitionRef
  referenceIndex: number
  // 目录选择是声明路径；实际提交只接受assetReadSourceTargets给出的具体位置。
  path: string
}

interface SourceLocation { path: string; value: JsonValue | undefined; parentSchema: DataSchema }

enum AssetSourceMessage {
  OBJECT_PAYLOAD_REQUIRED = '这个来源类型需要对象正文，请使用普通数据创建入口核对。',
  WORKSPACE_MISMATCH = '所选文件不属于当前工作区，请重新选择。',
  TARGET_UNAVAILABLE = '所选引用位置已不可用，请核对类型版本和表单中的实际位置。',
  CONDITION_INACTIVE = '所选引用的条件尚未满足，请在表单中选择对应的定位方式。',
}

export function assetReadSourceChoices(
  /* 当前工作区真实已发布目录，不从共享库或同名其它版本补全。 */ catalog: DefinitionCatalog | null,
): AssetSourceChoice[] {
  // 保留每个精确类型中的所有资产声明，不按首个类型或首个路径推断来源语义。
  return (catalog?.dataTypes ?? []).flatMap((/* 一个精确数据类型。 */ type) =>
    /* 同类型多位置仍保留原声明索引。 */ type.references.flatMap((/* 一项引用声明。 */ reference, /* 原声明稳定索引。 */ referenceIndex) =>
      /* 节点引用不成为资产来源位置。 */ reference.target.kind === 'asset'
        ? [{ typeRef: { id: type.id, version: type.version }, referenceIndex, path: reference.path }] : []))
}

export function assetCreateSourcePayload(
  /* 用户已经选择的精确来源类型。 */ type: DataTypeDefinition,
): GraphPayload {
  // 初值继续沿原通用表单，oneOf由用户选择，不自动修复整个Schema。
  const initial = payloadCreateInitial(type.schema)
  if (!isObject(initial)) throw new Error(AssetSourceMessage.OBJECT_PAYLOAD_REQUIRED)
  return initial
}

export function assetReadSourceTargets(
  /* 已选来源的精确类型，包含可信路径声明。 */ type: DataTypeDefinition,
  /* 当前窗口独立正文；数组位置只来自实际存在的项。 */ payload: GraphPayload,
): AssetSourceChoice[] {
  // 确定对象字段可按声明建立初值；通配数组/字典绝不创建猜测成员。
  return type.references.flatMap((/* 一个已发布引用。 */ reference, /* 原声明索引。 */ referenceIndex) =>
    /* 非资产声明不产生快捷目标。 */ reference.target.kind !== 'asset' ? []
      : readLocations(type, payload, reference.path, true).map((/* 已展开的明确位置。 */ location) =>
        /* 具体位置仍绑定原类型版本和引用声明。 */ ({ typeRef: { id: type.id, version: type.version }, referenceIndex, path: location.path })))
}

export function assetBuildSourceDraft(
  /* 固定资产、类型和用户明确选择的位置；正文只在独立副本上补齐。 */ input: {
    workspaceId: string; asset: Asset; type: DataTypeDefinition; payload: GraphPayload; target: AssetSourceChoice | null | undefined
  },
): { ok: true; payload: GraphPayload } | { ok: false; message: string } {
  // 目标必须仍来自同一精确类型与实际成员，旧草稿不能改写另一位置。
  const { asset, type, target } = input
  if (asset.workspaceId !== input.workspaceId) return { ok: false, message: AssetSourceMessage.WORKSPACE_MISMATCH }
  const reference = target && type.references[target.referenceIndex]
  if (!target || target.typeRef.id !== type.id || target.typeRef.version !== type.version || reference?.target.kind !== 'asset') {
    return { ok: false, message: AssetSourceMessage.TARGET_UNAVAILABLE }
  }
  const location = readLocations(type, input.payload, reference.path, true).find(
    /* 该声明当前仍可选择的具体位置。 */ item => /* 不接受自行拼出的路径或虚构数组下标。 */ item.path === target.path,
  )
  if (!location) return { ok: false, message: AssetSourceMessage.TARGET_UNAVAILABLE }
  const payload = Object.fromEntries(Object.entries(input.payload).map(
    /* 当前正文的自有字段。 */ ([key, value]) => /* 递归复制保留字段与原型同名的JSON数据。 */ [key, cloneValue(value)],
  ))
  if (!writeConcrete(type, payload, target.path, asset.id)) return { ok: false, message: AssetSourceMessage.TARGET_UNAVAILABLE }
  const parentPath = target.path.slice(0, target.path.lastIndexOf('/'))
  const parent = parentPath ? payloadReadPointer(payload, parentPath) : payload
  if (isObject(parent) && Object.prototype.hasOwnProperty.call(location.parentSchema.properties ?? {}, 'mediaType')) {
    Object.defineProperty(parent, 'mediaType', { value: asset.mediaType, enumerable: true, configurable: true, writable: true })
  }
  if (!referenceActive(type, payload, reference)) return { ok: false, message: AssetSourceMessage.CONDITION_INACTIVE }
  const titlePath = type.presentation?.titlePath
  if (titlePath && readLocations(type, payload, titlePath, true).some(
    /* 展示声明可以解析的一项实际位置。 */ item => /* 不对通配标题猜测首项。 */ item.path === titlePath,
  )) {
    const title = payloadReadPointer(payload, titlePath)
    if (title === undefined || title === null || title === '') writeConcrete(type, payload, titlePath, asset.filename)
  }
  return { ok: true, payload }
}

export function assetReadSourceReferences(
  /* 节点保存的精确类型，不借当前目录的最新同名类型。 */ type: DataTypeDefinition,
  /* 已保存节点正文；不为缺少的可选位置建立虚拟引用。 */ payload: GraphPayload,
): Array<{ path: string; assetId: string }> {
  // when与后端保持根路径ANY及JSON等值语义，数组位置读取实际值。
  return type.references.flatMap((/* 一项真实声明。 */ reference) => {
    // 不活跃条件和非资产字段不会造成“已引用”的误提示。
    if (reference.target.kind !== 'asset' || !referenceActive(type, payload, reference)) return []
    return readLocations(type, payload, reference.path, false).flatMap((/* 已保存的实际引用位置。 */ location) =>
      /* 空初值不是一个可用资产身份，完整Schema仍交服务端。 */ typeof location.value === 'string' && location.value
        ? [{ path: location.path, assetId: location.value }] : [])
  })
}

function referenceActive(
  /* 该引用所属精确类型。 */ type: DataTypeDefinition,
  /* 当前根正文，条件不是相对目标位置的表达式。 */ payload: GraphPayload,
  /* 需要检查条件的资产引用声明。 */ reference: DataReferenceDefinition,
): boolean {
  // 一个匹配值激活整个声明，不擅自把两个wildcard按索引配对。
  const condition = reference.when
  return !condition || readLocations(type, payload, condition.path, false).some(
    /* 条件根路径实际展开的值。 */ location => /* false、0和结构值均保留原JSON类型。 */ equalValue(location.value, condition.equals),
  )
}

function isObject(/* 需要按自有字段读取的JSON值。 */ value: JsonValue | undefined): value is GraphPayload {
  // null与数组分别处理，不能被当成对象容器写入。
  return value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)
}

function cloneValue(/* 需要独立保存的JSON字段。 */ value: JsonValue): JsonValue {
  // 不直接structuredClone Vue代理，也不共享用户草稿中的嵌套数组。
  if (Array.isArray(value)) return value.map((/* 一个数组成员。 */ item) => /* 逐项复制。 */ cloneValue(item))
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map((/* 一个自有对象字段。 */ [key, item]) => /* 同名原型字段仍是普通数据。 */ [key, cloneValue(item)]))
  return value
}

function equalValue(
  /* 当前正文中存在或缺失的值。 */ actual: JsonValue | undefined,
  /* 已发布条件的精确JSON值。 */ expected: JsonValue,
): boolean {
  // 对象键顺序不改变等值性，数组顺序和标量类型仍属于值本身。
  if (actual === expected) return true
  if (Array.isArray(actual)) return Array.isArray(expected) && actual.length === expected.length
    && actual.every((/* 当前数组成员。 */ value, /* 对应位置。 */ index) => /* 不跨位置匹配。 */ equalValue(value, expected[index]))
  if (!isObject(actual) || !isObject(expected)) return false
  const keys = Object.keys(actual)
  return keys.length === Object.keys(expected).length && keys.every((/* 自有字段名称。 */ key) =>
    /* 不从Object原型继承条件值。 */ Object.prototype.hasOwnProperty.call(expected, key) && equalValue(actual[key], expected[key]))
}

function activeSchema(
  /* 当前字段声明，只读取原表单支持的本地引用/判别分支。 */ schema: DataSchema,
  /* 类型根schema，供本地$ref解析。 */ root: DataSchema,
  /* 当前字段正文，决定现有oneOf判别分支。 */ value: JsonValue | undefined,
): DataSchema {
  // 与通用表单一样按const选现有分支，缺值沿原初值首分支，不执行完整Schema验证。
  const resolved = payloadResolveSchema(schema, root)
  const variants = resolved.oneOf
  if (!variants?.length) return resolved
  const selected = variants.find((/* 一个已发布候选分支。 */ variant) =>
    /* 只解释字段const，不实现第二份oneOf验证器。 */ Object.entries(payloadResolveSchema(variant, root).properties ?? {}).every(
      (/* 分支的一个固定字段。 */ [key, field]) => /* 当前正文的判别值必须匹配。 */ field.const === undefined || isObject(value) && equalValue(value[key], field.const),
    )) ?? variants[0]
  return selected ? activeSchema(selected, root, value) : resolved
}

function readLocations(
  /* 当前精确类型，用于有限路径与本地引用解析。 */ type: DataTypeDefinition,
  /* 当前独立或已保存正文。 */ payload: GraphPayload,
  /* 声明中的JSON Pointer，wildcard只展开真实自有成员。 */ pointer: string,
  /* 新建时可补确定对象字段，保存引用读取则只认实际字段。 */ allowInitial: boolean,
): SourceLocation[] {
  // 遍历只决定可填写位置；数组必须已经存在项，不按Schema的minItems猜索引。
  const parts = pointer.slice(1).split('/').map((/* 已编码的路径片段。 */ part) => /* 还原实际字段身份。 */ part.replace(/~1/g, '/').replace(/~0/g, '~'))
  const visit = (
    /* 当前字段schema。 */ schema: DataSchema,
    /* 当前真实值或确定对象初值。 */ value: JsonValue | undefined,
    /* 当前路径片段位置。 */ index: number,
    /* 已编码的具体路径。 */ path: string,
    /* 上一层实际选定的schema，用于相邻媒体字段。 */ parentSchema: DataSchema,
  ): SourceLocation[] => {
    // 只有路径完整解析后才把该位置作为可提交目标。
    if (index === parts.length) return [{ path, value, parentSchema }]
    const resolved = activeSchema(schema, type.schema, value)
    const part = parts[index]
    if (part === '*') {
      if (!Array.isArray(value) && !isObject(value)) return []
      const childSchema = Array.isArray(value) ? resolved.items : typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : undefined
      if (!childSchema) return []
      return Object.entries(value).flatMap((/* 真实数组或字典的一个自有成员。 */ [key, child]) =>
        /* 数字索引和字典键分别编码，不生成字面通配字段。 */ visit(childSchema, child, index + 1, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`, resolved))
    }
    if (!isObject(value)) return []
    const childSchema = Object.prototype.hasOwnProperty.call(resolved.properties ?? {}, part) ? resolved.properties?.[part] : undefined
    if (!childSchema) return []
    const exists = Object.prototype.hasOwnProperty.call(value, part)
    if (!exists && !allowInitial) return []
    const child = exists ? value[part] : payloadCreateInitial(childSchema, type.schema)
    return visit(childSchema, child, index + 1, `${path}/${part.replace(/~/g, '~0').replace(/\//g, '~1')}`, resolved)
  }
  return pointer.startsWith('/') ? visit(type.schema, payload, 0, '', type.schema) : []
}

function writeConcrete(
  /* 位置所属的精确已发布类型。 */ type: DataTypeDefinition,
  /* 需要补齐的独立正文副本。 */ payload: GraphPayload,
  /* 只能由readLocations确认的具体位置。 */ pointer: string,
  /* 本次固定的资产身份或声明中已有的元数据。 */ value: JsonValue,
): boolean {
  // 只建立确定对象初值；数组或字典的通配成员必须由用户事先创建。
  const parts = pointer.slice(1).split('/').map((/* 已编码的具体路径段。 */ part) => /* 数组索引或自有属性身份。 */ part.replace(/~1/g, '/').replace(/~0/g, '~'))
  let current: JsonValue = payload, schema = type.schema
  for (let index = 0; index < parts.length; index++) {
    const key = parts[index], resolved = activeSchema(schema, type.schema, current)
    const last = index === parts.length - 1
    if (Array.isArray(current)) {
      const itemIndex = /^\d+$/.test(key) ? Number(key) : -1
      if (itemIndex < 0 || !Object.prototype.hasOwnProperty.call(current, itemIndex) || !resolved.items) return false
      if (last) { current[itemIndex] = cloneValue(value); return true }
      current = current[itemIndex]; schema = resolved.items
    } else if (isObject(current)) {
      const childSchema = Object.prototype.hasOwnProperty.call(resolved.properties ?? {}, key) ? resolved.properties?.[key]
        : Object.prototype.hasOwnProperty.call(current, key) && typeof resolved.additionalProperties === 'object' ? resolved.additionalProperties : undefined
      if (!childSchema) return false
      if (last) {
        Object.defineProperty(current, key, { value: cloneValue(value), enumerable: true, configurable: true, writable: true })
        return true
      }
      if (!Object.prototype.hasOwnProperty.call(current, key)) Object.defineProperty(current, key, {
        value: payloadCreateInitial(childSchema, type.schema), enumerable: true, configurable: true, writable: true,
      })
      current = current[key]; schema = childSchema
    } else return false
  }
  return false
}
