import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClientGateway } from '../../contracts/client'
import type { AppBootstrap, WorkspaceView } from '../../contracts/control'
import type { GraphSnapshot } from '../../contracts/graph'
import { sessionCreateState } from '../../src/stores/client'
import { verificationConfiguration } from '../backend/fixtures/verification'

vi.mock('../../src/api', () => ({ api: {} }))

const time = '2026-09-11T00:00:00.000Z'
const error = (status: number, code: string, retryable = false) => Object.assign(new Error(code), { status, code, retryable })
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function success(data: unknown) { return { ok: true, requestId: 'request', replayed: false, data } }
function map(id: string, workspaceId = 'workspace-a', revision = 1): GraphSnapshot {
  return { mapId: id, workspaceId, revision, name: id, updatedAt: time, edges: [], run: null,
    nodes: [{ id: `${id}-claim`, revision: 0, data: { kind: 'claim', content: `${id} content`, category: null }, createdAt: time, updatedAt: time }] }
}
function workspace(id: string): WorkspaceView {
  return { id, name: id, description: '', revision: 0, role: 'owner', mapCount: 2, updatedAt: time, agents: [], members: [],
    preferences: { workspaceId: id, revision: 0, openMapIds: [], currentMapId: null, nodeSelection: {} } }
}

function fakeGateway() {
  let configured = false
  const snapshots = new Map([['map-a', map('map-a')], ['map-b', map('map-b')], ['map-c', map('map-c', 'workspace-b')]])
  const workspaces = new Map([['workspace-a', workspace('workspace-a')], ['workspace-b', workspace('workspace-b')]])
  const bootstrap = { identity: { userId: 'user-a', displayName: 'A', hostAdmin: false }, settings: {
    revision: 0, llm: { provider: 'fixture', model: 'fixture' }, tools: [], limits: { maxAgentSlots: 3 },
  }, metadata: { version: 'fixture', promptKinds: [], executableKinds: ['verify'], scores: [0, 0.5, 1], variables: {}, outputs: [] } } as unknown as AppBootstrap
  const read = vi.fn(async (method: string, params: any, _signal?: AbortSignal): Promise<any> => {
    if (method === 'app.bootstrap') return structuredClone(bootstrap)
    if (method === 'workspace.list') return { items: [...workspaces.values()], nextCursor: null }
    if (method === 'workspace.get') return structuredClone(workspaces.get(params.workspaceId))
    if (method === 'map.list') return [...snapshots.values()].filter(snapshot => snapshot.workspaceId === params.workspaceId).map(snapshot => ({
      id: snapshot.mapId, workspaceId: snapshot.workspaceId, revision: snapshot.revision, name: snapshot.name, nodeCount: snapshot.nodes.length,
      claimCount: 1, updatedAt: snapshot.updatedAt,
    }))
    if (method === 'map.get') return structuredClone(snapshots.get(params.mapId))
    throw new Error(`Unexpected query: ${method}`)
  })
  const dispatch = vi.fn(async (_id: string, method: string, params: any, _signal?: AbortSignal): Promise<any> => {
    if (method === 'preferences.set') return success({ workspaceId: params.workspaceId, revision: params.expectedRevision + 1,
      openMapIds: params.openMapIds, currentMapId: params.currentMapId, nodeSelection: params.nodeSelection })
    throw new Error(`Unexpected command: ${method}`)
  })
  const connect = vi.fn(async () => { configured = true; return structuredClone(bootstrap) })
  const disconnect = vi.fn(async () => { configured = false })
  const getConnection = vi.fn(async () => ({ baseUrl: 'http://fixture', configured, remembered: false, canRemember: false }))
  const gateway = { read, dispatch, connect, disconnect, getConnection } as unknown as ClientGateway
  return { gateway, read, dispatch, connect, disconnect, getConnection, snapshots, workspaces, bootstrap }
}

const sessions: ReturnType<typeof sessionCreateState>[] = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { for (const session of sessions.splice(0)) session.dispose(); vi.useRealTimers() })

async function opened() {
  const f = fakeGateway()
  const session = sessionCreateState(f.gateway, 100)
  sessions.push(session)
  await session.connect({ baseUrl: 'http://fixture', token: 'token', remember: false })
  await session.openMap('map-a', false)
  return { ...f, session }
}

