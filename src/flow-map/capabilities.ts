import type { MapNode, MapSnapshot } from './types'

function hasChild(snapshot: MapSnapshot, nodeId: string): boolean {
  return snapshot.nodes.some(node => node.parentId === nodeId)
}

export function canEditNode(snapshot: MapSnapshot, nodeId: string): boolean {
  if (snapshot.runPhase === 'running') return false
  const node = snapshot.nodes.find(item => item.id === nodeId)
  return Boolean(node && node.kind !== 'parseAgent' && node.kind !== 'opinion')
}

export function canAddSubAgent(snapshot: MapSnapshot, parentId: string): boolean {
  if (snapshot.runPhase === 'running') return false
  const node = snapshot.nodes.find(item => item.id === parentId)
  return Boolean(
    node
    && (node.kind === 'news' || node.kind === 'claim')
    && !snapshot.nodes.some(item =>
      item.parentId === parentId
      && (item.kind === 'claim' || item.kind === 'opinion'),
    ),
  )
}

export function canRemoveNode(snapshot: MapSnapshot, nodeId: string): boolean {
  if (snapshot.runPhase === 'running') return false
  const node = snapshot.nodes.find(item => item.id === nodeId)
  return Boolean(node && node.kind !== 'parseAgent' && node.kind !== 'opinion')
}

export function readNodeLockReason(
  snapshot: MapSnapshot,
  nodeId: string,
): string | undefined {
  const node = snapshot.nodes.find(item => item.id === nodeId)
  if (!node) return '节点不存在'
  if (snapshot.runPhase === 'running') return '地图正在运行'
  if (node.kind === 'parseAgent' || node.kind === 'opinion') return '派生节点不可编辑'
  if (node.kind === 'subAgent' && hasChild(snapshot, node.id)) return '已有下游数据'
  return undefined
}

export function isNodeParamLocked(snapshot: MapSnapshot, node: MapNode): boolean {
  return !canEditNode(snapshot, node.id)
}
