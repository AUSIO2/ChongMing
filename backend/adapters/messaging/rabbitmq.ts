// 文件职责：实现 RabbitMQ 工作队列与变更广播的校验、发布确认、消费确认和连接收尾。
import { RuntimeMessage } from '../../../contracts/messages'
import { workReadConcurrency, type QueueLink, type WorkTransport } from '../../ports/messaging'
import { activityIsRecord } from '../../../contracts/activity'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { connect, type Channel, type ConfirmChannel, type ChannelModel } from 'amqplib'
import type { QueueConfig, QueueWork, QueueChange } from '../../../contracts/events'

export class QueueError extends Error {
  /**
   * 创建带稳定错误码的队列异常，供上层区分重连与永久故障。
   *
   * @param code 稳定队列错误码，作为只读字段供上层判断重试或终止。
   * @param message 描述队列配置、协议或连接故障的可读消息。
   */
  constructor(readonly code: string, message: string) {
     super(message); this.name = 'QueueError' }
}
/**
 * 验证消息是普通对象且没有协议外字段，拒绝数组和未知键。
 *
 * @param value 未经验证的 JSON 值，必须是非数组对象。
 * @param keys 当前协议允许出现的字段名白名单。
 */
function queueReadObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => /* 查找不属于当前消息协议的字段。 */  !keys.includes(key))) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.INVALID_QUEUE_MESSAGE_SHAPE)
  return value as Record<string, unknown>
}
/**
 * 校验队列资源身份采用允许版本的 UUID 字符串。
 *
 * @param value 未经验证的资源身份，必须符合允许版本的 UUID 格式。
 */
function queueReadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.INVALID_QUEUE_RESOURCE_IDENTITY)
  return value
}
/**
 * 解析工作通知的版本、部署、图和工作身份，拒绝不受支持的结构。
 *
 * @param value 原始工作通知对象，需验证版本及部署、图、工作身份。
 */
export function queueReadWork(value: unknown): QueueWork {
  const item = queueReadObject(value, ['version', 'deploymentId', 'mapId', 'workId'])
  if (item.version !== 1 || typeof item.workId !== 'string' || !/^[a-zA-Z0-9_:-]{1,256}$/.test(item.workId)) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.UNSUPPORTED_WORK_MESSAGE)
  return { version: 1, deploymentId: queueReadId(item.deploymentId), mapId: queueReadId(item.mapId), workId: item.workId }
}
/**
 * 校验各类变更提示的必填身份与活动载荷，并投影协议允许字段。
 *
 * @param value 原始变更提示对象，需验证种类对应的身份与活动字段。
 */
export function queueReadChange(value: unknown): QueueChange {
  const item = queueReadObject(value, ['version', 'deploymentId', 'kind', 'mapId', 'workspaceId', 'activity', 'holderId'])
  if (item.version !== 1 || !['graph', 'workspace', 'settings', 'access', 'activity'].includes(String(item.kind))) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.UNSUPPORTED_CHANGE_MESSAGE)
  if (item.kind === 'activity' && (!activityIsRecord(item.activity) || item.activity.mapId !== item.mapId || typeof item.holderId !== 'string')) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.INVALID_ACTIVITY)
  if (item.kind !== 'activity' && (item.activity !== undefined || item.holderId !== undefined)) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.UNEXPECTED_ACTIVITY)
  if (item.kind === 'graph' && item.mapId === undefined) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.GRAPH_CHANGE_REQUIRES_MAPID)
  if (item.kind === 'workspace' && item.workspaceId === undefined) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.WORKSPACE_CHANGE_REQUIRES_WORKSPACEID)
  return { version: 1, deploymentId: queueReadId(item.deploymentId), kind: item.kind as QueueChange['kind'],
    ...(item.mapId === undefined ? {} : { mapId: queueReadId(item.mapId) }),
    ...(item.workspaceId === undefined ? {} : { workspaceId: queueReadId(item.workspaceId) }),
    ...(item.kind === 'activity' ? { activity: item.activity as import('../../../contracts/activity').GraphActivity, holderId: queueReadId(item.holderId) } : {}) }
}
/**
 * 限制消息大小后解析 JSON，将语法错误统一为无效消息。
 *
 * @param content broker 投递的原始消息字节，JSON 解码前限制为 8 KiB。
 */
