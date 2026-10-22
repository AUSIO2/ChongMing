// 通过 Mongo 原生索引查询证据摘要，分页时不读取完整节点快照或固定依据。
import { mongo, type ClientSession, type Connection as MongooseConnection } from 'mongoose'

import { EvidenceMessage, type EvidenceEntrySummary, type EvidenceLibraryEntry } from '../../../../contracts/evidence-library'
import { RuntimeMessage } from '../../../../contracts/messages'
import { evidenceParseUseSummary, type EvidenceUseDocument } from '../../../modules/evidence-library/evidence-usage-record'

import {
  EVIDENCE_COLLECTION,
  EVIDENCE_USES_COLLECTION,
  type EvidenceQueryInput,
  type EvidenceQueryObservation,
  type EvidenceQueryPage,
  type EvidenceQueryPosition,
  type EvidenceQueryStore,
  type EvidenceUsagePosition,
  type EvidenceUsageQueryInput,
  type EvidenceUsageQueryPage,
} from '../../../ports/evidence-query'
import type { StorageSession } from '../../../ports/persistence'

type EvidenceDocument = EvidenceLibraryEntry & {
  _id: string
  dedupKey: string
  fingerprint: string
  tokens: string[]
}

interface ProjectedEntry {
  summary: EvidenceEntrySummary
  position: EvidenceQueryPosition
}

interface QueryPlanObservation {
  indexNames: string[]
  fullWorkspaceScan: boolean
}

enum EvidenceQueryMessage {
  SESSION_INVALID = 'Evidence query requires a live MongoDB storage session.',
  SUMMARY_INVALID = 'Stored evidence summary has invalid fields.',
  EXPLAIN_INVALID = 'MongoDB evidence query did not return a query plan.',
}

const indexes = {
  active: 'evidence_workspace_status_collected',
  all: 'evidence_workspace_collected',
  activeTokens: 'evidence_workspace_status_tokens_collected',
  allTokens: 'evidence_workspace_tokens_collected',
  activeConfidence: 'evidence_workspace_status_confidence_collected',
  allConfidence: 'evidence_workspace_confidence_collected',
  activeSubject: 'evidence_workspace_status_subject_collected',
  allSubject: 'evidence_workspace_subject_collected',
  activeEvent: 'evidence_workspace_status_event_collected',
  allEvent: 'evidence_workspace_event_collected',
  conflicts: 'evidence_workspace_status_fingerprint_confidence',
  activeUses: 'evidence_uses_workspace_entry_current_started',
  allUses: 'evidence_uses_workspace_entry_started',
}

const summaryProjection = {
  _id: 1,
  'claim.nodeSnapshot.payload.content': 1,
  confidence: 1,
  contentDigest: 1,
  status: 1,
  collectedAt: 1,
}

const entrySort: mongo.Sort = { collectedAt: -1, _id: -1 }
const conflictLimit = 32
const useSummaryProjection = { _id: 1, id: 1, workspaceId: 1, ref: 1, consumer: 1, reason: 1,
  kind: 1, runId: 1, operationId: 1, workId: 1, reusedFromOperationId: 1, startedAt: 1, endedAt: 1 }
const useDetailProjection = { ...useSummaryProjection, consumerSnapshot: 1, identityHash: 1, consumerDigest: 1 }
const useSort: mongo.Sort = { startedAt: -1, _id: -1 }

