// 从已验证的类型声明和 payload 派生不可伪造的节点引用索引，供分支版本与影响范围使用。
import type { DefinitionCatalog, DefinitionRef } from '../../../contracts/data-definition'
import type { GraphNode, GraphPayload } from '../../../contracts/graph'
import { definitionsReadPayloadReferences } from './data-definition'

/**
 * 相同声明路径和目标只保留一次；顺序固定，避免对象/数组遍历顺序改变分支摘要。
 *
 * @param definitions 包含精确引用声明的冻结或工作区定义目录。
 * @param type 当前节点的精确类型版本。
 * @param payload 已经过该类型 schema 校验的 payload。
 */
export function graphReadPayloadReferenceIndex(
  definitions: DefinitionCatalog,
  type: DefinitionRef,
  payload: GraphPayload,
): NonNullable<GraphNode['payloadReferences']> {
  const unique = new Map<string, { path: string; targetId: string }>()
  for (const reference of definitionsReadPayloadReferences(definitions, type, payload)) {
    if (reference.definition.target.kind !== 'node') continue
    const item = { path: reference.definition.path, targetId: reference.value }
    unique.set(`${item.path}\u0000${item.targetId}`, item)
  }
  return [...unique.values()].sort((left, right) => left.path.localeCompare(right.path) || left.targetId.localeCompare(right.targetId))
}

/**
 * 对全部节点重建派生索引，使升级前数据和新写入遵守相同分支版本语义；不改变业务 revision。
 *
 * @param definitions 包含所有精确节点类型定义的当前或冻结目录。
 * @param nodes 同一图内准备参与版本计算或持久化的节点。
 */
export function graphRefreshPayloadReferenceIndexes(
  definitions: DefinitionCatalog,
  nodes: readonly GraphNode[],
): GraphNode[] {
  return nodes.map(node => ({ ...structuredClone(node), payloadReferences: graphReadPayloadReferenceIndex(definitions,
    { id: node.typeId, version: node.typeVersion }, node.payload) }))
}
