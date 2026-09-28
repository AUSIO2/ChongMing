// 图存储端口统一图文档、版本提交及工作租约，具体时钟和事务由适配器实现。
import type { GraphMapSummary, GraphWork, GraphWorkGrant, GraphWorkProof } from '../../contracts/graph'
import type { GraphDocument, GraphReceipt } from '../modules/graph/graph-record'

export interface GraphStore {
  // 准备适配器所需的索引或存储结构，完成后才能提供图服务。
  initialize(): Promise<void>
  // 创建新图并标记待分发；图身份已存在时返回 false。
  create(/* 尚未持久化、身份唯一的新图文档。 */ document: GraphDocument): Promise<boolean>
  // 读取包含收据和租约的持久化图；逻辑删除的记录仍可用于确认既有请求。
  read(/* 需要读取的图身份。 */ mapId: string): Promise<GraphDocument | null>
  // 枚举仍在运行且未暂停的图，供启动或重连时补偿发现工作。
  discover(): AsyncGenerator<GraphDocument>
  // 返回指定租约距离到期还需等待的毫秒数，无有效等待期时返回零。
  readLeaseDelay(/* 持有或等待租约的图身份。 */ mapId: string, /* 需要查询剩余等待时间的工作身份。 */ workId: string): Promise<number>
  // 枚举待发布的图变更，并返回用于确认该次发布的分发版本。
  readDispatch(): AsyncGenerator<GraphDocument & { dispatchVersion: number }>
  // 仅在分发版本仍匹配时清除待发布标记，避免覆盖并发提交产生的新通知。
  clearDispatch(/* 已发布通知所属的图身份。 */ mapId: string, /* 发布者观察到并准备确认的分发版本。 */ version: number): Promise<boolean>
  // 按图版本领取无租约或租约已到期的工作，成功时递增 fence 并返回新授权。
  claim(/* 领取前读取的图快照，用于版本条件比较。 */ document: GraphDocument, /* 根据该图快照推导出的待执行工作。 */ work: GraphWork, /* 申请领取工作的 Host 身份。 */ hostId: string, /* 本次领取尝试生成的独立持有者身份。 */ holderId: string, /* 新租约从存储时钟起计算的有效毫秒数。 */ leaseMs: number): Promise<GraphWorkGrant | null>
  // 校验 holder/fence、存储时钟期限和当前 Run 状态，返回授权仍有效的图。
  readLease(/* 需要验证租约的图身份。 */ mapId: string, /* 必须匹配当前 holder 和 fence 的工作证明。 */ proof: GraphWorkProof): Promise<GraphDocument | null>
  // 只延长尚未失效且身份匹配的租约，失效或被接管时返回 null。
  renew(/* 需要续租的图身份。 */ mapId: string, /* 必须仍处于有效期内的工作证明。 */ proof: GraphWorkProof): Promise<GraphWorkGrant | null>
  // 使匹配 holder/fence 的租约立即到期，保留授权身份供接管和结果确认。
  release(/* 需要释放租约的图身份。 */ mapId: string, /* 只允许释放相同 holder 和 fence 的工作证明。 */ proof: GraphWorkProof): Promise<boolean>
  // 列出指定工作区中未删除图的摘要；用户权限由调用方先行检查。
  list(/* 需要列出未删除图的工作区身份。 */ workspaceId: string): Promise<GraphMapSummary[]>
  // 原子校验版本与可选租约，提交图、收据和分发标记；暂停必须沿用授权事务并撤销租约。
  commit(/* 包含业务变更但尚未推进持久化版本的图草稿。 */ document: GraphDocument, /* 调用方读取草稿时观察到的图版本。 */ expectedRevision: number, /* 与图状态一起原子追加的幂等收据。 */ receipt: GraphReceipt, /* 执行结果提交时必须在最终写入处匹配的可选租约授权。 */ grant?: GraphWorkGrant): Promise<boolean>
}
