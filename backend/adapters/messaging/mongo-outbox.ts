import { RuntimeMessage } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import type { Connection } from 'mongoose'
import type { ChangeStreamDocument } from 'mongodb'
import type { QueueChange, QueueConfig } from '../../../contracts/events'
import { GraphError } from '../../modules/shared/domain-error'
import { queueOpen } from './rabbitmq'
import { type QueueLink } from '../../ports/messaging'
import { GRAPH_COLLECTION } from '../../modules/graph/graph-record'
import { type GraphStore } from '../../ports/graph-store'
import { workReadItems } from '../../modules/graph/work-state'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

/** One broker connection and one fanout subscription per API instance. */
// 用途：创建服务，供后续流程使用。
export function outboxCreateService(connection: Connection, store: GraphStore, config?: QueueConfig, reporter?: DiagnosticReporter) {
  const deployment = connection.collection<{ _id: string; deploymentId: string }>('control_deployment')
  const activities = new Map<string, QueueChange>()
  const listeners = new Set<(change: QueueChange | null) => void>()
  const lifetime = new AbortController()
  let connected = false
  let deploymentId: string, link: QueueLink | undefined, task: Promise<void> | undefined
  let failure: unknown | undefined
  let ready: Promise<void> | undefined, resolveReady: (() => void) | undefined
  let closeStream: (() => Promise<void>) | undefined

  // 用途：读取身份，并把结构化结果交给调用方。
  function outboxReadIdentity() {
    if (!deploymentId) throw new Error(RuntimeMessage.INITIALIZE_APPLICATION_BEFORE_READING_MESSAGING_IDENTITY)
    return { version: 1 as const, deploymentId, namespace: `${config?.namespace ?? 'chongming'}.${deploymentId}`, enabled: !!config }
  }
  // 用途：更新变更发布，并保持相关状态一致。
  function outboxUpdateListeners(change: QueueChange | null) {
    for (const listener of listeners) listener(change)
  }
  // 用途：执行连接流程，并返回执行结果。
  async function outboxRunConnection(current: QueueLink) {
    const outboxCloseSubscribers = () => { connected = false; outboxUpdateListeners(null) }
    current.signal.addEventListener('abort', outboxCloseSubscribers, { once: true })
    await current.subscribeChanges(change => {
      if (change.deploymentId !== deploymentId) return
      if (change.kind === 'activity') {
        const item = change.activity!, key = item.mapId + ':' + item.workId
        const previous = activities.get(key)?.activity
        if (previous && (previous.fence > item.fence || (previous.fence === item.fence && previous.sequence >= item.sequence))) return
        activities.delete(key); activities.set(key, change)
        // ponytail: bounded display cache; evictions recover on the next Host renewal.
        if (activities.size > 1000) activities.delete(activities.keys().next().value!)
      }
      outboxUpdateListeners(change)
    }, lifetime.signal)
    connected = true
    // Establish the change-stream cursor before reconciliation; commits during the scan stay queued.
    const stream = connection.db!.watch([{ $match: { $or: [
      { 'ns.coll': GRAPH_COLLECTION, $or: [
        { operationType: { $in: ['insert', 'replace'] } },
        { 'updateDescription.updatedFields.dispatch': { $exists: true } },
      ] },
      { 'ns.coll': { $in: ['control_workspaces', 'control_settings', 'control_library'] }, $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        { 'updateDescription.updatedFields.revision': { $exists: true } },
      ] },
      { 'ns.coll': 'control_users', $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        ...['disabled', 'hostAdmin', 'displayName'].map(field => ({ [`updateDescription.updatedFields.${field}`]: { $exists: true } })),
      ] },
      { 'ns.coll': 'control_tokens', $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        ...['revoked', 'expiresAt', 'userId'].map(field => ({ [`updateDescription.updatedFields.${field}`]: { $exists: true } })),
      ] },
      { 'ns.coll': 'control_assets', $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        { 'updateDescription.updatedFields.state': { $exists: true } },
      ] },
    ] } }], { maxAwaitTimeMS: 250 })
    closeStream = () => stream.close()
    // 用途：执行变更发布流程，并返回执行结果。
    async function outboxRunDispatch() {
      for await (const document of store.readDispatch()) {
        if (!document.deletedAt) for (const work of workReadItems(document)) {
          await current.publishWork({ version: 1, deploymentId, mapId: document.id, workId: work.workId })
        }
            await current.publishChange({ version: 1, deploymentId, kind: 'graph', mapId: document.id, workspaceId: document.workspaceId })
        await store.clearDispatch(document.id, document.dispatchVersion)
      }
    }
    // 用途：发布变更消息，让其他组件收到状态变化。
    async function outboxPublishChange(change: ChangeStreamDocument) {
      if (change.operationType !== 'insert' && change.operationType !== 'replace' && change.operationType !== 'update' && change.operationType !== 'delete') return
      const collection = change.ns.coll
      if (collection === GRAPH_COLLECTION) { await outboxRunDispatch(); return }
      const hint = collection === 'control_workspaces'
        ? { kind: 'workspace' as const, workspaceId: String(change.documentKey._id) }
        : collection === 'control_settings' || collection === 'control_library' ? { kind: 'settings' as const }
        : { kind: 'access' as const }
      await current.publishChange({ version: 1, deploymentId, ...hint })
    }
    let watching: Promise<void> | undefined
    try {
      const first = await stream.tryNext()
      await outboxRunDispatch()
      if (first) await outboxPublishChange(first)
      watching = (async () => { for await (const change of stream) await outboxPublishChange(change) })()
      // Observe failures immediately while the startup reconciliation is still running.
      void watching.catch(() => current.close())
      // A broker may have lost previously confirmed data: re-derive every active Run at reconnect.
      for await (const document of store.discover()) for (const work of workReadItems(document)) {
        await current.publishWork({ version: 1, deploymentId, mapId: document.id, workId: work.workId })
      }
      // Reconnect repairs refresh hints committed while every relay was offline.
      await current.publishChange({ version: 1, deploymentId, kind: 'access' })
      resolveReady!()
      await Promise.race([current.closed, watching])
      const reason = current.signal.reason
      if (reason && typeof reason === 'object' && 'code' in reason && reason.code === 'QUEUE_HANDLER') throw reason
    } finally {
      await stream.close()
      await watching?.catch(() => {})
      closeStream = undefined
      current.signal.removeEventListener('abort', outboxCloseSubscribers)
    }
  }
  // 用途：执行变更发布流程，并返回执行结果。
  async function outboxRunLoop() {
    let waitMs = 250
    while (!lifetime.signal.aborted) {
      let current: QueueLink | undefined
      try {
        current = await queueOpen({ ...config!, namespace: outboxReadIdentity().namespace })
        if (lifetime.signal.aborted) { await current.close(); break }
        link = current
        waitMs = 250
        await outboxRunConnection(current)
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && error.code === 'QUEUE_HANDLER') {
          failure = error
          reporter?.report({ name: 'messaging.handler.failed', severity: 'fatal', error })
          lifetime.abort(error); resolveReady!(); return
        }
        if (!lifetime.signal.aborted) reporter?.report({ name: 'messaging.reconnect', severity: 'warn',
          context: { reason: error instanceof GraphError ? error.code : 'QUEUE_UNAVAILABLE' }, error })
      } finally {
        connected = false
        link = undefined
        outboxUpdateListeners(null)
        await current?.close()
      }
      if (!lifetime.signal.aborted) await delay(waitMs, undefined, { signal: lifetime.signal }).catch(() => {})
      waitMs = Math.min(waitMs * 2, 5000)
    }
    resolveReady!()
  }
  // 用途：关闭变更发布，并释放相关资源。
  async function outboxClose() {
    lifetime.abort()
    outboxUpdateListeners(null)
    await Promise.all([link?.close(), closeStream?.()])
    await task
  }
  connection.once('close', () => { void outboxClose() })
  return {
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize() {
      await deployment.updateOne({ _id: 'identity' }, { $setOnInsert: { deploymentId: randomUUID() } }, { upsert: true })
      const identity = await deployment.findOne({ _id: 'identity' })
      if (!identity) throw new Error(RuntimeMessage.DEPLOYMENT_IDENTITY_DISAPPEARED)
      deploymentId = identity.deploymentId
    },
    messaging: outboxReadIdentity,
    readActivities: (mapId: string) => [...activities.values()].filter(change => change.mapId === mapId),
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async publishActivity(activity: import('../../../contracts/activity').GraphActivity, holderId: string) {
      if (!connected || !link || link.signal.aborted) throw new GraphError(503, 'MESSAGING_UNAVAILABLE', RuntimeMessage.ACTIVITY_MESSAGING_IS_RECONNECTING)
      await link.publishChange({ version: 1, deploymentId, kind: 'activity', mapId: activity.mapId, activity, holderId })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    startMessaging(): Promise<void> {
      if (!config) return Promise.resolve()
      if (!ready) {
        ready = new Promise<void>(resolve => { resolveReady = resolve })
        task = outboxRunLoop()
      }
      return ready
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async finished() { await task; return failure },
    closeMessaging: outboxClose,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    watchChanges(listener: (change: QueueChange | null) => void): () => void {
      if (!config || !connected || !link || link.signal.aborted) throw new GraphError(503, 'MESSAGING_UNAVAILABLE', RuntimeMessage.REALTIME_MESSAGING_IS_RECONNECTING)
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
