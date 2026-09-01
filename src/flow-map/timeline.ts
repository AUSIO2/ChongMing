import type { MapperTimeline } from '../../electron/mapper/types'

export const STATE_CHAIN = ['source', 'news', 'fact', 'conclusion'] as const
export type StateKind = typeof STATE_CHAIN[number]
export type StateIndex = 0 | 1 | 2 | 3
export type TransitionKey = '0-1' | '1-2' | '2-3'
export type MapTimeline = MapperTimeline

export const STATE_CHAIN_LABEL: Record<StateIndex, string> = {
  0: '源',
  1: '新闻',
  2: '事实',
  3: '结论',
}

export const STATE_TRANSITION_LABEL: Record<TransitionKey, string> = {
  '0-1': '解析',
  '1-2': '拆分',
  '2-3': '核查',
}

export function timelineCreateDefault(activeScope = ''): MapTimeline {
  return { startX: 0, endX: 3, activeScope }
}

export function timelineValidate(timeline: MapTimeline): void {
  if (timeline.startX > timeline.endX) {
    throw new Error(`timeline startX ${timeline.startX} > endX ${timeline.endX}`)
  }
}
