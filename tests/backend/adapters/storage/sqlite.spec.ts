import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { sqliteCreatePersistence, type SqlitePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { verificationConfiguration } from '../../fixtures/verification'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { localCreateRuntime } from '../../../../apps/local-server/runtime'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function sqliteCreateFixture() {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-sqlite-'))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const database = sqliteCreatePersistence(directory)
  cleanup.push(() => database.close())
  return { directory, database }
}
async function sqliteCreateApp(database: SqlitePersistence) {
  const app = applicationCreateLocalService(database, { leaseMs: 250 })
  cleanup.push(() => app.closeMessaging())
  await app.initialize(); await app.control.seed(verificationConfiguration()); await app.startMessaging()
  return app
}

describe('Independent SQLite persistence', () => {
  it('rolls back atomically, isolates asynchronous readers and persists across exclusive reopening', async () => {
    const { database, directory } = await sqliteCreateFixture()
    expect(() => sqliteCreatePersistence(directory)).toThrow()
    const records = database.records<{ _id: string; value: number }>('test')
    const changes: unknown[] = []
    database.subscribe(items => changes.push(items))
    await expect(database.transaction(async tx => { await records.insert({ _id: 'a', value: 1 }, tx); throw new Error('rollback') })).rejects.toThrow('rollback')
    expect(await records.get('a')).toBeNull()
    expect(changes).toEqual([])
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const writing = database.transaction(async tx => { await records.insert({ _id: 'a', value: 2 }, tx); entered(); await gate })
    await ready
    let readFinished = false
    const reading = records.get('a').then(value => { readFinished = true; return value })
    await Promise.resolve()
    expect(readFinished).toBe(false)
    release(); await writing
    expect(await reading).toEqual({ _id: 'a', value: 2 })
    await database.close()
    const reopened = sqliteCreatePersistence(directory)
    cleanup.push(() => reopened.close())
    expect(await reopened.records('test').get('a')).toEqual({ _id: 'a', value: 2 })
  })

  it('shares authorization transactions, idempotency, CAS and pause fences with the graph service', async () => {
    const { database, directory } = await sqliteCreateFixture(), app = await sqliteCreateApp(database)
    const user = await app.auth.createUser({ id: randomUUID(), displayName: 'Local', hostAdmin: true })
    const { token } = await app.auth.createToken(user.userId)
    const workspace = await app.auth.transact(token, ctx => app.control.createWorkspace(ctx, { id: randomUUID(), name: 'Local', description: '', agentSource: 'library' }))
    const mapId = randomUUID(), claimId = randomUUID()
    const create = { requestId: randomUUID(), method: 'map.create' as const, params: { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Local graph' } }
    expect((await app.dispatch(token, create)).replayed).toBe(false)
    expect((await app.dispatch(token, create)).replayed).toBe(true)
    await app.dispatch(token, { requestId: randomUUID(), method: 'graph.apply', params: { mapId, expectedRevision: 0,
      changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'A local fact', category: null } }] } } } })
    const runId = randomUUID()
    await app.dispatch(token, { requestId: randomUUID(), method: 'run.start', params: { mapId, expectedRevision: 1, id: runId, scope: { nodeIds: [claimId] }, until: 'verified', mode: 'auto' } })
    const work = workReadItems((await app.store.read(mapId))!)[0]
    const first = await app.graph.dispatchWork({ method: 'claim', params: { mapId, workId: work.workId, deploymentId: app.messaging().deploymentId, hostId: 'local', holderId: randomUUID() } })
    if (!('status' in first) || first.status !== 'claimed') throw new Error('Claim missing')
    const grant = first.grant
    const before = await app.readSnapshot(token, mapId)
    await expect(app.auth.transact(token, async ctx => {
      await database.records<{ _id: string; marker?: boolean }>('test').insert({ _id: 'never', marker: true }, ctx.session)
      throw new Error('reject')
    })).rejects.toThrow('reject')
    expect(await database.records('test').get('never')).toBeNull()
    await app.dispatch(token, { requestId: randomUUID(), method: 'run.pause', params: { mapId, expectedRevision: before.revision, runId } })
    expect(await app.store.readLease(mapId, grant)).toBeNull()
    await app.dispatch(token, { requestId: randomUUID(), method: 'run.resume', params: { mapId, expectedRevision: before.revision + 1, runId } })
    const second = await app.graph.dispatchWork({ method: 'claim', params: { mapId, workId: work.workId, deploymentId: app.messaging().deploymentId, hostId: 'local', holderId: randomUUID() } })
    if (!('status' in second) || second.status !== 'claimed') throw new Error('Reclaim missing')
    expect(second.grant.fence).toBeGreaterThan(grant.fence)
    await expect(app.graph.dispatchWork({ method: 'renew', params: { mapId, ...grant } })).rejects.toMatchObject({ code: 'LEASE_LOST' })
    expect(await app.store.release(mapId, grant)).toBe(false)
    const bad = { requestId: randomUUID(), method: 'graph.apply' as const, params: { mapId, expectedRevision: 0, changes: { name: 'wrong' } } }
    await expect(app.dispatch(token, bad)).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
    await app.auth.revokeToken((await app.auth.createToken(user.userId)).tokenId)
    expect((await app.readSnapshot(token, mapId)).run?.paused).toBe(false)
    await app.closeMessaging(); await database.close()
    const reopened = sqliteCreatePersistence(directory)
    cleanup.push(() => reopened.close())
    const resumed = await sqliteCreateApp(reopened)
    const claimAgain = () => resumed.graph.dispatchWork({ method: 'claim', params: { mapId, workId: work.workId,
      deploymentId: resumed.messaging().deploymentId, hostId: 'after-restart', holderId: randomUUID() } })
    expect(await claimAgain()).toMatchObject({ status: 'busy' })
    await delay(300)
    const afterCrash = await claimAgain()
    if (!('status' in afterCrash) || afterCrash.status !== 'claimed') throw new Error('Recovery claim missing')
    expect(afterCrash.grant.fence).toBeGreaterThan(second.grant.fence)
    expect((await resumed.readSnapshot(token, mapId)).nodes).toEqual(before.nodes)

  })

  it('recovers the file lock and rolls back an open transaction after SIGKILL', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-crash-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const child = spawn(process.execPath, ['--import', 'tsx', 'tests/backend/fixtures/sqlite-crash.ts', directory], { stdio: ['ignore', 'pipe', 'pipe'] })
    const ended = new Promise<void>((resolve, reject) => { child.once('exit', () => resolve()); child.once('error', reject) })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    try {
      await expect.poll(() => output, { timeout: 5000 }).toContain('transaction-open')
      expect(() => sqliteCreatePersistence(directory)).toThrow()
      child.kill('SIGKILL'); await ended
      const database = sqliteCreatePersistence(directory)
      cleanup.push(() => database.close())
      expect(await database.records('crash_test').get('committed')).toMatchObject({ value: 'retained' })
      expect(await database.records('crash_test').get('pending')).toBeNull()
    } finally { child.kill('SIGKILL'); await ended }
  })

  it('restarts a complete local service with the same identity, configuration, workspace and stored graph', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-runtime-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const one = await localCreateRuntime({ directory, port: 0, configuration: verificationConfiguration() })
    cleanup.push(() => one.close())
    const workspace = await one.application.read(one.userToken, { method: 'workspace.get', params: { workspaceId: one.workspaceId } })
    if (!('revision' in workspace)) throw new Error('Workspace missing')
    const mapId = randomUUID()
    await one.application.dispatch(one.userToken, { requestId: randomUUID(), method: 'map.create', params: { workspaceId: one.workspaceId, expectedRevision: workspace.revision, id: mapId, name: 'Survives restart' } })
    await one.close()
    const two = await localCreateRuntime({ directory, port: 0, configuration: verificationConfiguration() })
    cleanup.push(() => two.close())
    expect(two.userToken).toBe(one.userToken)
    expect(two.workspaceId).toBe(one.workspaceId)
    expect((await two.application.readSnapshot(two.userToken, mapId)).name).toBe('Survives restart')
    expect(two.application.messaging().deploymentId).toBe(one.application.messaging().deploymentId)
  })
})
