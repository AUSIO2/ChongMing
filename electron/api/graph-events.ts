import { IPC_CHANNELS } from './channels'
import type {
  GraphCompletedPayload,
  GraphErrorPayload,
  GraphInterruptedPayload,
  GraphProgressPayload,
  GraphStatePayload,
} from './types'

type GraphHandler<T> = (payload: T) => void

const interruptedHandlers = new Set<GraphHandler<GraphInterruptedPayload>>()
const completedHandlers = new Set<GraphHandler<GraphCompletedPayload>>()
const errorHandlers = new Set<GraphHandler<GraphErrorPayload>>()
const progressHandlers = new Set<GraphHandler<GraphProgressPayload>>()
const stateHandlers = new Set<GraphHandler<GraphStatePayload>>()

function graphOn<T>(
  set: Set<GraphHandler<T>>,
  cb: GraphHandler<T>,
): () => void {
  set.add(cb)
  return () => {
    set.delete(cb)
  }
}

function graphEmitSet<T>(set: Set<GraphHandler<T>>, payload: T): void {
  for (const h of set) {
    try {
      h(payload)
    } catch (err) {
      console.error('[graph-events] subscriber error', err)
    }
  }
}

/** 向进程内订阅者广播图事件（桌面 window 推送由调用方另做）。 */
export function graphEmit(channel: string, payload: unknown): void {
  switch (channel) {
    case IPC_CHANNELS.GRAPH_INTERRUPTED:
      graphEmitSet(interruptedHandlers, payload as GraphInterruptedPayload)
      break
    case IPC_CHANNELS.GRAPH_COMPLETED:
      graphEmitSet(completedHandlers, payload as GraphCompletedPayload)
      break
    case IPC_CHANNELS.GRAPH_ERROR:
      graphEmitSet(errorHandlers, payload as GraphErrorPayload)
      break
    case IPC_CHANNELS.GRAPH_PROGRESS:
      graphEmitSet(progressHandlers, payload as GraphProgressPayload)
      break
    case IPC_CHANNELS.GRAPH_STATE:
      graphEmitSet(stateHandlers, payload as GraphStatePayload)
      break
    default:
      break
  }
}

export function graphOnInterrupted(
  cb: GraphHandler<GraphInterruptedPayload>,
): () => void {
  return graphOn(interruptedHandlers, cb)
}

export function graphOnCompleted(
  cb: GraphHandler<GraphCompletedPayload>,
): () => void {
  return graphOn(completedHandlers, cb)
}

export function graphOnError(cb: GraphHandler<GraphErrorPayload>): () => void {
  return graphOn(errorHandlers, cb)
}

export function graphOnProgress(
  cb: GraphHandler<GraphProgressPayload>,
): () => void {
  return graphOn(progressHandlers, cb)
}

export function graphOnState(cb: GraphHandler<GraphStatePayload>): () => void {
  return graphOn(stateHandlers, cb)
}

/** 测试用：清空所有订阅。 */
export function graphDeleteHandlers(): void {
  interruptedHandlers.clear()
  completedHandlers.clear()
  errorHandlers.clear()
  progressHandlers.clear()
  stateHandlers.clear()
}
