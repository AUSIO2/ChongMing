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
import type { GraphRunPlan } from '../../../../contracts/graph'

let directory: string, database: ReturnType<typeof sqliteCreatePersistence>
let app: ReturnType<typeof applicationCreateLocalService>, server: ReturnType<typeof apiCreateServer>
let client: ReturnType<typeof clientCreateApi>, workspaceId: string, userId: string, userToken: string
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'local-coordination-'))
  database = sqliteCreatePersistence(directory)
  app = applicationCreateLocalService(database)
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
