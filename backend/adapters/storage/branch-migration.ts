// 显式把退役的 data/kind 图转成通用数据实例；通过 Persistence 同时服务 Mongo 和 SQLite。
import { randomUUID } from 'node:crypto'
import type { DefinitionPackage, JsonValue } from '../../../contracts/data-definition'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { Persistence } from '../../ports/persistence'
import { GRAPH_COLLECTION } from '../../modules/graph/graph-record'
import { GraphError } from '../../modules/shared/domain-error'
import { definitionsDigest } from '../../modules/shared/data-definition'

type RawObject = Record<string, unknown>
interface RawGraph extends RawObject { _id: string }
interface RawWorkspace extends RawObject { _id: string }

export type BranchMigrationPlan =
  | { status: 'current'; mapId: string }
  | { status: 'blocked'; mapId: string; activeRun: boolean; reason: string }
  | { status: 'migrate'; mapId: string; expectedRevision: number; document: RawGraph; reportIds: Record<string, string> }

export interface BranchMigrationSummary {
  matchedMaps: number
  migratableMaps: number
  activeRuns: number
  blockedMaps: number
  modifiedMaps: number
  details: Array<{ mapId: string; status: BranchMigrationPlan['status']; reason?: string }>
}

const terminalStatuses = new Set(['completed', 'failed', 'cancelled'])

function migrationObject(/* 存储中未知结构值。 */ value: unknown, /* 失败说明中的字段名。 */ label: string): RawObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, label))
  return value as RawObject
}

function migrationArray(/* 存储中未知数组值。 */ value: unknown, /* 失败说明中的字段名。 */ label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_ARRAY, label))
  return value
}

function migrationString(/* 存储中未知文本值。 */ value: unknown, /* 失败说明中的字段名。 */ label: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_EMPTY_STRING, label))
  return value
}

function migrationRevision(/* 存储中未知非负整数。 */ value: unknown, /* 失败说明中的字段名。 */ label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_NEGATIVE_INTEGER, label))
  return value
}

function migrationTime(/* 存储中可能是 Date 或字符串的时间。 */ value: unknown, /* 失败说明中的字段名。 */ label: string): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_TIMESTAMP, label))
  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_VALID_TIMESTAMP, label))
  return time.toISOString()
}

