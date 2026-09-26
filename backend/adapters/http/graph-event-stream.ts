import { RuntimeMessage } from '../../../contracts/messages'
import { once } from 'node:events'
import type { ServerResponse } from 'node:http'
import type { GraphStreamEvent } from '../../../contracts/events'
import type { ApplicationService } from '../../application/graph-application'
import { GraphError } from '../../modules/shared/domain-error'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

/** A stream stores dirty flags only; each flush reads the newest authorized snapshot. */
// 用途：处理实时事件相关工作，并把结果交给调用方。
export async function eventsOpen(application: ApplicationService, token: string, mapId: string, response: ServerResponse,
  diagnostics?: { reporter: DiagnosticReporter; requestId: string }): Promise<void> {
  const lifetime = new AbortController()
  let resolveClosed!: () => void
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  let unsubscribe = () => {}, timer: ReturnType<typeof setInterval> | undefined
  let activity = true, graph = false, heartbeat = false, access = false, running = true, revision = -1, workspaceId: string | undefined
  const scopes = new Set<'workspace' | 'settings'>(['workspace', 'settings'])
    // 用途：关闭实时事件，并释放相关资源。
    function eventsClose() {
    if (lifetime.signal.aborted) return
    lifetime.abort()
    unsubscribe()
    clearInterval(timer)
    response.destroy()
    resolveClosed()
  }
  response.once('close', eventsClose)
    // 用途：处理实时事件相关工作，并把结果交给调用方。
    async function eventsWrite(event?: GraphStreamEvent) {
    lifetime.signal.throwIfAborted()
    const frame = event ? `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n` : ': heartbeat\n\n'
    if (!response.write(frame)) {
      const timeout = AbortSignal.timeout(10000)
      await once(response, 'drain', { signal: AbortSignal.any([lifetime.signal, timeout]) })
    }
  }
    // 用途：处理实时事件相关工作，并把结果交给调用方。
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
    // 用途：执行实时事件流程，并返回执行结果。
    async function eventsRunFlush() {
    if (running || lifetime.signal.aborted) return
    running = true
    try {
      while (!lifetime.signal.aborted && (activity || graph || heartbeat || access || scopes.size)) {
        const readGraph = graph, writeActivity = activity || graph || heartbeat, writeHeartbeat = heartbeat, refresh = [...scopes]
        activity = false; graph = false; heartbeat = false; access = false; scopes.clear()
        if (readGraph) {
          const snapshot = await application.readSnapshot(token, mapId)
          await application.authorizeMap(token, mapId)
          if (snapshot.revision > revision) {
            await eventsWrite({ type: 'snapshot', snapshot })
            revision = snapshot.revision
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
    running = false
    timer = setInterval(() => { heartbeat = true; void eventsRunFlush() }, 15000)
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
