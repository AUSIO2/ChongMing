import type { DisplayClaim } from '../../../electron/api/types'
import type { MapSnapshot } from '../types'

export type ScheduleTransitionKey = '0-1' | '1-2' | '2-3'

export interface TimelineWorkItem {
  parentNodeId: string
  scopeNodeId?: string
}

export interface TimelineScheduleContext {
  snapshot: MapSnapshot
  claims: DisplayClaim[]
}

export interface TimelineScopePatch {
  activeScope?: string
}

export interface TimelineScheduleSpec {
  key: ScheduleTransitionKey
  readPending(ctx: TimelineScheduleContext): TimelineWorkItem[]
  readInterruptStale(ctx: TimelineScheduleContext, parentId: string): boolean
  readScopePatch?(parentId: string): TimelineScopePatch | undefined
}
