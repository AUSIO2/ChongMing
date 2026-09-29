// 文件职责：验证旧 Run 显式迁移的预览、身份保留、复用判定和原子拒绝。
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { repairMigrateNodeRuns } from '../../../../backend/adapters/storage/mongo/maintenance'
import { GRAPH_COLLECTION, storeCreateInputHash } from '../../../../backend/modules/graph/graph-record'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { verificationConfiguration, verificationSlots } from '../../fixtures/verification'

let mongo: MongoMemoryReplSet, connection: Connection
beforeAll(async () => {
  // 启动单节点 Mongo 副本集并连接独立迁移测试数据库。
  mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  connection = await storeCreateConnection(mongo.getUri('node_run_migration_' + randomUUID()))
}, 30_000)
afterAll(async () => {
  // 无论连接关闭是否成功，都停止临时 Mongo 副本集。
  try { await connection?.close() }
  finally { await mongo?.stop() }
})
beforeEach(async () => {
  // 清空图集合，隔离各迁移用例的历史数据。
   await connection.db!.collection(GRAPH_COLLECTION).deleteMany({}) })

function legacyMap(/* 要构造的旧 Run 状态，默认 completed；决定报告、审核与结果节点形状。 */ status: 'running' | 'waiting' | 'completed' = 'completed') {
  // 构造包含旧单 Operation、报告、审核、结果和过期租约的历史图。
  const now = '2026-08-20T10:00:00.000Z'
  const mapId = randomUUID(), targetId = randomUUID(), runId = randomUUID(), operationId = randomUUID(), resultId = randomUUID()
  const configuration = verificationConfiguration()
  const slots = verificationSlots(2)
  const reports = slots.slice(0, status === 'running' ? 1 : 2).map((/* 历史路由中的一个槽位，用来生成对应的旧核查报告。 */ slot, /* 槽位在配置数组中的位置，用于取得匹配 Agent 的展示名称。 */ index) => /* 为旧路由槽位生成具有稳定身份的已接纳报告。 */  ({
    id: operationId + ':report:1:' + slot.id, slotId: slot.id, agentId: slot.agentId, agentName: configuration.agents[index].name,
    angle: slot.angle, tools: slot.tools, routeRevision: 1, score: 0.5, reason: 'Evidence already accepted', createdAt: now,
  }))
  const review = status === 'running' ? null : { id: randomUUID(), kind: 'result', revision: 2,
    state: status === 'waiting' ? 'pending' : 'answered', decision: status === 'waiting' ? null : 'approve',
    createdAt: now, answeredAt: status === 'waiting' ? null : now }
  const operation = { id: operationId, kind: 'verify', targetId, status, inputRefs: [{ id: targetId, revision: 3 }],
    route: { revision: 1, reason: 'Frozen route', slots, approved: true }, reports,
    draft: status === 'running' ? null : { id: operationId + ':merge:1', routeRevision: 1, reportIds: reports.map(/* 历史报告对象，提取 ID 填入旧汇总草稿的引用列表。 */ report => /* 收集旧汇总草稿引用的报告身份。 */  report.id), score: 0.5, reason: 'Frozen merge' },
    review, resultNodeId: status === 'completed' ? resultId : null }
  const run = { id: runId, mode: status === 'waiting' ? 'human-in-loop' : 'auto', status, configuration, operation, createdAt: now, updatedAt: now }
  const nodes = [{ id: targetId, revision: 3, data: { kind: 'claim', content: 'Original fact', category: null }, createdAt: now, updatedAt: now }]
  if (status === 'completed') (nodes as unknown[]).push({ id: resultId, revision: 2,
    data: { kind: 'verification', score: 0.5, reason: 'Frozen merge', reportIds: reports.map(/* 历史报告对象，提取 ID 填入旧核查节点的报告列表。 */ report => /* 收集旧核查节点引用的报告身份。 */  report.id), opinions: reports }, createdAt: now, updatedAt: now })
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
  // 覆盖管理员迁移命令与底层事务迁移规则。
  it('exposes an explicit admin command whose default inspection never initializes application collections', async () => {
    // 验证管理员命令默认仅预览，不初始化无关集合；显式应用才迁移并暂停旧 Run。
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap('waiting')
    await graphs.insertOne(original)
    const collections = await connection.db!.listCollections({}, { nameOnly: true }).toArray()
    async function command(/* 通过 stdin 交给真实管理员命令的 JSON 值，可故意提供非法 apply 类型。 */ input: unknown) {
      // 运行真实管理员 CLI 并通过 stdin 提供迁移参数，收集输出及退出码。
      const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('apps/graph-server/admin.ts'), 'data.migrate-node-runs'], {
        cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
          CHONGMING_MONGO_URI: mongo.getUri(connection.name), CHONGMING_CONFIG_DIR: path.join(tmpdir(), 'unused-migration-config-' + randomUUID()) },
      })
      let output = '', errors = ''
      child.stdout.on('data', /* 管理员 CLI stdout 字节块，拼接为待断言的结构化结果。 */ chunk => {
        // 收集管理员命令的结构化标准输出。
         output += chunk.toString() })
      child.stderr.on('data', /* 管理员 CLI stderr 字节块，保存失败诊断。 */ chunk => {
        // 收集管理员命令的诊断错误文本。
         errors += chunk.toString() })
      const exited = new Promise<number | null>((/* 命令退出时兑现退出码的回调。 */ resolve, /* 命令子进程启动失败时拒绝等待的回调。 */ reject) => {
        // 把子进程退出或启动失败转为可等待结果。
         child.once('error', reject); child.once('exit', resolve) })
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
    expect((await graphs.findOne({ _id: original._id })).runs[0].paused).toBe(true)
  }, 20_000)

  it('defaults to dry-run, preserves business identities and history on apply, and is idempotent', async () => {
    // 验证默认预览无写入，应用保留图和业务身份，重复应用不再变更。
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
    expect(migrated.runs[0]).not.toHaveProperty('operation')
    expect(migrated.runs[0]).toMatchObject({ id: original.run.id, status: 'completed', paused: false, regenerate: true,
      scope: { nodeIds: [original.run.operation.targetId] }, until: 'verified', configuration: original.run.configuration })
    const operation = migrated.runs[0].operations[0]
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

  it.each([0, 2])('keeps legacy nodes behind the generic-data migration boundary after node-run repair (output revision %s)', async revision => {
    // node-run repair 只处理它的退役 Run 结构；data/kind 节点仍须经过后续显式通用数据迁移。
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
    const repaired = await graphs.findOne({ _id: original._id })
    expect(repaired!.runs[0].operations[0].inputRefs).toEqual([...original.run.operation.inputRefs].sort((a, b) => a.id.localeCompare(b.id)))
    expect(repaired!.runs[0].operations[0].outputRefs).toEqual([{ id: original.run.operation.resultNodeId, revision: 0 }])
    await expect(storeCreateGraphStore(connection).read(original._id)).rejects.toMatchObject({ code: 'NODE_SCHEMA_UNSUPPORTED' })
  })
  it.each(['running', 'waiting'] as const)('migrates an inactive-lease %s Run to paused without losing reports or Review', async /* 参数化用例给定的活动旧状态，running 与 waiting 都应迁移为暂停。 */ status => {
    // 验证活动旧 Run 以暂停状态迁移，并保留报告、审核和服务器时间基准。
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap(status)
    await graphs.insertOne(original)
    const before = await connection.db!.admin().command({ hello: 1 })
    expect(await repairMigrateNodeRuns(connection, true)).toMatchObject({ activeRuns: 1, modifiedMaps: 1 })
    const migrated = await graphs.findOne({ _id: original._id })
    expect(migrated.runs[0]).toMatchObject({ id: original.run.id, status, paused: true, regenerate: true })
    expect(migrated.runs[0].operations[0].reports).toEqual(original.run.operation.reports)
    expect(migrated.runs[0].operations[0].review).toEqual(original.run.operation.review)
    const after = await connection.db!.admin().command({ hello: 1 })
    expect(migrated.leases.original.expiresAt.getTime()).toBeGreaterThanOrEqual(before.localTime.getTime())
    expect(migrated.leases.original.expiresAt.getTime()).toBeLessThanOrEqual(after.localTime.getTime())
  })

  it('reports live leases in dry-run and refuses apply atomically using server time', async () => {
    // 验证有效租约在预览中标记阻塞，显式应用时整批迁移回滚。
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
    // 只迁移旧历史 Run，验证已经转换的当前 Run 保持原样。
    const graphs = connection.db!.collection<any>(GRAPH_COLLECTION)
    const original = legacyMap()
    await graphs.insertOne(original)
    await repairMigrateNodeRuns(connection, true)
    const current = await graphs.findOne({ _id: original._id })
    const history = legacyMap().run
    await graphs.updateOne({ _id: original._id }, { $push: { runHistory: history } })
    expect(await repairMigrateNodeRuns(connection, true)).toMatchObject({ matchedMaps: 1, matchedRuns: 1, modifiedMaps: 1 })
    const migrated = await graphs.findOne({ _id: original._id })
    expect(migrated.runs).toEqual(current.runs)
    expect(migrated.runHistory[0].operations[0].id).toBe(history.operation.id)
  })

  it.each(['operation-kind', 'missing-operation', 'input-revision', 'report-score', 'mixed-schema', 'lease-shape'])('rejects malformed legacy %s without writing', async /* 本轮要破坏的历史字段类别，决定注入哪一种不支持结构。 */ field => {
    // 逐类破坏历史结构，验证迁移明确拒绝且不写回任何数据。
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
