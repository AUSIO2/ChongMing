// 校验通用数据节点边界。具体字段规则由精确数据类型定义在领域提交时验证。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { DefinitionRef, JsonValue } from '../../../contracts/data-definition'
import type { GraphNodeInput, GraphPayload } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'

const MAX_JSON_DEPTH = 32
const MAX_JSON_MEMBERS = 4096

function graphInputReadJson(
  /* 尚未验证为可持久化 JSON 的任意值。 */ value: unknown,
  /* 报错中使用的字段路径。 */ label: string,
  /* 当前递归深度。 */ depth: number,
  /* 全 payload 共用的成员计数器。 */ budget: { members: number },
): JsonValue {
  // 拒绝 undefined、非有限数字、非普通对象及过深/过大的值，避免把运行时对象写入 payload。
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

export function graphInputReadPayload(
  /* 尚未验证的节点或候选 payload。 */ value: unknown,
  /* 报错中使用的字段路径。 */ label: string,
): GraphPayload {
  // payload 顶层固定为对象；类型 schema 的字段约束留给定义验证器。
  const result = graphInputReadJson(value, label, 0, { members: 0 })
  if (!result || Array.isArray(result) || typeof result !== 'object') {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, label))
  }
  return result
}

export function graphInputReadDefinitionRef(
  /* 尚未验证的精确定义引用。 */ value: unknown,
  /* 报错中使用的字段路径。 */ label: string,
): DefinitionRef {
  // 定义 ID 允许命名空间名称，版本必须从 1 开始，且不存在 latest 等浮动引用。
  const item = inputReadObject(value, ['id', 'version'], label)
  const version = inputReadRevision(item.version, `${label}.version`)
  if (version < 1) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, label))
  return { id: inputReadString(item.id, `${label}.id`), version }
}

export function graphInputReadAgentRef(
  /* 尚未验证的精确 Agent 配置引用；现有配置初始 revision 为零。 */ value: unknown,
  /* 报错中使用的字段路径。 */ label: string,
): DefinitionRef {
  // Agent 版本沿用既有 revision=0 起始约定；仍拒绝负数和浮动 latest。
  const item = inputReadObject(value, ['id', 'version'], label)
  return { id: inputReadString(item.id, `${label}.id`), version: inputReadRevision(item.version, `${label}.version`) }
}

export function graphInputReadNode(
  /* 来自 HTTP 命令或数据包的通用节点输入。 */ value: unknown,
  /* 报错中使用的节点字段路径。 */ label: string,
): GraphNodeInput {
  // 只解析通用信封；payload 与精确类型是否匹配由定义目录在授权事务中复核。
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