export function createMongoEvidenceQuery(
  /* 已连接的 Mongo 实例；连接和会话的关闭始终由装配入口负责。 */
  connection: MongooseConnection,
  /* 可选真实查询观测接收器；只在提供它时执行额外的查询计划诊断。 */
  observer?: (/* 本次摘要查询的实际返回行数和 Mongo 执行计划。 */ observation: EvidenceQueryObservation) => void,
): EvidenceQueryStore {
  // 绑定现有证据集合，提供稳定索引初始化、摘要分页和相反判断提示。
  const database = connection.db
  if (!database) throw new Error(RuntimeMessage.MONGO_CONNECTION_IS_NOT_READY)
  const entries = database.collection<EvidenceDocument>(EVIDENCE_COLLECTION)
  const usages = database.collection<EvidenceUseDocument>(EVIDENCE_USES_COLLECTION)

  async function initialize(): Promise<void> {
    // 在业务事务之外建立唯一去重键和各筛选路径的排序索引；重复调用沿用已有索引。
    await entries.createIndex({ dedupKey: 1 }, { name: 'evidence_dedup_key', unique: true })
    await entries.createIndex({ workspaceId: 1, status: 1, collectedAt: -1, _id: -1 }, { name: indexes.active })
    await entries.createIndex({ workspaceId: 1, collectedAt: -1, _id: -1 }, { name: indexes.all })
    await entries.createIndex({ workspaceId: 1, status: 1, tokens: 1, collectedAt: -1, _id: -1 }, { name: indexes.activeTokens })
    await entries.createIndex({ workspaceId: 1, tokens: 1, collectedAt: -1, _id: -1 }, { name: indexes.allTokens })
    await entries.createIndex({ workspaceId: 1, status: 1, confidence: 1, collectedAt: -1, _id: -1 }, { name: indexes.activeConfidence })
    await entries.createIndex({ workspaceId: 1, confidence: 1, collectedAt: -1, _id: -1 }, { name: indexes.allConfidence })
    await entries.createIndex({ workspaceId: 1, status: 1, 'applicability.subject': 1, collectedAt: -1, _id: -1 }, { name: indexes.activeSubject })
    await entries.createIndex({ workspaceId: 1, 'applicability.subject': 1, collectedAt: -1, _id: -1 }, { name: indexes.allSubject })
    await entries.createIndex({ workspaceId: 1, status: 1, 'applicability.event': 1, collectedAt: -1, _id: -1 }, { name: indexes.activeEvent })
    await entries.createIndex({ workspaceId: 1, 'applicability.event': 1, collectedAt: -1, _id: -1 }, { name: indexes.allEvent })
    await entries.createIndex({ workspaceId: 1, status: 1, fingerprint: 1, confidence: 1, _id: 1 }, { name: indexes.conflicts })
    await usages.createIndex({ identityHash: 1 }, { name: 'evidence_uses_identity', unique: true })
    await usages.createIndex({ workspaceId: 1, 'ref.entryId': 1, endedAt: 1, startedAt: -1, _id: -1 }, { name: indexes.activeUses })
    await usages.createIndex({ workspaceId: 1, 'ref.entryId': 1, startedAt: -1, _id: -1 }, { name: indexes.allUses })
    await usages.createIndex({ workspaceId: 1, 'consumer.mapId': 1, 'consumer.nodeId': 1, 'consumer.revision': 1, endedAt: 1 },
      { name: 'evidence_uses_current_consumer' })
  }

  async function search(
    /* 已授权的筛选、词项和分页位置；所有过滤在 Mongo 内执行。 */
    input: EvidenceQueryInput,
    /* 可选调用方快照；适配器不会创建、提交或结束该会话。 */
    session?: StorageSession | null,
  ): Promise<EvidenceQueryPage> {
    // 仅解码一页摘要和一条探测行，将是否还有下一页与真实结束位置一起返回。
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new RangeError(EvidenceMessage.QUERY_LIMIT_INVALID)
    }
    const filter = createSearchFilter(input)
    const hint = selectSearchIndex(input)
    const nativeSession = readMongoSession(session)
    const cursor = entries.find<Record<string, unknown>>(filter, {
      session: nativeSession,
      projection: summaryProjection,
      sort: entrySort,
      hint,
      limit: input.limit + 1,
    })
    const rows = await cursor.toArray()
    const hasMore = rows.length > input.limit
    const selected = rows.slice(0, input.limit).map(readProjectedEntry)
    const items = selected.map(
      /* 已校验、只持有正文摘要和排序位置的一行投影。 */
      entry => /* 仅向业务模块交出公共条目摘要。 */ entry.summary,
    )
    const last = selected[selected.length - 1]

    if (observer) {
      // Mongo 不允许事务内 explain；诊断同一查询形状时省略会话，不改变上面的授权事务结果。
      const explanation: unknown = await entries.find(filter, {
        projection: summaryProjection,
        sort: entrySort,
        hint,
        limit: input.limit + 1,
      }).explain('executionStats')
      const plan = readQueryPlanObservation(explanation)
      observer({
        implementation: 'mongo-index',
        indexNames: plan.indexNames,
        returnedRows: items.length,
        // 查询只投影正文单字段和摘要，执行过程中没有解码任何完整库条目。
        materializedRows: 0,
        fullWorkspaceScan: plan.fullWorkspaceScan,
      })
    }

    return { items, hasMore, ...(hasMore && last ? { after: last.position } : {}) }
  }

  async function conflicts(
    /* 已通过业务授权、限定本次冲突提示范围的工作区。 */
    workspaceId: string,
    /* 固定原文与范围共同组成的同文指纹。 */
    fingerprint: string,
    /* 本次收录的相反数字判断，不使用真假值过滤以免丢失 0。 */
    oppositeConfidence: 0 | 1,
    /* 与收录写入保持一致的可选事务快照。 */
    session?: StorageSession | null,
  ): Promise<string[]> {
    // 在冲突专用索引内读取最多 32 个有效相反条目身份，不加载任何固定正文。
    const rows = await entries.find<Record<string, unknown>>({
      workspaceId,
      status: 'active',
      fingerprint,
      confidence: oppositeConfidence,
    }, {
      session: readMongoSession(session),
      projection: { _id: 1 },
      sort: { _id: 1 },
      hint: indexes.conflicts,
      limit: conflictLimit,
    }).toArray()
    return rows.map(
      /* 只投影了 Mongo 字符串条目主键的冲突行。 */
      row => {
        // 验证存储身份，防止损坏记录进入业务冲突提示。
        if (typeof row._id !== 'string') throw new Error(EvidenceQueryMessage.SUMMARY_INVALID)
        return row._id
      },
    )
  }

  async function uses(
    /* 已授权条目、当前/历史筛选及精确倒序分页位置。 */ input: EvidenceUsageQueryInput,
    /* 权限、目录和实际页结果共享的可选调用方事务。 */ session?: StorageSession | null,
  ): Promise<EvidenceUsageQueryPage> {
    // Mongo只读取一页摘要与一条探测行，不解码原消费者正文。
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) throw new RangeError(EvidenceMessage.QUERY_LIMIT_INVALID)
    const filter: mongo.Filter<EvidenceUseDocument> = { workspaceId: input.workspaceId, 'ref.entryId': input.entryId }
    if (!input.includeHistory) filter.endedAt = null
    if (input.after) filter.$or = [
      { startedAt: { $lt: input.after.startedAt } },
      { startedAt: input.after.startedAt, _id: { $lt: input.after.id } },
    ]
    const hint = input.includeHistory ? indexes.allUses : indexes.activeUses
    const options = { projection: useSummaryProjection, sort: useSort, hint, limit: input.limit + 1 }
    const rows = await usages.find<Record<string, unknown>>(filter, { ...options, session: readMongoSession(session) }).toArray()
    const hasMore = rows.length > input.limit
    const items = rows.slice(0, input.limit).map((/* 只含公共轻量字段的实际Mongo投影。 */ row) => {
      // 摘要和排序身份必须一致，坏投影不返回给业务模块。
      const summary = evidenceParseUseSummary(row)
      if (summary.id !== row._id || summary.workspaceId !== input.workspaceId || summary.ref.entryId !== input.entryId) {
        throw new Error(EvidenceQueryMessage.SUMMARY_INVALID)
      }
      return summary
    })
    const last = items[items.length - 1]
    const after: EvidenceUsagePosition | undefined = hasMore && last ? { startedAt: last.startedAt, id: last.id } : undefined
    if (observer) {
      // 同形状的原生诊断不进入事务，也不改变授权事务内已读取的结果。
      const explanation: unknown = await usages.find(filter, options).explain('executionStats')
      const plan = readQueryPlanObservation(explanation)
      observer({ implementation: 'mongo-index', indexNames: plan.indexNames, returnedRows: items.length,
        materializedRows: 0, fullWorkspaceScan: plan.fullWorkspaceScan })
    }
    return { items, hasMore, ...(after ? { after } : {}) }
  }

  async function use(
    /* 已取得查看权限的工作区。 */ workspaceId: string,
    /* 必须绑定的库条目身份。 */ entryId: string,
    /* 明确需要读取的历史使用UUID。 */ usageId: string,
    /* 查看权限和条目读取共享的可选事务会话。 */ session?: StorageSession | null,
  ): Promise<unknown | null> {
    // 主键精确读取原消费者记录，不枚举历史或读取当前目标Map正文。
    return usages.findOne({ _id: usageId, workspaceId, 'ref.entryId': entryId },
      { projection: useDetailProjection, session: readMongoSession(session) })
  }

  return { initialize, search, conflicts, uses, use }
}

