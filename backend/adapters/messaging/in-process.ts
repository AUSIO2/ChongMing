// 文件职责：为独立本机模式提供单 Host 的进程内工作队列、提交通知与活动缓存。
import { RuntimeMessage } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import type { GraphActivity } from '../../../contracts/activity'
import type { QueueChange, QueueWork } from '../../../contracts/events'
import { workReadConcurrency, type QueueLink } from '../../ports/messaging'
import type { Persistence, PersistenceEvents } from '../../ports/persistence'
import { GRAPH_COLLECTION } from '../../modules/graph/graph-record'
import { workReadItems } from '../../modules/graph/work-state'
import { GraphError } from '../../modules/shared/domain-error'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

/** One process, one consumer. Work is derived again from persisted state at every startup. */
export function localCreateMessaging(/* 本机持久化与提交事件入口；消息服务订阅它但不关闭数据库。 */ database: Persistence & PersistenceEvents, /* 可选诊断接收器，用于记录后台分发的致命错误。 */ reporter?: DiagnosticReporter) {
  // 维护本机消息通道与订阅生命周期，并在启动时从持久化 Run 重建待执行工作。
  const stop = new AbortController(), pending = new Map<string, QueueWork>()
  const inFlight = new Map<string, Promise<void>>()
  const listeners = new Set<(/* 实时变更提示；null 用于告知监听者通道已终止。 */ change: QueueChange | null) => void>()
  const activities = new Map<string, QueueChange>()
  const store = database.graph()
  let deploymentId: string, started = false, consuming = false, unsubscribe = () => {
    // 数据库订阅建立前无需解除监听。
  }
  let failure: unknown | undefined, closing: Promise<void> | undefined
  let wake = () => {
    // 消费者尚未等待时，发布工作无需唤醒任何 Promise。
  }, resolveClosed!: () => void, flushing: Promise<void> | undefined, dirty = false
  const closed = new Promise<void>(/* 通道关闭 Promise 的兑现函数，停止和致命故障共用。 */ resolve => {
    // 保存关闭完成回调，供停止或致命错误解除等待。
     resolveClosed = resolve })
  const messaging = () => /* 返回本机部署身份和固定的进程内队列命名空间。 */  ({ version: 1 as const, deploymentId, namespace: 'local.' + deploymentId, enabled: true })
  function localFail(/* 导致本机分发无法继续的异常，保留为服务终止原因。 */ error: unknown) {
    // 记录首个消息分发故障并启动统一关闭，让 closed 在全部在途工作排空后才完成。
    failure ??= error
    reporter?.report({ name: 'messaging.local.failed', severity: 'fatal', context: { phase: 'dispatch' }, error })
    stop.abort(error); wake(); void close()
  }
  function localPublishChange(/* 待发布的业务刷新或活动提示，活动按 fence 与序号去重。 */ change: QueueChange) {
    // 按 fence 和序号丢弃过时活动，再向当前监听者同步发布变更。
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
  async function localRunFlush() {
    // 串行扫描待发布图，生成工作通知和快照提示后按版本清除标记。
    while (dirty && !stop.signal.aborted) {
      dirty = false
      for await (const document of store.readDispatch()) {
        if (stop.signal.aborted) return
        for (const work of workReadItems(document)) await queue.publishWork({ version: 1, deploymentId, mapId: document.id, workId: work.workId })
        localPublishChange({ version: 1, deploymentId, kind: 'graph', mapId: document.id, workspaceId: document.workspaceId })
        await store.clearDispatch(document.id, document.dispatchVersion)
      }
    }
  }
  function localUpdateDispatch() {
    // 合并多次提交通知，确保同一时间只有一个待发布图扫描。
    dirty = true
    flushing ??= localRunFlush().catch(/* 后台待发布图扫描抛出的异常，将终止本消息通道。 */ error => {
      // 将后台扫描异常升级为消息通道的终止故障。
      localFail(error)
    }).finally(() => {
      // 释放扫描占用；结束期间若又有变更则启动下一轮扫描。
       flushing = undefined; if (dirty && !stop.signal.aborted) localUpdateDispatch() })
  }
  function close(): Promise<void> {
    // 合并关闭请求，停止新工作和数据库监听，等待发布及全部在途处理器结束后再确认通道关闭。
    return closing ??= (async () => {
      // 先同步取消所有工作，再尝试通知每个订阅者，单个监听异常不跳过剩余资源清理。
      if (!stop.signal.aborted) stop.abort()
      unsubscribe(); wake()
      for (const listener of listeners) { try { listener(null) } catch { /* 关闭通知失败不覆盖原始故障或跳过排空。 */ } }
      listeners.clear()
      await flushing
      while (inFlight.size) await Promise.allSettled([...inFlight.values()])
      pending.clear()
      resolveClosed()
    })()
  }
  const queue: QueueLink = {
    signal: stop.signal, closed,
    async publishWork(/* 待领取工作通知，按图身份与工作身份合并重复项。 */ message) {
      // 按图与工作身份合并待执行或正在执行的重复通知，并唤醒等待中的消费者。
      if (stop.signal.aborted) throw new Error(RuntimeMessage.LOCAL_WORK_CHANNEL_IS_CLOSED)
      const key = message.mapId + ':' + message.workId
      if (!inFlight.has(key)) pending.set(key, message)
      wake()
    },
    async publishChange(/* 经本机消息入口发送的业务变更提示。 */ change) {
      // 将通道变更交给本机监听者分发。
       localPublishChange(change) },
    async subscribeChanges(/* 接收非空变更的同步处理器，由调用方提供。 */ handler, /* 可选订阅取消信号，只解除本监听，不关闭整个消息服务。 */ signal) {
      // 注册变更处理器，并返回可同时移除监听和取消钩子的清理操作。
      const listener = (/* 本机分发提示；关闭时收到 null，业务处理器不接收该值。 */ change: QueueChange | null) => {
        // 只向业务处理器转交实际变更，忽略关闭用的空通知。
         if (change) handler(change) }
      listeners.add(listener)
      const remove = () => {
        // 从本机监听集合移除此订阅。
         listeners.delete(listener) }
      signal?.addEventListener('abort', remove, { once: true })
      return async () => {
        // 结束订阅并卸下对应的取消事件监听。
         remove(); signal?.removeEventListener('abort', remove) }
    },
    async consumeWork(/* 并发执行通知的异步处理器，每项独立返回 ack 或 retry。 */ handler, /* 可选 Host 停止信号，与本机通道关闭信号共同取消全部在途工作。 */ signal, /* 本消费者的有界并发容量配置。 */ options) {
      // 独占消费本机工作队列，在容量内并行处理、合并重复项，并在取消后排空全部任务。
      const concurrency = workReadConcurrency(options)
      if (consuming) throw new Error(RuntimeMessage.INDEPENDENT_LOCAL_MODE_SUPPORTS_ONE_HOST)
      consuming = true
      const consumerStop = new AbortController()
      const lifetime = signal ? AbortSignal.any([signal, stop.signal, consumerStop.signal]) : AbortSignal.any([stop.signal, consumerStop.signal])
      let consumerFailure: unknown
      const abort = () => /* 取消消费时解除空队列等待，让循环及时退出。 */  wake()
      lifetime.addEventListener('abort', abort)
      try {
        while (!lifetime.aborted) {
          while (!lifetime.aborted && inFlight.size < concurrency) {
            const first = pending.entries().next().value as [string, QueueWork] | undefined
            if (!first) break
            pending.delete(first[0])
            let task: Promise<void>
            task = handler(first[1], lifetime).then(/* 当前工作处理结果，决定是否在消费者仍有效时重新排队。 */ result => {
              // retry 只恢复这一项通知；其他工作按各自结果完成，不共享确认状态。
              if (result === 'retry' && !lifetime.aborted) pending.set(first[0], first[1])
            }).catch(/* 单项处理器抛出的异常，终止本消费者并取消其他在途工作。 */ error => {
              // 保留首个处理器故障并取消本轮消费，finally 仍会等待所有任务。
              consumerFailure ??= error
              consumerStop.abort(error)
            }).finally(() => {
              // 归还本地容量并唤醒调度循环，允许下一项待处理工作启动。
              inFlight.delete(first[0]); wake()
            })
            inFlight.set(first[0], task)
          }
          if (lifetime.aborted) break
          if (!pending.size || inFlight.size >= concurrency) {
            await new Promise<void>(/* 当前无可启动工作时的唤醒函数，由发布、任务完成或取消调用。 */ resolve => {
            // 保存本轮空队列的唤醒回调，并处理已发生的取消。
             wake = resolve; if (lifetime.aborted) resolve() })
          }
        }
      } finally {
        consumerStop.abort()
        await Promise.allSettled([...inFlight.values()])
        consuming = false
        lifetime.removeEventListener('abort', abort)
      }
      if (consumerFailure) throw consumerFailure
    },
    close,
  }
  return {
    queue, messaging,
    async initialize() {
      // 建立或读取稳定部署身份，避免服务重启后更换本机命名空间。
      await database.transaction(async /* 本次部署身份初始化事务的会话，由持久化层管理。 */ session => {
        // 在同一事务中首次插入部署身份或复用既有身份。
        const records = database.records<{ _id: string; deploymentId: string }>('control_deployment')
        let record = await records.get('identity', session)
        if (!record) { record = { _id: 'identity', deploymentId: randomUUID() }; await records.insert(record, session) }
        deploymentId = record.deploymentId
      })
    },
    async startMessaging() {
      // 监听存储提交并恢复持久化工作，等待首轮待通知标记发布完毕。
      if (started) return
      started = true
      unsubscribe = database.subscribe(/* 刚提交事务产生的记录变更集合，已忽略纯授权栅栏修改。 */ changes => {
        // 按变更表分发图、工作区、共享设置和访问权限刷新提示。
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
    async finished() {
      // 等待通道终止并返回触发关闭的致命错误。
       await closed; return failure },
    closeMessaging: close,
    watchChanges(/* 调用方的实时监听函数；收到 null 时应结束现有订阅。 */ listener: (/* 业务变更或通道关闭标志，null 表示停止推送。 */ change: QueueChange | null) => void) {
      // 仅在消息通道运行期间注册实时监听，并返回解除监听操作。
      if (!started || stop.signal.aborted) throw new GraphError(503, 'MESSAGING_UNAVAILABLE', RuntimeMessage.LOCAL_NOTIFICATIONS_ARE_NOT_RUNNING)
      listeners.add(listener); return () => {
        // 解除调用者注册的实时变更监听。
         listeners.delete(listener) }
    },
    readActivities: (/* 需要补齐初始活动状态的图身份。 */ mapId: string) => /* 读取指定图的临时活动缓存，供客户端首次订阅时补齐状态。 */  [...activities.values()].filter(/* 缓存中的单条活动消息，用其 mapId 判断归属。 */ change => /* 只保留目标图的活动消息。 */  change.mapId === mapId),
    async publishActivity(/* 已由应用层检查租约的固定活动摘要，不包含原始模型内容。 */ activity: GraphActivity, /* 发布活动的工作持有者身份，供后续缓存读取重新验证授权。 */ holderId: string) {
      // 附带持有者身份发布工作活动，供后续租约复核。
       localPublishChange({ version: 1, deploymentId, kind: 'activity', mapId: activity.mapId, activity, holderId }) },
  }
}
