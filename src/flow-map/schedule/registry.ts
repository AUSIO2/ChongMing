import { parseScheduleSpec } from './parse'
import { splitScheduleSpec } from './split'
import type { ScheduleTransitionKey, TimelineScheduleContext, TimelineScheduleSpec } from './types'
import { verifyScheduleSpec } from './verify'

export type { TimelineScheduleContext, TimelineScheduleSpec, TimelineWorkItem } from './types'

export const SCHEDULE_REGISTRY: Record<ScheduleTransitionKey, TimelineScheduleSpec> = {
  '0-1': parseScheduleSpec,
  '1-2': splitScheduleSpec,
  '2-3': verifyScheduleSpec,
}

export function scheduleReadSpec(key: ScheduleTransitionKey): TimelineScheduleSpec {
  return SCHEDULE_REGISTRY[key]
}

export function scheduleReadPending(
  ctx: TimelineScheduleContext,
  key: ScheduleTransitionKey,
) {
  return scheduleReadSpec(key).readPending(ctx)
}

export function scheduleReadInterruptStale(
  ctx: TimelineScheduleContext,
  key: ScheduleTransitionKey,
  parentId: string,
): boolean {
  return scheduleReadSpec(key).readInterruptStale(ctx, parentId)
}

export function scheduleReadScopePatch(
  key: ScheduleTransitionKey,
  parentId: string,
) {
  return scheduleReadSpec(key).readScopePatch?.(parentId)
}
