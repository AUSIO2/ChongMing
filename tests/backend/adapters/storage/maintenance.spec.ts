import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { repairMigrateNodeRuns } from '../../../../backend/adapters/storage/mongo/maintenance'
import { runCreateRun } from '../../../../backend/modules/graph/run-state'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../../../../backend/modules/graph/graph-record'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { verificationConfiguration, verificationSlots } from '../../fixtures/verification'

let mongo: MongoMemoryReplSet, connection: Connection
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
  connection = await storeCreateConnection(mongo.getUri('node_run_migration_' + randomUUID()))
}, 30_000)
afterAll(async () => {
  try { await connection?.close() }
  finally { await mongo?.stop() }
})
beforeEach(async () => { await connection.db!.collection(GRAPH_COLLECTION).deleteMany({}) })

function legacyMap(status: 'running' | 'waiting' | 'completed' = 'completed') {
  const now = '2026-08-20T10:00:00.000Z'
  const mapId = randomUUID(), targetId = randomUUID(), runId = randomUUID(), operationId = randomUUID(), resultId = randomUUID()
  const configuration = verificationConfiguration()
  const slots = verificationSlots(2)
  const reports = slots.slice(0, status === 'running' ? 1 : 2).map((slot, index) => ({
    id: operationId + ':report:1:' + slot.id, slotId: slot.id, agentId: slot.agentId, agentName: configuration.agents[index].name,
    angle: slot.angle, tools: slot.tools, routeRevision: 1, score: 0.5, reason: 'Evidence already accepted', createdAt: now,
  }))
  const review = status === 'running' ? null : { id: randomUUID(), kind: 'result', revision: 2,
    state: status === 'waiting' ? 'pending' : 'answered', decision: status === 'waiting' ? null : 'approve',
    createdAt: now, answeredAt: status === 'waiting' ? null : now }
  const operation = { id: operationId, kind: 'verify', targetId, status, inputRefs: [{ id: targetId, revision: 3 }],
    route: { revision: 1, reason: 'Frozen route', slots, approved: true }, reports,
    draft: status === 'running' ? null : { id: operationId + ':merge:1', routeRevision: 1, reportIds: reports.map(report => report.id), score: 0.5, reason: 'Frozen merge' },
    review, resultNodeId: status === 'completed' ? resultId : null }
  const run = { id: runId, mode: status === 'waiting' ? 'human-in-loop' : 'auto', status, configuration, operation, createdAt: now, updatedAt: now }
  const nodes = [{ id: targetId, revision: 3, data: { kind: 'claim', content: 'Original fact', category: null }, createdAt: now, updatedAt: now }]
  if (status === 'completed') (nodes as unknown[]).push({ id: resultId, revision: 2,
    data: { kind: 'verification', score: 0.5, reason: 'Frozen merge', reportIds: reports.map(report => report.id), opinions: reports }, createdAt: now, updatedAt: now })
  return { _id: mapId, workspaceId: randomUUID(), name: 'Legacy graph', revision: 9, nodes,
    edges: status === 'completed' ? [{ id: randomUUID(), kind: 'verifies', from: resultId, to: targetId, revision: 0, createdAt: now, updatedAt: now }] : [],
    run, runHistory: [] as unknown[],
    leases: { original: { workId: operationId + ':report:1:' + slots[0].id, mapId, runId, operationId,
      actor: { role: 'worker', slotId: slots[0].id }, routeRevision: 1, hostId: 'old-host', holderId: 'old-holder',
      fence: 7, expiresAt: new Date(0), leaseMs: 30_000 } },
    receipts: [{ requestId: 'original-request', method: 'data.propose', inputHash: 'original-hash',
      createdNodeIds: status === 'completed' ? [resultId] : [], createdEdgeIds: [], createdAt: now }], createdAt: new Date(now), updatedAt: new Date(now) }
}

