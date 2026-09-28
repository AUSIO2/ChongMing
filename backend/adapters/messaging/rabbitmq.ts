// 文件职责：实现 RabbitMQ 工作队列与变更广播的校验、发布确认、消费确认和连接收尾。
import { RuntimeMessage } from '../../../contracts/messages'
import type { QueueLink, WorkTransport } from '../../ports/messaging'
import { activityIsRecord } from '../../../contracts/activity'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { connect, type Channel, type ConfirmChannel, type ChannelModel } from 'amqplib'
import type { QueueConfig, QueueWork, QueueChange } from '../../../contracts/events'

export class QueueError extends Error {
  constructor(/* 稳定队列错误码，作为只读字段供上层判断重试或终止。 */ readonly code: string, /* 描述队列配置、协议或连接故障的可读消息。 */ message: string) {
    // 创建带稳定错误码的队列异常，供上层区分重连与永久故障。
     super(message); this.name = 'QueueError' }
}
function queueReadObject(/* 未经验证的 JSON 值，必须是非数组对象。 */ value: unknown, /* 当前协议允许出现的字段名白名单。 */ keys: string[]): Record<string, unknown> {
  // 验证消息是普通对象且没有协议外字段，拒绝数组和未知键。
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(/* 消息实际携带的键，用于检测未知字段。 */ key => /* 查找不属于当前消息协议的字段。 */  !keys.includes(key))) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.INVALID_QUEUE_MESSAGE_SHAPE)
  return value as Record<string, unknown>
}
function queueReadId(/* 未经验证的资源身份，必须符合允许版本的 UUID 格式。 */ value: unknown): string {
  // 校验队列资源身份采用允许版本的 UUID 字符串。
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.INVALID_QUEUE_RESOURCE_IDENTITY)
  return value
}
export function queueReadWork(/* 原始工作通知对象，需验证版本及部署、图、工作身份。 */ value: unknown): QueueWork {
  // 解析工作通知的版本、部署、图和工作身份，拒绝不受支持的结构。
  const item = queueReadObject(value, ['version', 'deploymentId', 'mapId', 'workId'])
  if (item.version !== 1 || typeof item.workId !== 'string' || !/^[a-zA-Z0-9_:-]{1,256}$/.test(item.workId)) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.UNSUPPORTED_WORK_MESSAGE)
  return { version: 1, deploymentId: queueReadId(item.deploymentId), mapId: queueReadId(item.mapId), workId: item.workId }
}
export function queueReadChange(/* 原始变更提示对象，需验证种类对应的身份与活动字段。 */ value: unknown): QueueChange {
  // 校验各类变更提示的必填身份与活动载荷，并投影协议允许字段。
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
function queueReadJson(/* broker 投递的原始消息字节，JSON 解码前限制为 8 KiB。 */ content: Buffer): unknown {
  // 限制消息大小后解析 JSON，将语法错误统一为无效消息。
  if (content.byteLength > 8192) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.QUEUE_MESSAGE_EXCEEDS_8_KIB)
  try { return JSON.parse(content.toString('utf8')) }
  catch { throw new QueueError('INVALID_MESSAGE', RuntimeMessage.QUEUE_MESSAGE_IS_NOT_JSON) }
}
function queueWaitSignal(/* 连接或消费生命周期的取消信号，已取消时立即完成等待。 */ signal: AbortSignal): Promise<void> {
  // 等待取消信号，已取消时立即完成。
  if (signal.aborted) return Promise.resolve()
  return new Promise(/* 取消等待的兑现函数，由一次性 abort 监听调用。 */ resolve => /* 把取消事件转换为等待 Promise 的完成通知。 */  signal.addEventListener('abort', () => /* 收到取消事件后解除信号等待。 */  resolve(), { once: true }))
}
export async function queueOpen(/* 部署提供的连接 URL 与隔离命名空间，本层验证协议和名称。 */ config: QueueConfig): Promise<QueueLink> {
  // 校验连接配置并声明队列拓扑，返回带发布确认和有界关闭能力的连接。
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
  const disconnected = new Promise<void>(/* 连接实际关闭后的兑现函数，供收尾竞速等待。 */ resolve => /* 监听连接关闭，以便资源收尾无需继续等待网络响应。 */  connection.once('close', () => /* 连接实际关闭后通知所有关闭等待者。 */  resolve()))
  const abort = () => /* 将连接错误或关闭转换为统一的生命周期取消。 */  lifetime.abort(new QueueError('QUEUE_DISCONNECTED', RuntimeMessage.RABBITMQ_CONNECTION_CLOSED))
  connection.on('error', abort); connection.on('close', abort)
  const closed = queueWaitSignal(lifetime.signal)
  async function queueCloseHandle(/* 执行正常关闭握手的操作，超过期限后将取消底层传输。 */ closeHandle: () => Promise<unknown>) {
    // 给通道或连接关闭设置上限，超时后强制终止底层传输。
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(/* 关闭期限 Promise 的兑现函数，超时强制断开后解除等待。 */ resolve => {
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
    // 先取消业务生命周期，再尝试关闭连接，最终终止底层传输。
    abort()
    try { await queueCloseHandle(() => /* 向 RabbitMQ 连接发送正常关闭请求。 */  connection.close()) } finally { transport.abort() }
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
  function publish(/* 待发出的工作或变更消息，编码前按对应协议重新验证。 */ message: QueueWork | QueueChange, /* 是否使用持久、mandatory 的工作发布规则；false 表示临时广播。 */ work: boolean): Promise<void> {
    // 串行发布经协议校验的消息，并等待 broker 确认及写缓冲恢复。
    const data = Buffer.from(JSON.stringify(work ? queueReadWork(message) : queueReadChange(message)))
    const result = publishTail.then(async () => {
      // 为单条消息绑定返回检测、确认期限和取消信号，结束时移除全部监听。
      lifetime.signal.throwIfAborted()
      const messageId = randomUUID()
      let returned = false
      const onReturn = (/* 被 broker 退回的消息元数据，仅匹配本次发布的 messageId。 */ message: { properties: { messageId?: string } }) => {
        // 只把本次消息的 mandatory 返回标记为无法路由。
         if (message.properties.messageId === messageId) returned = true }
      publisher.on('return', onReturn)
      const timeout = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, timeout.signal])
      const timer = setTimeout(() => /* 发布确认超时后取消本次等待，触发连接关闭。 */  timeout.abort(new QueueError('QUEUE_CONFIRM_TIMEOUT', RuntimeMessage.RABBITMQ_PUBLISH_WAS_NOT_CONFIRMED)), 15000)
      let abortListener: (() => void) | undefined
      try {
        let accepted = true
        const confirmed = new Promise<void>((/* 单条消息确认成功的兑现函数。 */ resolve, /* broker 拒收、不可路由或取消时结束确认等待的拒绝函数。 */ reject) => {
          // 发送带确认回调的消息，并将取消、拒收和无路由结果转换为失败。
          abortListener = () => /* 生命周期取消时以原原因拒绝确认等待。 */  reject(signal.reason)
          signal.addEventListener('abort', abortListener, { once: true })
          accepted = publisher.publish(work ? workExchange : changeExchange, work ? 'work' : '', data,
            { persistent: work, mandatory: work, contentType: 'application/json', messageId },
            /* broker 确认回调中的失败信息；为空时还需检查 mandatory 返回。 */ error => /* 依据 broker 确认和消息返回情况决定本次发布是否成功。 */  error ? reject(new QueueError('QUEUE_NACK', RuntimeMessage.RABBITMQ_REJECTED_A_PUBLISH))
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
    publishWork: /* 待发送的持久工作通知，须能路由到工作队列。 */ message => /* 按持久化工作消息规则发布待领取通知。 */  publish(message, true),
    publishChange: /* 待广播的临时业务刷新提示，不要求存在订阅者。 */ message => /* 按变更广播规则发布临时刷新提示。 */  publish(message, false),
    async consumeWork(/* 处理单次投递的异步业务回调，返回 ack 或 retry。 */ handler, /* 可选消费停止信号；取消后等待当前业务处理器收尾。 */ stop) {
      // 以预取量 1 消费工作，按处理结果确认或重入队，取消时排空当前处理。
      const channel = await openChannel(), local = new AbortController()
      const signal = stop ? AbortSignal.any([lifetime.signal, stop, local.signal]) : AbortSignal.any([lifetime.signal, local.signal])
      let task: Promise<void> = Promise.resolve(), failure: unknown, consumerTag: string | undefined
      try {
        await channel.prefetch(1)
        signal.throwIfAborted()
        const consumer = await channel.consume(workQueue, /* broker 原始工作投递；null 表示 broker 主动取消消费者。 */ message => {
          // 接收工作投递，处理 broker 取消通知并启动对应的异步处理。
          if (!message) { local.abort(new QueueError('QUEUE_CONSUMER_CANCELLED', RuntimeMessage.RABBITMQ_CANCELLED_THE_CONSUMER)); return }
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
          })().catch(/* 业务处理或确认投递时发生的异常，触发本地消费取消。 */ error => {
            // 保存处理器异常并取消消费循环，避免失败被后台 Promise 隐藏。
             failure = error; local.abort(error) })
        }, { noAck: false })
        consumerTag = consumer.consumerTag
        await queueWaitSignal(signal)
      } finally {
        local.abort()
        if (consumerTag && !lifetime.signal.aborted) await queueCloseHandle(() => /* 在关闭连接前取消当前消费者，阻止接收新投递。 */  channel.cancel(consumerTag!))
        await close()
        await task
      }
      if (failure) throw failure
      if (!stop?.aborted) throw signal.reason ?? new QueueError('QUEUE_DISCONNECTED', RuntimeMessage.WORK_CONSUMER_ENDED)
    },
    async subscribeChanges(/* 同步接收已校验变更的业务回调，抛错将终止连接。 */ handler, /* 可选订阅停止信号，触发独占广播通道关闭。 */ stop) {
      // 为本连接建立独占广播队列，并返回可重复调用的订阅清理操作。
      const channel = await openChannel()
      const subscribed = await channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false })
      await channel.bindQueue(subscribed.queue, changeExchange, '')
      let disposed: Promise<void> | undefined
      const dispose = () => /* 合并重复释放请求，确保订阅通道只执行一次关闭。 */  disposed ??= queueCloseHandle(() => /* 关闭独占广播通道，使其临时队列随连接生命周期回收。 */  channel.close())
      const signal = stop ? AbortSignal.any([lifetime.signal, stop]) : lifetime.signal
      const onAbort = () => {
        // 订阅取消时异步关闭通道。
         void dispose() }
      const consumer = await channel.consume(subscribed.queue, /* broker 原始广播投递；null 表示订阅被取消，畸形载荷仅丢弃。 */ message => {
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
export function queueCreateTransport(/* 固定连接配置，传输实例沿用其 URL 与基础命名空间。 */ config: QueueConfig): WorkTransport {
  // 将固定队列配置包装为可按部署命名空间打开的工作传输。
  return { namespace: config.namespace, open: /* 经应用部署身份组合的最终隔离命名空间。 */ namespace => /* 保留连接配置，用调用方确定的命名空间打开队列。 */  queueOpen({ ...config, namespace }) }
}