function migrationCanonical(/* 用于判断同一历史报告内容是否一致的值。 */ value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(migrationCanonical).join(',')}]`
  const object = value as RawObject
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${migrationCanonical(object[key])}`).join(',')}}`
}

function migrationReadReport(/* Operation 或结论中的旧 GraphReport。 */ value: unknown): RawObject {
  const report = migrationObject(value, 'report')
  const score = report.score
  if (score !== 0 && score !== 0.5 && score !== 1) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  const tools = migrationArray(report.tools, 'report.tools').map(item => migrationString(item, 'report.tools[]'))
  return {
    id: migrationString(report.id, 'report.id'), slotId: migrationString(report.slotId, 'report.slotId'),
    agentId: migrationString(report.agentId, 'report.agentId'), agentName: migrationString(report.agentName, 'report.agentName'),
    angle: typeof report.angle === 'string' ? report.angle : migrationString(report.angle, 'report.angle'), tools,
    routeRevision: migrationRevision(report.routeRevision, 'report.routeRevision'), score,
    reason: migrationString(report.reason, 'report.reason'), createdAt: migrationTime(report.createdAt, 'report.createdAt'),
  }
}

function migrationReadRun(/* 需要确认为终态并转为只读归档的旧 Run。 */ value: unknown): { run: RawObject; reports: RawObject[]; active: boolean } {
  const source = migrationObject(value, 'run')
  const status = migrationString(source.status, 'run.status')
  const active = !terminalStatuses.has(status)
  if (active && status !== 'running' && status !== 'waiting') throw new Error(RuntimeMessage.INVALID_LEGACY_RUN_STATUS)
  const id = migrationString(source.id, 'run.id')
  const mode = source.mode === 'human-in-loop' ? 'human-in-loop' : source.mode === 'auto' ? 'auto' : (() => { throw new Error(RuntimeMessage.INVALID_LEGACY_RUN_MODE) })()
  const reports: RawObject[] = []
  const operations = Array.isArray(source.operations) ? source.operations : source.operation === undefined ? [] : [source.operation]
  for (const raw of operations) {
    const operation = migrationObject(raw, 'operation')
    for (const report of migrationArray(operation.reports ?? [], 'operation.reports')) reports.push(migrationReadReport(report))
  }
  const scopeIds = (() => {
    if (source.scope && typeof source.scope === 'object' && !Array.isArray(source.scope)) {
      return migrationArray((source.scope as RawObject).nodeIds, 'run.scope.nodeIds').map(item => migrationString(item, 'run.scope.nodeIds[]'))
    }
    return operations.map(operation => migrationString(migrationObject(operation, 'operation').targetId, 'operation.targetId'))
  })()
  const tools = source.configuration && typeof source.configuration === 'object' && !Array.isArray(source.configuration)
    && Array.isArray((source.configuration as RawObject).tools) ? structuredClone((source.configuration as RawObject).tools) : []
  const run: RawObject = {
    id, scope: { nodeIds: [...new Set(scopeIds)] }, plan: { steps: [] },
    definitions: { revision: 0, packages: [], index: [], dataTypes: [], transitions: [] }, agents: [], tools,
    paused: true, regenerate: true, mode, status, steps: [], operations: [],
    ...(source.error === undefined ? {} : { error: structuredClone(source.error) }),
    createdAt: migrationTime(source.createdAt, 'run.createdAt'), updatedAt: migrationTime(source.updatedAt, 'run.updatedAt'),
    // 终态旧执行不再可重启；完整原记录只作可读归档，候选内容不会成为正式数据节点。
    legacyArchive: structuredClone(source) as unknown as JsonValue,
  }
  return { run, reports, active }
}

function migrationReadLeaseActive(/* 原图租约字典。 */ value: unknown, /* 由存储端提供的当前时间。 */ serverNow: number): boolean {
  if (value === undefined) return false
  const leases = migrationObject(value, 'leases')
  return Object.values(leases).some(item => {
    const lease = migrationObject(item, 'lease')
    return Date.parse(migrationTime(lease.expiresAt, 'lease.expiresAt')) > serverNow
  })
}

function migrationValidateLocator(/* source/evidence 节点的旧 locator。 */ value: unknown): void {
  const locator = migrationObject(value, 'node.data.locator')
  if (locator.kind === 'asset') {
    migrationString(locator.assetId, 'node.data.locator.assetId'); migrationString(locator.mediaType, 'node.data.locator.mediaType'); return
  }
  if (locator.kind === 'url') {
    const text = migrationString(locator.url, 'node.data.locator.url')
    try {
      if (!['http:', 'https:'].includes(new URL(text).protocol)) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    } catch { throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA) }
    return
  }
  throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
}

function migrationValidateLegacyPayload(/* 旧业务类型。 */ kind: string, /* 去除 kind 前的旧节点内容。 */ data: RawObject): void {
  // 只接纳能被 factcheck.*@1 无损解释的终态数据；旧自由 category 等不猜测转换。
  if (kind === 'source') {
    migrationValidateLocator(data.locator)
    if (data.label !== null && typeof data.label !== 'string') throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    return
  }
  if (kind === 'news') {
    migrationString(data.content, 'node.data.content')
    const context = migrationObject(data.context, 'node.data.context')
    for (const field of Object.values(context)) {
      const item = migrationObject(field, 'node.data.context field')
      if (typeof item.value !== 'string' || typeof item.visibleToAI !== 'boolean') throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    }
    return
  }
  if (kind === 'claim') {
    migrationString(data.content, 'node.data.content')
    if (data.category !== null && data.category !== 'data' && data.category !== 'quote' && data.category !== 'causal') {
      throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    }
    return
  }
  if (kind === 'evidence') {
    migrationString(data.content, 'node.data.content'); migrationValidateLocator(data.locator); migrationTime(data.capturedAt, 'node.data.capturedAt'); return
  }
  if (kind === 'verification') {
    if (data.score !== 0 && data.score !== 0.5 && data.score !== 1) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    migrationString(data.reason, 'node.data.reason')
    if (!migrationArray(data.reportIds, 'node.data.reportIds').length) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  }
}

function migrationBlocked(/* 图身份。 */ mapId: string, /* 是否因活跃执行而阻断。 */ activeRun: boolean, /* 预览中可见的原因。 */ reason: string): BranchMigrationPlan {
  return { status: 'blocked', mapId, activeRun, reason }
}

function migrationCreateDataPackage(/* 部署随版本提供的完整事实核查包。 */ source: DefinitionPackage): DefinitionPackage {
  // 历史工作区没有可靠的 Agent 版本绑定；只注册能解释已迁移节点的六种数据类型。
  const required = new Set(['factcheck.source', 'factcheck.news', 'factcheck.claim', 'factcheck.evidence', 'factcheck.opinion', 'factcheck.verification'])
  const dataTypes = source.dataTypes.filter(type => required.has(type.id) && type.version === 1).map(type => structuredClone(type))
  if (dataTypes.length !== required.size) throw new GraphError(409, 'DATA_MIGRATION_BLOCKED', RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  return { id: 'chongming.fact-checking-data-migration', version: 1, title: 'Fact-checking migrated data',
    description: 'Data-only definitions installed by the explicit generic-data migration.',
    schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes, transitions: [], dependencies: { packages: [], agents: [] } }
}

function migrationPlanWorkspace(/* 候选图所属的原工作区记录。 */ workspace: RawWorkspace, /* 为历史节点提供的数据定义包。 */ migrationPackage: DefinitionPackage,
  /* 存储端时间，与同批图迁移使用同一基准。 */ serverNow: number): { expectedRevision: number; document: RawWorkspace } | null {
  const revision = migrationRevision(workspace.revision, 'workspace.revision')
  if (revision === Number.MAX_SAFE_INTEGER) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  const packages = migrationArray(workspace.definitionPackages ?? [], 'workspace.definitionPackages').map(value => migrationObject(value, 'definition package'))
  let missing = 0
  for (const expected of migrationPackage.dataTypes) {
    const owners = packages.filter(packageItem => migrationArray(packageItem.dataTypes ?? [], 'definition package.dataTypes')
      .some(value => { const type = migrationObject(value, 'data type'); return type.id === expected.id && type.version === expected.version }))
    if (!owners.length) { missing++; continue }
    if (owners.length !== 1) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    const actual = migrationArray(owners[0].dataTypes, 'definition package.dataTypes').map(value => migrationObject(value, 'data type'))
      .find(type => type.id === expected.id && type.version === expected.version)!
    if (definitionsDigest(actual) !== definitionsDigest(expected)) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  }
  if (!missing) return null
  if (missing !== migrationPackage.dataTypes.length) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  return { expectedRevision: revision, document: { ...structuredClone(workspace), definitionPackages: [...packages, structuredClone(migrationPackage)],
    definitionAgents: Array.isArray(workspace.definitionAgents) ? structuredClone(workspace.definitionAgents) : [],
    revision: revision + 1, updatedAt: new Date(serverNow).toISOString() } }
}

/** Build a pure conversion plan for one raw graph. It never mutates the supplied record. */
export function migrationPlanBranchGraph(/* 从存储直接读取的旧或新图。 */ raw: unknown, /* 存储端时间，用于判定租约是否仍有效。 */ serverNow: number): BranchMigrationPlan {
  let source: RawObject, mapId = '<unknown>'
  try {
    source = migrationObject(raw, 'map')
    mapId = migrationString(source._id ?? source.id, 'map.id')
    const rawNodes = migrationArray(source.nodes, 'map.nodes')
    const legacyFlags = rawNodes.map(value => {
      const node = migrationObject(value, 'node')
      return 'data' in node && !('payload' in node) && !('typeId' in node)
    })
    const currentFlags = rawNodes.map(value => {
      const node = migrationObject(value, 'node')
      return !('data' in node) && 'payload' in node && 'typeId' in node && 'typeVersion' in node
    })
    const oldEdges = migrationArray(source.edges, 'map.edges').some(value => {
      const kind = migrationObject(value, 'edge').kind
      return kind === 'derived-from' || kind === 'mentions' || kind === 'verifies' || kind === 'related-to'
    })
    if (!legacyFlags.some(Boolean) && currentFlags.every(Boolean) && !oldEdges) {
      if (Array.isArray(source.runs) && !('run' in source)) return { status: 'current', mapId }
      const revision = migrationRevision(source.revision, 'map.revision')
      if (revision === Number.MAX_SAFE_INTEGER) return migrationBlocked(mapId, false, 'Map revision cannot be incremented')
      if (migrationReadLeaseActive(source.leases, serverNow)) return migrationBlocked(mapId, true, 'Execution leases must expire before Run array migration')
      const document = structuredClone(source) as RawGraph
      document.runs = source.run == null ? [] : [structuredClone(source.run)]
      delete document.run
      Object.assign(document, { revision: revision + 1, updatedAt: new Date(serverNow).toISOString(),
        migration: { ...(migrationObject(source.migration ?? {}, 'map.migration')), kind: 'run-array-v5', migratedAt: new Date(serverNow).toISOString() } })
      return { status: 'migrate', mapId, expectedRevision: revision, document, reportIds: {} }
    }
    if (legacyFlags.some(flag => !flag) || currentFlags.some(Boolean)) return migrationBlocked(mapId, false, 'Map mixes legacy and generic data nodes')
    const revision = migrationRevision(source.revision, 'map.revision')
    if (revision === Number.MAX_SAFE_INTEGER) return migrationBlocked(mapId, false, 'Map revision cannot be incremented')
    const runValues = [...(source.run == null ? [] : [source.run]), ...migrationArray(source.runHistory ?? [], 'map.runHistory')]
    const archivedRuns: RawObject[] = [], runReports: RawObject[] = []
    let activeRun = false
    for (const value of runValues) {
      const parsed = migrationReadRun(value)
      archivedRuns.push(parsed.run); runReports.push(...parsed.reports); activeRun ||= parsed.active
    }
    const activeLease = migrationReadLeaseActive(source.leases, serverNow)
    if (activeRun || activeLease) return migrationBlocked(mapId, true, 'Active Run or execution lease must be stopped before migration')

    const reports = new Map<string, RawObject>()
    const remember = (report: RawObject) => {
      const id = report.id as string, prior = reports.get(id)
      if (prior && migrationCanonical(prior) !== migrationCanonical(report)) throw new Error(RuntimeMessage.DUPLICATE_LEGACY_REPORTS)
      reports.set(id, report)
    }
    for (const report of runReports) remember(report)
    for (const value of rawNodes) {
      const data = migrationObject(migrationObject(value, 'node').data, 'node.data')
      if (data.kind === 'verification') for (const report of migrationArray(data.opinions, 'verification.opinions')) remember(migrationReadReport(report))
    }
    const published = new Set<string>()
    for (const value of rawNodes) {
      const data = migrationObject(migrationObject(value, 'node').data, 'node.data')
      if (data.kind === 'verification') for (const id of migrationArray(data.reportIds, 'verification.reportIds').map(item => migrationString(item, 'reportId'))) {
        if (!reports.has(id)) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
        published.add(id)
      }
    }
    const reportIds = Object.fromEntries([...published].map(id => [id, randomUUID()]))
    const nodeKinds = new Map<string, string>(), nodes: RawObject[] = [], legacyProducers: Record<string, unknown> = {}
    for (const value of rawNodes) {
      const node = migrationObject(value, 'node'), id = migrationString(node.id, 'node.id'), data = migrationObject(node.data, 'node.data')
      const kind = migrationString(data.kind, 'node.data.kind')
      if (!['source', 'news', 'claim', 'evidence', 'verification'].includes(kind)) throw new Error(messageFormat(RuntimeMessage.VALUE_KIND_IS_INVALID, 'node.data'))
      migrationValidateLegacyPayload(kind, data)
      nodeKinds.set(id, kind)
      const payload = structuredClone(data) as RawObject
      delete payload.kind
      if (kind === 'verification') {
        const score = payload.score
        if (score !== 0 && score !== 0.5 && score !== 1) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
        const selected = [...new Set(migrationArray(payload.reportIds, 'verification.reportIds').map(item => migrationString(item, 'reportId')))]
        Object.assign(payload, { opinionIds: selected.map(reportId => reportIds[reportId]) })
        delete payload.reportIds; delete payload.opinions
      }
      const { data: _data, producer, ...envelope } = node
      if (producer !== undefined) legacyProducers[id] = structuredClone(producer)
      nodes.push({ ...structuredClone(envelope), id, revision: migrationRevision(node.revision, 'node.revision'),
        typeId: `factcheck.${kind}`, typeVersion: 1, payload,
        payloadReferences: kind === 'verification' ? migrationArray(payload.opinionIds, 'verification.opinionIds')
          .map(targetId => ({ path: '/opinionIds/*', targetId: migrationString(targetId, 'verification.opinionId') })) : [],
        createdAt: migrationTime(node.createdAt, 'node.createdAt'), updatedAt: migrationTime(node.updatedAt, 'node.updatedAt') })
    }
    for (const legacyId of published) {
      const report = reports.get(legacyId)!, id = reportIds[legacyId]
      nodeKinds.set(id, 'opinion')
      nodes.push({ id, revision: 0, typeId: 'factcheck.opinion', typeVersion: 1,
        payload: { score: report.score, reason: report.reason, evidenceIds: [], legacy: {
          reportId: report.id, slotId: report.slotId, routeRevision: report.routeRevision, agentId: report.agentId,
          agentName: report.agentName, angle: report.angle, tools: report.tools, createdAt: report.createdAt,
        } }, payloadReferences: [], createdAt: report.createdAt, updatedAt: report.createdAt })
    }
    const rawEdges = migrationArray(source.edges, 'map.edges').map(value => {
      const edge = migrationObject(value, 'edge'), id = migrationString(edge.id, 'edge.id'), from = migrationString(edge.from, 'edge.from'), to = migrationString(edge.to, 'edge.to')
      if (!nodeKinds.has(from) || !nodeKinds.has(to) || from === to) throw new Error(RuntimeMessage.EDGE_ENDPOINTS_MUST_EXIST_IN_THE_SAME_MAP)
      const kind = migrationString(edge.kind, 'edge.kind')
      if (!['derived-from', 'mentions', 'verifies', 'related-to'].includes(kind)) throw new Error(RuntimeMessage.INVALID_EDGE_KIND)
      if (kind === 'derived-from' && !((nodeKinds.get(from) === 'news' && nodeKinds.get(to) === 'source') || (nodeKinds.get(from) === 'claim' && nodeKinds.get(to) === 'news'))) throw new Error(RuntimeMessage.INVALID_EDGE_ENDPOINT_KINDS)
      if (kind === 'mentions' && (nodeKinds.get(from) !== 'news' || nodeKinds.get(to) !== 'claim')) throw new Error(RuntimeMessage.INVALID_EDGE_ENDPOINT_KINDS)
      if (kind === 'verifies' && (nodeKinds.get(from) !== 'verification' || nodeKinds.get(to) !== 'claim')) throw new Error(RuntimeMessage.INVALID_EDGE_ENDPOINT_KINDS)
      return { id, revision: migrationRevision(edge.revision, 'edge.revision'), legacyKind: kind, from, to,
        createdAt: migrationTime(edge.createdAt, 'edge.createdAt'), updatedAt: migrationTime(edge.updatedAt, 'edge.updatedAt') }
    })
    const edges: RawObject[] = rawEdges.map(edge => ({ id: edge.id, revision: edge.revision,
      kind: edge.legacyKind === 'derived-from' || edge.legacyKind === 'mentions' ? 'successor' : 'reference',
      from: edge.legacyKind === 'derived-from' ? edge.to : edge.from, to: edge.legacyKind === 'derived-from' ? edge.from : edge.to,
      label: `legacy:${edge.legacyKind}`, createdAt: edge.createdAt, updatedAt: edge.updatedAt }))
    for (const value of rawNodes) {
      const node = migrationObject(value, 'node'), data = migrationObject(node.data, 'node.data')
      if (data.kind !== 'verification') continue
      const verificationId = migrationString(node.id, 'verification.id')
      const claims = rawEdges.filter(edge => edge.legacyKind === 'verifies' && edge.from === verificationId).map(edge => edge.to as string)
      for (const legacyId of new Set(migrationArray(data.reportIds, 'verification.reportIds').map(item => migrationString(item, 'reportId')))) {
        const opinionId = reportIds[legacyId], report = reports.get(legacyId)!
        edges.push({ id: randomUUID(), revision: 0, kind: 'successor', from: opinionId, to: verificationId,
          label: 'legacy:opinion-verification', createdAt: report.createdAt, updatedAt: migrationTime(node.updatedAt, 'verification.updatedAt') })
        for (const claimId of claims) edges.push({ id: randomUUID(), revision: 0, kind: 'successor', from: claimId, to: opinionId,
          label: 'legacy:claim-opinion', createdAt: report.createdAt, updatedAt: migrationTime(node.updatedAt, 'verification.updatedAt') })
      }
    }
    const currentRuns = source.run == null ? [] : archivedRuns.slice(0, 1)
    const history = source.run == null ? archivedRuns : archivedRuns.slice(1)
    const document = structuredClone(source) as RawGraph
    delete document.run
    Object.assign(document, { nodes, edges, retiredNodeIds: [], retiredEdgeIds: [], runs: currentRuns, runHistory: history, leases: {}, revision: revision + 1,
      updatedAt: new Date(serverNow).toISOString(), dataFormat: 4,
      migration: { kind: 'generic-data-v4', migratedAt: new Date(serverNow).toISOString(), legacyReportIds: reportIds,
        ...(Object.keys(legacyProducers).length ? { legacyProducers } : {}) } })
    return { status: 'migrate', mapId, expectedRevision: revision, document, reportIds }
  } catch (error) {
    return migrationBlocked(mapId, false, error instanceof Error ? error.message : RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  }
}

/** Inspect or atomically apply all generic-data migrations through the configured Persistence adapter. */
export async function migrationMigrateBranches(/* Mongo 或 SQLite 的通用持久化实例。 */ database: Persistence, /* true 才实际写入，默认只预览。 */ apply = false,
  /* 可选部署默认包；管理入口必须提供，以便为旧工作区原子安装数据定义。 */ legacyDefinitions?: DefinitionPackage): Promise<BranchMigrationSummary> {
  const execute = async (/* 预览时为 null，应用时为同一原子事务会话。 */ session: Parameters<ReturnType<Persistence['records']>['list']>[1] = null) => {
    const records = database.records<RawGraph>(GRAPH_COLLECTION), workspaces = database.records<RawWorkspace>('control_workspaces'), now = await database.now()
    let plans = (await records.list({}, session)).map(row => migrationPlanBranchGraph(row, now))
    const workspaceChanges = new Map<string, { expectedRevision: number; document: RawWorkspace }>()
    if (legacyDefinitions) {
      const packageItem = migrationCreateDataPackage(legacyDefinitions)
      for (const plan of plans) if (plan.status === 'migrate') {
        if ((plan.document.migration as RawObject | undefined)?.kind === 'run-array-v5') continue
        const workspaceId = typeof plan.document.workspaceId === 'string' ? plan.document.workspaceId : ''
        try {
          const workspace = workspaceId ? await workspaces.get(workspaceId, session) : null
          if (!workspace) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
          const change = migrationPlanWorkspace(workspace, packageItem, now)
          if (change) workspaceChanges.set(workspaceId, change)
        } catch (error) {
          plans = plans.map(item => item === plan ? migrationBlocked(plan.mapId, false,
            error instanceof Error ? error.message : RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA) : item)
        }
      }
    }
    const candidates = plans.filter((plan): plan is Extract<BranchMigrationPlan, { status: 'migrate' }> => plan.status === 'migrate')
    const blocked = plans.filter((plan): plan is Extract<BranchMigrationPlan, { status: 'blocked' }> => plan.status === 'blocked')
    const summary: BranchMigrationSummary = { matchedMaps: candidates.length + blocked.length, migratableMaps: candidates.length,
      activeRuns: blocked.filter(plan => plan.activeRun).length, blockedMaps: blocked.length, modifiedMaps: 0,
      details: plans.filter(plan => plan.status !== 'current').map(plan => ({ mapId: plan.mapId, status: plan.status,
        ...(plan.status === 'blocked' ? { reason: plan.reason } : {}) })) }
    if (!apply) return summary
    if (blocked.length) throw new GraphError(409, 'DATA_MIGRATION_BLOCKED', blocked.some(plan => plan.activeRun)
      ? RuntimeMessage.STOP_HOSTS_AND_WAIT_FOR_THEIR_WORK_LEASES_TO_EXPIRE_BEFORE_APPLYING
      : RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    for (const [workspaceId, change] of workspaceChanges) {
      const changed = await workspaces.change(workspaceId, current => current.revision === change.expectedRevision ? change.document : null, session)
      if (!changed) throw new GraphError(409, 'DATA_MIGRATION_CONFLICT', RuntimeMessage.MAP_OR_LEASE_CHANGED_DURING_MIGRATION_RETRY_AFTER_STOPPING_HOSTS)
    }
    for (const plan of candidates) {
      const changed = await records.change(plan.mapId, current => {
        if (current.revision !== plan.expectedRevision || migrationPlanBranchGraph(current, now).status !== 'migrate') return null
        return plan.document
      }, session)
      if (!changed) throw new GraphError(409, 'DATA_MIGRATION_CONFLICT', RuntimeMessage.MAP_OR_LEASE_CHANGED_DURING_MIGRATION_RETRY_AFTER_STOPPING_HOSTS)
      summary.modifiedMaps++
    }
    return summary
  }
  return apply ? database.transaction(session => execute(session)) : execute()
}
