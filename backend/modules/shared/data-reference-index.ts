// 在正文边界一次建立可信 payload、实际引用及图索引，供分支证明和节点写入共用。
import type { DefinitionCatalog, DefinitionRef } from '../../../contracts/data-definition'
import type { GraphNode, GraphPayload } from '../../../contracts/graph'
import { messageFormat, RuntimeMessage } from '../../../contracts/messages'
import { definitionsParsePayload, type PayloadReferenceValue } from './data-definition'
import { GraphError } from './domain-error'

export interface ParsedGraphNode {
  node: GraphNode
  references: PayloadReferenceValue[]
}

/**
 * 完整解析未知图正文，返回独立对象 payload、实际引用和稳定派生索引。
 * 类型不存在、JSON/schema 无效或图根不是对象时抛领域错误；不修改输入。
 *
 * @param definitions 包含精确引用声明的冻结或工作区定义目录。
 * @param type 当前节点的精确类型版本。
 * @param payload 尚未经过本次 JSON、schema 和图对象根检查的正文。
 */
export function graphParseNodePayload(
  /* 包含精确引用声明的已发布目录。 */ definitions: DefinitionCatalog,
  /* 本次图节点的不可变类型版本。 */ type: DefinitionRef,
  /* 图输入或候选物化后尚未经过本次 schema 校验的正文。 */ payload: unknown,
): { payload: GraphPayload; payloadReferences: NonNullable<GraphNode['payloadReferences']>; references: PayloadReferenceValue[] } {
  // 完整验证一次正文，同时建立图协议要求的对象根和服务端节点引用索引。
  const parsed = definitionsParsePayload(definitions, type, payload)
  if (parsed.payload === null || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, 'payload'))
  }
  const unique = new Map<string, { path: string; targetId: string }>()
  for (const reference of parsed.references) {
    if (reference.definition.target.kind !== 'node') continue
    const item = { path: reference.definition.path, targetId: reference.value }
    unique.set(`${item.path}\u0000${item.targetId}`, item)
  }
  const payloadReferences = [...unique.values()].sort((/* 左侧派生引用。 */ left, /* 右侧派生引用。 */ right) =>
    /* 以声明路径和目标身份保持稳定索引顺序。 */ left.path.localeCompare(right.path) || left.targetId.localeCompare(right.targetId))
  return { payload: parsed.payload, payloadReferences, references: parsed.references }
}

/**
 * 为当前 attempt 一次解析全部节点，保持每份正文、实际引用与派生索引配对。
 * 返回独立节点和引用供证明与写入共用，不修改输入或业务 revision。
 *
 * @param definitions 包含所有精确节点类型定义的当前或冻结目录。
 * @param nodes 同一图内准备参与版本计算或持久化的节点。
 */
export function graphParseNodes(
  /* 包含全部当前节点精确类型的目录。 */ definitions: DefinitionCatalog,
  /* 准备参与分支版本计算的实际节点。 */ nodes: readonly GraphNode[],
): ParsedGraphNode[] {
  // 一次建立独立节点及同份正文的引用，供当前 attempt 的证明与修改共同使用。
  return nodes.map((/* 当前图的一份完整节点。 */ node) => {
    // 正文由解析器复制，元数据另行复制，不再次深复制同一正文。
    const { payload, payloadReferences: _previousReferences, ...metadata } = node
    const parsed = graphParseNodePayload(definitions, { id: node.typeId, version: node.typeVersion }, payload)
    return { node: { ...structuredClone(metadata), payload: parsed.payload, payloadReferences: parsed.payloadReferences },
      references: parsed.references }
  })
}
