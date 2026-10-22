// 记录前端定位 GraphNode 的完整 Workspace、Map 与 Node 身份。
export interface NodeIdentity {
  workspaceId: string
  mapId: string
  nodeId: string
}

/**
 * 将复合身份编码为不受分隔符字符影响的比较键。
 *
 * @param identity 当前用户已获权视图中的 Workspace、Map 与 Node 身份。
 */
export function graphCreateNodeIdentityKey(identity: NodeIdentity): string {
  return JSON.stringify([identity.workspaceId, identity.mapId, identity.nodeId])
}

/**
 * 只在 Workspace、Map 与 Node 三个身份字段全部相同时视为同一节点。
 *
 * @param left 左侧可选身份；null 表示尚未指向某个节点。
 * @param right 右侧可选身份；null 表示尚未指向某个节点。
 */
export function graphNodeIdentitiesEqual(left: NodeIdentity | null, right: NodeIdentity | null): boolean {
  if (left === null || right === null) return left === right
  return left.workspaceId === right.workspaceId && left.mapId === right.mapId && left.nodeId === right.nodeId
}
