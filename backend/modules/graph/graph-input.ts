// 校验通用数据节点边界。具体字段规则由精确数据类型定义在领域提交时验证。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { DefinitionRef, JsonValue } from '../../../contracts/data-definition'
import type { GraphNodeInput, GraphPayload } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'

const MAX_JSON_DEPTH = 32
const MAX_JSON_MEMBERS = 4096

/**
 * 拒绝 undefined、非有限数字、非普通对象及过深/过大的值，避免把运行时对象写入 payload。
 *
 * @param value 尚未验证为可持久化 JSON 的任意值。
 * @param label 报错中使用的字段路径。
 * @param depth 当前递归深度。
 * @param budget 全 payload 共用的成员计数器。
 */
function graphInputReadJson(
  value: unknown,
  label: string,
  depth: number,
  budget: { members: number },
): JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
    return value
  }
  if (Array.isArray(value)) return value.map((item, index) => {
    if (++budget.members > MAX_JSON_MEMBERS) throw new GraphError(413, 'PAYLOAD_LIMIT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
    return graphInputReadJson(item, `${label}[${index}]`, depth + 1, budget)
  })
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
  }
  const result: Record<string, JsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (++budget.members > MAX_JSON_MEMBERS) throw new GraphError(413, 'PAYLOAD_LIMIT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, label))
    result[key] = graphInputReadJson(item, `${label}.${key}`, depth + 1, budget)
  }
  return result
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
  value: unknown,
  label: string,
): GraphNodeInput {
  const item = inputReadObject(value, ['id', 'typeId', 'typeVersion', 'payload'], label)
  const typeVersion = inputReadRevision(item.typeVersion, `${label}.typeVersion`)
  if (typeVersion < 1) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, `${label}.typeVersion`))
  return {
    id: inputReadId(item.id, `${label}.id`),
    typeId: inputReadString(item.typeId, `${label}.typeId`),
    typeVersion,
    payload: graphInputReadPayload(item.payload, `${label}.payload`),
  }
}
