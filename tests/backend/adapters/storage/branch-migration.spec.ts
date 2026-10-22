// 验证统一迁移保留旧运行与报告，拒绝歧义，并在 Mongo/SQLite 保持同一原子边界。
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { afterEach, describe, expect, it } from 'vitest'

import { DEFAULT_DEFINITION_PACKAGE } from '../../../../apps/config/default-prompts'
import { migrationMigrateBranches, migrationPlanBranchGraph } from '../../../../backend/adapters/storage/branch-migration'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { GRAPH_COLLECTION } from '../../../../backend/modules/graph/graph-record'
import type { Persistence } from '../../../../backend/ports/persistence'

interface FixtureDatabase { name: string; database: Persistence; close(): Promise<void> }
type StoredRecord = { _id: string; [key: string]: unknown }
interface LegacyNode { id: string; revision: number; data: Record<string, unknown>; createdAt: string; updatedAt: string }
const open: FixtureDatabase[] = []
const now = Date.parse('2026-09-28T00:00:00.000Z')

afterEach(async () => {
  // 释放每例创建的存储和子进程，阻断图不会污染下一例迁移扫描。
  for (const fixture of open.splice(0).reverse()) await fixture.close()
})

async function databases(): Promise<FixtureDatabase[]> {
  // 同一行为用例在独立 SQLite 文件和 Mongo 副本集上执行。
  const directory = await mkdtemp(path.join(tmpdir(), 'branch-migration-')), sqlite = sqliteCreatePersistence(directory)
  const local: FixtureDatabase = { name: 'SQLite', database: sqlite, close: async () => {
    // 关闭 SQLite 后删除本例创建的临时目录。
    await sqlite.close(); await rm(directory, { recursive: true, force: true })
  } }
  open.push(local)
  const mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const connection = await storeCreateConnection(mongo.getUri('branch_migration_' + randomUUID()))
  const remote: FixtureDatabase = { name: 'Mongo', database: persistenceCreateMongo(connection), close: async () => {
    // 关闭连接后停止本例创建的 Mongo 副本集。
    try { await connection.close() }
    finally { await mongo.stop() }
  } }
  open.push(remote)
  return [local, remote]
}

function report(
  /* 旧报告的业务身份。 */ id: string,
  /* 同身份报告的内容，可用于制造冲突。 */ reason = 'Checked evidence',
) {
  // 构造可迁移的已接受报告，保留其 Agent、槽位与路由信息。
  return { id, slotId: 'slot-a', agentId: 'agent-a', agentName: 'Archive agent', angle: 'source quality', tools: ['search', 'search'],
    routeRevision: 2, score: 0.5, reason, createdAt: '2026-09-01T00:00:00.000Z' }
}

function legacyGraph() {
  // 构造带已发布意见和未发布候选的旧图，每次使用独立的业务身份。
  const mapId = randomUUID(), sourceId = randomUUID(), newsId = randomUUID(), claimId = randomUUID(), verificationId = randomUUID()
  const finalReport = report('legacy-report'), candidate = { ...report('candidate-only'), slotId: 'slot-b' }
  const time = '2026-09-02T00:00:00.000Z', runId = randomUUID()
  const nodes: LegacyNode[] = [
    { id: sourceId, revision: 1, data: { kind: 'source', locator: { kind: 'url', url: 'https://example.com/source' }, label: 'Source' }, createdAt: time, updatedAt: time },
    { id: newsId, revision: 2, data: { kind: 'news', content: 'Article', context: {} }, createdAt: time, updatedAt: time },
    { id: claimId, revision: 3, data: { kind: 'claim', content: 'Claim', category: null }, createdAt: time, updatedAt: time },
    { id: verificationId, revision: 4, data: { kind: 'verification', score: 0.5, reason: 'Conclusion', reportIds: [finalReport.id, finalReport.id], opinions: [finalReport, finalReport] }, createdAt: time, updatedAt: time },
  ]
  const edges = [
    { id: randomUUID(), revision: 0, kind: 'derived-from', from: newsId, to: sourceId, createdAt: time, updatedAt: time },
    { id: randomUUID(), revision: 0, kind: 'derived-from', from: claimId, to: newsId, createdAt: time, updatedAt: time },
    { id: randomUUID(), revision: 0, kind: 'mentions', from: newsId, to: claimId, createdAt: time, updatedAt: time },
    { id: randomUUID(), revision: 0, kind: 'verifies', from: verificationId, to: claimId, createdAt: time, updatedAt: time },
  ]
  const run = { id: runId, scope: { nodeIds: [claimId] }, until: 'verified', paused: false, regenerate: false, mode: 'auto', status: 'completed',
    configuration: { tools: [] }, operations: [{ id: randomUUID(), kind: 'verify', targetId: claimId, reports: [finalReport, candidate],
      review: { id: randomUUID(), kind: 'result', state: 'answered', decision: 'approve' } }],
    createdAt: time, updatedAt: time }
  return { _id: mapId, id: mapId, workspaceId: randomUUID(), revision: 8, name: 'Legacy', nodes, edges, run, runHistory: [] as typeof run[],
    leases: { expired: { workId: 'legacy-work', mapId, runId, operationId: run.operations[0].id, actor: { role: 'worker', slotId: 'slot-a' },
      routeRevision: 2, hostId: 'old-host', holderId: 'old-holder', fence: 1, expiresAt: '2026-09-03T00:00:00.000Z', leaseMs: 30_000 } },
    receipts: [{ requestId: 'keep', method: 'graph.apply', inputHash: 'hash', createdNodeIds: [verificationId], createdEdgeIds: [], createdAt: time }],
    createdAt: time, updatedAt: time }
}

