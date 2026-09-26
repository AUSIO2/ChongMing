import { RuntimeMessage } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import type { GraphActivity } from '../../../contracts/activity'
import type { QueueChange, QueueWork } from '../../../contracts/events'
import type { QueueLink } from '../../ports/messaging'
import type { Persistence, PersistenceEvents } from '../../ports/persistence'
import { GRAPH_COLLECTION } from '../../modules/graph/graph-record'
import { workReadItems } from '../../modules/graph/work-state'
import { GraphError } from '../../modules/shared/domain-error'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

/** One process, one consumer. Work is derived again from persisted state at every startup. */
// 用途：创建本机服务，供后续流程使用。
export function localCreateMessaging(database: Persistence & PersistenceEvents, reporter?: DiagnosticReporter) {
  const stop = new AbortController(), pending = new Map<string, QueueWork>()
  const listeners = new Set<(change: QueueChange | null) => void>()
  const activities = new Map<string, QueueChange>()
  const store = database.graph()
  let deploymentId: string, started = false, consuming = false, unsubscribe = () => {}
  let failure: unknown | undefined
  let wake = () => {}, resolveClosed!: () => void, flushing: Promise<void> | undefined, dirty = false
  const closed = new Promise<void>(resolve => { resolveClosed = resolve })
  const messaging = () => ({ version: 1 as const, deploymentId, namespace: 'local.' + deploymentId, enabled: true })
  // 用途：记录本机服务的失败，并让上层及时收敛。
  function localFail(error: unknown) {
    failure = error
    reporter?.report({ name: 'messaging.local.failed', severity: 'fatal', context: { phase: 'dispatch' }, error })
    stop.abort(error); wake(); resolveClosed()
    for (const listener of listeners) { try { listener(null) } catch { /* the original listener failure is already terminal */ } }
  }
  // 用途：发布变更消息，让其他组件收到状态变化。
  function localPublishChange(change: QueueChange) {
    if (stop.signal.aborted) return
    if (change.kind === 'activity') {
      const activity = change.activity!, key = activity.workId, prior = activities.get(key)?.activity
      if (prior && (prior.fence > activity.fence || prior.fence === activity.fence && prior.sequence >= activity.sequence)) return
      activities.set(key, change)
      if (activities.size > 1000) activities.delete(activities.keys().next().value!)
    }
    for (const listener of listeners) {
      try { listener(change) }
      catch (error) { localFail(error); throw error }
    }
  }
  // 用途：执行本机服务流程，并返回执行结果。
  async function localRunFlush() {
    while (dirty && !stop.signal.aborted) {
      dirty = false
      for await (const document of store.readDispatch()) {
        for (const work of workReadItems(document)) await queue.publishWork({ version: 1, deploymentId, mapId: document.id, workId: work.workId })
        localPublishChange({ version: 1, deploymentId, kind: 'graph', mapId: document.id, workspaceId: document.workspaceId })
        await store.clearDispatch(document.id, document.dispatchVersion)
      }
    }
  }
  // 用途：更新本机服务，并保持相关状态一致。
  function localUpdateDispatch() {
    dirty = true
    flushing ??= localRunFlush().catch(error => {
      localFail(error)
    }).finally(() => { flushing = undefined; if (dirty && !stop.signal.aborted) localUpdateDispatch() })
  }
  // 用途：关闭当前模块并释放占用的资源。
  async function close() {
    if (!stop.signal.aborted) { stop.abort(); unsubscribe(); wake(); for (const listener of listeners) listener(null); resolveClosed() }
    await flushing
  }
  const queue: QueueLink = {
    signal: stop.signal, closed,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async publishWork(message) {
      if (stop.signal.aborted) throw new Error(RuntimeMessage.LOCAL_WORK_CHANNEL_IS_CLOSED)
      pending.set(message.mapId + ':' + message.workId, message); wake()
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async publishChange(change) { localPublishChange(change) },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async subscribeChanges(handler, signal) {
      const listener = (change: QueueChange | null) => { if (change) handler(change) }
      listeners.add(listener)
      const remove = () => { listeners.delete(listener) }
      signal?.addEventListener('abort', remove, { once: true })
      return async () => { remove(); signal?.removeEventListener('abort', remove) }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async consumeWork(handler, signal) {
      if (consuming) throw new Error(RuntimeMessage.INDEPENDENT_LOCAL_MODE_SUPPORTS_ONE_HOST)
      consuming = true
      const lifetime = signal ? AbortSignal.any([signal, stop.signal]) : stop.signal
      const abort = () => wake()
      lifetime.addEventListener('abort', abort)
      try {
        while (!lifetime.aborted) {
          const first = pending.entries().next().value
          if (!first) { await new Promise<void>(resolve => { wake = resolve; if (lifetime.aborted) resolve() }); continue }
          pending.delete(first[0])
          const result = await handler(first[1], lifetime)
          if (result === 'retry' && !lifetime.aborted) pending.set(first[0], first[1])
        }
      } finally { consuming = false; lifetime.removeEventListener('abort', abort) }
    },
    close,
  }
  return {
    queue, messaging,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize() {
      await database.transaction(async session => {
        const records = database.records<{ _id: string; deploymentId: string }>('control_deployment')
        let record = await records.get('identity', session)
        if (!record) { record = { _id: 'identity', deploymentId: randomUUID() }; await records.insert(record, session) }
        deploymentId = record.deploymentId
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async startMessaging() {
      if (started) return
      started = true
      unsubscribe = database.subscribe(changes => {
        for (const change of changes) {
          if (change.table === GRAPH_COLLECTION) localUpdateDispatch()
          else if (change.table === 'control_workspaces') localPublishChange({ version: 1, deploymentId, kind: 'workspace', workspaceId: change.id })
          else if (['control_settings', 'control_library'].includes(change.table)) localPublishChange({ version: 1, deploymentId, kind: 'settings' })
          else if (['control_users', 'control_tokens', 'control_assets'].includes(change.table)) localPublishChange({ version: 1, deploymentId, kind: 'access' })
        }
      })
      for await (const document of store.discover()) for (const work of workReadItems(document)) await queue.publishWork({ version: 1, deploymentId, mapId: document.id, workId: work.workId })
      localUpdateDispatch(); await flushing
      if (stop.signal.aborted) throw stop.signal.reason
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async finished() { await closed; return failure },
    closeMessaging: close,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    watchChanges(listener: (change: QueueChange | null) => void) {
      if (!started || stop.signal.aborted) throw new GraphError(503, 'MESSAGING_UNAVAILABLE', RuntimeMessage.LOCAL_NOTIFICATIONS_ARE_NOT_RUNNING)
      listeners.add(listener); return () => { listeners.delete(listener) }
    },
    readActivities: (mapId: string) => [...activities.values()].filter(change => change.mapId === mapId),
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async publishActivity(activity: GraphActivity, holderId: string) { localPublishChange({ version: 1, deploymentId, kind: 'activity', mapId: activity.mapId, activity, holderId }) },
  }
}
