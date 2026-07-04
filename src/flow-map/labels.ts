import type { MapRunPhase } from './types'

/** 运行阶段中文标签（Header / Controls 共用）。 */
export const RUN_PHASE_LABEL: Record<MapRunPhase, string> = {
  idle: '空闲',
  running: '运行中',
  interrupted: '待确认',
  completed: '已完成',
  error: '出错',
}
