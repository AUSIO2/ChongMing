// 定义证据库摘要和冲突身份的有界查询，不承担授权或固定内容写入。
import type { EvidenceEntrySummary, EvidenceUseSummary } from '../../contracts/evidence-library'

import type { StorageSession } from './persistence'

export const EVIDENCE_COLLECTION = 'evidence_entries'
export const EVIDENCE_USES_COLLECTION = 'evidence_uses'

export interface EvidenceUsagePosition { readonly startedAt: string; readonly id: string }
export interface EvidenceUsageQueryInput {
  readonly workspaceId: string
  readonly entryId: string
  readonly includeHistory: boolean
  readonly after?: EvidenceUsagePosition
  readonly limit: number
}
export interface EvidenceUsageQueryPage {
  items: EvidenceUseSummary[]
  after?: EvidenceUsagePosition
  hasMore: boolean
}

export interface EvidenceQueryPosition {
  readonly collectedAt: string
  readonly id: string
}

export interface EvidenceQueryInput {
  readonly workspaceId: string
  readonly queryTokens: readonly string[]
  // 非空查询没有可索引词项时明确不匹配，区别于未指定关键词的库浏览。
  readonly matchNone?: boolean
  readonly confidence?: 0 | 1
  readonly subject?: string
  readonly event?: string
  readonly includeInactive: boolean
  readonly after?: EvidenceQueryPosition
  readonly limit: number
}

export interface EvidenceQueryPage {
  items: EvidenceEntrySummary[]
  after?: EvidenceQueryPosition
  hasMore: boolean
}

export interface EvidenceQueryObservation {
  implementation: 'mongo-index' | 'sqlite-index'
  indexNames: string[]
  returnedRows: number
  // 仅统计解码的完整库条目；摘要投影和服务端索引扫描不计入此数。
  materializedRows: number
  fullWorkspaceScan: boolean
}

export interface EvidenceQueryStore {
  // 幂等建立业务去重与有界查询索引；须在提供查询服务前调用，不在业务事务中执行。
  initialize(): Promise<void>
  /**
   * 在数据库内筛选、按 collectedAt 和条目身份倒序分页，最多返回 limit 条摘要。
   * 词项采用全部匹配，范围字段采用精确匹配；includeInactive 为 false 时只查 active。
   * matchNone 为 true 时必须返回空页，不将无词项的非空查询解释成整库浏览。
   * hasMore 为 true 时 after 是本页最后一条摘要的位置，否则省略 after。
   * 调用方先完成工作区授权、词项归一化和游标绑定；此端口不验证成员或目录版本。
   * 会话由调用方拥有，查询不提交或结束它；并发读取互不持有进程内分页状态。
   * limit 必须为 1 至 100 的整数；无效边界、损坏的存储投影及驱动故障会抛出错误。
   * 未另设取消所有者，数据库请求的超时和资源关闭沿用适配器连接配置。
   */
  search(
    /* 已授权并归一化的筛选条件，以及目录游标中的上一页结束位置。 */
    input: EvidenceQueryInput,
    /* 与授权和目录读取共享的可选事务会话；省略或 null 表示普通读取。 */
    session?: StorageSession | null,
  ): Promise<EvidenceQueryPage>
  /**
   * 返回同工作区、同固定正文与范围指纹、相反判断的 active 条目身份，最多 32 条。
   * 结果按条目身份稳定排序；仅用于冲突提示，不改写、撤回或合并任何条目。
   * 工作区授权由调用方保证，会话归属和错误行为与 search 一致。
   */
  conflicts(
    /* 已通过当前调用身份授权的证据工作区。 */
    workspaceId: string,
    /* 业务模块从固定正文和适用范围计算出的同文指纹。 */
    fingerprint: string,
    /* 与本次收录判断相反的数字 0 或 1。 */
    oppositeConfidence: 0 | 1,
    /* 让冲突提示与新收录共享同一事务快照的可选会话。 */
    session?: StorageSession | null,
  ): Promise<string[]>
  /**
   * 在 Mongo 内按工作区、库条目和当前/历史状态筛选，依 startedAt/_id 倒序返回最多 limit 条轻量摘要。
   * limit为1..100；授权和使用目录游标由调用方拥有。结果不得携带consumerSnapshot或解码全库材料。
   * 会话沿用调用方事务；hasMore时after绑定本页末行，否则省略。错误及连接资源责任与search一致。
   */
  uses(
    /* 已授权的库身份、历史开关及有界分页位置。 */ input: EvidenceUsageQueryInput,
    /* 与查看权限和使用目录版本共用的事务会话。 */ session?: StorageSession | null,
  ): Promise<EvidenceUsageQueryPage>
  /**
   * 按工作区/条目/使用身份读取单条历史记录投影，保留消费者快照；不存在或身份不匹配返回null。
   * 返回unknown由库模块建立固定历史不变量，不将驱动泛型当作内容校验；会话及资源规则与uses一致。
   */
  use(
    /* 已授权读取的工作区。 */ workspaceId: string,
    /* 使用记录必须指向的库条目。 */ entryId: string,
    /* 需要读取原消费者快照的使用UUID。 */ usageId: string,
    /* 由调用方拥有的只读事务会话。 */ session?: StorageSession | null,
  ): Promise<unknown | null>
}