function queueReadJson(content: Buffer): unknown {
  if (content.byteLength > 8192) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.QUEUE_MESSAGE_EXCEEDS_8_KIB)
  try { return JSON.parse(content.toString('utf8')) }
  catch { throw new QueueError('INVALID_MESSAGE', RuntimeMessage.QUEUE_MESSAGE_IS_NOT_JSON) }
}
/**
 * 等待取消信号，已取消时立即完成。
 *
 * @param signal 连接或消费生命周期的取消信号，已取消时立即完成等待。
 */
function queueWaitSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => /* 把取消事件转换为等待 Promise 的完成通知。 */  signal.addEventListener('abort', () => /* 收到取消事件后解除信号等待。 */  resolve(), { once: true }))
}
/**
 * 校验连接配置并声明队列拓扑，返回带发布确认和有界关闭能力的连接。
 *
 * @param config 部署提供的连接 URL 与隔离命名空间，本层验证协议和名称。
 */
export async function queueOpen(config: QueueConfig): Promise<QueueLink> {
  let address: URL
  try { address = new URL(config.url) } catch { throw new QueueError('QUEUE_CONFIG', RuntimeMessage.SET_A_VALID_RABBITMQ_URL) }
  if (!['amqp:', 'amqps:'].includes(address.protocol) || !/^[a-zA-Z0-9_.-]{1,180}$/.test(config.namespace)) throw new QueueError('QUEUE_CONFIG', RuntimeMessage.INVALID_RABBITMQ_PROTOCOL_OR_NAMESPACE)
  if (!address.searchParams.has('heartbeat')) address.searchParams.set('heartbeat', '15')
  const transport = new AbortController()
  let connection: ChannelModel
  const socketOptions = { timeout: 10000, signal: transport.signal }
  try { connection = await connect(address.toString(), socketOptions) }
  catch { transport.abort(); throw new QueueError('QUEUE_UNAVAILABLE', RuntimeMessage.RABBITMQ_CONNECTION_FAILED) }
  const lifetime = new AbortController()
  const disconnected = new Promise<void>(resolve => /* 监听连接关闭，以便资源收尾无需继续等待网络响应。 */  connection.once('close', () => /* 连接实际关闭后通知所有关闭等待者。 */  resolve()))
  const abort = () => /* 将连接错误或关闭转换为统一的生命周期取消。 */  lifetime.abort(new QueueError('QUEUE_DISCONNECTED', RuntimeMessage.RABBITMQ_CONNECTION_CLOSED))
  connection.on('error', abort); connection.on('close', abort)
  const closed = queueWaitSignal(lifetime.signal)
  const deliveries = new Set<Promise<void>>()
  async function queueWaitDeliveries(): Promise<void> {
    // 等待当前连接拥有的全部投递处理器完成；循环覆盖等待期间刚登记的最后一批任务。
    while (deliveries.size) await Promise.allSettled([...deliveries])
  }
  /**
   * 给通道或连接关闭设置上限，超时后强制终止底层传输。
   *
   * @param closeHandle 执行正常关闭握手的操作，超过期限后将取消底层传输。
   */
  async function queueCloseHandle(closeHandle: () => Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      // 启动关闭期限计时器，并保存清理所需的句柄。
      timer = setTimeout(() => {
        // 关闭超时时取消底层传输并解除等待。
         transport.abort(); resolve() }, 1500)
    })
    try { await Promise.race([Promise.resolve().then(closeHandle).catch(() => {
      // 协议关闭失败后继续依靠连接断开或期限完成清理。
    }), disconnected, deadline]) }
    finally { clearTimeout(timer) }
  }
  let closing: Promise<void> | undefined
  const close = () => /* 合并重复关闭请求，使调用者等待同一个收尾过程。 */  closing ??= (async () => {
    // 先取消业务生命周期并关闭连接以停止投递，再等待全部处理器清理，最终终止底层传输。
    abort()
    try {
      await queueCloseHandle(() => /* 向 RabbitMQ 连接发送正常关闭请求。 */  connection.close())
      await queueWaitDeliveries()
    } finally { transport.abort() }
  })()
  const workExchange = config.namespace + '.work-exchange', workQueue = config.namespace + '.work', changeExchange = config.namespace + '.events'
  let publisher: ConfirmChannel
  try {
    publisher = await connection.createConfirmChannel()
    publisher.on('error', abort); publisher.on('close', abort)
    await publisher.assertExchange(workExchange, 'direct', { durable: true })
    await publisher.assertQueue(workQueue, { durable: true, arguments: {
      'x-queue-type': 'quorum', 'x-delivery-limit': -1, 'x-consumer-timeout': 86400000,
    } })
    await publisher.bindQueue(workQueue, workExchange, 'work')
    await publisher.assertExchange(changeExchange, 'fanout', { durable: true })
  } catch { await close(); throw new QueueError('QUEUE_SETUP', RuntimeMessage.RABBITMQ_TOPOLOGY_COULD_NOT_BE_DECLARED) }

  let publishTail: Promise<unknown> = Promise.resolve()
  /**
   * 串行发布经协议校验的消息，并等待 broker 确认及写缓冲恢复。
   *
   * @param message 待发出的工作或变更消息，编码前按对应协议重新验证。
   * @param work 是否使用持久、mandatory 的工作发布规则；false 表示临时广播。
   */
  function publish(message: QueueWork | QueueChange, work: boolean): Promise<void> {
    const data = Buffer.from(JSON.stringify(work ? queueReadWork(message) : queueReadChange(message)))
    const result = publishTail.then(async () => {
      // 为单条消息绑定返回检测、确认期限和取消信号，结束时移除全部监听。
      lifetime.signal.throwIfAborted()
      const messageId = randomUUID()
      let returned = false
      /**
       * 只把本次消息的 mandatory 返回标记为无法路由。
       *
       * @param message 被 broker 退回的消息元数据，仅匹配本次发布的 messageId。
       */
      const onReturn = (message: { properties: { messageId?: string } }) => {
         if (message.properties.messageId === messageId) returned = true }
      publisher.on('return', onReturn)
      const timeout = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, timeout.signal])
      const timer = setTimeout(() => /* 发布确认超时后取消本次等待，触发连接关闭。 */  timeout.abort(new QueueError('QUEUE_CONFIRM_TIMEOUT', RuntimeMessage.RABBITMQ_PUBLISH_WAS_NOT_CONFIRMED)), 15000)
      let abortListener: (() => void) | undefined
      try {
        let accepted = true
        const confirmed = new Promise<void>((resolve, reject) => {
          // 发送带确认回调的消息，并将取消、拒收和无路由结果转换为失败。
          abortListener = () => /* 生命周期取消时以原原因拒绝确认等待。 */  reject(signal.reason)
          signal.addEventListener('abort', abortListener, { once: true })
          accepted = publisher.publish(work ? workExchange : changeExchange, work ? 'work' : '', data,
            { persistent: work, mandatory: work, contentType: 'application/json', messageId },
            error => /* 依据 broker 确认和消息返回情况决定本次发布是否成功。 */  error ? reject(new QueueError('QUEUE_NACK', RuntimeMessage.RABBITMQ_REJECTED_A_PUBLISH))
              : returned ? reject(new QueueError('QUEUE_UNROUTABLE', RuntimeMessage.WORK_MESSAGE_DID_NOT_REACH_A_QUEUE)) : resolve())
        })
        await Promise.all([confirmed, accepted ? Promise.resolve() : once(publisher, 'drain', { signal })])
        signal.throwIfAborted()
      } finally {
        clearTimeout(timer)
        if (abortListener) signal.removeEventListener('abort', abortListener)
        publisher.removeListener('return', onReturn)
        if (timeout.signal.aborted) await close()
      }
    })
    publishTail = result.catch(() => {
      // 消化发布链中的拒绝，使下一次发布仍能进入自身的状态检查。
    })
    return result
  }
  async function openChannel(): Promise<Channel> {
    // 在连接仍有效时创建消费通道，并把通道错误关联到连接生命周期。
    lifetime.signal.throwIfAborted()
    const channel = await connection.createChannel()
    channel.on('error', abort)
    return channel
  }
  return {
    signal: lifetime.signal, closed,
    /**
     * @param message 待发送的持久工作通知，须能路由到工作队列。
     */
    publishWork: message => /* 按持久化工作消息规则发布待领取通知。 */  publish(message, true),
    /**
     * @param message 待广播的临时业务刷新提示，不要求存在订阅者。
     */
    publishChange: message => /* 按变更广播规则发布临时刷新提示。 */  publish(message, false),
    /**
     * 按配置预取并发消费工作，每项独立确认；取消时停止新投递并排空全部处理器。
     *
     * @param handler 处理单次投递的异步业务回调，返回 ack 或 retry。
     * @param stop 可选消费停止信号；取消后等待全部业务处理器收尾。
     * @param options 本消费者的有界并发容量配置。
     */
    async consumeWork(handler, stop, options) {
      const concurrency = workReadConcurrency(options)
      const channel = await openChannel(), local = new AbortController()
      const signal = stop ? AbortSignal.any([lifetime.signal, stop, local.signal]) : AbortSignal.any([lifetime.signal, local.signal])
      let failure: unknown, consumerTag: string | undefined
      try {
        await channel.prefetch(concurrency)
        signal.throwIfAborted()
        const consumer = await channel.consume(workQueue, message => {
          // 接收工作投递，处理 broker 取消通知并启动对应的异步处理。
          if (!message) { local.abort(new QueueError('QUEUE_CONSUMER_CANCELLED', RuntimeMessage.RABBITMQ_CANCELLED_THE_CONSUMER)); return }
          if (signal.aborted) return
          let task: Promise<void>
          task = (async () => {
            // 校验投递载荷，永久丢弃畸形消息，并依业务结果执行 ack 或重入队。
            let notice: QueueWork
            try { notice = queueReadWork(queueReadJson(message.content)) }
            catch {
              channel.reject(message, false)
              return
            }
            const action = await handler(notice, signal)
            if (!signal.aborted) {
              if (action === 'ack') channel.ack(message)
              else channel.nack(message, false, true)
            }
          })().catch(error => {
            // 保存首个处理器异常并取消消费循环，其他在途处理器仍由 finally 全部等待。
             failure ??= error; local.abort(error) }).finally(() => {
            // 从连接级在途集合移除已结束投递，供 close 判断何时真正排空。
             deliveries.delete(task) })
          deliveries.add(task)
        }, { noAck: false })
        consumerTag = consumer.consumerTag
        await queueWaitSignal(signal)
      } finally {
        local.abort()
        if (consumerTag && !lifetime.signal.aborted) await queueCloseHandle(() => /* 在关闭连接前取消当前消费者，阻止接收新投递。 */  channel.cancel(consumerTag!))
        await queueWaitDeliveries()
        await close()
      }
      if (failure) throw failure
      if (!stop?.aborted) throw signal.reason ?? new QueueError('QUEUE_DISCONNECTED', RuntimeMessage.WORK_CONSUMER_ENDED)
    },
    /**
     * 为本连接建立独占广播队列，并返回可重复调用的订阅清理操作。
     *
     * @param handler 同步接收已校验变更的业务回调，抛错将终止连接。
     * @param stop 可选订阅停止信号，触发独占广播通道关闭。
     */
    async subscribeChanges(handler, stop) {
      const channel = await openChannel()
      const subscribed = await channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false })
      await channel.bindQueue(subscribed.queue, changeExchange, '')
      let disposed: Promise<void> | undefined
      const dispose = () => /* 合并重复释放请求，确保订阅通道只执行一次关闭。 */  disposed ??= queueCloseHandle(() => /* 关闭独占广播通道，使其临时队列随连接生命周期回收。 */  channel.close())
      const signal = stop ? AbortSignal.any([lifetime.signal, stop]) : lifetime.signal
      const onAbort = () => {
        // 订阅取消时异步关闭通道。
         void dispose() }
      const consumer = await channel.consume(subscribed.queue, message => {
        // 校验并分发广播提示；丢弃畸形提示，业务处理器异常则终止连接。
        if (!message) { if (!signal.aborted && !disposed) abort(); return }
        if (signal.aborted) return
        let change: QueueChange
        try { change = queueReadChange(queueReadJson(message.content)) }
        catch { return /* malformed display hints cannot change business state */ }
        try { handler(change) }
        catch (error) { lifetime.abort(new QueueError('QUEUE_HANDLER', error instanceof Error ? error.name : RuntimeMessage.CHANGE_HANDLER_FAILED)) }
      }, { noAck: true })
      void consumer
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) await dispose()
      return async () => {
        // 解除取消事件监听并等待订阅通道关闭。
         signal.removeEventListener('abort', onAbort); await dispose() }
    },
    close,
  }
}
/**
 * 将固定队列配置包装为可按部署命名空间打开的工作传输。
 *
 * @param config 固定连接配置，传输实例沿用其 URL 与基础命名空间。
 */
export function queueCreateTransport(config: QueueConfig): WorkTransport {
  return { namespace: config.namespace,
                                        /**
                                         * @param namespace 经应用部署身份组合的最终隔离命名空间。
                                         */
                                        open: namespace => /* 保留连接配置，用调用方确定的命名空间打开队列。 */  queueOpen({ ...config, namespace }) }
}
