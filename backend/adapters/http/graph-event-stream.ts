// 文件职责：在认证 SSE 连接上发送图快照、执行活动、管理刷新和心跳。
import { RuntimeMessage } from '../../../contracts/messages'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { GraphStreamEvent } from '../../../contracts/events'
import type { ApplicationService } from '../../application/graph-application'
import { GraphError } from '../../modules/shared/domain-error'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

/** A stream stores dirty flags only; each flush reads the newest authorized snapshot. */
/**
 * 维护单个图订阅的脏标记和连接生命周期，每次推送前重新取得授权状态。
 *
 * @param application 提供授权快照、活动读取及变更订阅的应用服务。
 * @param token 来自已解析 Authorization 头的用户令牌，每次刷新仍需重新鉴权。
 * @param mapId 本 SSE 连接唯一订阅的图身份。
 * @param response 本函数管理的 SSE 响应流，取消或故障时会结束或销毁。
 * @param diagnostics 可选诊断报告器与当前 HTTP 请求身份，用于关联流内故障。
 */
export async function eventsOpen(application: ApplicationService, token: string, mapId: string, response: ServerResponse,
  diagnostics?: { reporter: DiagnosticReporter; requestId: string }): Promise<void> {
  const lifetime = new AbortController()
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => {
    // 保存流关闭回调，供销毁响应时解除等待。
     resolveClosed = resolve })
  let unsubscribe = () => {
    // 消息订阅建立前没有监听需要解除。
  }, timer: ReturnType<typeof setInterval> | undefined
  let activity = true, graph = false, heartbeat = false, access = false, running = true, revision = -1, ownershipRevision = -1, workspaceId: string | undefined
  const scopes = new Set<'workspace' | 'settings'>(['workspace', 'settings'])
    function eventsClose() {
      // 幂等取消监听和心跳，销毁响应并通知订阅结束。
    if (lifetime.signal.aborted) return
    lifetime.abort()
    unsubscribe()
    clearInterval(timer)
    response.destroy()
    resolveClosed()
  }
  response.once('close', eventsClose)
    /**
     * 编码 SSE 事件或心跳，在写缓冲满时有界等待 drain。
     *
     * @param event 待发送的协议事件；未提供时发送无载荷心跳。
     */
    async function eventsWrite(event?: GraphStreamEvent) {
    lifetime.signal.throwIfAborted()
    const frame = event ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n` : ': heartbeat\n\n'
    if (!response.write(frame)) {
      const timeout = AbortSignal.timeout(10000)
      await once(response, 'drain', { signal: AbortSignal.any([lifetime.signal, timeout]) })
    }
  }
    /**
     * 为流内错误生成诊断身份并脱敏未知异常，尝试发出错误事件后结束响应。
     *
     * @param error 刷新或写流过程中的异常，未知错误会先脱敏再返回。
     */
    async function eventsWriteError(error: unknown) {
    if (lifetime.signal.aborted) return
    const failure = error instanceof GraphError ? error : new GraphError(500, 'INTERNAL_ERROR', RuntimeMessage.REALTIME_SYNCHRONIZATION_FAILED)
    const errorId = failure.status >= 500
      ? diagnostics?.reporter.report({ name: 'stream.failed', severity: 'error', context: { requestId: diagnostics.requestId, mapId, phase: 'flush' }, error }) ?? crypto.randomUUID()
      : crypto.randomUUID()
    try {
      await eventsWrite({ type: 'error', error: { status: failure.status, code: failure.code, message: failure.message,
        retryable: failure.status >= 500, errorId, ...(failure.currentRevision === undefined ? {} : { currentRevision: failure.currentRevision }) } })
      response.end()
    } catch { eventsClose() }
  }
    async function eventsRunFlush() {
      // 串行合并脏标记，重新鉴权并推送最新快照、活动和管理刷新。
    if (running || lifetime.signal.aborted) return
    running = true
    try {
      while (!lifetime.signal.aborted && (activity || graph || heartbeat || access || scopes.size)) {
        const readGraph = graph, writeActivity = activity || graph || heartbeat, writeHeartbeat = heartbeat, refresh = [...scopes]
        activity = false; graph = false; heartbeat = false; access = false; scopes.clear()
        if (readGraph) {
          const snapshot = await application.readSnapshot(token, mapId)
          await application.authorizeMap(token, mapId)
          if (snapshot.revision > revision || snapshot.ownershipRevision > ownershipRevision) {
            await eventsWrite({ type: 'snapshot', snapshot })
            revision = snapshot.revision
            ownershipRevision = snapshot.ownershipRevision
          }
        } else await application.authorizeMap(token, mapId)
        if (writeActivity) {
          const items = await application.readActivities(token, mapId)
          await application.authorizeMap(token, mapId)
          await eventsWrite({ type: 'activity', items })
        }
        for (const scope of refresh) await eventsWrite({ type: 'refresh', scope })
        if (writeHeartbeat) await eventsWrite()
      }
    } catch (error) { await eventsWriteError(error) }
    finally { running = false }
  }
  try {
    unsubscribe = application.watchChanges(change => {
      // 把相关图或管理变更转为脏标记，消息通道断开时关闭流。
      if (!change) { eventsClose(); return }
      if (change.kind === 'activity') {
        if (change.mapId !== mapId) return
        activity = true
      } else if (change.kind === 'graph') {
        if (change.mapId === mapId) graph = true
        else if (workspaceId && change.workspaceId === workspaceId) scopes.add('workspace')
        else return
      }
      else if (change.kind === 'workspace') {
        if (workspaceId && change.workspaceId !== workspaceId) return
        scopes.add('workspace')
      } else if (change.kind === 'settings') scopes.add('settings')
      else { access = true; scopes.add('workspace'); scopes.add('settings') }
      void eventsRunFlush()
    })
    const snapshot = await application.readSnapshot(token, mapId)
    workspaceId = snapshot.workspaceId
    await application.authorizeMap(token, mapId)
    lifetime.signal.throwIfAborted()
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive', 'x-accel-buffering': 'no',
    })
    response.flushHeaders()
    await eventsWrite({ type: 'snapshot', snapshot })
    revision = snapshot.revision
    ownershipRevision = snapshot.ownershipRevision
    running = false
    timer = setInterval(() => {
      // 周期性安排心跳及授权复核，让空闲连接也能感知失效。
       heartbeat = true; void eventsRunFlush() }, 15000)
    timer.unref()
    void eventsRunFlush()
    await closed
  } catch (error) {
    unsubscribe()
    clearInterval(timer)
    response.removeListener('close', eventsClose)
    if (response.headersSent) { eventsClose(); return }
    throw error
  }
}
