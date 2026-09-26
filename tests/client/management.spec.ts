import { effectScope, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ClientGateway } from '../../contracts/client'
import { ClientError } from '../../contracts/client'
import { useManagementTask } from '../../apps/ui/features/management/use-management'
import { sessionCreateState } from '../../apps/ui/state/client-session'
import { verificationConfiguration } from '../backend/fixtures/verification'

vi.mock('../../apps/ui/transport/client-gateway', () => ({ api: {} }))
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const networkError = () => new ClientError({ status: 0, code: 'NETWORK_ERROR', message: 'Disconnected', retryable: true })
function fixture() {
  const dispatch = vi.fn(), read = vi.fn(), onUnauthorized = vi.fn()
  const gateway = { dispatch, read } as unknown as ClientGateway
  const task = useManagementTask({ gateway, onUnauthorized })
  return { task, dispatch, read, onUnauthorized }
}

describe('Management request lifetime and mutation identity', () => {
  it('freezes nested reactive drafts and bytes and retries the exact original operation', async () => {
    const f = fixture()
    const draft = reactive({ members: [{ userId: 'member', role: 'editor' }], bytes: new Uint8Array([1, 2, 3]) })
    const calls: Array<{ input: typeof draft; requestId: string }> = []
    const execute = vi.fn(async (input: typeof draft, requestId: string) => {
      calls.push({ input: { members: input.members.map(member => ({ ...member })), bytes: input.bytes.slice() }, requestId })
      input.members[0].role = 'mutated inside transport'; input.bytes[0] = 99
      if (calls.length === 1) throw networkError()
      return 'accepted'
    })
    expect(await f.task.run(draft, execute)).toBeNull()
    expect(f.task.canRetry.value).toBe(true)
    draft.members[0].role = 'owner'; draft.bytes[0] = 7
    expect(await f.task.retry()).toBe(true)
    expect(calls[1]).toEqual(calls[0])
    expect(calls[1].input.bytes).toBeInstanceOf(Uint8Array)
    expect(calls[1].input.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect(draft.members[0].role).toBe('owner')
    f.task.dispose()
  })

  it('keeps an uncertain command until retry or explicit abandonment', async () => {
    const f = fixture()
    f.dispatch.mockRejectedValueOnce(networkError()).mockResolvedValue({ ok: true, data: { deleted: true } })
    const input = { workspaceId: 'workspace', expectedRevision: 4 }
    await f.task.command('workspace.delete', input)
    expect(await f.task.command('workspace.delete', { ...input, expectedRevision: 5 })).toBeNull()
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(f.task.canRetry.value).toBe(true)
    f.task.clearError()
    await f.task.command('workspace.delete', { ...input, expectedRevision: 5 })
    expect(f.dispatch).toHaveBeenCalledTimes(2)
    expect(f.dispatch.mock.calls[1][0]).not.toBe(f.dispatch.mock.calls[0][0])
    f.task.dispose()
  })

  it('aborts on panel disposal and discards late successful writes', async () => {
    const f = fixture(), pending = deferred<unknown>(), accept = vi.fn()
    f.dispatch.mockImplementation(() => pending.promise)
    const writing = f.task.command('member.set', { workspaceId: 'workspace', expectedRevision: 4, userId: 'member', role: 'viewer' }, accept)
    const signal = f.dispatch.mock.calls[0][3] as AbortSignal
    expect(f.task.busy.value).toBe(true)
    f.task.dispose()
    expect(signal.aborted).toBe(true)
    pending.resolve({ ok: true, data: { member: { userId: 'member' } } })
    expect(await writing).toBeNull()
    expect(accept).not.toHaveBeenCalled()
    expect(f.task.busy.value).toBe(false)
    expect(await f.task.retry()).toBe(false)
  })

  it('ties requests to the component scope so replacing identity cannot adopt old reads', async () => {
    const scope = effectScope(), pending = deferred<unknown>(), accept = vi.fn()
    const read = vi.fn(() => pending.promise)
    const task = scope.run(() => useManagementTask({ gateway: { read } as unknown as ClientGateway, onUnauthorized: vi.fn() }))!
    const reading = task.read('workspace.get', { workspaceId: 'old-workspace' }, accept)
    scope.stop()
    pending.resolve({ id: 'old-workspace' })
    expect(await reading).toBeNull()
    expect(accept).not.toHaveBeenCalled()
    expect(read.mock.calls[0][2].aborted).toBe(true)
  })

  it('reports version conflicts without changing or retrying the draft', async () => {
    const f = fixture()
    f.dispatch.mockRejectedValue(new ClientError({ status: 409, code: 'REVISION_CONFLICT', message: 'Changed', retryable: false, currentRevision: 8 }))
    const draft = reactive({ workspaceId: 'workspace', expectedRevision: 3, name: 'Unsaved name', description: 'Kept text' })
    await f.task.command('workspace.update', draft)
    expect(f.task.error.value).toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 8 })
    expect(f.task.error.value?.message).toContain('草稿已保留')
    expect(f.task.canRetry.value).toBe(false)
    expect(await f.task.retry()).toBe(false)
    expect(f.dispatch).toHaveBeenCalledTimes(1)
    expect(draft).toMatchObject({ expectedRevision: 3, name: 'Unsaved name', description: 'Kept text' })
    f.task.dispose()
  })

  it('routes expired authorization to the session owner instead of offering a write retry', async () => {
    const f = fixture()
    f.read.mockRejectedValue(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Expired', retryable: false }))
    expect(await f.task.read('app.bootstrap', {})).toBeNull()
    expect(f.onUnauthorized).toHaveBeenCalledOnce()
    expect(f.task.canRetry.value).toBe(false)
    f.task.dispose()
  })
})

