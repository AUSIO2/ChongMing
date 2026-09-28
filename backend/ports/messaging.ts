// 消息端口区分工作投递、图变更通知及临时活动；持久化图仍是业务状态依据。
import type { GraphActivity } from '../../contracts/activity'
import type { QueueWork, QueueChange } from '../../contracts/events'

export interface WorkChannel {
  // 通道失效时中止在途工作，具体原因由适配器写入 signal.reason。
  readonly signal: AbortSignal
  // 通道关闭并完成适配器清理后结束的通知。
  readonly closed: Promise<void>
  // 消费工作并等待处理器给出确认或重投决定；stop 用于结束消费并取消活动投递。
  consumeWork(/* 接收每项投递并返回确认或重投决定的异步处理器。 */ handler: (/* 当前队列投递的工作线索。 */ message: QueueWork, /* 队列通道失效或消费停止时取消当前投递的信号。 */ signal: AbortSignal) => Promise<'ack' | 'retry'>, /* 结束消费并取消在途投递的可选外部信号。 */ stop?: AbortSignal): Promise<void>
  // 关闭通道并等待适配器拥有的连接与消费资源结束。
  close(): Promise<void>
}
export interface WorkTransport {
  namespace: string;
  // 为指定部署命名空间建立工作通道，调用方负责在退出或重连时关闭。
  open(/* 带部署身份、用于隔离队列资源的完整命名空间。 */ namespace: string): Promise<WorkChannel>
}
export interface QueueLink extends WorkChannel {
  // 发布可领取工作的提示，实际可执行性仍由领取时读取的图状态决定。
  publishWork(/* 提示 Host 某项工作可能可领取的队列消息。 */ message: QueueWork): Promise<void>
  // 发布图、管理配置或临时活动的变更通知。
  publishChange(/* 需要广播给图或管理订阅者的变更消息。 */ message: QueueChange): Promise<void>
  // 订阅部署变更，返回可等待完成的退订操作，并支持外部取消信号。
  subscribeChanges(/* 接收每条部署变更的同步处理器。 */ handler: (/* 当前从变更通道收到的消息。 */ message: QueueChange) => void, /* 触发停止订阅的可选取消信号；需要确认清理完成时应等待返回的退订操作。 */ stop?: AbortSignal): Promise<() => Promise<void>>
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
  // 注册本进程变更观察者并返回退订函数；null 通知调用方重新同步基线。
  watchChanges(/* 接收本进程变更或重新同步标记的观察者。 */ listener: (/* 当前变更消息；null 表示订阅者必须重新读取基线。 */ change: QueueChange | null) => void): () => void
  // 读取当前缓存的临时活动；消费方仍须重新校验活动对应的租约。
  readActivities(/* 需要读取缓存执行活动的图身份。 */ mapId: string): QueueChange[]
  // 发布带工作持有者身份的临时活动，租约授权由上游业务服务验证。
  publishActivity(/* 已经过租约校验、准备发布的执行活动。 */ activity: GraphActivity, /* 发布活动时持有该工作的 holder 身份，用于消息侧覆盖隔离。 */ holderId: string): Promise<void>
}