describe('Explicit legacy node-run migration', () => {
  it('exposes an explicit admin command whose default inspection never initializes application collections', async () => {
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap('waiting')
    await graphs.insertOne(original)
    const collections = await connection.db!.listCollections({}, { nameOnly: true }).toArray()
    async function command(input: unknown) {
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('apps/graph-server/admin.ts'), 'data.migrate-node-runs'], {
        cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
          CHONGMING_MONGO_URI: mongo.getUri(connection.name), CHONGMING_CONFIG_DIR: path.join(tmpdir(), 'unused-migration-config-' + randomUUID()) },
      })
      let output = '', errors = ''
      child.stdout.on('data', chunk => { output += chunk.toString() })
      child.stderr.on('data', chunk => { errors += chunk.toString() })
      const exited = new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
      child.stdin.end(JSON.stringify(input))
      return { code: await exited, output, errors }
    }
    const dryRun = await command({})
    expect(dryRun.code, dryRun.errors).toBe(0)
    expect(JSON.parse(dryRun.output)).toMatchObject({ matchedMaps: 1, activeRuns: 1, modifiedMaps: 0 })
    expect(await graphs.findOne({ _id: original._id })).toEqual(original)
    expect(await connection.db!.listCollections({}, { nameOnly: true }).toArray()).toEqual(collections)
    const invalid = await command({ apply: 'yes' })
    expect(invalid.code).toBe(1)
    expect(await graphs.findOne({ _id: original._id })).toEqual(original)
    const applied = await command({ apply: true })
    expect(applied.code, applied.errors).toBe(0)
    expect(JSON.parse(applied.output)).toMatchObject({ modifiedMaps: 1 })
    expect((await graphs.findOne({ _id: original._id })).run.paused).toBe(true)
  }, 20_000)

  it('defaults to dry-run, preserves business identities and history on apply, and is idempotent', async () => {
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap()
    original.run.configuration.parse = { ...original.run.configuration.router, id: 'unused-parser' }
    const historical = legacyMap().run
    original.runHistory.push(historical)
    await graphs.insertOne(original)
    expect(await repairMigrateNodeRuns(connection)).toEqual({ matchedMaps: 1, matchedRuns: 2, activeRuns: 0, blockedMaps: 0, modifiedMaps: 0 })
    expect(await graphs.findOne({ _id: original._id })).toEqual(original)
    expect(await repairMigrateNodeRuns(connection, true)).toEqual({ matchedMaps: 1, matchedRuns: 2, activeRuns: 0, blockedMaps: 0, modifiedMaps: 1 })
    const migrated = await graphs.findOne({ _id: original._id })
    expect(migrated.run).not.toHaveProperty('operation')
    expect(migrated.run).toMatchObject({ id: original.run.id, status: 'completed', paused: false, regenerate: true,
      scope: { nodeIds: [original.run.operation.targetId] }, until: 'verified', configuration: original.run.configuration })
    const operation = migrated.run.operations[0]
    const { router, merger, agents, tools, maxSlots } = original.run.configuration
    expect(operation).toMatchObject(original.run.operation)
    expect(operation).toMatchObject({ splitReports: [], contentDraft: null,
      outputRefs: [{ id: original.run.operation.resultNodeId, revision: 0 }], configurationHash: storeCreateInputHash({ router, merger, agents, tools, maxSlots }) })
    expect(migrated.runHistory[0]).not.toHaveProperty('operation')
    expect(migrated.runHistory[0].id).toBe(historical.id)
    expect(migrated.runHistory[0].operations[0]).toMatchObject({ ...historical.operation, outputRefs: [] })
    expect(migrated.nodes).toEqual(original.nodes)
    expect(migrated.edges).toEqual(original.edges)
    expect(migrated.receipts).toEqual(original.receipts)
    expect(migrated.revision).toBe(original.revision + 1)
    expect(migrated.leases.original).toMatchObject({ holderId: 'old-holder', fence: 7 })
    expect(await repairMigrateNodeRuns(connection, true)).toEqual({ matchedMaps: 0, matchedRuns: 0, activeRuns: 0, blockedMaps: 0, modifiedMaps: 0 })
    expect(await graphs.findOne({ _id: original._id })).toEqual(migrated)
  })

  it.each([0, 2])('reuses only unchanged legacy outputs after canonicalizing input refs (current output revision %s)', async revision => {
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap()
    original.nodes.find(node => node.id === original.run.operation.resultNodeId)!.revision = revision
    const newsId = randomUUID(), now = original.run.updatedAt
    ;(original.nodes as unknown[]).push({ id: newsId, revision: 1, data: { kind: 'news', content: 'Original report', context: {} }, createdAt: now, updatedAt: now })
    original.edges.push({ id: randomUUID(), kind: 'mentions', from: newsId, to: original.run.operation.targetId, revision: 0, createdAt: now, updatedAt: now })
    original.run.operation.inputRefs.push({ id: newsId, revision: 1 })
    original.run.operation.inputRefs.sort((a, b) => b.id.localeCompare(a.id))
    await graphs.insertOne(original)
    await repairMigrateNodeRuns(connection, true)
    const document = (await storeCreateGraphStore(connection).read(original._id))!
    expect(document.run!.operations[0].inputRefs).toEqual([...original.run.operation.inputRefs].sort((a, b) => a.id.localeCompare(b.id)))
    expect(document.run!.operations[0].outputRefs).toEqual([{ id: original.run.operation.resultNodeId, revision: 0 }])
    const outputBefore = structuredClone(document.nodes.find(node => node.id === original.run.operation.resultNodeId))
    const next = runCreateRun(document, { mapId: document.id, expectedRevision: document.revision, id: randomUUID(),
      scope: { nodeIds: [original.run.operation.targetId] }, until: 'verified', mode: 'auto', regenerate: false }, document.run!.configuration, now)
    expect(next.run!.status).toBe(revision === 0 ? 'completed' : 'running')
    expect(next.run!.operations[0].resultNodeId).toBe(revision === 0 ? original.run.operation.resultNodeId : null)
    expect(next.run!.operations[0].reports).toEqual(revision === 0 ? original.run.operation.reports : [])
    expect(next.nodes.find(node => node.id === original.run.operation.resultNodeId)).toEqual(outputBefore)
    expect(outputBefore!.revision).toBe(revision)
  })

  it.each(['running', 'waiting'] as const)('migrates an inactive-lease %s Run to paused without losing reports or Review', async status => {
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap(status)
    await graphs.insertOne(original)
    const before = await connection.db!.admin().command({ hello: 1 })
    expect(await repairMigrateNodeRuns(connection, true)).toMatchObject({ activeRuns: 1, modifiedMaps: 1 })
    const migrated = await graphs.findOne({ _id: original._id })
    expect(migrated.run).toMatchObject({ id: original.run.id, status, paused: true, regenerate: true })
    expect(migrated.run.operations[0].reports).toEqual(original.run.operation.reports)
    expect(migrated.run.operations[0].review).toEqual(original.run.operation.review)
    const after = await connection.db!.admin().command({ hello: 1 })
    expect(migrated.leases.original.expiresAt.getTime()).toBeGreaterThanOrEqual(before.localTime.getTime())
    expect(migrated.leases.original.expiresAt.getTime()).toBeLessThanOrEqual(after.localTime.getTime())
  })

  it('reports live leases in dry-run and refuses apply atomically using server time', async () => {
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const first = legacyMap(), active = legacyMap('running')
    await graphs.insertMany([first, active])
    await graphs.updateOne({ _id: active._id }, [{ $set: { 'leases.original.expiresAt': { $add: ['$$NOW', 60_000] } } }])
    expect(await repairMigrateNodeRuns(connection)).toMatchObject({ matchedMaps: 2, blockedMaps: 1, modifiedMaps: 0 })
    await expect(repairMigrateNodeRuns(connection, true)).rejects.toMatchObject({ code: 'RUN_LEASE_ACTIVE' })
    expect(await graphs.findOne({ _id: first._id })).toEqual(first)
    const unchanged = await graphs.findOne({ _id: active._id })
    expect(unchanged.run).toEqual(active.run)
    expect(unchanged.revision).toBe(active.revision)
  })

  it('leaves an already migrated current Run untouched while upgrading legacy history', async () => {
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap()
    await graphs.insertOne(original)
    await repairMigrateNodeRuns(connection, true)
    const current = await graphs.findOne({ _id: original._id })
    const history = legacyMap().run
    await graphs.updateOne({ _id: original._id }, { $push: { runHistory: history } })
    expect(await repairMigrateNodeRuns(connection, true)).toMatchObject({ matchedMaps: 1, matchedRuns: 1, modifiedMaps: 1 })
    const migrated = await graphs.findOne({ _id: original._id })
    expect(migrated.run).toEqual(current.run)
    expect(migrated.runHistory[0].operations[0].id).toBe(history.operation.id)
  })

  it.each(['operation-kind', 'missing-operation', 'input-revision', 'report-score', 'mixed-schema', 'lease-shape'])('rejects malformed legacy %s without writing', async field => {
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const invalid: any = legacyMap()
    if (field === 'operation-kind') invalid.run.operation.kind = 'split'
    if (field === 'missing-operation') delete invalid.run.operation
    if (field === 'input-revision') invalid.run.operation.inputRefs[0].revision = '3'
    if (field === 'report-score') invalid.run.operation.reports[0].score = 99
    if (field === 'mixed-schema') invalid.run.operations = []
    if (field === 'lease-shape') invalid.leases = []
    await graphs.insertOne(invalid)
    await expect(repairMigrateNodeRuns(connection, true)).rejects.toMatchObject({ code: 'RUN_MIGRATION_INVALID' })
    expect(await graphs.findOne({ _id: invalid._id })).toEqual(invalid)
  })
})