function legacyGraphWithEvidence() {
  // 保留旧 Evidence 的原材料定位和采集时间，验证退役时不会丢失这些字段。
  const graph = legacyGraph()
  graph.nodes.push({ id: randomUUID(), revision: 1,
    data: { kind: 'evidence', content: 'Original evidence', locator: { kind: 'url', url: 'https://example.com/evidence' }, capturedAt: graph.createdAt },
    createdAt: graph.createdAt, updatedAt: graph.updatedAt })
  return graph
}

async function insertLegacy(
  /* 当前测试独占的存储适配器。 */ database: Persistence,
  /* 待迁移的原图及它关联的工作区身份。 */ graph: StoredRecord & { workspaceId: string; updatedAt: string },
): Promise<void> {
  // 安装图与空定义工作区，让真实迁移负责原子安装历史类型。
  await database.records<StoredRecord>('control_workspaces').insert({ _id: graph.workspaceId, revision: 2,
    definitionPackages: [], definitionAgents: [], updatedAt: graph.updatedAt })
  await database.records<StoredRecord>(GRAPH_COLLECTION).insert(graph)
}

async function command(
  /* 要执行的实际应用入口和参数。 */ args: string[],
  /* 管理命令经标准输入接收的 JSON。 */ input: unknown,
  /* 本例临时数据库和配置的环境覆盖。 */ env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; output: string; errors: string }> {
  // 运行实际 CLI，等待退出并收集诊断，调用者负责数据库和目录生命周期。
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } })
  let output = '', errors = ''
  child.stdout.on('data', /* 子进程的一段标准输出。 */ chunk => { /* 保存结构化结果。 */ output += chunk.toString() })
  child.stderr.on('data', /* 子进程的一段诊断输出。 */ chunk => { /* 为失败断言保留原因。 */ errors += chunk.toString() })
  const exited = new Promise<number | null>((/* 返回退出码。 */ resolve, /* 转交启动失败。 */ reject) => {
    // 监听启动失败与退出，防止测试遗漏子进程错误。
    child.once('error', reject); child.once('exit', resolve)
  })
  child.stdin.end(JSON.stringify(input))
  return { code: await exited, output, errors }
}

