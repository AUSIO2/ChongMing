// 管理任务单元测试：验证草稿隔离、重试身份、作用域取消和刷新版本仲裁。
import { effectScope, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ClientGateway } from '../../contracts/client'
import { ClientError } from '../../contracts/client'
import { useManagementTask } from '../../apps/ui/features/management/use-management'
import { sessionCreateState } from '../../apps/ui/state/client-session'

vi.mock('../../apps/ui/transport/client-gateway', () => /* 替换应用默认网关，避免单元测试触发真实连接装配。 */ ({ api: {} }))
function deferred<T>() {
  /**
   * 创建可由测试手动完成或拒绝的 Promise，以安排迟到结果。
   *
   * @param value 测试手动交付给延迟 Promise 的成功值。
   * @param error 测试手动注入的任意拒绝原因。
   */
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    // 保存 Promise 的完成和拒绝入口。
    resolve = yes; reject = no
  })
  return { promise, resolve, reject }
}
const networkError = () =>
  /* 创建可重试网络错误，模拟尚未确认的请求结果。 */
  new ClientError({ status: 0, code: 'NETWORK_ERROR', message: 'Disconnected', retryable: true })
function fixture() {
  // 建立带可观察查询、命令和认证失效回调的管理任务。
  const dispatch = vi.fn(), read = vi.fn(), onUnauthorized = vi.fn()
  const gateway = { dispatch, read } as unknown as ClientGateway
  const task = useManagementTask({ gateway, onUnauthorized })
  return { task, dispatch, read, onUnauthorized }
}

