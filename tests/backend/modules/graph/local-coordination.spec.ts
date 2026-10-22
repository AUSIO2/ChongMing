// 本机用户不管理租约，仍通过真实 HTTP/SQLite 验证内容冲突与 Run 范围隔离。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { clientCreateApi } from '../../../../client/graph-client'
import { GRAPH_COLLECTION, type GraphDocument } from '../../../../backend/modules/graph/graph-record'
import { verificationConfiguration } from '../../fixtures/verification'
import type { GraphRunPlan } from '../../../../contracts/graph-run'
import { modelCreateSecretCodec } from '../../../../backend/adapters/identity/model-secrets'

let directory: string, database: ReturnType<typeof sqliteCreatePersistence>
let app: ReturnType<typeof applicationCreateLocalService>, server: ReturnType<typeof apiCreateServer>
let client: ReturnType<typeof clientCreateApi>, workspaceId: string, userId: string, userToken: string
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'local-coordination-'))
  database = sqliteCreatePersistence(directory)
  app = applicationCreateLocalService(database, { modelSecrets: modelCreateSecretCodec(Buffer.alloc(32, 19)) })
  await app.initialize(); await app.control.seed(verificationConfiguration()); await app.startMessaging()
  const user = await app.auth.createUser({ id: randomUUID(), displayName: 'Local editor', hostAdmin: true })
  userId = user.userId; userToken = (await app.auth.createToken(userId)).token
  server = apiCreateServer(app, { internalToken: randomUUID() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Local API address missing')
  client = clientCreateApi({ baseUrl: 'http://127.0.0.1:' + address.port, token: userToken })
  workspaceId = (await client.dispatch(randomUUID(), 'workspace.create', {
    id: randomUUID(), name: 'Local', description: '', agentSource: 'library',
  })).data.id
  await client.dispatch(randomUUID(), 'model.update', { scope: { kind: 'workspace', workspaceId }, expectedRevision: 0,
    configuration: { provider: 'deepseek-official', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: 'fake-local-coordination-key' } })
})
afterAll(async () => {
  client?.close()
  server?.closeAllConnections()
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  await app?.closeMessaging(); await database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function createRoots() {
  const workspace = await client.read('workspace.get', { workspaceId }), mapId = randomUUID()
  const roots = [randomUUID(), randomUUID()]
  await client.dispatch(randomUUID(), 'map.create', { id: mapId, workspaceId, expectedRevision: workspace.revision, name: 'Local roots' })
  await client.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: roots, expectedVersion: null },
    changes: { nodes: { put: roots.map(id => ({ id, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Fact', category: null } })) } } })
  return { mapId, roots }
}
function plan(nodeId: string): GraphRunPlan {
  return { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
    input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [nodeId] } }],
    context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] }
}

describe('local client coordination', () => {
  it('records the authenticated creator for manual opinions and conclusions and retains it after editing', async () => {
    // 同次人工补录意见及结论后经独立公开查询核对真实身份，后续编辑不改变创建来源。
    const workspace = await client.read('workspace.get', { workspaceId }), mapId = randomUUID()
    const opinionId = randomUUID(), conclusionId = randomUUID()
    await client.dispatch(randomUUID(), 'map.create', { id: mapId, workspaceId, expectedRevision: workspace.revision, name: '人工补录' })
    const opinion = { id: opinionId, typeId: 'factcheck.opinion', typeVersion: 1, payload: { score: 1, reason: '人工核对', evidenceClaimIds: [] } }
    const conclusion = { id: conclusionId, typeId: 'factcheck.verification', typeVersion: 1, payload: { score: 1, reason: '人工汇总', opinionIds: [opinionId] } }
    await client.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [opinionId], expectedVersion: null },
      changes: { nodes: { put: [opinion, conclusion] }, edges: { put: [{ id: randomUUID(), kind: 'successor', from: opinionId, to: conclusionId }] } } })
    const saved = await client.read('map.get', { mapId })
    for (const node of saved.nodes) {
      expect(node).toHaveProperty('manualOrigin', { userId })
      expect(node).not.toHaveProperty('producer')
    }
    const branch = await client.read('branch.get', { mapId, rootIds: [opinionId] })
    const editor = await app.auth.createUser({ id: randomUUID(), displayName: '另一位编辑', hostAdmin: false })
    const currentWorkspace = await client.read('workspace.get', { workspaceId })
    await client.dispatch(randomUUID(), 'member.set', { workspaceId, expectedRevision: currentWorkspace.revision, userId: editor.userId, role: 'editor' })
    const editorToken = (await app.auth.createToken(editor.userId)).token
    await app.dispatch(editorToken, { requestId: randomUUID(), method: 'graph.apply', params: {
      mapId, branch: { rootIds: [opinionId], expectedVersion: branch.version },
      changes: { nodes: { put: [{ ...opinion, payload: { ...opinion.payload, reason: '另一编辑补充理由' } }] } },
    } })
    expect((await client.read('map.get', { mapId })).nodes.find((/* 重读同一意见。 */ node) => /* 身份仍是原节点。 */ node.id === opinionId))
      .toHaveProperty('manualOrigin', { userId })
  })

  it('does not relabel automatic or unknown historical nodes when a user edits them', async () => {
    // 持久化夹具分别表示已有自动产物和无来源旧数据，人工编辑不能冒充创建动作。
    const { mapId, roots } = await createRoots()
    const producer = { operationId: randomUUID(), transitionRef: { id: 'factcheck.split-news', version: 1 },
      stageId: 'extract', workId: randomUUID(), agentRef: { id: 'split-data', version: 0 }, agentName: '既有拆分代理' }
    await database.records<GraphDocument & { _id: string }>(GRAPH_COLLECTION).change(mapId, (/* 本例独有的持久化图。 */ document) => {
      // 模拟升级前已存在的数据，不触及其他图或运行记录。
      const nodes = document.nodes.map((/* 需保留原创建含义的节点。 */ node, /* 决定两类历史来源的数组位置。 */ index) => {
        // 历史缺少人工标记时不补造创建者，自动节点保留原producer。
        const result = { ...node, ...(index === 0 ? { producer } : {}) }
        Reflect.deleteProperty(result, 'manualOrigin')
        return result
      })
      return { ...document, nodes }
    })
    const branch = await client.read('branch.get', { mapId, rootIds: roots })
    await client.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: roots, expectedVersion: branch.version },
      changes: { nodes: { put: roots.map((/* 被人工修订正文的历史节点。 */ id) => /* 不提交任何创建来源字段。 */
        ({ id, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '人工修订旧内容', category: null } })) } } })
    const saved = await client.read('map.get', { mapId })
    expect(saved.nodes.find((/* 旧自动产物。 */ node) => /* 对应最初来源身份。 */ node.id === roots[0])).toHaveProperty('producer', producer)
    for (const node of saved.nodes) expect(node).not.toHaveProperty('manualOrigin')
  })

  it('rejects client supplied creation provenance before adding a node', async () => {
    // 节点写入白名单禁止客户端自称创建者或伪造代理产物。
    const { mapId } = await createRoots(), before = await client.read('map.get', { mapId })
    for (const metadata of [{ manualOrigin: { userId: randomUUID() } }, { producer: { agentName: '伪造代理' } }]) {
      const id = randomUUID(), node = { id, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '伪造来源', category: null }, ...metadata }
      await expect(client.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [id], expectedVersion: null },
        changes: { nodes: { put: [node] } } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    }
    expect(await client.read('map.get', { mapId })).toEqual(before)
  })

  // 通过真实本机服务验证能力声明及既有租约、分支和运行约束。
  it('declares the evidence library unavailable when the local service has no query adapter', async () => {
    // 本机装配未提供证据查询适配器，启动信息必须明确声明不可用。
    const bootstrap = await client.read('app.bootstrap', {})
    expect(bootstrap.metadata).toMatchObject({ capabilities: { evidenceLibrary: false, mapRename: true } })
  })

  it('renames and deletes local maps while active Runs still block both actions', async () => {
    // 本机无客户端租约，图生命周期动作仍遵守内容版本和活动 Run 保护。
    const { mapId, roots } = await createRoots(), before = await client.read('map.get', { mapId })
    const renamed = await client.dispatch(randomUUID(), 'map.rename', { mapId, expectedRevision: before.revision, name: '本机改名' })
    expect(renamed.data.snapshot).toMatchObject({ name: '本机改名', nodes: before.nodes, revision: before.revision + 1 })
    const branch = await client.read('branch.get', { mapId, rootIds: [roots[0]] }), runId = randomUUID()
    const started = await client.dispatch(randomUUID(), 'run.start', { mapId, id: runId,
      branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, scope: { nodeIds: [roots[0]] }, plan: plan(roots[0]), mode: 'auto' })
    await expect(client.dispatch(randomUUID(), 'map.rename', { mapId, expectedRevision: started.data.snapshot.revision, name: '活动时改名' }))
      .rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    await expect(client.dispatch(randomUUID(), 'map.delete', { mapId, expectedRevision: started.data.snapshot.revision }))
      .rejects.toMatchObject({ code: 'RUN_ACTIVE' })
    const cancelled = await client.dispatch(randomUUID(), 'run.cancel', { mapId, runId })
    const requestId = randomUUID(), params = { mapId, expectedRevision: cancelled.data.snapshot.revision }
    expect((await client.dispatch(requestId, 'map.delete', params)).data).toEqual({ mapId, deleted: true })
    expect((await client.dispatch(requestId, 'map.delete', params)).replayed).toBe(true)
    await expect(client.read('map.get', { mapId })).rejects.toMatchObject({ code: 'MAP_NOT_FOUND' })
  })

  it('edits without client leases while rejecting stale branch versions', async () => {
    expect((await client.read('app.bootstrap', {})).metadata.clientLeases).toBe('none')
    const { mapId, roots } = await createRoots()
    const branch = await client.read('branch.get', { mapId, rootIds: [roots[0]] })
    const params = { mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
      changes: { nodes: { put: [{ id: roots[0], typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Edited locally', category: null } }] } } }
    const written = await client.dispatch(randomUUID(), 'graph.apply', params)
    expect(written.data.snapshot).toMatchObject({ ownershipRevision: 0, ownerships: [], runControls: [] })
    await expect(client.dispatch(randomUUID(), 'graph.apply', params)).rejects.toMatchObject({ code: 'BRANCH_VERSION_CONFLICT' })
    await expect(client.dispatch(randomUUID(), 'branch.claim', { mapId, rootIds: [roots[0]], holderId: randomUUID() }))
      .rejects.toMatchObject({ code: 'CLIENT_LEASES_DISABLED' })
  })

  it('starts and controls Runs directly while protecting overlapping branches and root deletion', async () => {
    const { mapId, roots } = await createRoots()
    const branch = await client.read('branch.get', { mapId, rootIds: [roots[0]] })
    const start = { mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
      scope: { nodeIds: [roots[0]] }, plan: plan(roots[0]), mode: 'auto' as const }
    const competing = await Promise.allSettled([randomUUID(), randomUUID()].map(id => client.dispatch(randomUUID(), 'run.start', { ...start, id })))
    expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(competing.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'BRANCH_BUSY' } })
    const first = competing.find(result => result.status === 'fulfilled')!
    if (first.status !== 'fulfilled') throw new Error('Run start missing')
    expect(first.value.data.runControl).toBeUndefined()
    const runId = first.value.data.snapshot.runs[0].id
    expect(first.value.data.snapshot.runControls).toEqual([])
    await expect(client.dispatch(randomUUID(), 'graph.apply', { mapId, branch: start.branch, changes: { nodes: { remove: [roots[0]] } } }))
      .rejects.toMatchObject({ code: 'BRANCH_BUSY' })
    await expect(client.dispatch(randomUUID(), 'run.control.claim', { mapId, runId, holderId: randomUUID() }))
      .rejects.toMatchObject({ code: 'CLIENT_LEASES_DISABLED' })
    const secondBranch = await client.read('branch.get', { mapId, rootIds: [roots[1]] }), secondRunId = randomUUID()
    await client.dispatch(randomUUID(), 'run.start', { ...start, id: secondRunId,
      branch: { rootIds: [roots[1]], expectedVersion: secondBranch.version }, scope: { nodeIds: [roots[1]] }, plan: plan(roots[1]) })
    const paused = await client.dispatch(randomUUID(), 'run.pause', { mapId, runId })
    expect(paused.data.snapshot.runs.find(run => run.id === runId)?.paused).toBe(true)
    expect(paused.data.snapshot.runs.find(run => run.id === secondRunId)?.paused).toBe(false)
    await client.dispatch(randomUUID(), 'run.resume', { mapId, runId })
    await client.dispatch(randomUUID(), 'run.cancel', { mapId, runId })
    const finished = await client.dispatch(randomUUID(), 'run.cancel', { mapId, runId: secondRunId })
    expect(finished.data.snapshot.ownerships).toEqual([])
    expect(finished.data.snapshot.runControls).toEqual([])
  })

  it('does not revive client leases stored by an earlier local version', async () => {
    const { mapId, roots } = await createRoots(), leaseId = randomUUID()
    await database.records<GraphDocument & { _id: string }>(GRAPH_COLLECTION).change(mapId, doc => ({
      ...doc, ownershipRevision: 3, branchOwnerships: { [leaseId]: { leaseId, kind: 'editor', rootIds: [roots[0]],
        ownerUserId: userId, holderId: randomUUID(), fence: 3, expiresAt: '2999-01-01T00:00:00.000Z', leaseMs: 30_000 } },
    }))
    expect((await app.readSnapshot(userToken, mapId)).ownerships).toEqual([])
    const branch = await client.read('branch.get', { mapId, rootIds: [roots[0]] })
    const result = await client.dispatch(randomUUID(), 'graph.apply', { mapId,
      branch: { rootIds: [roots[0]], expectedVersion: branch.version },
      changes: { nodes: { put: [{ id: roots[0], typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'No stale lock', category: null } }] } } })
    expect(result.data.snapshot.ownerships).toEqual([])
    expect(Object.values((await app.store.read(mapId))!.branchOwnerships ?? {})).toEqual([])
  })
})
