// 校验通用数据节点边界。具体字段规则由精确数据类型定义在领域提交时验证。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { DefinitionRef, JsonValue } from '../../../contracts/data-definition'
import type { GraphNodeInput, GraphPayload } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'
import { graphInputReadLibraryUseRefs } from './library-claim-input'

const MAX_JSON_DEPTH = 32
const MAX_JSON_MEMBERS = 4096

function graphInputReadJson(
  /* 尚未验证为可持久化JSON的边界值。 */ value: unknown,
  /* 错误中使用的具体字段路径。 */ label: string,
  /* 当前递归深度，根为零。 */ depth: number,
  /* 整个正文共用的成员预算，递归时原地累加。 */ budget: { members: number },
): JsonValue {
  // 验证JSON类型与全局预算，复制自有字段时保留所有合法名称及普通对象原型。
  if (depth > MAX_JSON_DEPTH) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
    return value
  }
  if (Array.isArray(value)) return value.map((/* 正文数组的当前成员。 */ item, /* 用于报错定位的数组下标。 */ index) => {
    // 所有数组和对象成员计入同一预算。
    if (++budget.members > MAX_JSON_MEMBERS) throw new GraphError(413, 'PAYLOAD_LIMIT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
    return graphInputReadJson(item, `${label}[${index}]`, depth + 1, budget)
  })
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
  }
  return Object.fromEntries(Object.entries(value).map((/* 原对象的一个自有JSON成员。 */ [key, item]) => {
    // 数据属性构造不触发__proto__ setter，仍逐成员检查全局预算。
    if (++budget.members > MAX_JSON_MEMBERS) throw new GraphError(413, 'PAYLOAD_LIMIT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
    return [key, graphInputReadJson(item, `${label}.${key}`, depth + 1, budget)]
  }))
}

/**
 * payload 顶层固定为对象；类型 schema 的字段约束留给定义验证器。
 *
 * @param value 尚未验证的节点或候选 payload。
 * @param label 报错中使用的字段路径。
 */
export function graphInputReadPayload(
  value: unknown,
  label: string,
): GraphPayload {
  const result = graphInputReadJson(value, label, 0, { members: 0 })
  if (!result || Array.isArray(result) || typeof result !== 'object') {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, label))
  }
  return result
}

/**
 * 定义 ID 允许命名空间名称，版本必须从 1 开始，且不存在 latest 等浮动引用。
 *
 * @param value 尚未验证的精确定义引用。
 * @param label 报错中使用的字段路径。
 */
export function graphInputReadDefinitionRef(
  value: unknown,
  label: string,
): DefinitionRef {
  const item = inputReadObject(value, ['id', 'version'], label)
  const version = inputReadRevision(item.version, `${label}.version`)
  if (version < 1) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, label))
  return { id: inputReadString(item.id, `${label}.id`), version }
}

/**
 * Agent 版本沿用既有 revision=0 起始约定；仍拒绝负数和浮动 latest。
 *
 * @param value 尚未验证的精确 Agent 配置引用；现有配置初始 revision 为零。
 * @param label 报错中使用的字段路径。
 */
export function graphInputReadAgentRef(
  value: unknown,
  label: string,
): DefinitionRef {
  const item = inputReadObject(value, ['id', 'version'], label)
  return { id: inputReadString(item.id, `${label}.id`), version: inputReadRevision(item.version, `${label}.version`) }
}

/**
 * 只解析通用信封；payload 与精确类型是否匹配由定义目录在授权事务中复核。
 *
 * @param value 来自 HTTP 命令或数据包的通用节点输入。
 * @param label 报错中使用的节点字段路径。
 */
export function graphInputReadNode(
  /* HTTP命令或导入交付的未知通用节点。 */ value: unknown,
  /* 校验错误所定位的具体节点字段路径。 */ label: string,
): GraphNodeInput {
  // 解析严格通用信封与可选库元信息，具体payload仍由精确定义在事务中验证。
  const item = inputReadObject(value, ['id', 'typeId', 'typeVersion', 'payload', 'libraryClaimRefs'], label)
  const typeVersion = inputReadRevision(item.typeVersion, `${label}.typeVersion`)
  if (typeVersion < 1) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `${label}.typeVersion`))
  return {
    id: inputReadId(item.id, `${label}.id`),
    typeId: inputReadString(item.typeId, `${label}.typeId`),
    typeVersion,
    payload: graphInputReadPayload(item.payload, `${label}.payload`),
    ...(item.libraryClaimRefs === undefined ? {} : { libraryClaimRefs: graphInputReadLibraryUseRefs(item.libraryClaimRefs, `${label}.libraryClaimRefs`) }),
  }
}