describe('Unified legacy data migration', () => {
  // 覆盖旧单 Run、多 Run 与现行 envelope，以及真实存储事务和命令入口。
  it('deduplicates published reports, keeps candidates archived, and rejects contradictory reports', () => {
    // 同一报告只发布一个意见；不把运行中的候选产物冒充正式数据。
    const fixture = legacyGraph(), plan = migrationPlanBranchGraph(fixture, now)
    expect(plan.status).toBe('migrate')
    if (plan.status !== 'migrate') throw new Error('expected migration plan')
    expect(Object.keys(plan.reportIds)).toEqual(['legacy-report'])
    expect(plan.document).toMatchObject({ runs: [{ id: fixture.run.id, legacyArchive: fixture.run }] })
    expect(JSON.stringify(plan.document.nodes)).not.toContain('candidate-only')
    fixture.run.operations[0].reports[0] = { ...fixture.run.operations[0].reports[0], reason: 'Conflicting copy' }
    expect(migrationPlanBranchGraph(fixture, now)).toMatchObject({ status: 'blocked', activeRun: false })
    const unsupported = legacyGraph()
    unsupported.nodes[2].data.category = 'old-free-form-category'
    expect(migrationPlanBranchGraph(unsupported, now)).toMatchObject({ status: 'blocked', activeRun: false })
  })

  it('blocks retired legacy Evidence without converting or deleting its source metadata', () => {
    // 旧 Evidence 缺少无损 Claim 映射，纯迁移预览保留输入及其全部材料字段。
    const graph = legacyGraphWithEvidence(), before = structuredClone(graph)
    expect(migrationPlanBranchGraph(graph, now)).toMatchObject({ status: 'blocked', activeRun: false })
    expect(graph).toEqual(before)
  })

  it('keeps generic v1 Evidence, Opinion references and frozen definitions unchanged', () => {
    // 退役默认类型只影响新定义，现行通用 v1 节点及运行定义不会被自动重写。
    const { run: _run, ...graph } = legacyGraph(), evidenceId = randomUUID(), opinionId = randomUUID()
    const current = { ...graph, nodes: [
      { id: evidenceId, revision: 1, typeId: 'factcheck.evidence', typeVersion: 1,
        payload: { content: 'Historical evidence', locator: { kind: 'url', url: 'https://example.com/evidence' }, capturedAt: graph.createdAt },
        payloadReferences: [], createdAt: graph.createdAt, updatedAt: graph.updatedAt },
      { id: opinionId, revision: 1, typeId: 'factcheck.opinion', typeVersion: 1,
        payload: { score: 1, reason: 'Historical judgment', evidenceIds: [evidenceId] },
        payloadReferences: [{ path: '/evidenceIds/*', targetId: evidenceId }], createdAt: graph.createdAt, updatedAt: graph.updatedAt },
    ], edges: [], leases: {}, runs: [{ id: randomUUID(), plan: { steps: [] },
      definitions: { revision: 3, packages: [{ id: 'chongming.fact-checking', version: 1 }],
        dataTypes: [{ id: 'factcheck.evidence', version: 1 }], transitions: [], index: [] },
      agents: [], steps: [], operations: [], status: 'completed' }], runHistory: [] }
    const before = structuredClone(current)
    expect(migrationPlanBranchGraph(current, now)).toMatchObject({ status: 'current' })
    expect(current).toEqual(before)
  })

  it('archives the earliest single-operation Run directly without the retired intermediate upgrade', () => {
    // 验证最早的 operation 结构直接保留身份、Review 和全部报告。
    const { run, ...graph } = legacyGraph(), { operations, scope: _scope, ...single } = run
    const original = { ...graph, run: { ...single, operation: operations[0] } }
    const plan = migrationPlanBranchGraph(original, now)
    expect(plan.status).toBe('migrate')
    if (plan.status !== 'migrate') throw new Error('expected migration plan')
    expect(plan.document).toMatchObject({ runs: [{ id: run.id, scope: run.scope, status: 'completed', operations: [], legacyArchive: original.run }] })
    expect(plan.document).not.toHaveProperty('run')
    expect(original.run).toHaveProperty('operation')
  })

  it('preserves all runs[] and runHistory after the retired intermediate upgrade', () => {
    // 复现旧命令已写 runs[] 的记录，要求多条运行与历史完整归档且不覆盖丢失。
    const { run, ...graph } = legacyGraph()
    const second = { ...structuredClone(run), id: randomUUID(), status: 'failed' }
    const history = { ...structuredClone(run), id: randomUUID(), status: 'cancelled' }
    const original = { ...graph, runs: [run, second], runHistory: [history] }
    const before = structuredClone(original), plan = migrationPlanBranchGraph(original, now)
    expect(plan.status).toBe('migrate')
    if (plan.status !== 'migrate') throw new Error('expected migration plan')
    expect(plan.document).toMatchObject({ runs: [{ id: run.id, legacyArchive: run }, { id: second.id, legacyArchive: second }],
      runHistory: [{ id: history.id, legacyArchive: history }] })
    expect(plan.document.runs).toHaveLength(2)
    expect(plan.document.runHistory).toHaveLength(1)
    expect(original).toEqual(before)
  })

  it.each(['containers', 'duplicate-id', 'operations', 'generic-run', 'malformed-runs'])('rejects ambiguous %s without changing the input', /* 歧义类型。 */ kind => {
    // 不选择其中一份数据猜测迁移，防止丢弃另一份运行或把现行计划误当旧归档。
    const fixture = legacyGraph()
    const variants: Record<string, unknown> = {
      containers: { ...fixture, runs: [] },
      'duplicate-id': { ...fixture, runHistory: [structuredClone(fixture.run)] },
      operations: { ...fixture, run: { ...fixture.run, operation: fixture.run.operations[0] } },
      'generic-run': { ...fixture, run: { ...fixture.run, plan: { steps: [] } } },
      'malformed-runs': { ...fixture, run: undefined, runs: {} },
    }
    const original = variants[kind], before = structuredClone(original)
    expect(migrationPlanBranchGraph(original, now)).toMatchObject({ status: 'blocked', activeRun: false })
    expect(original).toEqual(before)
  })

  it.each(['running', 'waiting'])('blocks a paused legacy %s Run in runs[] even after Work leases expire', /* 仍非终态的旧状态。 */ status => {
    // 暂停不等于结束，归档迁移必须阻断任一活动运行。
    const { run, ...graph } = legacyGraph()
    expect(migrationPlanBranchGraph({ ...graph, runs: [{ ...run, status, paused: true }] }, now))
      .toMatchObject({ status: 'blocked', activeRun: true })
  })

  it('converts a generic single-Run envelope without altering current execution and ownership state', () => {
    // 现行结构的运行只调整存储容器，仍有效的业务状态和归档内容保持原值。
    const first = migrationPlanBranchGraph(legacyGraph(), now)
    if (first.status !== 'migrate' || !Array.isArray(first.document.runs)) throw new Error('expected initial migration plan')
    const { runs, ...envelope } = first.document
    const prior = { ...envelope, run: runs[0], runHistory: first.document.runHistory, ownershipRevision: 4, branchOwnerships: { kept: { kind: 'run', runId: 'retained' } } }
    const plan = migrationPlanBranchGraph(prior, now)
    expect(plan.status).toBe('migrate')
    if (plan.status !== 'migrate') throw new Error('expected envelope migration')
    expect(plan.document).not.toHaveProperty('run')
    expect(plan.document).toMatchObject({ runs: [prior.run], runHistory: prior.runHistory,
      ownershipRevision: prior.ownershipRevision, branchOwnerships: prior.branchOwnerships })
    expect(migrationPlanBranchGraph({ ...prior, runs: [] }, now)).toMatchObject({ status: 'blocked' })
  })

  it('preserves runs[], history, reports and identities in Mongo and SQLite with idempotent apply', async () => {
    // 在两种真实适配器上证明 dry-run 无写入，apply 保留全部原运行和图身份。
    for (const fixture of await databases()) {
      const { run, ...graph } = legacyGraph(), historical = { ...structuredClone(run), id: randomUUID(), status: 'failed' }
      const legacy = { ...graph, runs: [run], runHistory: [historical] }
      await insertLegacy(fixture.database, legacy)
      const records = fixture.database.records<StoredRecord>(GRAPH_COLLECTION), before = await records.get(legacy._id)
      expect(await migrationMigrateBranches(fixture.database, false, DEFAULT_DEFINITION_PACKAGE)).toMatchObject({ matchedMaps: 1, migratableMaps: 1, blockedMaps: 0, modifiedMaps: 0 })
      expect(await records.get(legacy._id), fixture.name).toEqual(before)
      expect(await migrationMigrateBranches(fixture.database, true, DEFAULT_DEFINITION_PACKAGE)).toMatchObject({ modifiedMaps: 1 })
      expect(await records.get(legacy._id), fixture.name).toMatchObject({ revision: legacy.revision + 1, receipts: legacy.receipts, leases: {},
        runs: [{ id: run.id, legacyArchive: run }], runHistory: [{ id: historical.id, legacyArchive: historical }] })
      const current = await fixture.database.graph().read(legacy._id)
      if (!current) throw new Error('expected migrated graph')
      expect(current.nodes.every(/* 显式旧格式转换生成的通用节点。 */ node =>
        /* 旧格式迁移统一采用当前五类定义的开发版本。 */ node.typeVersion === 1)).toBe(true)
      expect(current.nodes.filter(/* 当前通用节点。 */ node => /* 只统计从已发布报告生成的意见。 */ node.typeId === 'factcheck.opinion')).toHaveLength(1)
      expect(current.nodes.find(/* 当前通用节点。 */ node => /* 找回唯一已发布意见。 */ node.typeId === 'factcheck.opinion')?.payload)
        .toMatchObject({ evidenceClaimIds: [] })
      expect(current.nodes.find(/* 当前通用节点。 */ node => /* 找回原结论的稳定身份。 */ node.id === legacy.nodes[3].id))
        .toMatchObject({ revision: 4, typeId: 'factcheck.verification', payload: { opinionIds: [expect.any(String)] } })
      const edgeIds = new Set<string>(legacy.edges.map(/* 旧关系记录。 */ edge => /* 收集需要保留的身份。 */ edge.id))
      expect(current.edges.filter(/* 当前关系。 */ edge => /* 只选择原有关系。 */ edgeIds.has(edge.id)))
        .toHaveLength(legacy.edges.length)
      expect(await fixture.database.records<StoredRecord>('control_workspaces').get(legacy.workspaceId))
        .toMatchObject({ definitionPackages: [{ id: 'chongming.fact-checking-data-migration', version: 1,
          dataTypes: expect.arrayContaining([
            expect.objectContaining({ id: 'factcheck.source', version: 1 }),
            expect.objectContaining({ id: 'factcheck.news', version: 1 }),
            expect.objectContaining({ id: 'factcheck.claim', version: 1 }),
            expect.objectContaining({ id: 'factcheck.opinion', version: 1 }),
            expect.objectContaining({ id: 'factcheck.verification', version: 1 }),
          ]) }] })
      expect(await migrationMigrateBranches(fixture.database, true, DEFAULT_DEFINITION_PACKAGE)).toMatchObject({ matchedMaps: 0, modifiedMaps: 0 })
    }
  })

  it.each(['active-run', 'live-lease', 'ambiguous', 'legacy-evidence'])('rejects %s atomically in Mongo and SQLite', async (/* 阻断本批迁移的条件。 */ condition) => {
    // 一个问题图会阻断同批安全图，工作区定义也不会提前安装。
    for (const fixture of await databases()) {
      const safe = legacyGraph(), { run, ...graph } = legacyGraph()
      const base = { ...graph, runs: [run] }
      const blocked = condition === 'active-run' ? { ...base, runs: [{ ...run, status: 'running', paused: true }] }
        : condition === 'live-lease' ? { ...base, leases: { work: { expiresAt: '2999-01-01T00:00:00.000Z' } } }
        : condition === 'legacy-evidence' ? legacyGraphWithEvidence() : { ...base, run }
      await insertLegacy(fixture.database, safe); await insertLegacy(fixture.database, blocked)
      const records = fixture.database.records<StoredRecord>(GRAPH_COLLECTION), before = await records.list()
      expect(await migrationMigrateBranches(fixture.database, false, DEFAULT_DEFINITION_PACKAGE), fixture.name)
        .toMatchObject({ matchedMaps: 2, migratableMaps: 1, activeRuns: condition === 'active-run' || condition === 'live-lease' ? 1 : 0,
          blockedMaps: 1, modifiedMaps: 0 })
      await expect(migrationMigrateBranches(fixture.database, true, DEFAULT_DEFINITION_PACKAGE), fixture.name)
        .rejects.toMatchObject({ code: 'DATA_MIGRATION_BLOCKED' })
      expect(await records.list(), fixture.name).toEqual(before)
      expect(await fixture.database.records<StoredRecord>('control_workspaces').get(safe.workspaceId))
        .toMatchObject({ definitionPackages: [] })
    }
  })

  it('exposes Mongo dry-run/apply and rejects the retired command before connecting', async () => {
    // 真正执行管理员入口：预览不建无关集合，退休命令和非法参数不修改记录。
    const server = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
    const uri = server.getUri('branch_admin_' + randomUUID()), connection = await storeCreateConnection(uri)
    try {
      const database = persistenceCreateMongo(connection), legacy = legacyGraph()
      await insertLegacy(database, legacy)
      const db = connection.db
      if (!db) throw new Error('expected connected database')
      const before = await db.listCollections({}, { nameOnly: true }).toArray()
      const env = { CHONGMING_MONGO_URI: uri, CHONGMING_CONFIG_DIR: path.join(tmpdir(), 'unused-branch-admin-' + randomUUID()) }
      const entry = path.resolve('apps/graph-server/admin.ts')
      const preview = await command([entry, 'data.migrate-branches'], {}, env)
      expect(preview.code, preview.errors).toBe(0)
      expect(JSON.parse(preview.output)).toMatchObject({ matchedMaps: 1, modifiedMaps: 0 })
      expect(await db.listCollections({}, { nameOnly: true }).toArray()).toEqual(before)
      const invalid = await command([entry, 'data.migrate-branches'], { apply: 'yes' }, env)
      expect(invalid.code).toBe(1)
      expect(await database.records<StoredRecord>(GRAPH_COLLECTION).get(legacy._id)).toEqual(legacy)
      const retired = await command([entry, 'data.migrate-node-runs'], {}, { ...env, CHONGMING_MONGO_URI: 'invalid-uri' })
      expect(retired.code).toBe(1)
      expect(retired.errors).toContain('Admin command failed')
      const applied = await command([entry, 'data.migrate-branches'], { apply: true }, env)
      expect(applied.code, applied.errors).toBe(0)
      expect(JSON.parse(applied.output)).toMatchObject({ modifiedMaps: 1 })
    } finally { await connection.close(); await server.stop() }
  })

  it('runs the SQLite migration offline without starting local API or Host services', async () => {
    // SQLite 管理命令持有本机数据库锁，预览与应用完成后退出，不启动服务。
    const directory = await mkdtemp(path.join(tmpdir(), 'branch-local-admin-')), database = sqliteCreatePersistence(directory)
    const legacy = legacyGraph()
    await insertLegacy(database, legacy)
    await database.close()
    try {
      const args = [path.resolve('apps/local-server/main.ts'), '--directory', directory, '--migrate-branches']
      const preview = await command(args, {})
      expect(preview.code, preview.errors).toBe(0)
      expect(JSON.parse(preview.output)).toMatchObject({ matchedMaps: 1, modifiedMaps: 0 })
      const applied = await command([...args, '--apply'], {})
      expect(applied.code, applied.errors).toBe(0)
      expect(JSON.parse(applied.output)).toMatchObject({ modifiedMaps: 1 })
      const reopened = sqliteCreatePersistence(directory)
      try { await expect(reopened.graph().read(legacy._id)).resolves.toMatchObject({ id: legacy._id, dataFormat: 4 }) }
      finally { await reopened.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})

it.each(['ordinary-node', '__proto__', 'constructor'])('preserves legacy producer metadata for admitted node identity %s', (
  /* 合法旧字符串身份，含与原型属性同名的显式键。 */ id,
) => {
  // 迁移元信息必须保持自有数据键，不能接受节点后静默丢弃旧 producer。
  const time = '2026-09-02T00:00:00.000Z'
  const producer = { marker: 'original producer' }
  const source = { _id: randomUUID(), revision: 0, nodes: [{ id, revision: 0,
    data: { kind: 'claim', content: 'Archived claim', category: null }, producer, createdAt: time, updatedAt: time }], edges: [] }
  const plan = migrationPlanBranchGraph(source, now)
  expect(plan.status).toBe('migrate')
  if (plan.status !== 'migrate') throw new Error('Expected an admitted legacy Claim migration')
  const metadata = plan.document.migration as { legacyProducers: Record<string, unknown> }
  expect(Object.hasOwn(metadata.legacyProducers, id)).toBe(true)
  expect(metadata.legacyProducers[id]).toEqual(producer)
  expect(metadata.legacyProducers[id]).not.toBe(producer)
  expect(source.nodes[0].producer).toEqual(producer)
})