describe('Client session state and polling', () => {
  it('ignores late Map replies after a different Map is opened and aborts the old view', async () => {
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    let oldSignal: AbortSignal | undefined
    f.read.mockImplementation(async (method, params, signal) => {
      if (method === 'map.get' && params.mapId === 'map-a') { oldSignal = signal; return late.promise }
      return normalRead(method, params, signal)
    })
    const opening = f.session.openMap('map-a', false)
    await f.session.openMap('map-b', false)
    expect(oldSignal?.aborted).toBe(true)
    late.resolve(map('map-a', 'workspace-a', 99))
    await opening
    expect(f.session.activeMapId.value).toBe('map-b')
    expect(f.session.snapshot.value?.mapId).toBe('map-b')
    expect(f.session.loading.value).toBe(false)
  })

  it('keeps a newer command snapshot when an earlier poll arrives afterward', async () => {
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    f.read.mockImplementation((method, params, signal) => method === 'map.get' ? late.promise : normalRead(method, params, signal))
    const polling = f.session.refresh()
    const newest = map('map-a', 'workspace-a', 3)
    f.dispatch.mockResolvedValueOnce(success({ snapshot: newest, createdNodeIds: [], createdEdgeIds: [] }))
    await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data: { kind: 'claim', content: 'Mine', category: null } })
    late.resolve(map('map-a', 'workspace-a', 2))
    await polling
    expect(f.session.snapshot.value?.revision).toBe(3)
  })

  it('does not restore private state from pending requests after disconnect', async () => {
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    f.read.mockImplementationOnce(() => late.promise)
    const polling = f.session.refresh()
    await f.session.disconnect()
    late.resolve(map('map-a', 'workspace-a', 8))
    await polling
    const reads = f.read.mock.calls.length
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.read.mock.calls).toHaveLength(reads)
    expect(f.session.bootstrap.value).toBeNull()
    expect(f.session.workspace.value).toBeNull()
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.online.value).toBe(false)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel')).toBe(false)
  })

  it('ignores initialization connection metadata that arrives after a new login', async () => {
    const f = fakeGateway()
    const session = sessionCreateState(f.gateway, 100)
    sessions.push(session)
    const stale = deferred<Awaited<ReturnType<ClientGateway['getConnection']>>>()
    f.getConnection.mockImplementationOnce(() => stale.promise)
    const initializing = session.initialize()
    await session.connect({ baseUrl: 'http://fixture', token: 'new-token', remember: false })
    expect(session.connection.value?.configured).toBe(true)
    stale.resolve({ baseUrl: 'http://previous-host', configured: false, remembered: false, canRemember: false })
    await initializing
    expect(session.connection.value).toMatchObject({ baseUrl: 'http://fixture', configured: true })
    expect(session.bootstrap.value?.identity.userId).toBe('user-a')
  })

  it('schedules the next poll only after the previous one settles', async () => {
    const f = await opened()
    const late = deferred<GraphSnapshot>()
    const normalRead = f.read.getMockImplementation()!
    let polls = 0
    f.read.mockImplementation((method, params, signal) => {
      if (method === 'map.get') { polls++; return polls === 1 ? late.promise : Promise.resolve(map('map-a', 'workspace-a', 2)) }
      return normalRead(method, params, signal)
    })
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(1000)
    expect(polls).toBe(1)
    late.resolve(map('map-a', 'workspace-a', 2))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(99)
    expect(polls).toBe(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(polls).toBe(2)
  })

  it('disconnects on 401, clears private data, and does not cancel remote execution', async () => {
    const f = await opened()
    f.read.mockRejectedValueOnce(error(401, 'UNAUTHORIZED'))
    await f.session.refresh()
    expect(f.disconnect).toHaveBeenCalledOnce()
    expect(f.session.bootstrap.value).toBeNull()
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.error.value?.status).toBe(401)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel')).toBe(false)
  })

  it('clears an inaccessible Workspace without signing the user out', async () => {
    const f = await opened()
    const normalRead = f.read.getMockImplementation()!
    f.read.mockImplementation(async (method, params, signal) => {
      if (method === 'map.get' || method === 'workspace.get') throw error(404, 'WORKSPACE_NOT_FOUND')
      if (method === 'workspace.list') return { items: [], nextCursor: null }
      return normalRead(method, params, signal)
    })
    await f.session.refresh()
    expect(f.session.workspace.value).toBeNull()
    expect(f.session.openMapIds.value).toEqual([])
    expect(f.session.snapshot.value).toBeNull()
    expect(f.session.bootstrap.value?.identity.userId).toBe('user-a')
    expect(f.disconnect).not.toHaveBeenCalled()
  })

  it('refreshes conflicts without auto-retrying or mutating the caller draft', async () => {
    const f = await opened()
    const draft = { kind: 'claim' as const, content: 'Unsaved user edit', category: null }
    f.dispatch.mockRejectedValueOnce(error(409, 'REVISION_CONFLICT'))
    f.snapshots.set('map-a', map('map-a', 'workspace-a', 5))
    expect(await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data: draft })).toBe(false)
    expect(f.session.snapshot.value?.revision).toBe(5)
    expect(draft.content).toBe('Unsaved user edit')
    expect(f.session.canRetry.value).toBe(false)
    expect(f.dispatch).toHaveBeenCalledOnce()
  })

  it('retries the exact original mutation identity and payload even if the editor draft changes', async () => {
    const f = await opened()
    const sent: Array<{ id: string; method: string; params: any }> = []
    let failed = false
    f.dispatch.mockImplementation(async (id, method, params) => {
      sent.push(structuredClone({ id, method, params }))
      if (!failed) { failed = true; throw error(0, 'NETWORK_ERROR', true) }
      return success({ snapshot: map('map-a', 'workspace-a', 2), createdNodeIds: [], createdEdgeIds: [] })
    })
    const data = { kind: 'claim' as const, content: 'Original submitted edit', category: null }
    await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data })
    expect(f.session.canRetry.value).toBe(true)
    data.content = 'A newer unsaved draft'
    await f.session.retry()
    expect(sent).toHaveLength(2)
    expect(sent[1]).toEqual(sent[0])
  })

  it('drops a retry belonging to a Workspace that the user has left', async () => {
    const f = await opened()
    f.dispatch.mockRejectedValueOnce(error(0, 'NETWORK_ERROR', true))
    await f.session.saveNode({ expectedRevision: 1, nodeId: 'map-a-claim', data: { kind: 'claim', content: 'Edit', category: null } })
    expect(f.session.canRetry.value).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    expect(f.session.canRetry.value).toBe(false)
    await f.session.retry()
    expect(f.dispatch).toHaveBeenCalledOnce()
  })

  it('persists the new Workspace preferences after an old Workspace save finishes late', async () => {
    const f = await opened()
    const pending = deferred<unknown>()
    const normalDispatch = f.dispatch.getMockImplementation()!
    f.dispatch.mockImplementation((id, method, params, signal) => {
      if (method === 'preferences.set' && params.workspaceId === 'workspace-a') return pending.promise
      return normalDispatch(id, method, params, signal)
    })
    f.session.selectNode('map-a-claim')
    await vi.advanceTimersByTimeAsync(250)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-a')).toBe(true)
    await f.session.selectWorkspace('workspace-b')
    await f.session.openMap('map-c', false)
    f.session.selectNode('map-c-claim')
    await vi.advanceTimersByTimeAsync(250)
    pending.resolve(success({ workspaceId: 'workspace-a', revision: 1, openMapIds: ['map-a'], currentMapId: 'map-a', nodeSelection: {} }))
    await vi.advanceTimersByTimeAsync(300)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'preferences.set' && call[2].workspaceId === 'workspace-b')).toBe(true)
    expect(f.session.workspace.value?.id).toBe('workspace-b')
  })

  it('closes a tab without cancelling its remote Run and enforces refreshed Viewer permissions', async () => {
    const f = await opened()
    f.snapshots.get('map-a')!.run = { id: 'run-a', mode: 'human-in-loop', status: 'running', configuration: verificationConfiguration(),
      operation: { id: 'operation-a', kind: 'verify', targetId: 'map-a-claim', status: 'running', inputRefs: [],
        route: null, reports: [], draft: null, review: null, resultNodeId: null }, createdAt: time, updatedAt: time }
    f.snapshots.get('map-a')!.revision++
    await f.session.refresh()
    expect(f.session.active.value).toBe(true)
    await f.session.closeMap('map-a')
    expect(f.session.snapshot.value).toBeNull()
    await f.session.openMap('map-a', false)
    f.workspaces.get('workspace-a')!.role = 'viewer'
    await f.session.refreshWorkspace()
    expect(f.session.canEdit.value).toBe(false)
    expect(await f.session.createNode('claim', 'No write')).toBe(false)
    expect(f.dispatch.mock.calls.some(call => call[1] === 'run.cancel' || call[1] === 'graph.apply')).toBe(false)
  })
})
