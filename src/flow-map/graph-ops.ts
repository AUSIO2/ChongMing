import type { MapNode, MapSnapshot } from './types'
import { NEWS_ROOT_ID } from './ids'

/**
 * 参数是否已锁定（不可再编辑）。
 * 规则：
 *   - runPhase 为 running 时全部锁
 *   - claim / opinion 一旦进入 pendingValidated 或 persisted 就锁
 *   - subAgent 只要有已产出的下游 claim/opinion（任何 dataPhase）就锁
 *   - news 一旦挂上 subAgent 就锁（避免拆分中途改新闻正文）
 */
export function isParamsLocked(snapshot: MapSnapshot, node: MapNode): boolean {
  if (snapshot.runPhase === 'running') return true

  if (node.kind === 'claim' || node.kind === 'opinion') {
    return node.dataPhase !== 'workerOut'
  }

  if (node.kind === 'news') {
    return snapshot.nodes.some(n => n.parentId === node.id && n.kind === 'subAgent')
  }

  // subAgent：有下游产出即锁
  const hasChildOutput = snapshot.nodes.some(
    n => n.parentId === node.id && (n.kind === 'claim' || n.kind === 'opinion'),
  )
  return hasChildOutput
}

/**
 * 能否在 parentNodeId 下新增 SubAgent。
 *   - 拆分槽（news）：idle，或 Route 之后、invoke 确认前（interrupted + pendingTool=invoke）
 *     → Route Agent 预置后人工仍可加槽
 *   - 核查槽（persisted claim）：idle / interrupted / completed（invoke 前加核查槽同理）
 *   - runPhase === 'running' 时一律禁止
 */
export function canAddSubAgent(snapshot: MapSnapshot, parentNodeId: string): boolean {
  if (snapshot.runPhase === 'running') return false

  const parent = snapshot.nodes.find(n => n.id === parentNodeId)
  const configuring =
    snapshot.runPhase === 'interrupted' && snapshot.pendingTool === 'invoke'

  // 拆分槽：idle 预置，或 route 之后 invoke 前加槽
  if (parentNodeId === NEWS_ROOT_ID || parent?.kind === 'news') {
    if (snapshot.runPhase === 'idle' || configuring) {
      return !parent || parent.kind === 'news'
    }
    return false
  }

  // 核查槽：已持久化 claim；invoke 配置期与其它 interrupted 均可加
  if (!parent || parent.kind !== 'claim') return false
  return parent.dataPhase === 'persisted'
}

/** 能否编辑节点参数。 */
export function canEditNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node) return false
  return !isParamsLocked(snapshot, node)
}

/**
 * 能否手动移除节点（仅空 SubAgent 槽）。
 * invoke 配置期与 idle 允许；running / save|validate 中断 / completed / error 禁止。
 */
export function canRemoveNode(snapshot: MapSnapshot, nodeId: string): boolean {
  const node = snapshot.nodes.find(n => n.id === nodeId)
  if (!node || node.kind !== 'subAgent') return false
  if (snapshot.runPhase === 'running') return false
  if (snapshot.runPhase === 'completed' || snapshot.runPhase === 'error') return false
  if (
    snapshot.runPhase === 'interrupted'
    && snapshot.pendingTool !== 'invoke'
  ) {
    return false
  }
  return !hasDescendants(snapshot, nodeId)
}

/** 移除某节点后是否留下悬空子节点（供 UI 提示用）。 */
export function hasDescendants(snapshot: MapSnapshot, nodeId: string): boolean {
  return snapshot.nodes.some(n => n.parentId === nodeId)
}
