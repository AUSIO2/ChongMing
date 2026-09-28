// 文件职责：提供显式新闻上下文修复和旧版单 Operation Run 的离线事务迁移。
import { RuntimeMessage, messageFormat } from '../../../../contracts/messages'
import type { Connection } from 'mongoose'
import type { GraphOperation, GraphRun } from '../../../../contracts/graph'
import { configurationRead, configurationReadSlots } from '../../../modules/workspace/agent-configuration'
import { GraphError } from '../../../modules/shared/domain-error'
import { inputReadArray, inputReadNames, inputReadObject, inputReadRevision, inputReadScore, inputReadString } from '../../../modules/shared/input-validation'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../../../modules/graph/graph-record'

/** Explicit repair for empty News contexts omitted by pre-056 Mongoose serialization. */
export async function repairUpdateNewsContext(/* 管理员显式提供的 Mongo 连接，修复只操作该库的图集合。 */ connection: Connection, /* 是否真正写回修复；默认 false 仅统计匹配图数量。 */ apply = false) {
  // 统计缺失新闻上下文的图，仅在显式应用时补空对象并推进图版本。
  const graphs = connection.collection(GRAPH_COLLECTION)
  const filter = { deletedAt: { $exists: false }, nodes: { $elemMatch: { 'data.kind': 'news', 'data.context': { $exists: false } } } }
  const matchedMaps = await graphs.countDocuments(filter)
  if (!apply || !matchedMaps) return { matchedMaps, modifiedMaps: 0 }
  const result = await graphs.updateMany(filter, [{ $set: {
    nodes: { $map: { input: '$nodes', as: 'node', in: { $cond: [
      { $and: [{ $eq: ['$$node.data.kind', 'news'] }, { $eq: [{ $type: '$$node.data.context' }, 'missing'] }] },
      { $mergeObjects: ['$$node', { data: { $mergeObjects: ['$$node.data', { $literal: { context: {} } }] } }] },
      '$$node',
    ] } } },
    revision: { $add: ['$revision', 1] }, updatedAt: '$$NOW',
  } }])
  return { matchedMaps, modifiedMaps: result.modifiedCount }
}
function repairReadTimestamp(/* 历史记录中的未经验证时间值，仅接受 Date 或可解析字符串。 */ value: unknown, /* 时间字段在历史结构中的路径，用于说明具体错误位置。 */ label: string): string {
  // 验证历史时间戳可解析，并统一输出 UTC ISO 字符串。
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_TIMESTAMP, label))
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_VALID_TIMESTAMP, label))
  return date.toISOString()
}
function repairReadStatus(/* 旧 Run 或 Operation 的原始状态字段，需要限制在支持集合。 */ value: unknown): GraphRun['status'] {
  // 把历史 Run 状态限制在当前支持的状态集合。
  if (typeof value !== 'string' || !['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(value)) throw new Error(RuntimeMessage.INVALID_LEGACY_RUN_STATUS)
  return value as GraphRun['status']
}

/** Read the retired single-operation schema only at this explicit maintenance boundary. */
function repairReadLegacyRun(/* 待迁移的原始 Run，可能已是新结构；混用新旧结构会被拒绝。 */ value: unknown, /* 所属图已验证的节点身份、版本和种类，用于定位原核查产物。 */ nodes: Array<{ id: string; revision: number; kind: unknown }>): { run: unknown; legacy: boolean; active: boolean } {
  // 严格解析旧单 Operation 核查结构，保留身份与产物，并让活动 Run 暂停后迁移。
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(RuntimeMessage.INVALID_STORED_RUN)
  if ('operations' in value) {
    if ('operation' in value || !Array.isArray(value.operations)) throw new Error(RuntimeMessage.AMBIGUOUS_STORED_RUN_SCHEMA)
    return { run: value, legacy: false, active: false }
  }
  const run = inputReadObject(value, ['id', 'mode', 'status', 'configuration', 'operation', 'error', 'createdAt', 'updatedAt'], 'legacy Run')
  const id = inputReadString(run.id, 'Run.id')
  const status = repairReadStatus(run.status)
  if (run.mode !== 'auto' && run.mode !== 'human-in-loop') throw new Error(RuntimeMessage.INVALID_LEGACY_RUN_MODE)
  const configuration = configurationRead(run.configuration)
  const source = inputReadObject(run.operation, ['id', 'kind', 'targetId', 'status', 'inputRefs', 'route', 'draft', 'reports', 'review', 'resultNodeId'], 'legacy operation')
  if (source.kind !== 'verify') throw new Error(RuntimeMessage.ONLY_THE_LEGACY_VERIFY_OPERATION_CAN_BE_MIGRATED)
  const operationId = inputReadString(source.id, 'operation.id')
  const targetId = inputReadString(source.targetId, 'operation.targetId')
  const inputRefs = inputReadArray(source.inputRefs, 'operation.inputRefs').map(/* 旧 Operation 中单条原始输入引用，需验证节点身份与版本。 */ value => {
    // 校验旧输入引用的节点身份与版本。
    const ref = inputReadObject(value, ['id', 'revision'], 'inputRef')
    return { id: inputReadString(ref.id, 'inputRef.id'), revision: inputReadRevision(ref.revision, 'inputRef.revision') }
  }).sort((/* 排序比较左侧的已验证输入引用，按节点身份规范顺序。 */ a, /* 排序比较右侧的已验证输入引用，用于与左侧身份比较。 */ b) => /* 固定历史输入引用顺序，保持配置复用哈希稳定。 */  a.id.localeCompare(b.id))
  if (!inputRefs.some(/* 已验证的历史输入引用，检查其中是否包含目标节点。 */ ref => /* 确认目标节点包含在旧 Operation 的输入引用中。 */  ref.id === targetId) || new Set(inputRefs.map(/* 已验证的历史输入引用，提取身份以检测重复。 */ ref => /* 提取输入身份以检测重复引用。 */  ref.id)).size !== inputRefs.length) throw new Error(RuntimeMessage.INVALID_LEGACY_INPUT_REFERENCES)
  let route: GraphOperation['route'] = null
  if (source.route !== null) {
    const row = inputReadObject(source.route, ['revision', 'reason', 'slots', 'approved'], 'route')
    if (typeof row.approved !== 'boolean') throw new Error(RuntimeMessage.INVALID_LEGACY_ROUTE_APPROVAL)
    const slots = configurationReadSlots(row.slots)
    if (!slots.length || slots.length > configuration.maxSlots || new Set(slots.map(/* 已解析的历史路由槽位，提取身份以检测重复槽位。 */ slot => /* 提取路由槽位身份以检测重复槽位。 */  slot.id)).size !== slots.length) throw new Error(RuntimeMessage.INVALID_LEGACY_ROUTE_SLOTS)
    for (const slot of slots) {
      const agent = configuration.agents.find(/* 旧 Run 冻结配置中的 Agent 候选，按槽位 agentId 查找。 */ agent => /* 查找旧槽位所引用的配置 Agent。 */  agent.id === slot.agentId)
      if (!agent || slot.tools.some(/* 旧槽位所选工具名，必须属于其 Agent 的声明能力。 */ tool => /* 判断旧槽位工具是否超出 Agent 声明的能力。 */  !agent.tools.includes(tool))) throw new Error(RuntimeMessage.INVALID_LEGACY_ROUTE_CAPABILITIES)
    }
    route = { revision: inputReadRevision(row.revision, 'route.revision'), reason: inputReadString(row.reason, 'route.reason'), slots, approved: row.approved }
  }
  const reports = inputReadArray(source.reports, 'operation.reports').map(/* 原始旧核查报告条目，需逐项验证身份、分数和时间。 */ value => {
    // 校验并复制旧核查报告的身份、分数、能力和时间字段。
    const row = inputReadObject(value, ['id', 'slotId', 'agentId', 'agentName', 'angle', 'tools', 'routeRevision', 'score', 'reason', 'createdAt'], 'report')
    return { id: inputReadString(row.id, 'report.id'), slotId: inputReadString(row.slotId, 'report.slotId'),
      agentId: inputReadString(row.agentId, 'report.agentId'), agentName: inputReadString(row.agentName, 'report.agentName'),
      angle: inputReadString(row.angle, 'report.angle'), tools: inputReadNames(row.tools, 'report.tools'),
      routeRevision: inputReadRevision(row.routeRevision, 'report.routeRevision'), score: inputReadScore(row.score),
      reason: inputReadString(row.reason, 'report.reason'), createdAt: repairReadTimestamp(row.createdAt, 'report.createdAt') }
  })
  if (new Set(reports.map(/* 已验证旧报告，提取报告身份检查重复记录。 */ report => /* 提取报告身份以检查重复报告。 */  report.id)).size !== reports.length || new Set(reports.map(/* 已验证旧报告，提取槽位身份检查重复提交。 */ report => /* 提取报告槽位身份以检查同一槽位重复提交。 */  report.slotId)).size !== reports.length) throw new Error(RuntimeMessage.DUPLICATE_LEGACY_REPORTS)
  let draft: GraphOperation['draft'] = null
  if (source.draft !== null) {
    const row = inputReadObject(source.draft, ['id', 'routeRevision', 'reportIds', 'score', 'reason'], 'draft')
    draft = { id: inputReadString(row.id, 'draft.id'), routeRevision: inputReadRevision(row.routeRevision, 'draft.routeRevision'),
      reportIds: inputReadNames(row.reportIds, 'draft.reportIds'), score: inputReadScore(row.score), reason: inputReadString(row.reason, 'draft.reason') }
  }
  let review: GraphOperation['review'] = null
  if (source.review !== null) {
    const row = inputReadObject(source.review, ['id', 'kind', 'revision', 'state', 'decision', 'createdAt', 'answeredAt'], 'review')
    if ((row.kind !== 'route' && row.kind !== 'result') || (row.state !== 'pending' && row.state !== 'answered')
      || (row.decision !== null && row.decision !== 'approve' && row.decision !== 'reject')) throw new Error(RuntimeMessage.INVALID_LEGACY_REVIEW)
    review = { id: inputReadString(row.id, 'review.id'), kind: row.kind, revision: inputReadRevision(row.revision, 'review.revision'),
      state: row.state, decision: row.decision, createdAt: repairReadTimestamp(row.createdAt, 'review.createdAt'),
      answeredAt: row.answeredAt === null ? null : repairReadTimestamp(row.answeredAt, 'review.answeredAt') }
  }
  const resultNodeId = source.resultNodeId === null ? null : inputReadString(source.resultNodeId, 'operation.resultNodeId')
  const output = nodes.find(/* 所属图节点摘要，匹配旧结果身份与核查类型。 */ node => /* 查找旧结果身份对应的核查节点，以恢复可复用产物引用。 */  node.id === resultNodeId && node.kind === 'verification')
  const { router, merger, agents, tools, maxSlots } = configuration
  const operation: GraphOperation = { id: operationId, kind: 'verify', targetId, status: repairReadStatus(source.status), inputRefs,
    configurationHash: storeCreateInputHash({ router, merger, agents, tools, maxSlots }),
    // Legacy verify outputs were created at revision 0; later edits must invalidate reuse.
    outputRefs: output ? [{ id: output.id, revision: 0 }] : [],
    route, reports, draft, review, resultNodeId, splitReports: [], contentDraft: null }
  let error: GraphRun['error']
  if (run.error !== undefined) {
    const row = inputReadObject(run.error, ['code', 'message', 'workId'], 'Run.error')
    error = { code: inputReadString(row.code, 'error.code'), message: inputReadString(row.message, 'error.message'), workId: inputReadString(row.workId, 'error.workId') }
  }
  const active = status === 'running' || status === 'waiting'
  const migrated: GraphRun = { id, mode: run.mode, status, configuration, scope: { nodeIds: [targetId] }, until: 'verified',
    paused: active, regenerate: true, operations: [operation], ...(error ? { error } : {}),
    createdAt: repairReadTimestamp(run.createdAt, 'Run.createdAt'), updatedAt: repairReadTimestamp(run.updatedAt, 'Run.updatedAt') }
  return { run: migrated, legacy: true, active }
}

/** Offline, all-or-nothing upgrade; dry runs only inspect and never write application state. */
export async function repairMigrateNodeRuns(/* 管理员提供的目标数据库连接，迁移在其事务中执行。 */ connection: Connection, /* 是否应用迁移；默认 false 仅读取检查，true 要求整批可安全转换。 */ apply = false) {
  // 在显式维护事务中检查旧数据与有效租约，按预览或应用模式迁移全部候选图。
  if (!connection.db) throw new Error(RuntimeMessage.MONGO_CONNECTION_IS_NOT_READY)
  const graphs = connection.db.collection<{ _id: string; [/* 原始 Mongo 图文档中除 _id 外的存储字段名。 */ key: string]: unknown }>(GRAPH_COLLECTION)
  const filter = { $or: [
    { 'run.operation': { $exists: true } },
    { run: { $ne: null }, 'run.operations': { $exists: false } },
    { runHistory: { $elemMatch: { $or: [{ operation: { $exists: true } }, { operations: { $exists: false } }] } } },
  ] }
  // Server time arbitrates leases even when the administrator's machine clock differs.
  const leaseEntries = { $objectToArray: { $cond: [{ $eq: [{ $type: '$leases' }, 'object'] }, '$leases', {}] } }
  const activeLeases = { $anyElementTrue: [{ $map: { input: leaseEntries, as: 'lease',
    in: { $gt: [{ $convert: { input: '$$lease.v.expiresAt', to: 'date', onError: new Date('9999-12-31T00:00:00.000Z'), onNull: new Date('9999-12-31T00:00:00.000Z') } }, '$$NOW'] },
  } }] }
  const session = await connection.startSession()
  try {
    return await session.withTransaction(async () => {
      // 使用同一数据库快照完成校验与迁移，任何不支持结构或竞争使应用整体回滚。
      const rows = await graphs.aggregate<{ document: { _id: string; [/* 聚合返回的原始图文档字段名，用于读取未知形状的旧存储数据。 */ key: string]: unknown }; activeLeases: boolean }>([
        { $match: filter }, { $project: { document: '$$ROOT', activeLeases } },
      ], { session }).toArray()
      const summary = { matchedMaps: rows.length, matchedRuns: 0, activeRuns: 0, blockedMaps: 0, modifiedMaps: 0 }
      for (const row of rows) {
        const document = row.document
        let run: unknown, history: unknown[], revision: number
        try {
          inputReadString(document._id, 'Map.id')
          revision = inputReadRevision(document.revision, 'Map.revision')
          if (revision === Number.MAX_SAFE_INTEGER) throw new Error(RuntimeMessage.MAP_REVISION_CANNOT_BE_INCREMENTED)
          const nodes = inputReadArray(document.nodes, 'Map.nodes').map(/* 原始图节点，需先确认对象与 data 结构再提取迁移信息。 */ value => {
            // 读取迁移所需节点身份、版本与类型，拒绝畸形历史节点。
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(RuntimeMessage.INVALID_MAP_NODE)
            const node = value as Record<string, unknown>
            if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) throw new Error(RuntimeMessage.INVALID_MAP_NODE_DATA)
            const data = node.data as Record<string, unknown>
            return { id: inputReadString(node.id, 'node.id'), revision: inputReadRevision(node.revision, 'node.revision'), kind: data.kind }
          })
          if (new Set(nodes.map(/* 已验证节点摘要，提取身份检查图内重复节点。 */ node => /* 提取图节点身份以检查迁移前数据是否重复。 */  node.id)).size !== nodes.length) throw new Error(RuntimeMessage.DUPLICATE_MAP_NODE_IDENTITIES)
          if (document.leases !== undefined && (!document.leases || typeof document.leases !== 'object' || Array.isArray(document.leases))) throw new Error(RuntimeMessage.INVALID_LEGACY_LEASES)
          for (const lease of Object.values(document.leases ?? {})) {
            const grant = inputReadObject(lease, ['workId', 'mapId', 'runId', 'operationId', 'actor', 'routeRevision', 'hostId', 'holderId', 'fence', 'expiresAt', 'leaseMs'], 'lease')
            for (const key of ['workId', 'mapId', 'runId', 'operationId', 'hostId', 'holderId']) inputReadString(grant[key], 'lease.' + key)
            if (!inputReadRevision(grant.fence, 'lease.fence') || !inputReadRevision(grant.leaseMs, 'lease.leaseMs')) throw new Error(RuntimeMessage.INVALID_LEASE_FENCE_OR_LIFETIME)
            inputReadRevision(grant.routeRevision, 'lease.routeRevision')
            const actor = inputReadObject(grant.actor, ['role', 'slotId'], 'lease.actor')
            if (!['parse', 'router', 'worker', 'merge'].includes(String(actor.role))) throw new Error(RuntimeMessage.INVALID_LEASE_ACTOR)
            if (actor.role === 'worker') inputReadString(actor.slotId, 'lease.actor.slotId')
            else if (actor.slotId !== undefined) throw new Error(RuntimeMessage.INVALID_LEASE_SLOT)
            repairReadTimestamp(grant.expiresAt, 'lease.expiresAt')
          }
          const migrate = (/* 当前或历史 Run 的原始值，转换后同时更新迁移统计。 */ value: unknown) => {
            // 转换当前或历史 Run，并累计旧结构与活动运行数量。
            const migrated = repairReadLegacyRun(value, nodes)
            summary.matchedRuns += Number(migrated.legacy)
            summary.activeRuns += Number(migrated.active)
            return migrated.run
          }
          run = document.run == null ? null : migrate(document.run)
          history = inputReadArray(document.runHistory ?? [], 'Map.runHistory').map(migrate)
        } catch {
          throw new GraphError(409, 'RUN_MIGRATION_INVALID', RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
        }
        if (row.activeLeases) {
          summary.blockedMaps++
          if (apply) throw new GraphError(409, 'RUN_LEASE_ACTIVE', RuntimeMessage.STOP_HOSTS_AND_WAIT_FOR_THEIR_WORK_LEASES_TO_EXPIRE_BEFORE_APPLYING)
        }
        if (!apply) continue
        const result = await graphs.updateOne({ _id: document._id, revision, $expr: { $not: [activeLeases] } }, [{ $set: {
          run: { $literal: run }, runHistory: { $literal: history }, revision: { $add: ['$revision', 1] }, updatedAt: '$$NOW',
          leases: { $arrayToObject: { $map: { input: leaseEntries, as: 'lease',
            in: { k: '$$lease.k', v: { $mergeObjects: ['$$lease.v', { expiresAt: '$$NOW' }] } },
          } } },
        } }], { session })
        if (!result.matchedCount) throw new GraphError(409, 'RUN_MIGRATION_CONFLICT', RuntimeMessage.MAP_OR_LEASE_CHANGED_DURING_MIGRATION_RETRY_AFTER_STOPPING_HOSTS)
        summary.modifiedMaps++
      }
      return summary
    })
  } finally { await session.endSession() }
}
