import type { MapDataPhase, MapNode, MapNodeKind } from './types'

/** 运行阶段中文标签（Header / Controls 共用）。 */
export const RUN_PHASE_LABEL: Record<import('./types').MapRunPhase, string> = {
  idle: '空闲',
  running: '运行中',
  interrupted: '待确认',
  completed: '已完成',
  error: '出错',
}

export const NODE_KIND_LABEL: Record<MapNodeKind, string> = {
  source: '源',
  parseAgent: '解析',
  news: '新闻',
  subAgent: 'SubAgent',
  claim: '事实',
  opinion: '意见',
}

export const DATA_PHASE_LABEL: Record<MapDataPhase, string> = {
  workerOut: '产出中',
  persisted: '已保存',
}

export function labelFormatNodeKind(node: MapNode): string {
  return NODE_KIND_LABEL[node.kind]
}

/** Controls 焦点行：subAgent 显示 agentName，其余用 kind 标签。 */
export function labelFormatFocusNode(node: MapNode): string {
  if (node.kind === 'subAgent') return node.params.agentName
  if (node.kind === 'source') return node.params.label ?? node.params.uri
  return NODE_KIND_LABEL[node.kind]
}

/** 拓扑节点主文案最大字符数（超出在末尾加省略号，框内仍按宽度换行）。 */
export const MAP_NODE_LABEL_MAX = 80

export function labelTruncate(text: string, max = MAP_NODE_LABEL_MAX): string {
  const t = text.trim()
  if (t.length <= max) return t
  return `${t.slice(0, Math.max(1, max - 1))}…`
}
