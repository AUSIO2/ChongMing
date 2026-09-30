// 文件职责：把 Mongo 图提交与管理变更可靠转发到 RabbitMQ，并向 API 订阅者提供实时提示。
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
/**
 * 维护单个 API 实例的队列连接、Mongo 变更流与活动缓存，负责断线后补发。
 *
 * @param connection 已连接的 Mongo 实例；本服务从中读取部署身份并建立变更流。
 * @param store 用于恢复可执行工作及清理待发布标记的图存储接口。
 * @param config 可选 RabbitMQ 部署配置；缺省时只初始化身份，不启动消息连接。
 * @param reporter 可选诊断报告器，记录重连警告和处理器终止故障。
 */
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
  function outboxReadIdentity() {
    // 读取持久部署身份并组合隔离命名空间，初始化前拒绝使用。
    if (!deploymentId) throw new Error(RuntimeMessage.INITIALIZE_APPLICATION_BEFORE_READING_MESSAGING_IDENTITY)
    return { version: 1 as const, deploymentId, namespace: `${config?.namespace ?? 'chongming'}.${deploymentId}`, enabled: !!config }
  }
  /**
   * 向所有实时订阅者发送变更或连接关闭通知。
   *
   * @param change 传递给所有监听者的变更，null 表示需要结束实时订阅。
   */
  function outboxUpdateListeners(change: QueueChange | null) {
    for (const listener of listeners) listener(change)
  }
  /**
   * 建立队列订阅与 Mongo 变更流，补发未完成工作并等待连接结束。
   *
   * @param current 本轮已经建立的队列连接，出错或断线后由外层关闭并重建。
   */
  async function outboxRunConnection(current: QueueLink) {
    const outboxCloseSubscribers = () => {
      // 标记队列断开并通知实时订阅者重新连接。
       connected = false; outboxUpdateListeners(null) }
    current.signal.addEventListener('abort', outboxCloseSubscribers, { once: true })
    await current.subscribeChanges(change => {
      // 忽略其他部署及过时活动，缓存最新活动后通知本机订阅者。
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
      // Mongo change streams encode dotted update paths as literal keys inside updatedFields; observe every graph update and let readDispatch filter pending work.
      { 'ns.coll': GRAPH_COLLECTION, operationType: { $in: ['insert', 'replace', 'update'] } },
      { 'ns.coll': { $in: ['control_workspaces', 'control_settings', 'control_library'] }, $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        { 'updateDescription.updatedFields.revision': { $exists: true } },
      ] },
      { 'ns.coll': 'control_users', $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        ...['disabled', 'hostAdmin', 'displayName'].map(field => /* 将影响用户身份的字段变更加入 Mongo 订阅条件。 */  ({ [`updateDescription.updatedFields.${field}`]: { $exists: true } })),
      ] },
      { 'ns.coll': 'control_tokens', $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        ...['revoked', 'expiresAt', 'userId'].map(field => /* 将影响令牌有效性的字段变更加入 Mongo 订阅条件。 */  ({ [`updateDescription.updatedFields.${field}`]: { $exists: true } })),
      ] },
      { 'ns.coll': 'control_assets', $or: [
        { operationType: { $in: ['insert', 'replace', 'delete'] } },
        { 'updateDescription.updatedFields.state': { $exists: true } },
      ] },
    ] } }], { maxAwaitTimeMS: 250 })
    closeStream = () => /* 暴露当前变更流的关闭操作，供服务停止时解除读取等待。 */  stream.close()
    async function outboxRunDispatch() {
      // 发布待通知图的当前工作和刷新提示，成功后按版本清除分发标记。
      for await (const document of store.readDispatch()) {
        if (!document.deletedAt) for (const work of workReadItems(document)) {
          await current.publishWork({ version: 1, deploymentId, mapId: document.id, workId: work.workId })
        }
            await current.publishChange({ version: 1, deploymentId, kind: 'graph', mapId: document.id, workspaceId: document.workspaceId })
        await store.clearDispatch(document.id, document.dispatchVersion)
      }
    }
    /**
     * 把集合变更转换为图补发、工作区刷新、设置刷新或访问权限刷新。
     *
     * @param change Mongo 变更流原始事件，按集合及操作类型转换为刷新提示。
     */
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
      watching = (async () => {
        // 持续消费 Mongo 变更流并按顺序发布对应提示。
         for await (const change of stream) await outboxPublishChange(change) })()
      // Observe failures immediately while the startup reconciliation is still running.
      void watching.catch(() => /* 变更流监听失败时关闭队列，促使外层进入恢复流程。 */  current.close())
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
      await watching?.catch(() => {
        // 关闭变更流时忽略已观察过的监听错误，继续完成资源清理。
      })
      closeStream = undefined
      current.signal.removeEventListener('abort', outboxCloseSubscribers)
    }
  }
  async function outboxRunLoop() {
    // 以有界指数退避重连 RabbitMQ；处理器故障则终止服务并报告错误。
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
      if (!lifetime.signal.aborted) await delay(waitMs, undefined, { signal: lifetime.signal }).catch(() => {
        // 停止期间取消重连延时属于正常收尾，无需再报告错误。
      })
      waitMs = Math.min(waitMs * 2, 5000)
    }
    resolveReady!()
  }
  async function outboxClose() {
    // 取消消息生命周期，断开订阅、队列和 Mongo 变更流，并等待循环结束。
    lifetime.abort()
    outboxUpdateListeners(null)
    await Promise.all([link?.close(), closeStream?.()])
    await task
  }
  connection.once('close', () => {
    // Mongo 连接关闭时同步收敛依赖它的消息服务。
     void outboxClose() })
  return {
    async initialize() {
      // 原子创建或复用部署身份，确保重连使用相同队列隔离空间。
      await deployment.updateOne({ _id: 'identity' }, { $setOnInsert: { deploymentId: randomUUID() } }, { upsert: true })
      const identity = await deployment.findOne({ _id: 'identity' })
      if (!identity) throw new Error(RuntimeMessage.DEPLOYMENT_IDENTITY_DISAPPEARED)
      deploymentId = identity.deploymentId
    },
    messaging: outboxReadIdentity,
    /**
     * @param mapId 本次查询活动缓存所属的图身份。
     */
    readActivities: (mapId: string) => /* 从临时缓存取得目标图的最新活动消息。 */  [...activities.values()].filter(change => /* 按图身份筛选活动缓存。 */  change.mapId === mapId),
    /**
     * 仅在队列已连接时发布活动，并携带用于后续授权复核的持有者身份。
     *
     * @param activity 已验证工作身份的临时活动摘要，发送失败不写入持久图。
     * @param holderId 活动发布者的租约持有者身份，随提示传给后续授权检查。
     */
    async publishActivity(activity: import('../../../contracts/activity').GraphActivity, holderId: string) {
      if (!connected || !link || link.signal.aborted) throw new GraphError(503, 'MESSAGING_UNAVAILABLE', RuntimeMessage.ACTIVITY_MESSAGING_IS_RECONNECTING)
      await link.publishChange({ version: 1, deploymentId, kind: 'activity', mapId: activity.mapId, activity, holderId })
    },
    startMessaging(): Promise<void> {
      // 按需启动唯一的重连循环，并等待首轮恢复流程完成。
      if (!config) return Promise.resolve()
      if (!ready) {
        ready = new Promise<void>(resolve => {
          // 保存首轮恢复完成的通知回调。
           resolveReady = resolve })
        task = outboxRunLoop()
      }
      return ready
    },
    async finished() {
      // 等待消息循环停止并返回终止原因。
       await task; return failure },
    closeMessaging: outboxClose,
    /**
     * 在有效队列连接上注册实时变更监听，拒绝断线期订阅。
     *
     * @param listener 调用者提供的同步变更接收器，返回清理函数可解除注册。
     */
    watchChanges(listener: (change: QueueChange | null) => void): () => void {
      if (!config || !connected || !link || link.signal.aborted) throw new GraphError(503, 'MESSAGING_UNAVAILABLE', RuntimeMessage.REALTIME_MESSAGING_IS_RECONNECTING)
      listeners.add(listener)
      return () => {
        // 移除该调用者的变更监听。
         listeners.delete(listener) }
    },
  }
}
