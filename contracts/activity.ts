import type { GraphDataActor } from './graph'

export type ActivityStatus = 'preparing' | 'model' | 'tool' | 'result'
export const ACTIVITY_LABELS: Record<ActivityStatus, string> = {
  preparing: '准备处理', model: '正在调用模型', tool: '正在执行工具', result: '正在处理工具结果',
}
export interface GraphActivity {
  mapId: string; runId: string; operationId: string; nodeId: string; workId: string
  actor: GraphDataActor; agentName: string; status: ActivityStatus
  fence: number; sequence: number; updatedAt: string
}

/** Shared network boundary; raw runtime payloads are never accepted as display content. */
// 用途：判断活动状态是否满足当前条件。
export function activityIsStatus(value: unknown): value is ActivityStatus {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ACTIVITY_LABELS, value)
}
// 用途：判断活动状态是否满足当前条件。
export function activityIsRecord(value: unknown): value is GraphActivity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  if (Object.keys(item).some(key => !['mapId','runId','operationId','nodeId','workId','actor','agentName','status','fence','sequence','updatedAt'].includes(key))) return false
  if (!['mapId','runId','operationId','nodeId','workId','agentName','updatedAt'].every(key => typeof item[key] === 'string' && (item[key] as string).length > 0 && (item[key] as string).length <= 256)) return false
  if (!activityIsStatus(item.status) || !Number.isSafeInteger(item.fence) || Number(item.fence) < 1 || !Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1 || !Number.isFinite(Date.parse(String(item.updatedAt)))) return false
  const actor = item.actor as Record<string, unknown> | null
  return !!actor && typeof actor === 'object' && !Array.isArray(actor)
    && ['parse', 'router', 'worker', 'merge'].includes(String(actor.role))
    && Object.keys(actor).every(key => key === 'role' || (actor.role === 'worker' && key === 'slotId'))
    && (actor.role !== 'worker' || (typeof actor.slotId === 'string' && actor.slotId.length > 0 && actor.slotId.length <= 256))
}