describe('Management request lifetime and mutation identity', () => {
  // 覆盖管理请求的草稿隔离、原操作重试、作用域取消与认证失效。
  it('freezes nested reactive drafts and bytes and retries the exact original operation', async () => {
    // 验证嵌套响应式草稿和字节被复制，传输层修改或后续编辑不会改变重试内容。
    const f = fixture()
    const draft = reactive({ members: [{ userId: 'member', role: 'editor' }], bytes: new Uint8Array([1, 2, 3]) })
    const calls: Array<{ input: typeof draft; requestId: string }> = []
    const execute = vi.fn(async (
      input: typeof draft,
      requestId: string
    ) => {
      // 记录独立提交参数，修改收到的副本并令首次调用失败，以检验原操作重试。
      calls.push({ input: { members: input.members.map(member =>
        /* 复制成员条目，保留调用时输入以供两次提交比较。 */
        ({ ...member })), bytes: input.bytes.slice() }, requestId })
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
    // 验证不确定命令会阻止新命令，放弃重试后才允许新请求身份。
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
    // 验证面板释放会取消请求，迟到写入结果不会触发接纳回调。
    const f = fixture(), pending = deferred<unknown>(), accept = vi.fn()
    f.dispatch.mockImplementation(() => /* 返回由测试控制完成时机的命令 Promise。 */ pending.promise)
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
    // 验证管理请求绑定 Vue 作用域，身份替换后不接纳旧查询结果。
    const scope = effectScope(), pending = deferred<unknown>(), accept = vi.fn()
    const read = vi.fn(() => /* 延迟查询结果，供作用域销毁后交付。 */ pending.promise)
    const task = scope.run(() =>
      /* 在测试作用域中创建管理任务，以验证自动释放绑定。 */
      useManagementTask({ gateway: { read } as unknown as ClientGateway, onUnauthorized: vi.fn() }))!
    const reading = task.read('workspace.get', { workspaceId: 'old-workspace' }, accept)
    scope.stop()
    pending.resolve({ id: 'old-workspace' })
    expect(await reading).toBeNull()
    expect(accept).not.toHaveBeenCalled()
    expect(read.mock.calls[0][2].aborted).toBe(true)
  })

  it('reports version conflicts without changing or retrying the draft', async () => {
    // 验证版本冲突保留原草稿和预期版本，且不自动重试。
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
    // 验证 401 通知会话所有者，且不保留写入重试入口。
    const f = fixture()
    f.read.mockRejectedValue(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Expired', retryable: false }))
    expect(await f.task.read('app.bootstrap', {})).toBeNull()
    expect(f.onUnauthorized).toHaveBeenCalledOnce()
    expect(f.task.canRetry.value).toBe(false)
    f.task.dispose()
  })
})

async function openedManagement() {
    // 构造已登录并打开暂停运行的会话，供管理刷新测试观察图和选择是否保留。
    const time = '2026-09-12T00:00:00.000Z'
    const workspace = { id: 'workspace', name: 'Original', description: '', revision: 1, role: 'owner', mapCount: 1, updatedAt: time, agents: [], members: [], preferences: { workspaceId: 'workspace', revision: 0, openMapIds: ['map'], currentMapId: 'map', nodeSelection: { map: 'claim' } } }
    const bootstrap = { identity: { userId: 'user', displayName: 'User', hostAdmin: true }, settings: { revision: 1, llm: { provider: 'fixture', model: 'before' }, tools: [], limits: { maxAgentSlots: 4 } },
      metadata: { version: '077', promptKinds: [], executableKinds: [], scores: [0, 0.5, 1], variables: {}, outputs: [], definitions: { queryMethod: 'definition.get', publishMethod: 'definition.publish' } } }
    const definitions = { workspaceId: 'workspace', catalog: { revision: 1, packages: [], index: [], dataTypes: [], transitions: [] } }
    const map = { mapId: 'map', workspaceId: 'workspace', name: 'Graph', revision: 1, ownershipRevision: 0, ownerships: [], runControls: [], nodes: [{ id: 'claim', revision: 0,
      typeId: 'demo.claim', typeVersion: 1, payload: { content: 'Kept claim' }, createdAt: time, updatedAt: time }], edges: [], updatedAt: time,
      runs: [{ id: 'run', scope: { nodeIds: ['claim'] }, plan: { steps: [] }, definitions: definitions.catalog, agents: [], tools: [], maxAgentSlots: 4,
        paused: true, regenerate: false, mode: 'auto', status: 'running', steps: [], operations: [], createdAt: time, updatedAt: time }] }
    const dispatch = vi.fn(), disconnect = vi.fn()
    const gateway = {
      watch: vi.fn((
        _mapId: string,
        _onEvent: unknown,
        signal?: AbortSignal
      ) =>
        /* 模拟持续到取消信号到达才结束的图订阅。 */
        new Promise<void>((_resolve, reject) => {
          // 为模拟订阅安装取消拒绝回调。
          signal?.addEventListener('abort', () => /* 收到取消后结束模拟订阅。 */ reject(new Error('Stopped')), { once: true })
      })),
      connect: vi.fn(async () => /* 为登录返回独立的启动信息副本。 */ structuredClone(bootstrap)),
      getConnection: vi.fn(async () =>
        /* 返回已配置且不记住凭据的连接信息。 */
        ({ baseUrl: 'http://fixture', configured: true, remembered: false, canRemember: false })),
      read: vi.fn(async (method: string, params?: any) => {
        // 按查询方法返回可变夹具的独立快照，供测试模拟服务端刷新。
        if (method === 'app.bootstrap') return structuredClone(bootstrap)
        if (method === 'workspace.list') return { items: [structuredClone(workspace)], nextCursor: null }
        if (method === 'workspace.get') return structuredClone(workspace)
        if (method === 'map.list') return [{ id: 'map', workspaceId: 'workspace', name: 'Graph', revision: 1, nodeCount: 1, typeCounts: { 'demo.claim@1': 1 }, updatedAt: time }]
        if (method === 'map.get') return structuredClone(map)
        if (method === 'branch.get') return { scope: { rootIds: [...params.rootIds], nodeIds: ['claim'], edgeIds: [] }, version: 'claim-branch-v1', rootRevisions: { claim: 0 }, mapRevision: map.revision }
        if (method === 'definition.get') return structuredClone(definitions)
        throw new Error('Unexpected query ' + method)
      }), dispatch, disconnect,
    } as unknown as ClientGateway
    const read = vi.mocked(gateway.read)
    const session = sessionCreateState(gateway, 60_000)
    await session.connect({ baseUrl: 'http://fixture', token: 'fixture', remember: false })
    return { session, gateway, read, workspace, bootstrap, map, dispatch, disconnect }
}

describe('Management refresh preserves the current graph', () => {
  // 覆盖管理刷新中的版本仲裁、迟到结果隔离和当前图状态保留。
  it('ignores older management successes and failures and never rolls settings backward', async () => {
    // 验证旧管理成功及错误均被忽略，全局设置版本不会倒退。
    const f = await openedManagement()
    const read = f.read.getMockImplementation()!
    const oldBootstrap = structuredClone(f.bootstrap), late = deferred<any>()
    let intercept = true
    f.read.mockImplementation(((
      method: string,
      params: any,
      signal: any
    ) => {
      // 仅延迟首次启动信息查询，其他请求沿用夹具实现。
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
    f.read.mockImplementationOnce(() => /* 延迟旧管理读取的错误，供较新刷新完成后再拒绝。 */ failed.promise)
    const oldFailure = f.session.refreshManagement()
    await f.session.refreshManagement()
    failed.reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: 'Old authorization result', retryable: false }))
    await oldFailure
    expect(f.session.bootstrap.value?.identity.userId).toBe('user')
    expect(f.disconnect).not.toHaveBeenCalled()
    f.session.dispose()
  })

  it('keeps Workspace and preference revisions independent and ignores stale access failures', async () => {
    // 验证工作区与偏好版本独立推进，旧访问错误不清空当前图或选择。
    const f = await openedManagement()
    const read = f.read.getMockImplementation()!
    const initialRun = f.session.snapshot.value!.runs[0], oldWorkspace = structuredClone(f.workspace), late = deferred<any>()
    let intercept = true
    f.read.mockImplementation(((
      method: string,
      params: any,
      signal: any
    ) => {
      // 仅延迟首次工作区读取，制造新旧版本交错到达。
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
    f.read.mockImplementationOnce(() => /* 延迟旧工作区访问错误，供刷新后检验失效结果隔离。 */ failed.promise)
    const oldFailure = f.session.refreshWorkspace()
    await f.session.refreshWorkspace()
    failed.reject(new ClientError({ status: 404, code: 'WORKSPACE_NOT_FOUND', message: 'Old access result', retryable: false }))
    await oldFailure
    expect(f.session.workspace.value?.id).toBe('workspace')
    await f.session.loadWorkspaces()
    expect(f.session.workspaces.value[0]).toMatchObject({ revision: 4, name: 'Latest fields' })
    expect(f.session.snapshot.value!.runs[0]).toBe(initialRun)
    expect(f.session.selectedId.value).toBe('claim')
    expect(f.session.error.value).toBeNull()
    f.session.dispose()
  })

  it('adopts Workspace and Settings changes without replacing a paused Run or selection', async () => {
    // 验证管理刷新接纳工作区与设置变化，同时保留暂停运行对象和节点选择。
    const { session, workspace, bootstrap, dispatch } = await openedManagement()
    const initialRun = session.snapshot.value!.runs[0]
    workspace.name = 'Updated workspace'; workspace.revision = 2
    bootstrap.settings.llm.model = 'after'; bootstrap.settings.revision = 2
    await session.refreshManagement()
    expect(session.workspace.value?.name).toBe('Updated workspace')
    expect(session.bootstrap.value?.settings.llm.model).toBe('after')
    expect(session.snapshot.value!.runs[0]).toBe(initialRun)
    expect(session.snapshot.value!.runs[0]?.paused).toBe(true)
    expect(session.activeMapId.value).toBe('map')
    expect(session.selectedId.value).toBe('claim')
    expect(dispatch).not.toHaveBeenCalled()
    session.dispose()
  })
})
