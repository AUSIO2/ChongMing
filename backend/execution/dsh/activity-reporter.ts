import type { DshEvent } from '../../../contracts/dsh'
import type { ActivityStatus } from '../../../contracts/activity'

/** Installed SDK session.event envelope; deliberately excludes all model/tool content. */
// 用途：读取状态，并把结构化结果交给调用方。
export function activityReadStatus(event: DshEvent): ActivityStatus | null {
  if (event.method !== 'session.event') return null
  const entry = event.params.event
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  switch (entry.type) {
    case 'turn/start': return 'preparing'
    case 'step/start': return 'model'
    case 'tool/call': return 'tool'
    case 'tool/result': return 'result'
    default: return null
  }
}

/** Lossy single-flight display channel. Execution never awaits the display transport. */
// 用途：创建活动状态，供后续流程使用。
export function activityCreateReporter(input: { dataApiUrl: string; token: string; grant: import('../../../contracts/graph').GraphWorkGrant; signal: AbortSignal }) {
  const stop = new AbortController()
  let status: ActivityStatus = 'preparing', sequence = 0, pending = false, task: Promise<void> | undefined
  const signal = AbortSignal.any([stop.signal, input.signal])
  // 用途：执行活动状态流程，并返回执行结果。
  async function activityRunPublish() {
    while (pending && !signal.aborted) {
      pending = false
      const current = ++sequence
      try {
        await fetch(new URL('/internal/v1/activity', input.dataApiUrl), {
          method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + input.token,
            'x-work-id': input.grant.workId, 'x-work-holder': input.grant.holderId, 'x-work-fence': String(input.grant.fence) },
          body: JSON.stringify({ mapId: input.grant.mapId, status, sequence: current }),
        }).then(response => response.body?.cancel())
      } catch { /* Display loss is repaired by the next event or lease renewal. */ }
    }
  }
  // 用途：更新活动状态，并保持相关状态一致。
  function activityUpdateReport(next = status) {
    if (signal.aborted) return
    status = next; pending = true
    task ??= activityRunPublish().finally(() => { task = undefined; if (pending && !signal.aborted) activityUpdateReport() })
  }
  return {
    update: activityUpdateReport,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    event(event: DshEvent) { const next = activityReadStatus(event); if (next && next !== status) activityUpdateReport(next) },
    // 用途：关闭当前模块并释放占用的资源。
    async close() { stop.abort(); await task },
  }
}
