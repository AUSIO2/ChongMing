// 文件职责：把 DSH 固定事件摘要转换为有界、可丢失的执行活动通知。
import type { DshEvent } from '../../../contracts/dsh'
import type { ActivityStatus } from '../../../contracts/activity'

/** Installed SDK session.event envelope; deliberately excludes all model/tool content. */
/**
 * 仅从已知会话事件类型提取活动阶段，不读取模型文本或工具内容。
 *
 * @param event DSH 公共通知，仅检查已知事件类型以产生无内容的阶段摘要。
 */
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
/**
 * 维护当前状态、递增序号和唯一发送任务，让显示通知独立于业务执行。
 *
 * @param input 当前工作的 API、内部令牌、授权和取消信号；报告器据此绑定活动所有者。
 */
export function activityCreateReporter(input: { dataApiUrl: string; token: string; grant: import('../../../contracts/graph').GraphWorkGrant; signal: AbortSignal }) {
  const stop = new AbortController()
  let status: ActivityStatus = 'preparing', sequence = 0, pending = false, task: Promise<void> | undefined
  const signal = AbortSignal.any([stop.signal, input.signal])
  async function activityRunPublish() {
    // 合并待发送状态并以两秒期限上报，传输失败由后续事件或续租修复。
    while (pending && !signal.aborted) {
      pending = false
      const current = ++sequence
      try {
        await fetch(new URL('/internal/v1/activity', input.dataApiUrl), {
          method: 'POST', signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
          headers: { 'content-type': 'application/json', authorization: 'Bearer ' + input.token,
            'x-work-id': input.grant.workId, 'x-work-holder': input.grant.holderId, 'x-work-fence': String(input.grant.fence) },
          body: JSON.stringify({ mapId: input.grant.mapId, status, sequence: current }),
        }).then(response => /* 取消无须读取的响应正文，及时释放显示请求资源。 */  response.body?.cancel())
      } catch { /* Display loss is repaired by the next event or lease renewal. */ }
    }
  }
  /**
   * 保存最新活动状态并启动或复用唯一后台发送任务。
   *
   * @param next 下一活动阶段，缺省沿用当前状态以支持续租后的补发。
   */
  function activityUpdateReport(next = status) {
    if (signal.aborted) return
    status = next; pending = true
    task ??= activityRunPublish().finally(() => {
      // 释放发送任务占用；收尾时若又有更新则续发最新状态。
       task = undefined; if (pending && !signal.aborted) activityUpdateReport() })
  }
  return {
    update: activityUpdateReport,
    /**
     * 将事件转换为阶段，仅在阶段变化时触发上报。
     *
     * @param event 执行器产生的通知，只有识别到不同阶段时才触发上报。
     */
    event(event: DshEvent) {
       const next = activityReadStatus(event); if (next && next !== status) activityUpdateReport(next) },
    async close() {
      // 取消活动发送并等待在途请求结束。
       stop.abort(); await task },
  }
}
