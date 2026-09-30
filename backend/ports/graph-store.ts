// 图存储端口统一图文档、版本提交及工作租约，具体时钟和事务由适配器实现。
import type { GraphBranchLeaseProof, GraphMapSummary, GraphRunControlProof, GraphWork, GraphWorkGrant, GraphWorkProof } from '../../contracts/graph'
import type { GraphDocument, GraphOwnershipReceipt, GraphOwnershipRecord, GraphReceipt } from '../modules/graph/graph-record'

export interface GraphCommitGuard {
  ownershipRevision: number
  editor?: GraphBranchLeaseProof & { ownerUserId: string }
  runId?: string
  control?: GraphRunControlProof & { ownerUserId: string; runId: string }
}

export interface GraphStore {
  // 准备适配器所需的索引或存储结构，完成后才能提供图服务。
  initialize(): Promise<void>
  /**
   * 创建新图并标记待分发；图身份已存在时返回 false。
   *
   * @param document 尚未持久化、身份唯一的新图文档。
   */
  create(document: GraphDocument): Promise<boolean>
  /**
   * 读取包含收据和租约的持久化图；逻辑删除的记录仍可用于确认既有请求。
   *
   * @param mapId 需要读取的图身份。
   */
  read(mapId: string): Promise<GraphDocument | null>
  // 枚举仍在运行且未暂停的图，供启动或重连时补偿发现工作。
  discover(): AsyncGenerator<GraphDocument>
  /**
   * 返回指定租约距离到期还需等待的毫秒数，无有效等待期时返回零。
   *
   * @param mapId 持有或等待租约的图身份。
   * @param workId 需要查询剩余等待时间的工作身份。
   */
  readLeaseDelay(mapId: string, workId: string): Promise<number>
  // 枚举待发布的图变更，并返回用于确认该次发布的分发版本。
  readDispatch(): AsyncGenerator<GraphDocument & { dispatchVersion: number }>
  /**
   * 仅在分发版本仍匹配时清除待发布标记，避免覆盖并发提交产生的新通知。
   *
   * @param mapId 已发布通知所属的图身份。
   * @param version 发布者观察到并准备确认的分发版本。
   */
  clearDispatch(mapId: string, version: number): Promise<boolean>
  /**
   * 按图版本领取无租约或租约已到期的工作，成功时递增 fence 并返回新授权。
   *
   * @param document 领取前读取的图快照，用于版本条件比较。
   * @param work 根据该图快照推导出的待执行工作。
   * @param hostId 申请领取工作的 Host 身份。
   * @param holderId 本次领取尝试生成的独立持有者身份。
   * @param leaseMs 新租约从存储时钟起计算的有效毫秒数。
   */
  claim(document: GraphDocument, work: GraphWork, hostId: string, holderId: string, leaseMs: number): Promise<GraphWorkGrant | null>
  /**
   * 校验 holder/fence、存储时钟期限和当前 Run 状态，返回授权仍有效的图。
   *
   * @param mapId 需要验证租约的图身份。
   * @param proof 必须匹配当前 holder 和 fence 的工作证明。
   */
  readLease(mapId: string, proof: GraphWorkProof): Promise<GraphDocument | null>
  /**
   * 只延长尚未失效且身份匹配的租约，失效或被接管时返回 null。
   *
   * @param mapId 需要续租的图身份。
   * @param proof 必须仍处于有效期内的工作证明。
   */
  renew(mapId: string, proof: GraphWorkProof): Promise<GraphWorkGrant | null>
  /**
   * 使匹配 holder/fence 的租约立即到期，保留授权身份供接管和结果确认。
   *
   * @param mapId 需要释放租约的图身份。
   * @param proof 只允许释放相同 holder 和 fence 的工作证明。
   */
  release(mapId: string, proof: GraphWorkProof): Promise<boolean>
  /**
   * 列出指定工作区中未删除图的摘要；用户权限由调用方先行检查。
   *
   * @param workspaceId 需要列出未删除图的工作区身份。
   */
  list(workspaceId: string): Promise<GraphMapSummary[]>
  /**
   * 只更新分支占有状态和独立协调版本；内容 revision 不变，仍通过 dispatch 唤醒实时订阅。
   *
   * @param mapId 图身份。
   * @param expectedRevision 读取 scope 时的内容版本。
   * @param expectedOwnershipRevision 读取占有时的协调版本。
   * @param ownerships 完整替换的新占有字典。
   * @param receipt 幂等占有收据。
   */
  commitOwnership(mapId: string, expectedRevision: number,
    expectedOwnershipRevision: number, ownerships: Record<string, GraphOwnershipRecord>,
    receipt: GraphOwnershipReceipt): Promise<boolean>
  // 原子校验存储串行版本与可选完整租约，提交图、收据和分发标记；false 后只能基于重新读取的文档重放局部变化，不能给旧草稿换一个新版本号后盲写。
  /**
   * revision 是整文档的物理 CAS token；节点/边 revision 或其分支摘要才是业务并发域。这样服务层可在不相交分支变化后安全重放，同时仍由存储层串行化最终写入。
   *
   * @param document 包含业务变更但尚未推进持久化版本的图草稿；其 revision 必须等于 expectedRevision。
   * @param expectedRevision 生成该草稿的同一图快照版本。
   * @param receipt 与图状态一起原子追加的幂等收据。
   * @param grant 执行结果提交时必须完整匹配持久授权和当前冻结阶段的可选租约。
   * @param guard 分支占有最终写条件。
   */
  commit(document: GraphDocument, expectedRevision: number, receipt: GraphReceipt, grant?: GraphWorkGrant, guard?: GraphCommitGuard): Promise<boolean>
}
