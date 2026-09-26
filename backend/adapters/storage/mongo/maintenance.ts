import { RuntimeMessage, messageFormat } from '../../../../contracts/messages'
import type { Connection } from 'mongoose'
import type { GraphOperation, GraphRun } from '../../../../contracts/graph'
import { configurationRead, configurationReadSlots } from '../../../modules/workspace/agent-configuration'
import { GraphError } from '../../../modules/shared/domain-error'
import { inputReadArray, inputReadNames, inputReadObject, inputReadRevision, inputReadScore, inputReadString } from '../../../modules/shared/input-validation'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../../../modules/graph/graph-record'

/** Explicit repair for empty News contexts omitted by pre-056 Mongoose serialization. */
// 用途：更新上下文，并保持相关状态一致。
export async function repairUpdateNewsContext(connection: Connection, apply = false) {
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

// 用途：读取时间戳，并把结构化结果交给调用方。
function repairReadTimestamp(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_TIMESTAMP, label))
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_VALID_TIMESTAMP, label))
  return date.toISOString()
}

// 用途：读取状态，并把结构化结果交给调用方。
function repairReadStatus(value: unknown): GraphRun['status'] {
  if (typeof value !== 'string' || !['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(value)) throw new Error(RuntimeMessage.INVALID_LEGACY_RUN_STATUS)
  return value as GraphRun['status']
}

/** Read the retired single-operation schema only at this explicit maintenance boundary. */
// 用途：读取运行状态，并把结构化结果交给调用方。
function repairReadLegacyRun(value: unknown, nodes: Array<{ id: string; revision: number; kind: unknown }>): { run: unknown; legacy: boolean; active: boolean } {
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
  const inputRefs = inputReadArray(source.inputRefs, 'operation.inputRefs').map(value => {
    const ref = inputReadObject(value, ['id', 'revision'], 'inputRef')
    return { id: inputReadString(ref.id, 'inputRef.id'), revision: inputReadRevision(ref.revision, 'inputRef.revision') }
  }).sort((a, b) => a.id.localeCompare(b.id))
  if (!inputRefs.some(ref => ref.id === targetId) || new Set(inputRefs.map(ref => ref.id)).size !== inputRefs.length) throw new Error(RuntimeMessage.INVALID_LEGACY_INPUT_REFERENCES)
  let route: GraphOperation['route'] = null
  if (source.route !== null) {
    const row = inputReadObject(source.route, ['revision', 'reason', 'slots', 'approved'], 'route')
    if (typeof row.approved !== 'boolean') throw new Error(RuntimeMessage.INVALID_LEGACY_ROUTE_APPROVAL)
    const slots = configurationReadSlots(row.slots)
    if (!slots.length || slots.length > configuration.maxSlots || new Set(slots.map(slot => slot.id)).size !== slots.length) throw new Error(RuntimeMessage.INVALID_LEGACY_ROUTE_SLOTS)
    for (const slot of slots) {
      const agent = configuration.agents.find(agent => agent.id === slot.agentId)
      if (!agent || slot.tools.some(tool => !agent.tools.includes(tool))) throw new Error(RuntimeMessage.INVALID_LEGACY_ROUTE_CAPABILITIES)
    }
    route = { revision: inputReadRevision(row.revision, 'route.revision'), reason: inputReadString(row.reason, 'route.reason'), slots, approved: row.approved }
  }
  const reports = inputReadArray(source.reports, 'operation.reports').map(value => {
    const row = inputReadObject(value, ['id', 'slotId', 'agentId', 'agentName', 'angle', 'tools', 'routeRevision', 'score', 'reason', 'createdAt'], 'report')
    return { id: inputReadString(row.id, 'report.id'), slotId: inputReadString(row.slotId, 'report.slotId'),
      agentId: inputReadString(row.agentId, 'report.agentId'), agentName: inputReadString(row.agentName, 'report.agentName'),
      angle: inputReadString(row.angle, 'report.angle'), tools: inputReadNames(row.tools, 'report.tools'),
      routeRevision: inputReadRevision(row.routeRevision, 'report.routeRevision'), score: inputReadScore(row.score),
      reason: inputReadString(row.reason, 'report.reason'), createdAt: repairReadTimestamp(row.createdAt, 'report.createdAt') }
  })
  if (new Set(reports.map(report => report.id)).size !== reports.length || new Set(reports.map(report => report.slotId)).size !== reports.length) throw new Error(RuntimeMessage.DUPLICATE_LEGACY_REPORTS)
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
  const output = nodes.find(node => node.id === resultNodeId && node.kind === 'verification')
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
// 用途：处理当前模块相关工作，并把结果交给调用方。
export async function repairMigrateNodeRuns(connection: Connection, apply = false) {
  if (!connection.db) throw new Error(RuntimeMessage.MONGO_CONNECTION_IS_NOT_READY)
  const graphs = connection.db.collection<{ _id: string; [key: string]: unknown }>(GRAPH_COLLECTION)
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
      const rows = await graphs.aggregate<{ document: { _id: string; [key: string]: unknown }; activeLeases: boolean }>([
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
          const nodes = inputReadArray(document.nodes, 'Map.nodes').map(value => {
            if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(RuntimeMessage.INVALID_MAP_NODE)
            const node = value as Record<string, unknown>
            if (!node.data || typeof node.data !== 'object' || Array.isArray(node.data)) throw new Error(RuntimeMessage.INVALID_MAP_NODE_DATA)
            const data = node.data as Record<string, unknown>
            return { id: inputReadString(node.id, 'node.id'), revision: inputReadRevision(node.revision, 'node.revision'), kind: data.kind }
          })
          if (new Set(nodes.map(node => node.id)).size !== nodes.length) throw new Error(RuntimeMessage.DUPLICATE_MAP_NODE_IDENTITIES)
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
          const migrate = (value: unknown) => {
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
