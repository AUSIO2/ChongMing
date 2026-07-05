/**
 * Map 画布列号 —— 与过渡阶段一致，布局 x = PAD + column * GAP。
 * 0 源 · 1 解析 · 2 新闻 · 3 拆分 · 4 事实 · 5 核查 · 6 意见
 */
export const MAP_COLUMN = {
  source: 0,
  parse: 1,
  news: 2,
  splitAgent: 3,
  claim: 4,
  verifyAgent: 5,
  opinion: 6,
} as const

export type MapColumnKey = keyof typeof MAP_COLUMN

export const MAP_COLUMN_LABEL: Record<number, string> = {
  [MAP_COLUMN.source]: '源',
  [MAP_COLUMN.parse]: '解析',
  [MAP_COLUMN.news]: '新闻',
  [MAP_COLUMN.splitAgent]: '拆分',
  [MAP_COLUMN.claim]: '事实',
  [MAP_COLUMN.verifyAgent]: '核查',
  [MAP_COLUMN.opinion]: '意见',
}

export const MAP_TRANSITION_COLUMN: Record<string, number> = {
  '0-1': MAP_COLUMN.parse,
  '1-2': MAP_COLUMN.splitAgent,
  '2-3': MAP_COLUMN.verifyAgent,
}

export interface MapLayoutNodeLike {
  kind: string
  parentId?: string
  id?: string
}

export function layoutReadNodeColumn(
  node: MapLayoutNodeLike,
  nodes: MapLayoutNodeLike[],
): number {
  switch (node.kind) {
    case 'source':
      return MAP_COLUMN.source
    case 'parseAgent':
      return MAP_COLUMN.parse
    case 'news':
      return MAP_COLUMN.news
    case 'subAgent': {
      const parent = nodes.find(n => n.id === node.parentId)
      return parent?.kind === 'claim' ? MAP_COLUMN.verifyAgent : MAP_COLUMN.splitAgent
    }
    case 'claim':
      return MAP_COLUMN.claim
    case 'opinion':
      return MAP_COLUMN.opinion
    default:
      return MAP_COLUMN.source
  }
}
