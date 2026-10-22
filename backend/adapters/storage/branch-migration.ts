// 显式把退役的 data/kind 图转成通用数据实例；通过 Persistence 同时服务 Mongo 和 SQLite。
import { randomUUID } from 'node:crypto'
import type { DefinitionPackage } from '../../../contracts/data-definition'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { Persistence } from '../../ports/persistence'
import { GRAPH_COLLECTION, storeAssertCurrentGraphSchema } from '../../modules/graph/graph-record'
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
const migrationDataVersion = 1

/**
 * @param value 存储中未知结构值。
 * @param label 失败说明中的字段名。
 */
function migrationObject(value: unknown, label: string): RawObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_OBJECT, label))
  return value as RawObject
}

/**
 * @param value 存储中未知数组值。
 * @param label 失败说明中的字段名。
 */
function migrationArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_AN_ARRAY, label))
  return value
}

/**
 * @param value 存储中未知文本值。
 * @param label 失败说明中的字段名。
 */
function migrationString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.length) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_EMPTY_STRING, label))
  return value
}

/**
 * @param value 存储中未知非负整数。
 * @param label 失败说明中的字段名。
 */
function migrationRevision(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_NON_NEGATIVE_INTEGER, label))
  return value
}

/**
 * @param value 存储中可能是 Date 或字符串的时间。
 * @param label 失败说明中的字段名。
 */
function migrationTime(value: unknown, label: string): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_TIMESTAMP, label))
  const time = new Date(value)
  if (!Number.isFinite(time.getTime())) throw new Error(messageFormat(RuntimeMessage.VALUE_MUST_BE_A_VALID_TIMESTAMP, label))
  return time.toISOString()
}

/**
 * @param value 用于判断同一历史报告内容是否一致的值。
 */
function migrationCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(migrationCanonical).join(',')}]`
  const object = value as RawObject
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${migrationCanonical(object[key])}`).join(',')}}`
}

/**
 * @param value Operation 或结论中的旧 GraphReport。
 */
function migrationReadReport(value: unknown): RawObject {
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

/** 读取互斥的当前运行容器，并在迁移前拒绝任何会造成运行丢失的重复身份。 */
function migrationReadRunCollections(
  /* 尚未确定使用单 run 还是 runs[] 的原图。 */ source: RawObject,
): { runs: unknown[]; history: unknown[] } {
  // 当前和历史容器只在此处解释，后续转换保持各自的顺序与归属。
  if ('run' in source && 'runs' in source) throw new Error(RuntimeMessage.AMBIGUOUS_STORED_RUN_SCHEMA)
  const runs = 'runs' in source ? migrationArray(source.runs, 'map.runs') : source.run == null ? [] : [source.run]
  const history = migrationArray(source.runHistory ?? [], 'map.runHistory')
  const ids = new Set<string>()
  for (const value of [...runs, ...history]) {
    const run = migrationObject(value, 'run'), id = migrationString(run.id, 'run.id')
    if (ids.has(id)) throw new Error(RuntimeMessage.AMBIGUOUS_STORED_RUN_SCHEMA)
    ids.add(id)
  }
  return { runs, history }
}

/** 将旧运行变成终态归档，同时读取结论仍可能引用的报告；绝不把旧配置重新变成可执行计划。 */
function migrationReadRun(
  /* 固定业务流程保存的单 Operation 或多 Operation 运行。 */ value: unknown,
): { run: RawObject; reports: RawObject[]; active: boolean } {
  // 归档保存完整原记录，投影只提供当前读取所需字段，并让调用者阻断活动运行。
  const source = migrationObject(value, 'run')
  if (('operation' in source && 'operations' in source) || 'plan' in source || 'definitions' in source || 'steps' in source) {
    throw new Error(RuntimeMessage.AMBIGUOUS_STORED_RUN_SCHEMA)
  }
  const operations = 'operations' in source ? migrationArray(source.operations, 'run.operations')
    : [migrationObject(source.operation, 'run.operation')]
  const status = migrationString(source.status, 'run.status')
  const active = !terminalStatuses.has(status)
  if (active && status !== 'running' && status !== 'waiting') throw new Error(RuntimeMessage.INVALID_LEGACY_RUN_STATUS)
  if (source.mode !== 'human-in-loop' && source.mode !== 'auto') throw new Error(RuntimeMessage.INVALID_LEGACY_RUN_MODE)
  const reports: RawObject[] = [], targetIds: string[] = []
  for (const raw of operations) {
    const operation = migrationObject(raw, 'operation')
    targetIds.push(migrationString(operation.targetId, 'operation.targetId'))
    for (const report of migrationArray(operation.reports ?? [], 'operation.reports')) reports.push(migrationReadReport(report))
  }
  const scopeIds = source.scope === undefined ? targetIds
    : migrationArray(migrationObject(source.scope, 'run.scope').nodeIds, 'run.scope.nodeIds')
      .map(/* 历史范围内的节点身份。 */ item => /* 拒绝无法保留的非文本身份。 */ migrationString(item, 'run.scope.nodeIds[]'))
  const configuration = source.configuration === undefined ? {} : migrationObject(source.configuration, 'run.configuration')
  const tools = configuration.tools === undefined ? [] : structuredClone(migrationArray(configuration.tools, 'run.configuration.tools'))
  return { reports, active, run: {
    id: migrationString(source.id, 'run.id'), scope: { nodeIds: [...new Set(scopeIds)] }, plan: { steps: [] },
    definitions: { revision: 0, packages: [], index: [], dataTypes: [], transitions: [] }, agents: [], tools,
    paused: true, regenerate: true, mode: source.mode, status, steps: [], operations: [],
    ...(source.error === undefined ? {} : { error: structuredClone(source.error) }),
    createdAt: migrationTime(source.createdAt, 'run.createdAt'), updatedAt: migrationTime(source.updatedAt, 'run.updatedAt'),
    legacyArchive: structuredClone(source),
  } }
}

/**
 * @param value 原图租约字典。
 * @param serverNow 由存储端提供的当前时间。
 */
function migrationReadLeaseActive(value: unknown, serverNow: number): boolean {
  if (value === undefined) return false
  const leases = migrationObject(value, 'leases')
  return Object.values(leases).some(item => {
    const lease = migrationObject(item, 'lease')
    return Date.parse(migrationTime(lease.expiresAt, 'lease.expiresAt')) > serverNow
  })
}

/**
 * @param value source 节点的旧 locator。
 */
function migrationValidateLocator(value: unknown): void {
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

/**
 * 只接纳能被当前 factcheck.* 定义无损解释的终态数据；退役 Evidence 和旧自由 category 不猜测转换。
 *
 * @param kind 旧业务类型。
 * @param data 去除 kind 前的旧节点内容。
 */
function migrationValidateLegacyPayload(
  /* 已通过旧节点类型白名单的业务类型。 */ kind: 'source' | 'news' | 'claim' | 'verification',
  /* 去除旧 kind 前、仍需验证字段含义的节点内容。 */ data: RawObject,
): string[] {
  // 校验能保留到当前定义的旧字段，并返回去重报告引用；其他类型没有旧报告引用。
  if (kind === 'source') {
    migrationValidateLocator(data.locator)
    if (data.label !== null && typeof data.label !== 'string') throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    return []
  }
  if (kind === 'news') {
    migrationString(data.content, 'node.data.content')
    const context = migrationObject(data.context, 'node.data.context')
    for (const field of Object.values(context)) {
      const item = migrationObject(field, 'node.data.context field')
      if (typeof item.value !== 'string' || typeof item.visibleToAI !== 'boolean') throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    }
    return []
  }
  if (kind === 'claim') {
    migrationString(data.content, 'node.data.content')
    if (data.category !== null && data.category !== 'data' && data.category !== 'quote' && data.category !== 'causal') {
      throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
    }
    return []
  }
  if (data.score !== 0 && data.score !== 0.5 && data.score !== 1) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  migrationString(data.reason, 'node.data.reason')
  const reportIds = migrationArray(data.reportIds, 'node.data.reportIds').map(
    (/* 旧结论中的报告身份。 */ item) => /* 首次解析并保留实际发布的文本身份。 */ migrationString(item, 'reportId'),
  )
  if (!reportIds.length) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  return [...new Set(reportIds)]
}

/**
 * @param mapId 图身份。
 * @param activeRun 是否因活跃执行而阻断。
 * @param reason 预览中可见的原因。
 */
function migrationBlocked(mapId: string, activeRun: boolean, reason: string): BranchMigrationPlan {
  return { status: 'blocked', mapId, activeRun, reason }
}

/**
 * 历史工作区没有可靠的 Agent 版本绑定；只注册能解释已迁移节点的当前五种数据类型。
 *
 * @param source 部署随版本提供的完整事实核查包。
 */
function migrationCreateDataPackage(
  /* 当前部署随版本提供、包含全部五类核查类型的默认包。 */ source: DefinitionPackage,
): DefinitionPackage {
  // 固定迁移输出使用的类型版本，仅安装数据定义，避免恢复历史 Agent 的执行授权。
  const required = new Set(['factcheck.source', 'factcheck.news', 'factcheck.claim', 'factcheck.opinion', 'factcheck.verification'])
  const dataTypes = source.dataTypes.filter(
    /* 默认包中的一项数据类型定义。 */ type =>
      /* 选择迁移实际输出的当前五种类型。 */ required.has(type.id) && type.version === migrationDataVersion,
  ).map(
    /* 已选中的部署类型定义。 */ type =>
      /* 让迁移专用包拥有独立副本。 */ structuredClone(type),
  )
  if (dataTypes.length !== required.size) throw new GraphError(409, 'DATA_MIGRATION_BLOCKED', RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  return { id: 'chongming.fact-checking-data-migration', version: migrationDataVersion, title: 'Fact-checking migrated data',
    description: 'Data-only definitions installed by the explicit generic-data migration.',
    schemaDialect: 'http://json-schema.org/draft-07/schema#', dataTypes, transitions: [], dependencies: { packages: [], agents: [] } }
}

/**
 * @param workspace 候选图所属的原工作区记录。
 * @param migrationPackage 为历史节点提供的数据定义包。
 * @param serverNow 存储端时间，与同批图迁移使用同一基准。
 */
function migrationPlanWorkspace(workspace: RawWorkspace, migrationPackage: DefinitionPackage,
  serverNow: number): { expectedRevision: number; document: RawWorkspace } | null {
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
/**
 * @param raw 从存储直接读取的旧或新图。
 * @param serverNow 存储端时间，用于判定租约是否仍有效。
 */
export function migrationPlanBranchGraph(
  /* 存储直接读取的原始图，不会被此函数修改。 */ raw: unknown,
  /* 存储端当前毫秒时间，用于判断 Work 租约是否已到期。 */ serverNow: number,
): BranchMigrationPlan {
  // 先检查运行容器，再决定只升级 envelope 还是一次性转换旧节点和运行归档。
  let source: RawObject, mapId = '<unknown>'
  try {
    source = migrationObject(raw, 'map')
    mapId = migrationString(source._id ?? source.id, 'map.id')
    const runCollections = migrationReadRunCollections(source)
    const rawNodes = migrationArray(source.nodes, 'map.nodes')
    const legacyFlags = rawNodes.map(/* 存储中的未知节点记录。 */ value => {
      // 标出只带旧 data、没有通用类型和 payload 的节点。
      const node = migrationObject(value, 'node')
      return 'data' in node && !('payload' in node) && !('typeId' in node)
    })
    const currentFlags = rawNodes.map(/* 存储中的未知节点记录。 */ value => {
      // 标出采用通用数据实例外壳的节点，保留它们原本的类型版本。
      const node = migrationObject(value, 'node')
      return !('data' in node) && 'payload' in node && 'typeId' in node && 'typeVersion' in node
    })
    const sourceEdges = migrationArray(source.edges, 'map.edges')
    const oldEdges = sourceEdges.some(/* 存储中的未知关系记录。 */ value => {
      // 识别尚未转换为通用 successor/reference 的旧关系。
      const kind = migrationObject(value, 'edge').kind
      return kind === 'derived-from' || kind === 'mentions' || kind === 'verifies' || kind === 'related-to'
    })
    if (!legacyFlags.some(Boolean) && currentFlags.every(Boolean) && !oldEdges) {
      if (Array.isArray(source.runs)) {
        storeAssertCurrentGraphSchema(source)
        return { status: 'current', mapId }
      }
      const revision = migrationRevision(source.revision, 'map.revision')
      if (revision === Number.MAX_SAFE_INTEGER) return migrationBlocked(mapId, false, 'Map revision cannot be incremented')
      if (migrationReadLeaseActive(source.leases, serverNow)) return migrationBlocked(mapId, true, 'Execution leases must expire before Run array migration')
      const document = structuredClone(source) as RawGraph
      document.runs = structuredClone(runCollections.runs)
      document.runHistory = structuredClone(runCollections.history)
      delete document.run
      storeAssertCurrentGraphSchema(document)
      Object.assign(document, { revision: revision + 1, updatedAt: new Date(serverNow).toISOString(),
        migration: { ...(migrationObject(source.migration ?? {}, 'map.migration')), kind: 'run-array-v5', migratedAt: new Date(serverNow).toISOString() } })
      return { status: 'migrate', mapId, expectedRevision: revision, document, reportIds: {} }
    }
    if (legacyFlags.some(/* 节点是否只有旧 data 外壳。 */ flag =>
      /* 任一非旧节点都会使本批转换产生歧义。 */ !flag) || currentFlags.some(Boolean)) return migrationBlocked(mapId, false, 'Map mixes legacy and generic data nodes')
    const revision = migrationRevision(source.revision, 'map.revision')
    if (revision === Number.MAX_SAFE_INTEGER) return migrationBlocked(mapId, false, 'Map revision cannot be incremented')
    const runValues = [...runCollections.runs, ...runCollections.history]
    const archivedRuns: RawObject[] = [], runReports: RawObject[] = []
    let activeRun = false
    for (const value of runValues) {
      const parsed = migrationReadRun(value)
      archivedRuns.push(parsed.run); runReports.push(...parsed.reports); activeRun ||= parsed.active
    }
    const activeLease = migrationReadLeaseActive(source.leases, serverNow)
    if (activeRun || activeLease) return migrationBlocked(mapId, true, 'Active Run or execution lease must be stopped before migration')

    const legacyNodes = rawNodes.map((/* 尚未解析的旧节点。 */ value) => {
      // 同次迁移只解析一份旧载荷，发布集合、正式节点及关系共用已确认的引用。
      const node = migrationObject(value, 'node'), id = migrationString(node.id, 'node.id'), data = migrationObject(node.data, 'node.data')
      const kind = migrationString(data.kind, 'node.data.kind')
      // Evidence 没有 Claim 对等字段，保持原记录并阻断显式迁移。
      if (kind !== 'source' && kind !== 'news' && kind !== 'claim' && kind !== 'verification') throw new Error(messageFormat(RuntimeMessage.VALUE_KIND_IS_INVALID, 'node.data'))
      const selectedReportIds = migrationValidateLegacyPayload(kind, data)
      return { node, id, data, kind, selectedReportIds }
    })

    const reports = new Map<string, RawObject>()
    const remember = (/* 已验证字段的历史报告。 */ report: RawObject): void => {
      // 按稳定报告身份去重，矛盾副本阻断迁移而不选择其中一份。
      const id = report.id as string, prior = reports.get(id)
      if (prior && migrationCanonical(prior) !== migrationCanonical(report)) throw new Error(RuntimeMessage.DUPLICATE_LEGACY_REPORTS)
      reports.set(id, report)
    }
    for (const report of runReports) remember(report)
    for (const { data, kind } of legacyNodes) {
      if (kind === 'verification') for (const report of migrationArray(data.opinions, 'verification.opinions')) remember(migrationReadReport(report))
    }
    const published = new Set<string>()
    for (const { selectedReportIds } of legacyNodes) {
      for (const id of selectedReportIds) {
        if (!reports.has(id)) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
        published.add(id)
      }
    }
    const reportIds = Object.fromEntries([...published].map(/* 已发布旧报告的稳定身份。 */ id =>
      /* 为正式意见节点分配新身份，并保存旧到新的映射。 */ [id, randomUUID()],
    ))
    const nodeKinds = new Map<string, string>(), nodes: RawObject[] = [], legacyProducers: Array<[string, unknown]> = []
    for (const { node, id, data, kind, selectedReportIds } of legacyNodes) {
      nodeKinds.set(id, kind)
      const payload = structuredClone(data) as RawObject
      delete payload.kind
      const opinionIds = selectedReportIds.map((/* 已验证并去重的旧报告身份。 */ reportId) =>
        /* 发布集合已为每个报告分配本次正式意见身份。 */ reportIds[reportId])
      if (kind === 'verification') {
        Object.assign(payload, { opinionIds })
        delete payload.reportIds; delete payload.opinions
      }
      const { data: _data, producer, ...envelope } = node
      if (producer !== undefined) legacyProducers.push([id, structuredClone(producer)])
      nodes.push({ ...structuredClone(envelope), id, revision: migrationRevision(node.revision, 'node.revision'),
        typeId: `factcheck.${kind}`, typeVersion: migrationDataVersion, payload,
        payloadReferences: opinionIds.map((/* 本次结论实际发布的意见身份。 */ targetId) =>
          /* 复用已确认的正式引用，不再验证自建数组。 */ ({ path: '/opinionIds/*', targetId })),
        createdAt: migrationTime(node.createdAt, 'node.createdAt'), updatedAt: migrationTime(node.updatedAt, 'node.updatedAt') })
    }
    for (const legacyId of published) {
      const report = reports.get(legacyId), id = reportIds[legacyId]
      if (!report) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
      nodeKinds.set(id, 'opinion')
      nodes.push({ id, revision: 0, typeId: 'factcheck.opinion', typeVersion: migrationDataVersion,
        payload: { score: report.score, reason: report.reason, evidenceClaimIds: [], legacy: {
          reportId: report.id, slotId: report.slotId, routeRevision: report.routeRevision, agentId: report.agentId,
          agentName: report.agentName, angle: report.angle, tools: report.tools, createdAt: report.createdAt,
        } }, payloadReferences: [], createdAt: report.createdAt, updatedAt: report.createdAt })
    }
    const rawEdges = sourceEdges.map(/* 存储中的未知旧关系记录。 */ value => {
      // 验证旧关系身份、端点和方向，保证转换后仍引用同一批正式节点。
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
    const edges: RawObject[] = rawEdges.map(/* 已验证的旧关系及其原始身份。 */ edge =>
      /* 保留关系身份，按通用后继方向或引用关系重建外壳。 */ ({ id: edge.id, revision: edge.revision,
      kind: edge.legacyKind === 'derived-from' || edge.legacyKind === 'mentions' ? 'successor' : 'reference',
      from: edge.legacyKind === 'derived-from' ? edge.to : edge.from, to: edge.legacyKind === 'derived-from' ? edge.from : edge.to,
      label: `legacy:${edge.legacyKind}`, createdAt: edge.createdAt, updatedAt: edge.updatedAt }),
    )
    for (const { node, id: verificationId, kind, selectedReportIds } of legacyNodes) {
      if (kind !== 'verification') continue
      const claims = rawEdges.filter(/* 已验证的旧关系。 */ edge =>
        /* 取得当前结论原来核查的全部事实。 */ edge.legacyKind === 'verifies' && edge.from === verificationId,
      ).map(/* 当前结论的一条事实引用关系。 */ edge =>
        /* 关系端点已在读取时验证为文本身份。 */ edge.to,
      )
      for (const legacyId of selectedReportIds) {
        const opinionId = reportIds[legacyId], report = reports.get(legacyId)
        if (!report) throw new Error(RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
        edges.push({ id: randomUUID(), revision: 0, kind: 'successor', from: opinionId, to: verificationId,
          label: 'legacy:opinion-verification', createdAt: report.createdAt, updatedAt: migrationTime(node.updatedAt, 'verification.updatedAt') })
        for (const claimId of claims) edges.push({ id: randomUUID(), revision: 0, kind: 'successor', from: claimId, to: opinionId,
          label: 'legacy:claim-opinion', createdAt: report.createdAt, updatedAt: migrationTime(node.updatedAt, 'verification.updatedAt') })
      }
    }
    const currentRuns = archivedRuns.slice(0, runCollections.runs.length)
    const history = archivedRuns.slice(runCollections.runs.length)
    const document = structuredClone(source) as RawGraph
    delete document.run
    Object.assign(document, { nodes, edges, retiredNodeIds: [], retiredEdgeIds: [], runs: currentRuns, runHistory: history, leases: {}, revision: revision + 1,
      updatedAt: new Date(serverNow).toISOString(), dataFormat: 4,
      migration: { kind: 'generic-data-v4', migratedAt: new Date(serverNow).toISOString(), legacyReportIds: reportIds,
        ...(legacyProducers.length ? { legacyProducers: Object.fromEntries(legacyProducers) } : {}) } })
    return { status: 'migrate', mapId, expectedRevision: revision, document, reportIds }
  } catch (error) {
    return migrationBlocked(mapId, false, error instanceof Error ? error.message : RuntimeMessage.STORED_RUN_DATA_DOES_NOT_MATCH_THE_SUPPORTED_LEGACY_SCHEMA)
  }
}

/** Inspect or atomically apply all generic-data migrations through the configured Persistence adapter. */
/**
 * @param database Mongo 或 SQLite 的通用持久化实例。
 * @param apply true 才实际写入，false 只预览。
 * @param legacyDefinitions 部署默认包，为旧工作区原子安装数据定义。
 */
export async function migrationMigrateBranches(
  /* 此次离线迁移独占的 Mongo 或 SQLite 持久化入口。 */ database: Persistence,
  /* false 只预览，true 在同一事务中更新图及其定义。 */ apply: boolean,
  /* 安装历史节点所需精确数据类型的部署包。 */ legacyDefinitions: DefinitionPackage,
): Promise<BranchMigrationSummary> {
  // 一次检查全部图，任何图存在活动运行、租约或歧义时不写入任何候选。
  /**
   * @param session 预览时为 null，应用时为同一原子事务会话。
   */
  const execute = async (session: Parameters<ReturnType<Persistence['records']>['list']>[1] = null) => {
    const records = database.records<RawGraph>(GRAPH_COLLECTION), workspaces = database.records<RawWorkspace>('control_workspaces'), now = await database.now()
    let plans = (await records.list({}, session)).map(row => migrationPlanBranchGraph(row, now))
    const workspaceChanges = new Map<string, { expectedRevision: number; document: RawWorkspace }>()
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
