// 持久化端口分开提供结构化记录、事务、图存储和不可变附件字节。
import type { Readable } from 'node:stream'
import type { GraphStore } from './graph-store'

export interface StorageSession {
  // 判断该会话当前是否处于活动事务，供需要授权事务的操作验证前置条件。
  inTransaction(): boolean
}
export type RecordFilter = Record<string, string | number | boolean | null | string[]>
export interface StorageRecords<T extends { _id: string }> {
  // 按主键读取记录；传入会话时沿用调用方事务。
  get(/* 需要读取的记录主键。 */ id: string, /* 限定本次读取快照和事务归属的可选会话。 */ session?: StorageSession | null): Promise<T | null>
  // 返回首个匹配筛选条件的记录，未找到时返回 null。
  first(/* 用于匹配字段值的记录筛选条件。 */ filter: RecordFilter, /* 限定本次读取快照和事务归属的可选会话。 */ session?: StorageSession | null): Promise<T | null>
  // 统计当前会话可见且满足筛选条件的记录数。
  count(/* 可选记录筛选条件；省略时统计整个命名空间。 */ filter?: RecordFilter, /* 限定本次统计快照和事务归属的可选会话。 */ session?: StorageSession | null): Promise<number>
  // 读取当前会话可见的匹配记录；排序与分页由业务服务另行完成。
  list(/* 可选记录筛选条件；省略时列出整个命名空间。 */ filter?: RecordFilter, /* 限定本次读取快照和事务归属的可选会话。 */ session?: StorageSession | null): Promise<T[]>
  // 插入新记录；重复主键及其他约束错误由适配器抛出。
  insert(/* 带唯一主键、准备插入的完整记录。 */ document: T, /* 让插入参与调用方事务的可选会话。 */ session?: StorageSession | null): Promise<void>
  // 按记录主键替换持久化内容，事务归属与调用方传入会话一致。
  replace(/* 按同一主键覆盖现有值的完整记录。 */ document: T, /* 让替换参与调用方事务的可选会话。 */ session?: StorageSession | null): Promise<void>
  // 在事务中读取并调用更新函数，返回 null 表示记录缺失或更新被回调拒绝。
  change(/* 需要原子读取并条件修改的记录主键。 */ id: string, /* 根据当前记录返回替换值，返回 null 表示拒绝本次更新的回调。 */ update: (/* 当前持久化记录的独立副本或事务视图。 */ document: T) => T | null, /* 让条件修改参与调用方事务的可选会话。 */ session?: StorageSession | null): Promise<T | null>
  // 声明字段索引及唯一性选项，由具体适配器建立对应存储约束。
  index(/* 按顺序组成索引键的字段路径。 */ fields: string[], /* 控制索引唯一性和空字段处理的可选设置。 */ options?: { unique?: boolean; sparse?: boolean }): Promise<void>
}
export interface StorageBlobs {
  // 消费字节流并写入附件存储，返回附件字节的独立存储身份。
  write(/* 由调用方拥有、写入完成前必须持续可读的字节流。 */ source: AsyncIterable<Uint8Array>, /* 用于诊断或下载展示的原始文件名。 */ filename: string): Promise<string>
  // 打开附件字节流；调用方负责消费完毕或销毁读取流。
  read(/* 需要打开读取流的附件存储身份。 */ id: string): Readable
  // 移除指定附件字节，返回是否实际删除了对象。
  remove(/* 需要从附件存储移除的字节对象身份。 */ id: string): Promise<boolean>
}
export interface Persistence {
  // 获取指定集合或命名空间的记录访问器，不在此处执行用户权限检查。
  records<T extends { _id: string }>(/* 记录集合或逻辑命名空间名称。 */ name: string): StorageRecords<T>
  // 在同一事务中执行回调并提交结果，失败时回滚；回调应避免无法回滚的外部副作用。
  transaction<T>(/* 在同一存储事务中执行授权和业务访问的回调。 */ callback: (/* 只在当前回调有效、不能跨事务保存的会话。 */ session: StorageSession) => Promise<T>): Promise<T>
  // 准备持久化适配器，供身份服务及各业务模块初始化使用。
  initialize(): Promise<void>
  // 返回存储端当前时间的 Unix 毫秒值，用于令牌时效等持久化判定。
  now(): Promise<number>
  // 获取与可选事务会话绑定的图存储访问器。
  graph(/* 将返回的图存储绑定到调用方现有事务的可选会话。 */ session?: StorageSession | null): GraphStore
  blobs: StorageBlobs
}

export interface StorageChange { table: string; id: string }
export interface PersistenceEvents {
  // 订阅已提交记录的变更批次，返回解除本次订阅的函数。
  subscribe(/* 接收每批已提交记录变更的同步观察者。 */ listener: (/* 同一次提交产生的记录变更集合。 */ changes: StorageChange[]) => void): () => void
}