function readMongoSession(
  /* Persistence 交出的可选存储会话，必须来自 Mongo 驱动且尚未关闭。 */
  session?: StorageSession | null,
): ClientSession | undefined {
  // 在适配器边界验证真实驱动会话，避免把其他存储实现的会话强制转换后传入 Mongo。
  if (!session) return undefined
  if (!(session instanceof mongo.ClientSession) || session.hasEnded) {
    throw new Error(EvidenceQueryMessage.SESSION_INVALID)
  }
  return session
}

function createSearchFilter(
  /* 已归一化的工作区、词项、精确范围和上一页结束位置。 */
  input: EvidenceQueryInput,
): mongo.Filter<EvidenceDocument> {
  // 将库筛选和倒序游标组合为数据库条件，不用 offset 或内存内过滤。
  const filter: mongo.Filter<EvidenceDocument> = { workspaceId: input.workspaceId }
  if (input.matchNone) filter._id = { $in: [] }
  if (!input.includeInactive) filter.status = 'active'
  if (input.queryTokens.length > 0) filter.tokens = { $all: [...input.queryTokens] }
  if (input.confidence !== undefined) filter.confidence = input.confidence
  if (input.subject !== undefined) filter['applicability.subject'] = input.subject
  if (input.event !== undefined) filter['applicability.event'] = input.event
  if (input.after) {
    filter.$or = [
      { collectedAt: { $lt: input.after.collectedAt } },
      { collectedAt: input.after.collectedAt, _id: { $lt: input.after.id } },
    ]
  }
  return filter
}

