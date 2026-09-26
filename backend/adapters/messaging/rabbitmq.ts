import { RuntimeMessage } from '../../../contracts/messages'
import type { QueueLink, WorkTransport } from '../../ports/messaging'
import { activityIsRecord } from '../../../contracts/activity'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { connect, type Channel, type ConfirmChannel, type ChannelModel } from 'amqplib'
import type { QueueConfig, QueueWork, QueueChange } from '../../../contracts/events'

export class QueueError extends Error {
  // 用途：初始化QueueError实例。
  constructor(readonly code: string, message: string) { super(message); this.name = 'QueueError' }
}
// 用途：读取对象，并把结构化结果交给调用方。
function queueReadObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.INVALID_QUEUE_MESSAGE_SHAPE)
  return value as Record<string, unknown>
}
// 用途：读取标识，并把结构化结果交给调用方。
function queueReadId(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.INVALID_QUEUE_RESOURCE_IDENTITY)
  return value
}
// 用途：读取工作，并把结构化结果交给调用方。
export function queueReadWork(value: unknown): QueueWork {
  const item = queueReadObject(value, ['version', 'deploymentId', 'mapId', 'workId'])
  if (item.version !== 1 || typeof item.workId !== 'string' || !/^[a-zA-Z0-9_:-]{1,256}$/.test(item.workId)) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.UNSUPPORTED_WORK_MESSAGE)
  return { version: 1, deploymentId: queueReadId(item.deploymentId), mapId: queueReadId(item.mapId), workId: item.workId }
}
// 用途：读取变更，并把结构化结果交给调用方。
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
// 用途：读取JSON，并把结构化结果交给调用方。
function queueReadJson(content: Buffer): unknown {
  if (content.byteLength > 8192) throw new QueueError('INVALID_MESSAGE', RuntimeMessage.QUEUE_MESSAGE_EXCEEDS_8_KIB)
  try { return JSON.parse(content.toString('utf8')) }
  catch { throw new QueueError('INVALID_MESSAGE', RuntimeMessage.QUEUE_MESSAGE_IS_NOT_JSON) }
}
// 用途：处理队列消息相关工作，并把结果交给调用方。
function queueWaitSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
}
// 用途：处理队列消息相关工作，并把结果交给调用方。
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
  const disconnected = new Promise<void>(resolve => connection.once('close', () => resolve()))
  const abort = () => lifetime.abort(new QueueError('QUEUE_DISCONNECTED', RuntimeMessage.RABBITMQ_CONNECTION_CLOSED))
  connection.on('error', abort); connection.on('close', abort)
  const closed = queueWaitSignal(lifetime.signal)
  // 用途：关闭队列消息，并释放相关资源。
  async function queueCloseHandle(closeHandle: () => Promise<unknown>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>(resolve => {
      timer = setTimeout(() => { transport.abort(); resolve() }, 1500)
    })
    try { await Promise.race([Promise.resolve().then(closeHandle).catch(() => {}), disconnected, deadline]) }
    finally { clearTimeout(timer) }
  }
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    abort()
    try { await queueCloseHandle(() => connection.close()) } finally { transport.abort() }
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
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  function publish(message: QueueWork | QueueChange, work: boolean): Promise<void> {
    const data = Buffer.from(JSON.stringify(work ? queueReadWork(message) : queueReadChange(message)))
    const result = publishTail.then(async () => {
      lifetime.signal.throwIfAborted()
      const messageId = randomUUID()
      let returned = false
      const onReturn = (message: { properties: { messageId?: string } }) => { if (message.properties.messageId === messageId) returned = true }
      publisher.on('return', onReturn)
      const timeout = new AbortController()
      const signal = AbortSignal.any([lifetime.signal, timeout.signal])
      const timer = setTimeout(() => timeout.abort(new QueueError('QUEUE_CONFIRM_TIMEOUT', RuntimeMessage.RABBITMQ_PUBLISH_WAS_NOT_CONFIRMED)), 15000)
      let abortListener: (() => void) | undefined
      try {
        let accepted = true
        const confirmed = new Promise<void>((resolve, reject) => {
          abortListener = () => reject(signal.reason)
          signal.addEventListener('abort', abortListener, { once: true })
          accepted = publisher.publish(work ? workExchange : changeExchange, work ? 'work' : '', data,
            { persistent: work, mandatory: work, contentType: 'application/json', messageId },
            error => error ? reject(new QueueError('QUEUE_NACK', RuntimeMessage.RABBITMQ_REJECTED_A_PUBLISH))
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
    publishTail = result.catch(() => {})
    return result
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  async function openChannel(): Promise<Channel> {
    lifetime.signal.throwIfAborted()
    const channel = await connection.createChannel()
    channel.on('error', abort)
    return channel
  }
  return {
    signal: lifetime.signal, closed,
    publishWork: message => publish(message, true),
    publishChange: message => publish(message, false),
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async consumeWork(handler, stop) {
      const channel = await openChannel(), local = new AbortController()
      const signal = stop ? AbortSignal.any([lifetime.signal, stop, local.signal]) : AbortSignal.any([lifetime.signal, local.signal])
      let task: Promise<void> = Promise.resolve(), failure: unknown, consumerTag: string | undefined
      try {
        await channel.prefetch(1)
        signal.throwIfAborted()
        const consumer = await channel.consume(workQueue, message => {
          if (!message) { local.abort(new QueueError('QUEUE_CONSUMER_CANCELLED', RuntimeMessage.RABBITMQ_CANCELLED_THE_CONSUMER)); return }
          task = (async () => {
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
          })().catch(error => { failure = error; local.abort(error) })
        }, { noAck: false })
        consumerTag = consumer.consumerTag
        await queueWaitSignal(signal)
      } finally {
        local.abort()
        if (consumerTag && !lifetime.signal.aborted) await queueCloseHandle(() => channel.cancel(consumerTag!))
        await close()
        await task
      }
      if (failure) throw failure
      if (!stop?.aborted) throw signal.reason ?? new QueueError('QUEUE_DISCONNECTED', RuntimeMessage.WORK_CONSUMER_ENDED)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async subscribeChanges(handler, stop) {
      const channel = await openChannel()
      const subscribed = await channel.assertQueue('', { exclusive: true, autoDelete: true, durable: false })
      await channel.bindQueue(subscribed.queue, changeExchange, '')
      let disposed: Promise<void> | undefined
      const dispose = () => disposed ??= queueCloseHandle(() => channel.close())
      const signal = stop ? AbortSignal.any([lifetime.signal, stop]) : lifetime.signal
      const onAbort = () => { void dispose() }
      const consumer = await channel.consume(subscribed.queue, message => {
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
      return async () => { signal.removeEventListener('abort', onAbort); await dispose() }
    },
    close,
  }
}

// 用途：创建队列消息，供后续流程使用。
export function queueCreateTransport(config: QueueConfig): WorkTransport {
  return { namespace: config.namespace, open: namespace => queueOpen({ ...config, namespace }) }
}
