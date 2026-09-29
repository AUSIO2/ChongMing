// 验证通用数据显式迁移在 Mongo/SQLite 共用同一转换计划、事务和阻断规则。
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, describe, expect, it } from 'vitest'
import { migrationMigrateBranches, migrationPlanBranchGraph } from '../../../../backend/adapters/storage/branch-migration'
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { sqliteCreatePersistence, type SqlitePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { GRAPH_COLLECTION } from '../../../../backend/modules/graph/graph-record'
import type { Persistence } from '../../../../backend/ports/persistence'
import { DEFAULT_DEFINITION_PACKAGE } from '../../../../apps/config/default-prompts'

interface FixtureDatabase { name: string; database: Persistence; close(): Promise<void> }
const open: FixtureDatabase[] = []
afterAll(async () => {
  for (const fixture of open.reverse()) await fixture.close()
})

async function databases(): Promise<FixtureDatabase[]> {
  if (open.length) return open
  const directory = await mkdtemp(path.join(tmpdir(), 'branch-migration-'))
  const sqlite = sqliteCreatePersistence(directory)
  open.push({ name: 'SQLite', database: sqlite, close: async () => { await sqlite.close(); await rm(directory, { recursive: true, force: true }) } })
  const mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  const connection: Connection = await storeCreateConnection(mongo.getUri('branch_migration_' + randomUUID()))
  open.push({ name: 'Mongo', database: persistenceCreateMongo(connection), close: async () => { await connection.close(); await mongo.stop() } })
  return open
}

function report(/* 用于结论、Run 和矛盾用例的历史报告身份。 */ id: string, /* 可选替换理由以制造同身份矛盾。 */ reason = 'Checked evidence') {
  return { id, slotId: 'slot-a', agentId: 'agent-a', agentName: 'Archive agent', angle: 'source quality', tools: ['search', 'search'],
    routeRevision: 2, score: 0.5, reason, createdAt: '2026-09-01T00:00:00.000Z' }
}

function legacyGraph(/* 用例图身份，每个存储后端独立。 */ mapId = randomUUID()) {
  const sourceId = randomUUID(), newsId = randomUUID(), claimId = randomUUID(), verificationId = randomUUID()
  const finalReport = report('legacy-report'), candidate = { ...report('candidate-only'), slotId: 'slot-b' }
  const time = '2026-09-02T00:00:00.000Z', runId = randomUUID()
  const nodes = [
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
    configuration: { tools: [] }, operations: [{ id: randomUUID(), kind: 'verify', targetId: claimId, reports: [finalReport, candidate] }],
    createdAt: time, updatedAt: time }
  return { _id: mapId, id: mapId, workspaceId: randomUUID(), revision: 8, name: 'Legacy', nodes, edges, run, runHistory: [],
    leases: { expired: { workId: 'legacy-work', mapId, runId, operationId: run.operations[0].id, actor: { role: 'worker', slotId: 'slot-a' },
      routeRevision: 2, hostId: 'old-host', holderId: 'old-holder', fence: 1, expiresAt: '2026-09-03T00:00:00.000Z', leaseMs: 30_000 } },
    receipts: [{ requestId: 'keep', method: 'graph.apply', inputHash: 'hash', createdNodeIds: [verificationId], createdEdgeIds: [], createdAt: time }],
    createdAt: time, updatedAt: time, expected: { sourceId, newsId, claimId, verificationId, runId, edgeIds: edges.map(edge => edge.id) } }
}

describe('Generic data and branch migration', () => {
  it('plans one opinion per (Map, legacyReportId), blocks contradictions, and never publishes a Run-only candidate', () => {
    const fixture = legacyGraph(), now = Date.parse('2026-09-28T00:00:00.000Z')
    const plan = migrationPlanBranchGraph(fixture, now)
    expect(plan.status).toBe('migrate')
    if (plan.status !== 'migrate') throw new Error('expected migration plan')
    expect(Object.keys(plan.reportIds)).toEqual(['legacy-report'])
    expect((plan.document.nodes as Array<Record<string, unknown>>).filter(node => node.typeId === 'factcheck.opinion')).toHaveLength(1)
    expect((plan.document.nodes as Array<Record<string, unknown>>).some(node => JSON.stringify(node).includes('candidate-only'))).toBe(false)
    const changed = structuredClone(fixture)
    changed.run.operations[0].reports[0] = { ...changed.run.operations[0].reports[0], reason: 'Conflicting copy' }
    expect(migrationPlanBranchGraph(changed, now)).toMatchObject({ status: 'blocked', activeRun: false })
    const unsupported = structuredClone(fixture)
    unsupported.nodes[2].data.category = 'old-free-form-category'
    expect(migrationPlanBranchGraph(unsupported, now)).toMatchObject({ status: 'blocked', activeRun: false })
  })

  it('explicitly converts the prior generic single-Run envelope into runs[]', () => {
    const first = migrationPlanBranchGraph(legacyGraph(), Date.parse('2026-09-28T00:00:00.000Z'))
    if (first.status !== 'migrate') throw new Error('expected initial migration plan')
    const prior = structuredClone(first.document) as any
    prior.revision = Number(prior.revision) + 1
    prior.run = prior.runs[0]
    delete prior.runs
    const plan = migrationPlanBranchGraph(prior, Date.parse('2026-09-29T00:00:00.000Z'))
    expect(plan).toMatchObject({ status: 'migrate', expectedRevision: prior.revision })
    if (plan.status !== 'migrate') throw new Error('expected Run array migration')
    expect(plan.document).not.toHaveProperty('run')
    expect(plan.document.runs).toEqual([prior.run])
  })

  it('dry-runs and atomically applies the same identity-preserving conversion in Mongo and SQLite', async () => {
    for (const fixture of await databases()) {
      const legacy = legacyGraph(), records = fixture.database.records<any>(GRAPH_COLLECTION)
      const workspaces = fixture.database.records<any>('control_workspaces')
      await workspaces.insert({ _id: legacy.workspaceId, revision: 2, definitionPackages: [], definitionAgents: [], updatedAt: legacy.updatedAt })
      await records.insert(legacy)
      const before = structuredClone(await records.get(legacy._id))
      expect(await migrationMigrateBranches(fixture.database, false, DEFAULT_DEFINITION_PACKAGE)).toMatchObject({ matchedMaps: 1, migratableMaps: 1, blockedMaps: 0, modifiedMaps: 0 })
      expect(await records.get(legacy._id), fixture.name).toEqual(before)
      expect(await migrationMigrateBranches(fixture.database, true, DEFAULT_DEFINITION_PACKAGE)).toMatchObject({ modifiedMaps: 1 })
      const migrated = await records.get(legacy._id)
      expect(migrated.revision, fixture.name).toBe(legacy.revision + 1)
      expect(migrated.nodes.filter((node: any) => node.typeId === 'factcheck.opinion'), fixture.name).toHaveLength(1)
      expect(migrated.nodes.find((node: any) => node.id === legacy.expected.verificationId), fixture.name).toMatchObject({
        id: legacy.expected.verificationId, revision: 4, typeId: 'factcheck.verification', payload: { opinionIds: [expect.any(String)] },
      })
      expect(migrated.edges.filter((edge: any) => legacy.expected.edgeIds.includes(edge.id)).map((edge: any) => edge.id).sort(), fixture.name)
        .toEqual([...legacy.expected.edgeIds].sort())
      expect(migrated.receipts, fixture.name).toEqual(legacy.receipts)
      expect(migrated.runs[0].id, fixture.name).toBe(legacy.expected.runId)
      expect(migrated.runs[0].legacyArchive.operations[0].reports, fixture.name).toHaveLength(2)
      expect(migrated.leases, fixture.name).toEqual({})
      await expect(fixture.database.graph().read(legacy._id), fixture.name).resolves.toMatchObject({ id: legacy._id })
      expect((await workspaces.get(legacy.workspaceId)).definitionPackages, fixture.name).toMatchObject([{ id: 'chongming.fact-checking-data-migration' }])
      expect(await migrationMigrateBranches(fixture.database, true, DEFAULT_DEFINITION_PACKAGE), fixture.name).toMatchObject({ matchedMaps: 0, modifiedMaps: 0 })
    }
  }, 30_000)

  it('reports active Runs and leases during dry-run and rejects apply without modifying any candidate', async () => {
    for (const fixture of await databases()) {
      const records = fixture.database.records<any>(GRAPH_COLLECTION), safe = legacyGraph(), active = legacyGraph()
      const workspaces = fixture.database.records<any>('control_workspaces')
      await workspaces.insert({ _id: safe.workspaceId, revision: 0, definitionPackages: [], definitionAgents: [], updatedAt: safe.updatedAt })
      await workspaces.insert({ _id: active.workspaceId, revision: 0, definitionPackages: [], definitionAgents: [], updatedAt: active.updatedAt })
      active.run.status = 'running'
      active.leases.work = { expiresAt: '2999-01-01T00:00:00.000Z' }
      await records.insert(safe); await records.insert(active)
      const preview = await migrationMigrateBranches(fixture.database, false, DEFAULT_DEFINITION_PACKAGE)
      expect(preview, fixture.name).toMatchObject({ matchedMaps: 2, migratableMaps: 1, activeRuns: 1, blockedMaps: 1, modifiedMaps: 0 })
      await expect(migrationMigrateBranches(fixture.database, true, DEFAULT_DEFINITION_PACKAGE), fixture.name).rejects.toMatchObject({ code: 'DATA_MIGRATION_BLOCKED' })
      expect((await records.get(safe._id)).nodes[0], fixture.name).toHaveProperty('data')
      expect((await records.get(active._id)).nodes[0], fixture.name).toHaveProperty('data')
      expect((await workspaces.get(safe.workspaceId)).definitionPackages, fixture.name).toEqual([])
    }
  }, 30_000)

  it('exposes dry-run/apply through the explicit Mongo admin command', async () => {
    const server = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
    const uri = server.getUri('branch_admin_' + randomUUID()), connection = await storeCreateConnection(uri), database = persistenceCreateMongo(connection)
    const legacy = legacyGraph()
    await database.records<any>('control_workspaces').insert({ _id: legacy.workspaceId, revision: 0, definitionPackages: [], definitionAgents: [], updatedAt: legacy.updatedAt })
    await database.records<any>(GRAPH_COLLECTION).insert(legacy)
    async function command(/* 管理命令的输入 JSON。 */ input: unknown) {
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('apps/graph-server/admin.ts'), 'data.migrate-branches'], {
        cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CHONGMING_MONGO_URI: uri,
          CHONGMING_CONFIG_DIR: path.join(tmpdir(), 'unused-branch-admin-' + randomUUID()) },
      })
      let output = '', errors = ''
      child.stdout.on('data', chunk => { output += chunk.toString() }); child.stderr.on('data', chunk => { errors += chunk.toString() })
      const exit = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      child.stdin.end(JSON.stringify(input))
      return { code: await exit, output, errors }
    }
    try {
      const preview = await command({})
      expect(preview.code, preview.errors).toBe(0); expect(JSON.parse(preview.output)).toMatchObject({ matchedMaps: 1, modifiedMaps: 0 })
      const applied = await command({ apply: true })
      expect(applied.code, applied.errors).toBe(0); expect(JSON.parse(applied.output)).toMatchObject({ modifiedMaps: 1 })
    } finally { await connection.close(); await server.stop() }
  }, 20_000)

  it('runs the SQLite migration offline without starting local API or Host services', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'branch-local-admin-')), database = sqliteCreatePersistence(directory), legacy = legacyGraph()
    await database.records<any>('control_workspaces').insert({ _id: legacy.workspaceId, revision: 0, definitionPackages: [], definitionAgents: [], updatedAt: legacy.updatedAt })
    await database.records<any>(GRAPH_COLLECTION).insert(legacy); await database.close()
    async function command(/* 是否真正应用迁移。 */ apply: boolean) {
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('apps/local-server/main.ts'), '--directory', directory,
        '--migrate-branches', ...(apply ? ['--apply'] : [])], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', errors = ''
      child.stdout.on('data', chunk => { output += chunk.toString() }); child.stderr.on('data', chunk => { errors += chunk.toString() })
      const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      return { code, output, errors }
    }
    try {
      const preview = await command(false)
      expect(preview.code, preview.errors).toBe(0); expect(JSON.parse(preview.output)).toMatchObject({ matchedMaps: 1, modifiedMaps: 0 })
      const applied = await command(true)
      expect(applied.code, applied.errors).toBe(0); expect(JSON.parse(applied.output)).toMatchObject({ modifiedMaps: 1 })
      const reopened = sqliteCreatePersistence(directory)
      try { await expect(reopened.graph().read(legacy._id)).resolves.toMatchObject({ id: legacy._id, dataFormat: 4 }) }
      finally { await reopened.close() }
    } finally { await rm(directory, { recursive: true, force: true }) }
  }, 20_000)
})
