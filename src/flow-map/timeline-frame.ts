import { MAP_COLUMN_LABEL } from './columns'
import type { StateIndex } from './timeline'

/** 7 帧画布列（0–6）。 */
export type FrameIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** 用户可选结束：仅数据列。 */
export const MAP_DATA_FRAME = [0, 2, 4, 6] as const
export type DataFrameIndex = typeof MAP_DATA_FRAME[number]

export const DATA_FRAME_LABEL: Record<DataFrameIndex, string> = {
  0: MAP_COLUMN_LABEL[0],
  2: MAP_COLUMN_LABEL[2],
  4: MAP_COLUMN_LABEL[4],
  6: MAP_COLUMN_LABEL[6],
}

/** 过渡锚点（工艺列）。 */
export const FRAME_ANCHOR = [1, 3, 5] as const

export const FRAME_COUNT = 7

const FRAME_WIDTH = 72
const GUTTER_WIDTH = 88
const RULER_HEIGHT = 28

export function frameReadDataIndex(state: StateIndex): DataFrameIndex {
  return (state * 2) as DataFrameIndex
}

export function frameReadStateIndex(data: DataFrameIndex): StateIndex {
  return (data / 2) as StateIndex
}

export function frameIsDataColumn(f: number): f is DataFrameIndex {
  return (MAP_DATA_FRAME as readonly number[]).includes(f)
}

export function frameToX(f: FrameIndex, gutter = GUTTER_WIDTH, width = FRAME_WIDTH): number {
  return gutter + f * width + width / 2
}

export function frameReadCanvasWidth(gutter = GUTTER_WIDTH, width = FRAME_WIDTH): number {
  return gutter + FRAME_COUNT * width
}

export function frameReadRulerHeight(): number {
  return RULER_HEIGHT
}

export function frameReadGutterWidth(): number {
  return GUTTER_WIDTH
}

export function frameReadCellWidth(): number {
  return FRAME_WIDTH
}

export function frameReadPrevAnchor(f: FrameIndex): FrameIndex | null {
  const anchors = FRAME_ANCHOR.filter(a => a < f)
  if (anchors.length === 0) return null
  return anchors[anchors.length - 1] as FrameIndex
}

export function frameReadNextAnchor(f: FrameIndex): FrameIndex | null {
  const next = FRAME_ANCHOR.find(a => a > f)
  return next !== undefined ? (next as FrameIndex) : null
}

export function layoutYScale(
  layoutY: number,
  mapHeight: number,
  contentTop: number,
  contentHeight: number,
): number {
  if (mapHeight <= 0) return contentTop
  const pad = 12
  const inner = Math.max(1, contentHeight - pad * 2)
  return contentTop + pad + (layoutY / mapHeight) * inner
}
