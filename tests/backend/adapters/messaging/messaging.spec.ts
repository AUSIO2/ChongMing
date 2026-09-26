import { randomUUID } from 'node:crypto'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { applicationCreateService } from '../../../../apps/graph-server/application'
import { type ApplicationService } from '../../../../backend/application/graph-application'
import { queueOpen } from '../../../../backend/adapters/messaging/rabbitmq'
import { type QueueLink } from '../../../../backend/ports/messaging'
import { GRAPH_COLLECTION, type GraphDocument } from '../../../../backend/modules/graph/graph-record'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import type { GraphClaimResult, GraphStreamEvent, QueueChange, QueueWork } from '../../../../contracts/events'
import { createGraphApi, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
const cleanup: Array<() => Promise<unknown>> = []

beforeAll(async () => { api = await createGraphApi(1500) }, 90_000)
afterEach(async () => {
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw failures[0]
})
afterAll(async () => { await api?.close() }, 30_000)

async function messagingOpenLink(application = api.application): Promise<QueueLink> {
  const link = await queueOpen({ ...api.queue, namespace: application.messaging().namespace })
  cleanup.push(() => link.close())
  return link
}

async function messagingCreatePeer(separateDatabase = false, messaging = api.queue) {
  const connection = await storeCreateConnection(separateDatabase
    ? api.mongo.getUri('messaging_' + randomUUID().replaceAll('-', '')) : api.uri)
  const application = applicationCreateService(connection, { messaging, leaseMs: 1500 })
  cleanup.push(async () => {
    await application.closeMessaging(); await connection.close()
    if (separateDatabase) await api.deleteNamespace(application.messaging().namespace)
  })
  await application.initialize()
  return { application, connection }
}

async function messagingServe(application: ApplicationService) {
  const server = apiCreateServer(application, { internalToken: api.token })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Messaging API did not bind')
  cleanup.push(async () => {
    if (!server.listening) return
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function messagingCreateMap() {
  const workspace = await api.createWorkspace()
  const mapId = randomUUID()
  expect(await api.command('map.create', {
    workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Messaging fixture',
  })).toMatchObject({ status: 201 })
  return { mapId, workspace }
}

async function messagingWatch(mapId: string, baseUrl = api.url, token = api.userToken) {
  const stop = new AbortController()
  const response = await fetch(`${baseUrl}/api/v1/maps/${mapId}/events`, {
    headers: { authorization: `Bearer ${token}` }, signal: stop.signal,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  if (!response.body) throw new Error('Missing SSE response body')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const state = { events: [] as GraphStreamEvent[], ended: false, failure: undefined as unknown }
  const done = (async () => {
    let pending = ''
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        pending = (pending + decoder.decode(item.value, { stream: true })).replaceAll('\r\n', '\n')
        let boundary: number
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const lines = pending.slice(0, boundary).split('\n')
          pending = pending.slice(boundary + 2)
          const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data) continue
          const event = JSON.parse(data) as GraphStreamEvent
          const eventName = lines.find(line => line.startsWith('event:'))?.slice(6).trim()
          expect(eventName).toBe(event.type)
          state.events.push(event)
        }
      }
    } catch (error) { if (!stop.signal.aborted) state.failure = error }
    finally { state.ended = true; reader.releaseLock() }
  })()
  cleanup.push(async () => { stop.abort(); await done })
  async function event(predicate: (value: GraphStreamEvent) => boolean) {
    await expect.poll(() => {
      const found = state.events.find(predicate)
      if (!found && state.failure) throw state.failure
      return found
    }, { timeout: 8000 }).toBeDefined()
    return state.events.find(predicate)!
  }
  return { state, done, stop, event }
}

async function messagingClearBaseline(stream: Awaited<ReturnType<typeof messagingWatch>>) {
  await stream.event(event => event.type === 'snapshot')
  await stream.event(event => event.type === 'refresh' && event.scope === 'workspace')
  await stream.event(event => event.type === 'refresh' && event.scope === 'settings')
  stream.state.events.length = 0
}

describe('RabbitMQ outbox and authenticated graph streams', () => {
  it('projects fenced activity across API peers without changing the graph and clears it on pause', async () => {
    const { mapId } = await api.createRun()
    const peer = await messagingCreatePeer()
    await peer.application.startMessaging()
    const served = await messagingServe(peer.application)
    const stream = await messagingWatch(mapId, served.url)
    await messagingClearBaseline(stream)
    const document = (await api.store.read(mapId))!
    const work = workReadItems(document)[0]
    const holderId = randomUUID()
    const claim = await api.work('claim', { mapId, workId: work.workId, holderId, hostId: 'activity',
      deploymentId: api.application.messaging().deploymentId })
    const grant = claim.body.data.grant
    const proof = { workId: grant.workId, holderId, fence: grant.fence }
    const publish = (body: unknown, fence = grant.fence, token = api.token) => fetch(api.url + '/internal/v1/activity', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'x-work-id': grant.workId, 'x-work-holder': holderId, 'x-work-fence': String(fence) }, body: JSON.stringify(body),
    })
    expect((await publish({ mapId, status: 'tool', sequence: 2 })).status).toBe(200)
    const event = await stream.event(event => event.type === 'activity' && event.items.some(item => item.status === 'tool'))
    expect(event.type).toBe('activity')
    expect(JSON.stringify(event)).not.toContain(holderId)
    expect(JSON.stringify(event)).not.toContain(api.token)
    expect((await api.store.read(mapId))!.revision).toBe(document.revision)
    expect((await publish({ mapId, status: 'model', sequence: 1 })).status).toBe(200)
    expect((await publish({ mapId, status: 'tool', sequence: 3, parameters: 'secret' })).status).toBe(400)
    expect((await publish({ mapId, status: 'secret', sequence: 3 })).status).toBe(400)
    expect((await publish({ mapId, status: 'tool', sequence: 3 }, grant.fence + 1)).status).toBe(409)
    expect((await publish({ mapId, status: 'tool', sequence: 3 }, grant.fence, api.userToken)).status).toBe(401)
    const cached = await peer.application.readActivities(api.userToken, mapId)
    expect(cached).toHaveLength(1)
    expect(cached[0]).toMatchObject({ status: 'tool', sequence: 2, nodeId: document.run!.operations[0].targetId })
    const reconnect = await messagingWatch(mapId, served.url)
    await reconnect.event(event => event.type === 'activity' && event.items.length === 1)
    stream.state.events.length = 0
    expect(await api.command('run.pause', { mapId, expectedRevision: document.revision, runId: document.run!.id })).toMatchObject({ status: 200 })
    await stream.event(event => event.type === 'snapshot' && event.snapshot.run?.paused === true)
    await stream.event(event => event.type === 'activity' && event.items.length === 0)
    expect((await publish({ mapId, status: 'model', sequence: 4 })).status).toBe(409)
    expect(await peer.application.readActivities(api.userToken, mapId)).toEqual([])
    await expect(peer.application.publishActivity(mapId, proof, 'model', 5)).rejects.toMatchObject({ code: 'LEASE_LOST' })
  })

  it('refreshes the Workspace list when another Map is created, renamed or deleted', async () => {
    const { mapId, workspace } = await messagingCreateMap()
    const stream = await messagingWatch(mapId)
    await messagingClearBaseline(stream)
    const otherId = randomUUID()
    expect(await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: otherId, name: 'Peer Map' })).toMatchObject({ status: 201 })
    await stream.event(event => event.type === 'refresh' && event.scope === 'workspace')
    stream.state.events.length = 0
    expect(await api.command('graph.apply', { mapId: otherId, expectedRevision: 0, changes: { name: 'Peer renamed' } })).toMatchObject({ status: 200 })
    await stream.event(event => event.type === 'refresh' && event.scope === 'workspace')
    stream.state.events.length = 0
    expect(await api.command('map.delete', { mapId: otherId, expectedRevision: 1 })).toMatchObject({ status: 200 })
    await stream.event(event => event.type === 'refresh' && event.scope === 'workspace')
    expect(stream.state.events.some(event => event.type === 'snapshot' && event.snapshot.mapId !== mapId)).toBe(false)
  })
  it('persists deployment identity per database and refuses claims for another deployment', async () => {
    const same = await messagingCreatePeer(), other = await messagingCreatePeer(true)
    const identity = api.application.messaging()
    expect(identity).toEqual({ version: 1, enabled: true, deploymentId: expect.any(String),
      namespace: api.queue.namespace + '.' + identity.deploymentId })
    expect(same.application.messaging()).toEqual(identity)
    expect(other.application.messaging().deploymentId).not.toBe(identity.deploymentId)
    expect(other.application.messaging().namespace).not.toBe(identity.namespace)
    const { mapId } = await api.createRun()
    const work = workReadItems((await api.store.read(mapId))!)[0]
    const result = await api.work('claim', { mapId, workId: work.workId,
      deploymentId: other.application.messaging().deploymentId, hostId: 'wrong-deployment', holderId: randomUUID() })
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.status).toBeLessThan(500)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'DEPLOYMENT_MISMATCH' } })
    expect((await api.store.read(mapId))!.leases).toEqual({})
    for (const missing of ['workId', 'mapId', 'deploymentId']) {
      const input: Record<string, string> = { mapId, workId: work.workId, deploymentId: identity.deploymentId,
        hostId: 'missing-field', holderId: randomUUID() }
      delete input[missing]
      expect((await api.work('claim', input)).status).toBe(400)
    }
  })

  it('keeps a newer pending version when an older publish is confirmed and recovers tombstones on startup', async () => {
    const { application, connection } = await messagingCreatePeer(true)
    const now = new Date().toISOString(), mapId = randomUUID()
    const document: GraphDocument = { id: mapId, workspaceId: randomUUID(), revision: 0, name: 'Before publish',
      nodes: [], edges: [], run: null, runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    expect(await application.store.create(document)).toBe(true)
    const pending = []
    for await (const item of application.store.readDispatch()) pending.push(item)
    expect(pending).toMatchObject([{ id: mapId, revision: 0, dispatchVersion: 0 }])
    await application.graph.dispatch({ requestId: randomUUID(), method: 'graph.apply',
      params: { mapId, expectedRevision: 0, changes: { name: 'Committed during publish' } } })
    expect(await application.store.clearDispatch(mapId, pending[0].dispatchVersion)).toBe(false)
    const graphs = connection.collection(GRAPH_COLLECTION)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: 1,
      name: 'Committed during publish', dispatch: { version: 1, pending: true } })
    expect(await application.store.clearDispatch(mapId, 1)).toBe(true)
    expect(await application.store.read(mapId)).toMatchObject({ revision: 1, leases: {} })
    await application.graph.dispatch({ requestId: randomUUID(), method: 'map.delete', params: { mapId, expectedRevision: 1 } })
    expect(await application.store.clearDispatch(mapId, 1)).toBe(false)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: 2, deletedAt: expect.any(Date),
      dispatch: { version: 2, pending: true } })
    const observer = await messagingOpenLink(application), changes: QueueChange[] = []
    await observer.subscribeChanges(message => changes.push(message))
    await application.startMessaging()
    await expect.poll(() => changes.find(message => message.kind === 'graph' && message.mapId === mapId), { timeout: 8000 })
      .toMatchObject({ version: 1, deploymentId: application.messaging().deploymentId, kind: 'graph', mapId })
    await expect.poll(async () => (await graphs.findOne({ _id: mapId } as never))?.dispatch, { timeout: 8000 })
      .toEqual({ version: 2, pending: false })
    expect(await application.store.read(mapId)).toMatchObject({ revision: 2, leases: {} })
  })

  it('publishes real work notices and returns claimed, busy, obsolete, then reissues resumed work', async () => {
    const observer = await messagingOpenLink(), notices: QueueWork[] = [], stop = new AbortController()
    const consume = observer.consumeWork(async message => { notices.push(message); return 'ack' }, stop.signal)
    cleanup.push(async () => { stop.abort(); await consume })
    const { mapId, runId } = await api.createRun()
    await expect.poll(() => notices.find(message => message.mapId === mapId), { timeout: 8000 }).toBeDefined()
    const notice = notices.find(message => message.mapId === mapId)!
    expect(Object.keys(notice).sort()).toEqual(['deploymentId', 'mapId', 'version', 'workId'])
    expect(notice).toMatchObject({ version: 1, deploymentId: api.application.messaging().deploymentId, mapId })
    const input = { mapId, workId: notice.workId, deploymentId: notice.deploymentId, hostId: 'claim-owner', holderId: randomUUID() }
    const claimed = (await api.work('claim', input)).body.data as GraphClaimResult
    expect(claimed.status).toBe('claimed')
    if (claimed.status !== 'claimed') throw new Error('Expected claim grant')
    const busy = (await api.work('claim', { ...input, hostId: 'contender', holderId: randomUUID() })).body.data as GraphClaimResult
    expect(busy).toMatchObject({ status: 'busy', retryAfterMs: expect.any(Number) })
    if (busy.status === 'busy') expect(busy.retryAfterMs).toBeGreaterThan(0)
    expect((await api.work('claim', input)).body.data).toEqual(claimed)
    expect((await api.work('claim', { ...input, workId: randomUUID() })).body.data).toEqual({ status: 'obsolete' })
    const before = await api.snapshot(mapId)
    expect(await api.command('run.pause', { mapId, runId, expectedRevision: before.revision })).toMatchObject({ status: 200 })
    expect((await api.work('claim', { ...input, holderId: randomUUID() })).body.data).toEqual({ status: 'obsolete' })
    const paused = await api.snapshot(mapId), beforeResume = notices.filter(message => message.mapId === mapId).length
    expect(await api.command('run.resume', { mapId, runId, expectedRevision: paused.revision })).toMatchObject({ status: 200 })
    await expect.poll(() => notices.filter(message => message.mapId === mapId).length, { timeout: 8000 }).toBeGreaterThan(beforeResume)
    expect(notices.filter(message => message.mapId === mapId).at(-1)?.workId).toBe(notice.workId)
    const resumed = (await api.work('claim', { ...input, holderId: randomUUID() })).body.data as GraphClaimResult
    expect(resumed.status).toBe('claimed')
    if (resumed.status === 'claimed') expect(resumed.grant.fence).toBeGreaterThan(claimed.grant.fence)
  })

  it('broadcasts complete baselines and subsequent graph changes to two API instances', async () => {
    const { application } = await messagingCreatePeer()
    await application.startMessaging()
    const peer = await messagingServe(application), { mapId } = await messagingCreateMap()
    const [first, second] = await Promise.all([messagingWatch(mapId), messagingWatch(mapId, peer.url)])
    const baseline = await api.snapshot(mapId)
    for (const stream of [first, second]) {
      expect(await stream.event(event => event.type === 'snapshot')).toEqual({ type: 'snapshot', snapshot: baseline })
    }
    const updated = await api.command('graph.apply', { mapId, expectedRevision: baseline.revision,
      changes: { nodes: { put: [{ id: randomUUID(), data: { kind: 'claim', content: '广播更新', category: 'data' } }] } } })
    expect(updated.status).toBe(200)
    for (const stream of [first, second]) {
      expect(await stream.event(event => event.type === 'snapshot' && event.snapshot.revision === baseline.revision + 1))
        .toEqual({ type: 'snapshot', snapshot: updated.body.data.snapshot })
    }
    first.stop.abort()
    await first.done
    const reconnected = await messagingWatch(mapId)
    expect(await reconnected.event(event => event.type === 'snapshot')).toEqual({ type: 'snapshot', snapshot: updated.body.data.snapshot })
  })

  it('retains a broker change that arrives while the first snapshot is being read', async () => {
    const { application } = await messagingCreatePeer()
    await application.startMessaging()
    const peer = await messagingServe(application), { mapId } = await messagingCreateMap()
    const changes: QueueChange[] = []
    const unsubscribe = application.watchChanges(message => { if (message) changes.push(message) })
    cleanup.push(async () => { unsubscribe() })
    let release!: () => void, captured!: () => void, held = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const reading = new Promise<void>(resolve => { captured = resolve })
    const readSnapshot = application.readSnapshot.bind(application)
    application.readSnapshot = async (...args) => {
      const snapshot = await readSnapshot(...args)
      if (args[1] === mapId && !held) { held = true; captured(); await gate }
      return snapshot
    }
    const pending = messagingWatch(mapId, peer.url)
    cleanup.push(async () => { release(); const stream = await pending; stream.stop.abort(); await stream.done })
    await reading
    changes.length = 0
    const updated = await api.command('graph.apply', { mapId, expectedRevision: 0, changes: { name: 'Changed during baseline' } })
    expect(updated.status).toBe(200)
    await expect.poll(() => changes.some(message => message.kind === 'graph' && message.mapId === mapId), { timeout: 8000 }).toBe(true)
    release()
    const stream = await pending
    expect(await stream.event(event => event.type === 'snapshot' && event.snapshot.revision === 0))
      .toMatchObject({ type: 'snapshot', snapshot: { mapId, revision: 0 } })
    expect(await stream.event(event => event.type === 'snapshot' && event.snapshot.revision === 1))
      .toEqual({ type: 'snapshot', snapshot: updated.body.data.snapshot })
    const revisions = stream.state.events.flatMap(event => event.type === 'snapshot' ? [event.snapshot.revision] : [])
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
  })

  it('sends management refresh hints and terminates access immediately after membership removal', async () => {
    const { mapId, workspace } = await messagingCreateMap()
    const viewer = await api.auth.createUser({ id: randomUUID(), displayName: 'Stream viewer', hostAdmin: false })
    const { token } = await api.auth.createToken(viewer.userId)
    expect(await api.command('member.set', { workspaceId: workspace.id, expectedRevision: workspace.revision,
      userId: viewer.userId, role: 'viewer' })).toMatchObject({ status: 200 })
    const stream = await messagingWatch(mapId, api.url, token)
    await messagingClearBaseline(stream)
    expect(await api.command('workspace.update', { workspaceId: workspace.id, expectedRevision: workspace.revision + 1,
      name: 'Visible rename', description: '' })).toMatchObject({ status: 200 })
    expect(await stream.event(event => event.type === 'refresh' && event.scope === 'workspace')).toEqual({ type: 'refresh', scope: 'workspace' })
    expect(await api.command('member.set', { workspaceId: workspace.id, expectedRevision: workspace.revision + 2,
      userId: viewer.userId, role: null })).toMatchObject({ status: 200 })
    expect(await stream.event(event => event.type === 'error')).toMatchObject({ type: 'error', error: { status: 404, retryable: false } })
    await expect.poll(() => stream.state.ended).toBe(true)
    const denied = await fetch(`${api.url}/api/v1/maps/${mapId}/events`, { headers: { authorization: `Bearer ${token}` } })
    expect(denied.status).toBe(404)
    await denied.body?.cancel()
  })

  it('broadcasts independent control writes and direct settings revisions without application dispatch', async () => {
    const { application, connection } = await messagingCreatePeer()
    const { mapId, workspace } = await messagingCreateMap()
    const stream = await messagingWatch(mapId)
    await messagingClearBaseline(stream)
    await application.auth.transact(api.userToken, ctx => application.control.dispatch(ctx, {
      requestId: randomUUID(), method: 'workspace.update', params: {
        workspaceId: workspace.id, expectedRevision: workspace.revision, name: 'Independent writer', description: '',
      },
    }))
    expect(await stream.event(event => event.type === 'refresh' && event.scope === 'workspace'))
      .toEqual({ type: 'refresh', scope: 'workspace' })
    stream.state.events.length = 0
    const settings = connection.collection('control_settings')
    const before = (await settings.findOne({ _id: 'global' } as never))!
    expect((await settings.updateOne({ _id: 'global' } as never, { $inc: { revision: 1 },
      $set: { 'llm.model': 'external-model-' + randomUUID() } })).modifiedCount).toBe(1)
    expect(await stream.event(event => event.type === 'refresh' && event.scope === 'settings'))
      .toEqual({ type: 'refresh', scope: 'settings' })
    const bootstrap = await api.application.read(api.userToken, { method: 'app.bootstrap', params: {} }) as { settings: { revision: number } }
    expect(bootstrap.settings.revision).toBe(before.revision + 1)
    expect(stream.state.ended).toBe(false)
  })

  it('rejects query-string tokens, revoked credentials and deleted maps on existing streams', async () => {
    const { mapId } = await messagingCreateMap()
    const insecure = await fetch(`${api.url}/api/v1/maps/${mapId}/events?token=${encodeURIComponent(api.userToken)}`)
    expect(insecure.status).toBeGreaterThanOrEqual(400)
    expect(insecure.status).toBeLessThan(500)
    await insecure.body?.cancel()
    const credential = await api.auth.createToken(api.owner.userId)
    const revoked = await messagingWatch(mapId, api.url, credential.token)
    await messagingClearBaseline(revoked)
    await api.auth.revokeToken(credential.tokenId)
    expect(await revoked.event(event => event.type === 'error')).toMatchObject({ type: 'error', error: { status: 401, retryable: false } })
    await expect.poll(() => revoked.state.ended).toBe(true)
    const deleted = await messagingWatch(mapId)
    await deleted.event(event => event.type === 'snapshot')
    expect(await api.command('map.delete', { mapId, expectedRevision: 0 })).toMatchObject({ status: 200 })
    expect(await deleted.event(event => event.type === 'error')).toMatchObject({ type: 'error', error: { status: 404, retryable: false } })
    await expect.poll(() => deleted.state.ended).toBe(true)
  })

  it('does not leave active SSE responses hanging when an API service closes', async () => {
    const { application } = await messagingCreatePeer()
    await application.startMessaging()
    const peer = await messagingServe(application), { mapId } = await messagingCreateMap()
    const stream = await messagingWatch(mapId, peer.url)
    await stream.event(event => event.type === 'snapshot')
    const closed = new Promise<void>((resolve, reject) => peer.server.close(error => error ? reject(error) : resolve()))
    await expect.poll(() => stream.state.ended, { timeout: 3000 }).toBe(true)
    await closed
  })

  it('disconnects SSE and republishes confirmed active work after a real AMQP connection failure', async () => {
    const sockets = new Set<Socket>(), address = new URL(api.queue.url)
    const brokerPort = Number(address.port || 5672), brokerHost = address.hostname
    let disconnected = false
    // Drop only this application's transport; AMQP and all queue operations still use the real broker.
    const tunnel = createTcpServer(socket => {
      if (disconnected) { socket.destroy(); return }
      const upstream = connect(brokerPort, brokerHost)
      sockets.add(socket); sockets.add(upstream)
      for (const current of [socket, upstream]) {
        current.on('error', () => { socket.destroy(); upstream.destroy() })
        current.on('close', () => { sockets.delete(current); socket.destroy(); upstream.destroy() })
      }
      socket.pipe(upstream); upstream.pipe(socket)
    })
    await new Promise<void>(resolve => tunnel.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => tunnel.close(error => error ? reject(error) : resolve()))
    })
    const binding = tunnel.address()
    if (!binding || typeof binding === 'string') throw new Error('AMQP transport did not bind')
    address.hostname = '127.0.0.1'; address.port = String(binding.port)
    const { application, connection } = await messagingCreatePeer(true, { ...api.queue, url: address.toString() })
    const owner = await application.auth.createUser({ id: randomUUID(), displayName: 'Reconnect owner', hostAdmin: true })
    const { token } = await application.auth.createToken(owner.userId)
    const workspace = await application.auth.transact(token, ctx => application.control.createWorkspace(ctx, {
      id: randomUUID(), name: 'Reconnect workspace', description: '', agentSource: 'empty',
    }))
    const { mapId } = await api.createRun()
    const source = (await api.store.read(mapId))!
    expect(await application.store.create({ ...source, workspaceId: workspace.id })).toBe(true)
    await application.control.seed(source.run!.configuration)
    const workId = workReadItems(source)[0].workId
    const observer = await messagingOpenLink(application), notices: QueueWork[] = [], stop = new AbortController()
    let barrier = false
    const consume = observer.consumeWork(async message => {
      if (message.workId === 'test-barrier') barrier = true
      else notices.push(message)
      return 'ack'
    }, stop.signal)
    cleanup.push(async () => { stop.abort(); await consume })
    await application.startMessaging()
    const peer = await messagingServe(application), stream = await messagingWatch(mapId, peer.url, token)
    await messagingClearBaseline(stream)
    const replica = applicationCreateService(connection, { messaging: api.queue })
    cleanup.push(() => replica.closeMessaging())
    await replica.initialize()
    await replica.startMessaging()
    const replicaServer = await messagingServe(replica), existing = await messagingWatch(mapId, replicaServer.url, token)
    await messagingClearBaseline(existing)
    const graphs = connection.collection(GRAPH_COLLECTION)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: source.revision,
      dispatch: { version: source.revision, pending: false } })
    // A FIFO marker proves every startup notification was consumed before the connection is cut.
    await observer.publishWork({ version: 1, deploymentId: application.messaging().deploymentId, mapId, workId: 'test-barrier' })
    await expect.poll(() => barrier, { timeout: 8000 }).toBe(true)
    expect(notices.some(message => message.mapId === mapId && message.workId === workId)).toBe(true)
    notices.length = 0
    expect(sockets.size).toBeGreaterThan(0)
    disconnected = true
    for (const socket of sockets) socket.destroy()
    await expect.poll(() => stream.state.ended, { timeout: 3000 }).toBe(true)
    expect((await connection.collection('control_settings').updateOne({ _id: 'global' } as never, { $inc: { revision: 1 } })).modifiedCount).toBe(1)
    await existing.event(event => event.type === 'refresh' && event.scope === 'settings')
    existing.state.events.length = 0
    disconnected = false
    await expect.poll(() => notices.some(message => message.mapId === mapId && message.workId === workId), { timeout: 8000 }).toBe(true)
    expect(await existing.event(event => event.type === 'refresh' && event.scope === 'workspace')).toEqual({ type: 'refresh', scope: 'workspace' })
    expect(await existing.event(event => event.type === 'refresh' && event.scope === 'settings')).toEqual({ type: 'refresh', scope: 'settings' })
    expect(existing.state.ended).toBe(false)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: source.revision,
      dispatch: { version: source.revision, pending: false } })
    const restored = await messagingWatch(mapId, peer.url, token)
    expect(await restored.event(event => event.type === 'snapshot')).toEqual({ type: 'snapshot', snapshot: await application.readSnapshot(token, mapId) })
  }, 15_000)
})