async function openedManagement() {
    const time = '2026-09-12T00:00:00.000Z'
    const workspace = { id: 'workspace', name: 'Original', description: '', revision: 1, role: 'owner', mapCount: 1, updatedAt: time, agents: [], members: [], preferences: { workspaceId: 'workspace', revision: 0, openMapIds: ['map'], currentMapId: 'map', nodeSelection: { map: 'claim' } } }
    const bootstrap = { identity: { userId: 'user', displayName: 'User', hostAdmin: true }, settings: { revision: 1, llm: { provider: 'fixture', model: 'before' }, tools: [], limits: { maxAgentSlots: 4 } }, metadata: { version: '060' } }
    const map = { mapId: 'map', workspaceId: 'workspace', name: 'Graph', revision: 1, nodes: [{ id: 'claim', revision: 0, data: { kind: 'claim', content: 'Kept claim', category: null }, createdAt: time, updatedAt: time }], edges: [], updatedAt: time,
      run: { id: 'run', scope: { nodeIds: ['claim'] }, until: 'verified', paused: true, regenerate: false, mode: 'auto', status: 'running', configuration: verificationConfiguration(), operations: [], createdAt: time, updatedAt: time } }
    const dispatch = vi.fn(), disconnect = vi.fn()
    const gateway = {
      watch: vi.fn((_mapId: string, _onEvent: unknown, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => { signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }) })),
      connect: vi.fn(async () => structuredClone(bootstrap)),
      getConnection: vi.fn(async () => ({ baseUrl: 'http://fixture', configured: true, remembered: false, canRemember: false })),
      read: vi.fn(async (method: string) => {
        if (method === 'app.bootstrap') return structuredClone(bootstrap)
        if (method === 'workspace.list') return { items: [structuredClone(workspace)], nextCursor: null }
        if (method === 'workspace.get') return structuredClone(workspace)
        if (method === 'map.list') return [{ id: 'map', workspaceId: 'workspace', name: 'Graph', revision: 1, nodeCount: 1, claimCount: 1, updatedAt: time }]
        if (method === 'map.get') return structuredClone(map)
        throw new Error('Unexpected query ' + method)
      }), dispatch, disconnect,
    } as unknown as ClientGateway
    const read = vi.mocked(gateway.read)
    const session = sessionCreateState(gateway, 60_000)
    await session.connect({ baseUrl: 'http://fixture', token: 'fixture', remember: false })
    return { session, gateway, read, workspace, bootstrap, map, dispatch, disconnect }
}