function selectSearchIndex(
  /* 决定查询使用词项、范围或普通目录路径的已归一化筛选条件。 */
  input: EvidenceQueryInput,
): string {
  // 优先用词项和精确范围的索引，防止关键词页只按整个工作区目录逐条试读。
  if (input.queryTokens.length > 0) return input.includeInactive ? indexes.allTokens : indexes.activeTokens
  if (input.subject !== undefined) return input.includeInactive ? indexes.allSubject : indexes.activeSubject
  if (input.event !== undefined) return input.includeInactive ? indexes.allEvent : indexes.activeEvent
  if (input.confidence !== undefined) return input.includeInactive ? indexes.allConfidence : indexes.activeConfidence
  return input.includeInactive ? indexes.all : indexes.active
}

function readProjectedEntry(
  /* 从 Mongo 摘要白名单投影解码的原始字段，未把泛型视为运行时校验。 */
  row: Record<string, unknown>,
): ProjectedEntry {
  // 校验存储投影的必要字段，把正文单字段与排序位置转换为可信摘要。
  const claim = readStoredObject(row.claim)
  const snapshot = readStoredObject(claim.nodeSnapshot)
  const payload = readStoredObject(snapshot.payload)
  if (typeof row._id !== 'string' || typeof payload.content !== 'string'
    || (row.confidence !== 0 && row.confidence !== 1) || typeof row.contentDigest !== 'string'
    || (row.status !== 'active' && row.status !== 'withdrawn' && row.status !== 'superseded')
    || typeof row.collectedAt !== 'string' || !Number.isFinite(Date.parse(row.collectedAt))) {
    throw new Error(EvidenceQueryMessage.SUMMARY_INVALID)
  }
  return {
    summary: { id: row._id, content: payload.content, confidence: row.confidence, contentDigest: row.contentDigest, status: row.status },
    position: { collectedAt: row.collectedAt, id: row._id },
  }
}

function readStoredObject(
  /* Mongo 投影中的未知嵌套值，必须是普通字段对象才能继续读取。 */
  value: unknown,
): Record<string, unknown> {
  // 在进入嵌套字段前排除缺失、数组和非对象，损坏的库记录直接报告存储错误。
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(EvidenceQueryMessage.SUMMARY_INVALID)
  }
  return value as Record<string, unknown>
}

function readQueryPlanObservation(
  /* 原生 Mongo explain 返回的诊断文档，仅分析实际胜出的计划与执行树。 */
  explanation: unknown,
): QueryPlanObservation {
  // 从真实计划提取索引名称和全表扫描阶段，不计入被优化器拒绝的候选计划。
  const root = readStoredObject(explanation)
  const queryPlanner = readStoredObject(root.queryPlanner)
  if (queryPlanner.winningPlan === undefined) throw new Error(EvidenceQueryMessage.EXPLAIN_INVALID)
  const indexNames = new Set<string>()
  let fullWorkspaceScan = false

  function visitPlan(
    /* 胜出计划或执行树中的一个未知节点，可包含分片、SBE 或传统引擎子节点。 */
    value: unknown,
  ): void {
    // 遍历已选计划，记录实际索引与 COLLSCAN，不把 explain 中的拒绝候选误报为执行。
    if (Array.isArray(value)) {
      for (const child of value) visitPlan(child)
      return
    }
    if (typeof value !== 'object' || value === null) return
    const node = value as Record<string, unknown>
    if (typeof node.indexName === 'string') indexNames.add(node.indexName)
    if (node.stage === 'COLLSCAN') fullWorkspaceScan = true
    for (const [key, child] of Object.entries(node)) {
      if (key !== 'rejectedPlans' && key !== 'allPlansExecution') visitPlan(child)
    }
  }

  visitPlan(queryPlanner.winningPlan)
  if (typeof root.executionStats === 'object' && root.executionStats !== null) {
    const execution = readStoredObject(root.executionStats)
    visitPlan(execution.executionStages)
  }
  return { indexNames: [...indexNames].sort(), fullWorkspaceScan }
}
