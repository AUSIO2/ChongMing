// 消息端口区分工作投递、图变更通知及临时活动；持久化图仍是业务状态依据。
import { RuntimeMessage } from '../../contracts/messages'
import type { GraphActivity } from '../../contracts/activity'
import type { QueueWork, QueueChange } from '../../contracts/events'

export interface WorkConsumeOptions {
  // 同一消费者最多同时交给处理器的工作数；省略时保持单工作串行消费。
  concurrency?: number
}

/**
 * 将消费容量限制为 1..64，避免 adapter 接受无界预取或创建无界任务集合。
 *
 * @param options 调用方给出的消费容量配置，省略时采用兼容默认值 1。
 */
export function workReadConcurrency(options?: WorkConsumeOptions): number {
  const concurrency = options?.concurrency ?? 1
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new RangeError(RuntimeMessage.HOST_CONCURRENCY_MUST_BE_AN_INTEGER_FROM_1_TO_64)
  }
  return concurrency
}

export interface WorkChannel {
  // 通道失效时中止在途工作，具体原因由适配器写入 signal.reason。
  readonly signal: AbortSignal
  // 通道关闭并完成适配器清理后结束的通知。
  readonly closed: Promise<void>
  /**
   * 按容量消费工作并独立确认每项投递；停止后不再投递新项，并等待全部在途处理器清理。
   *
   * @param handler 接收每项投递并返回确认或重投决定的异步处理器。
   * @param stop 结束消费并取消在途投递的可选外部信号。
   * @param options 可选有界并发容量；缺省为 1。
   */
  consumeWork(handler: (message: QueueWork, signal: AbortSignal) => Promise<'ack' | 'retry'>, stop?: AbortSignal, options?: WorkConsumeOptions): Promise<void>
  // 关闭通道并等待适配器拥有的连接与消费资源结束。
  close(): Promise<void>
}
export interface WorkTransport {
  namespace: string;
  /**
   * 为指定部署命名空间建立工作通道，调用方负责在退出或重连时关闭。
   *
   * @param namespace 带部署身份、用于隔离队列资源的完整命名空间。
   */
  open(namespace: string): Promise<WorkChannel>
}
export interface QueueLink extends WorkChannel {
  /**
   * 发布可领取工作的提示，实际可执行性仍由领取时读取的图状态决定。
   *
   * @param message 提示 Host 某项工作可能可领取的队列消息。
   */
  publishWork(message: QueueWork): Promise<void>
  /**
   * 发布图、管理配置或临时活动的变更通知。
   *
   * @param message 需要广播给图或管理订阅者的变更消息。
   */
  publishChange(message: QueueChange): Promise<void>
  /**
   * 订阅部署变更，返回可等待完成的退订操作，并支持外部取消信号。
   *
   * @param handler 接收每条部署变更的同步处理器。
   * @param stop 触发停止订阅的可选取消信号；需要确认清理完成时应等待返回的退订操作。
   */
  subscribeChanges(handler: (message: QueueChange) => void, stop?: AbortSignal): Promise<() => Promise<void>>
}
export interface MessagingService {
  // 准备部署身份及消息服务状态，供随后启动分发循环。
  initialize(): Promise<void>
  // 返回工作 API 对外声明的部署身份、协议版本和队列命名空间。
  messaging(): { version: 1; deploymentId: string; namespace: string; enabled: boolean }
  // 启动后台分发与变更监听，调用方随后负责观察 finished 并在退出时关闭。
  startMessaging(): Promise<void>
  // 等待后台循环结束，并返回服务记录的故障原因。
  finished(): Promise<unknown | undefined>
  // 停止后台分发并释放消息监听及连接资源。
  closeMessaging(): Promise<void>
  /**
   * 注册本进程变更观察者并返回退订函数；null 通知调用方重新同步基线。
   *
   * @param listener 接收本进程变更或重新同步标记的观察者。
   */
  watchChanges(listener: (change: QueueChange | null) => void): () => void
  /**
   * 读取当前缓存的临时活动；消费方仍须重新校验活动对应的租约。
   *
   * @param mapId 需要读取缓存执行活动的图身份。
   */
  readActivities(mapId: string): QueueChange[]
  /**
   * 发布带工作持有者身份的临时活动，租约授权由上游业务服务验证。
   *
   * @param activity 已经过租约校验、准备发布的执行活动。
   * @param holderId 发布活动时持有该工作的 holder 身份，用于消息侧覆盖隔离。
   */
  publishActivity(activity: GraphActivity, holderId: string): Promise<void>
}