describe('Management refresh preserves the current graph', () => {
  it('ignores older management successes and failures and never rolls settings backward', async () => {
    const f = await openedManagement()
    const read = f.read.getMockImplementation()!
    const oldBootstrap = structuredClone(f.bootstrap), late = deferred<any>()
    let intercept = true
    f.read.mockImplementation(((method: string, params: any, signal: any) => {
      if (method === 'app.bootstrap' && intercept) { intercept = false; return late.promise }
      return read(method as any, params, signal)
    }) as typeof read)
    const first = f.session.refreshManagement()
    f.bootstrap.settings.revision = 2; f.bootstrap.settings.llm.model = 'newest'
    await f.session.refreshManagement()
    late.resolve(oldBootstrap)
    await first
    expect(f.session.bootstrap.value?.settings).toMatchObject({ revision: 2, llm: { model: 'newest' } })
    f.bootstrap.settings.revision = 1; f.bootstrap.settings.llm.model = 'cached old value'
    await f.session.refreshManagement()
    expect(f.session.bootstrap.value?.settings.llm.model).toBe('newest')
    const failed = deferred<any>()
    f.read.mockImplementationOnce(() => failed.promise)
    const oldFailure = f.session.refreshManagement()
    await f.session.refreshManagement()
    failed.reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Old authorization result', retryable: false }))
    await oldFailure
    expect(f.session.bootstrap.value?.identity.userId).toBe('user')
    expect(f.disconnect).not.toHaveBeenCalled()
    f.session.dispose()
  })

  it('keeps Workspace and preference revisions independent and ignores stale access failures', async () => {
    const f = await openedManagement()
    const read = f.read.getMockImplementation()!
    const initialRun = f.session.snapshot.value!.run, oldWorkspace = structuredClone(f.workspace), late = deferred<any>()
    let intercept = true
    f.read.mockImplementation(((method: string, params: any, signal: any) => {
      if (method === 'workspace.get' && intercept) { intercept = false; return late.promise }
      return read(method as any, params, signal)
    }) as typeof read)
    const first = f.session.refreshWorkspace()
    f.workspace.revision = 3; f.workspace.name = 'Newest'; f.workspace.preferences.revision = 8
    await f.session.refreshWorkspace()
    late.resolve(oldWorkspace)
    await first
    expect(f.session.workspace.value).toMatchObject({ name: 'Newest', revision: 3, preferences: { revision: 8 } })
    f.workspace.revision = 2; f.workspace.name = 'Older fields'; f.workspace.preferences.revision = 9
    await f.session.refreshWorkspace()
    expect(f.session.workspace.value).toMatchObject({ name: 'Newest', revision: 3, preferences: { revision: 9 } })
    f.workspace.revision = 4; f.workspace.name = 'Latest fields'; f.workspace.preferences.revision = 1
    await f.session.refreshWorkspace()
    expect(f.session.workspace.value).toMatchObject({ name: 'Latest fields', revision: 4, preferences: { revision: 9 } })
    const failed = deferred<any>()
    f.read.mockImplementationOnce(() => failed.promise)
    const oldFailure = f.session.refreshWorkspace()
    await f.session.refreshWorkspace()
    failed.reject(new ClientError({ status: 404, code: 'WORKSPACE_NOT_FOUND', message: 'Old access result', retryable: false }))
    await oldFailure
    expect(f.session.workspace.value?.id).toBe('workspace')
    await f.session.loadWorkspaces()
    expect(f.session.workspaces.value[0]).toMatchObject({ revision: 4, name: 'Latest fields' })
    expect(f.session.snapshot.value!.run).toBe(initialRun)
    expect(f.session.selectedId.value).toBe('claim')
    expect(f.session.error.value).toBeNull()
    f.session.dispose()
  })

  it('adopts Workspace and Settings changes without replacing a paused Run or selection', async () => {
    const { session, workspace, bootstrap, dispatch } = await openedManagement()
    const initialRun = session.snapshot.value!.run
    workspace.name = 'Updated workspace'; workspace.revision = 2
    bootstrap.settings.llm.model = 'after'; bootstrap.settings.revision = 2
    await session.refreshManagement()
    expect(session.workspace.value?.name).toBe('Updated workspace')
    expect(session.bootstrap.value?.settings.llm.model).toBe('after')
    expect(session.snapshot.value!.run).toBe(initialRun)
    expect(session.snapshot.value!.run?.paused).toBe(true)
    expect(session.activeMapId.value).toBe('map')
    expect(session.selectedId.value).toBe('claim')
    expect(dispatch).not.toHaveBeenCalled()
    session.dispose()
  })
})
