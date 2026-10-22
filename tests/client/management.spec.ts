// 管理任务单元测试：验证草稿隔离、重试身份、作用域取消和刷新版本仲裁。
import { effectScope, reactive } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { ClientGateway } from '../../contracts/client'
import { ClientError } from '../../contracts/client'
import type { AgentBinding, AgentInput, AgentProfile } from '../../contracts/control'
import type { DefinitionCatalog } from '../../contracts/data-definition'
import { useManagementTask } from '../../apps/ui/features/management/use-management'
import { sessionCreateState } from '../../apps/ui/state/client-session'
import { agentBuildBoundDraft, agentCreateDraft, agentReadBindingChoices, agentReadBindingValidation, agentReadEditorContract } from '../../apps/ui/features/agents/agent-editor'
import { DEFAULT_DEFINITION_PACKAGE } from '../../apps/config/default-prompts'

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

describe('Agent drafts and registered stage contracts', () => {
  // 覆盖编辑隔离、三种当前结果模式，以及绑定变量不再退回固定 kind 白名单。
  const profile: AgentProfile = {
    id: 'bound-agent', name: 'Bound Agent', description: 'Agent for a registered stage', content: 'Produce a result',
    kind: 'verifySubAgent', promptPath: 'custom/bound-agent', provider: null, model: null, tools: [],
    promptVars: ['claimContent'], defaultPriority: 'medium', claimCategory: null, role: 'producer',
    bindings: [{ transition: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'assess' }],
    revision: 3, deletable: true, updatedAt: '2026-10-04T00:00:00.000Z',
  }
  const catalog: DefinitionCatalog = { revision: 1, packages: [], index: [],
    dataTypes: DEFAULT_DEFINITION_PACKAGE.dataTypes, transitions: DEFAULT_DEFINITION_PACKAGE.transitions }

  it('copies generic role and bindings without retaining mutable references or server metadata', () => {
    // 修改草稿绑定和变量时，服务端配置快照必须保持原值。
    const draft = agentCreateDraft(reactive(profile))
    expect(draft).toMatchObject({ role: profile.role, bindings: profile.bindings })
    expect(draft).not.toHaveProperty('revision')
    expect(draft).not.toHaveProperty('deletable')
    if (!draft.bindings) throw new Error('Draft binding is missing')
    draft.bindings[0].transition.version = 2
    draft.promptVars.push('changed')
    expect(profile.bindings?.[0].transition.version).toBe(1)
    expect(profile.promptVars).toEqual(['claimContent'])
  })

  it('reads exact schemas and current outputs, selection and plan modes from bound stages', () => {
    // 三类输出说明来自真实发布定义，不能复用旧报告或路由示例。
    const output = agentReadEditorContract(profile, catalog, { verifySubAgent: ['obsoleteVariable'] })
    expect(output.variables).toContain('claimContent')
    expect(output.variables).not.toContain('obsoleteVariable')
    const opinion = catalog.dataTypes.find(
      /* 目录中声明的一个类型。 */ type => /* 定位阶段输出的精确类型。 */ type.id === 'factcheck.opinion' && type.version === 1,
    )
    expect(output.stages[0].output).toMatchObject({ mode: 'outputs', ports: [{ port: 'opinions', schema: opinion?.schema }] })
    const selection = agentReadEditorContract({ ...profile, role: 'selector', bindings: [
      { transition: { id: 'factcheck.split-news', version: 1 }, stageId: 'merge' },
    ] }, catalog, {})
    expect(selection.stages[0].output.mode).toBe('selection')
    const plan = agentReadEditorContract({ ...profile, role: 'planner', bindings: [
      { transition: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'route' },
    ] }, catalog, {})
    expect(plan.stages[0].output).toEqual({ mode: 'plan', ports: [] })
    expect(plan.stages[0].plan).toMatchObject({ stageIds: ['assess'], maxSlots: expect.any(Number) })
    const multiple = agentReadEditorContract({ ...profile, bindings: [
      { transition: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'assess' },
      { transition: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'merge' },
    ] }, catalog, {})
    expect(multiple.variables).toEqual(['claimContent', 'originalContent'])
  })

  it('uses exact binding versions and leaves unresolved or unbound configurations editable', () => {
    // 缺少绑定目录时不能拿旧 kind 白名单拒绝现有变量，也不能编造输出合同。
    const unresolved = agentReadEditorContract({ ...profile, bindings: [
      { transition: { id: 'factcheck.verify-claim', version: 2 }, stageId: 'assess' },
    ] }, catalog, { verifySubAgent: [] })
    expect(unresolved.variables).toBeNull()
    expect(unresolved.stages).toEqual([])
    expect(unresolved.unresolved).toHaveLength(1)
    const unbound = agentCreateDraft(profile)
    delete unbound.role; delete unbound.bindings
    expect(agentReadEditorContract(unbound, catalog, { verifySubAgent: ['claimContent'] }))
      .toEqual({ variables: ['claimContent'], stages: [], unresolved: [] })
  })

  it.each(['toString', 'constructor', '__proto__'])('自定义角色 %s 不会继承对象原型变量', (
    /* 服务允许的自定义角色名称，恰好与对象原型属性同名。 */ kind,
  ) => {
    // 未配置该角色的变量合同应保持未知，而非返回函数或原型对象。
    const agent = agentCreateDraft(profile)
    delete agent.role
    delete agent.bindings
    agent.kind = kind
    expect(agentReadEditorContract(agent, catalog, { verifySubAgent: ['claimContent'] }))
      .toEqual({ variables: null, stages: [], unresolved: [] })
  })
})

describe('C14 precise Agent role and binding drafts', () => {
  // 角色来自阶段结果职责，绑定编辑不改既有身份、变量或已发布目录。
  const draft: AgentInput = { id: 'new-bound-agent', name: '新通用智能体', description: '绑定已有精确阶段', content: '保留正文',
    kind: 'customBoundAgent', promptPath: 'custom/original-path', provider: null, model: null,
    tools: ['saved-tool'], promptVars: ['claimContent', 'savedButNowInvalid'], defaultPriority: 'medium', claimCategory: null }
  const catalog: DefinitionCatalog = { revision: 1, packages: [], index: [],
    dataTypes: DEFAULT_DEFINITION_PACKAGE.dataTypes, transitions: DEFAULT_DEFINITION_PACKAGE.transitions }
  const binding: AgentBinding = { transition: { id: 'factcheck.verify-claim', version: 1 }, stageId: 'assess' }

  it.each([
    { role: 'producer' as const, mode: 'outputs' as const },
    { role: 'planner' as const, mode: 'plan' as const },
    { role: 'selector' as const, mode: 'selection' as const },
  ])('lists only exact $mode stages for $role without requiring the current executor to be this Agent', (/* 阶段结果模式与可保存角色的真实对应。 */ { role, mode }) => {
    // 新Agent尚未被任何旧阶段引用，也能选择同职责已发布阶段。
    const choices = agentReadBindingChoices(catalog, role)
    const expected = catalog.transitions.flatMap((/* 当前真实目录的一份转换。 */ transition) =>
      /* 不跨范围或回落其它版本。 */ transition.execution.stages.filter((/* 该转换的阶段。 */ stage) => /* 只取同职责。 */ stage.resultMode === mode)
        .map((/* 可参与的同职责阶段。 */ stage) => /* 稳定精确绑定身份。 */ ({ transition: { id: transition.id, version: transition.version }, stageId: stage.id })))
    expect(choices.map((/* 可直接用于下拉列表的选择。 */ choice) => /* 比较精确身份而非显示名。 */ choice.binding)).toEqual(expected)
    expect(choices.length).toBeGreaterThan(0)
    expect(choices.every((/* 页面显示的精确选择。 */ choice) => /* 标题保留转换和阶段身份。 */ choice.title.includes(choice.binding.transition.id) && choice.title.includes(choice.binding.stageId))).toBe(true)
  })

  it('preserves multiple exact versions and returns independent choices from only the supplied catalog', () => {
    // 同一转换的新旧版本都是明确选项，不被latest替换或写回目录。
    const scoped = structuredClone(catalog)
    const original = scoped.transitions.find((/* 当前真实转换。 */ item) => /* 找到将复制为另一精确版本的转换。 */ item.id === binding.transition.id)
    if (!original) throw new Error('Expected published transition')
    const next = structuredClone(original)
    next.version = 2
    scoped.transitions = [original, next]
    const before = structuredClone(scoped)
    const choices = agentReadBindingChoices(scoped, 'producer')
    expect(choices.some((/* 精确选择。 */ choice) => /* 明确保留旧版本。 */ choice.binding.transition.version === 1)).toBe(true)
    expect(choices.some((/* 精确选择。 */ choice) => /* 明确保留另一个已发布版本。 */ choice.binding.transition.version === 2)).toBe(true)
    choices[0].binding.transition.version = 9
    expect(scoped).toEqual(before)
    expect(agentReadBindingChoices(null, 'producer')).toEqual([])
  })

  it('builds independent bound drafts without changing identity original prompt variables or input bindings', () => {
    // 换职责或移除绑定都保留旧变量，由用户明确清理，不偷偷改kind/path。
    const bindings = [structuredClone(binding)]
    const before = structuredClone({ draft, bindings })
    const built = agentBuildBoundDraft(reactive(draft), 'producer', reactive(bindings))
    expect(built).toEqual({ ...draft, role: 'producer', bindings })
    built.tools.push('new-tool'); built.promptVars.push('new-var')
    if (!built.bindings) throw new Error('Expected bound draft')
    built.bindings[0].transition.version = 9
    expect({ draft, bindings }).toEqual(before)
    const removed = agentBuildBoundDraft(built, 'planner', [])
    expect(removed).toMatchObject({ id: draft.id, kind: draft.kind, promptPath: draft.promptPath, role: 'planner', bindings: [], promptVars: built.promptVars })
  })

  it('validates same-role variable intersection without deleting an invalid saved variable', () => {
    // 两个生成阶段允许变量的交集决定保存范围，草稿中的旧变量必须原样留给用户处理。
    const scoped = structuredClone(catalog)
    const transition = scoped.transitions.find((/* 精确转换。 */ item) => /* 只改本用例的独立目录副本。 */ item.id === binding.transition.id)
    if (!transition) throw new Error('Expected published transition')
    const first = transition.execution.stages.find((/* 同职责阶段。 */ stage) => /* 定位原生成阶段。 */ stage.id === binding.stageId)
    if (!first) throw new Error('Expected published producer stage')
    const second = structuredClone(first)
    second.id = 'another.producer-stage'
    first.promptBindings = { shared: { source: 'input', port: 'claim', format: 'text' }, firstOnly: { source: 'input', port: 'claim', format: 'text' } }
    second.promptBindings = { shared: { source: 'input', port: 'claim', format: 'text' }, secondOnly: { source: 'input', port: 'claim', format: 'text' } }
    transition.execution.stages.push(second)
    const built = agentBuildBoundDraft({ ...draft, promptVars: ['shared', 'firstOnly'] }, 'producer', [binding, { ...binding, stageId: second.id }])
    expect(agentReadEditorContract(built, scoped, {}).variables).toEqual(['shared'])
    expect(agentReadBindingValidation(built, scoped).join(' ')).toContain('firstOnly')
    expect(built.promptVars).toEqual(['shared', 'firstOnly'])
    expect(agentReadBindingValidation({ ...built, promptVars: ['shared'] }, scoped)).toEqual([])
  })

  it.each([
    { name: 'empty', role: 'producer' as const, bindings: [] },
    { name: 'duplicate', role: 'producer' as const, bindings: [binding, binding] },
    { name: 'wrong role', role: 'planner' as const, bindings: [binding] },
    { name: 'wrong exact version', role: 'producer' as const, bindings: [{ ...binding, transition: { ...binding.transition, version: 99 } }] },
    { name: 'unknown stage', role: 'producer' as const, bindings: [{ ...binding, stageId: 'missing-stage' }] },
  ])('blocks $name bindings when the exact catalog is known', (/* 已知目录能证明不可保存的绑定。 */ { role, bindings }) => {
    // 空集合、重复、职责与精确定位都不能借合同展示投影冒充有效配置。
    const built = agentBuildBoundDraft({ ...draft, promptVars: [] }, role, bindings)
    expect(agentReadBindingValidation(built, catalog).length).toBeGreaterThan(0)
  })

  it('keeps unresolved saved bindings and unknown variables when the scope has no catalog', () => {
    // 旧服务无法核对时保留原字段，页面禁用新增更换，不退回旧kind变量白名单。
    const unknown = { transition: { id: 'old.unresolved-transition', version: 7 }, stageId: 'old.unresolved-stage' }
    const original = { ...draft, role: 'selector' as const, bindings: [unknown] }
    const built = agentBuildBoundDraft(original, original.role, original.bindings)
    expect(agentReadBindingChoices(null, 'selector')).toEqual([])
    expect(agentReadEditorContract(built, null, { customBoundAgent: [] })).toMatchObject({ variables: null, unresolved: [unknown] })
    expect(agentReadBindingValidation(built, null)).toEqual([])
    expect(built).toEqual(original)
    expect(built.bindings).not.toBe(original.bindings)
  })

  it('requires role and bindings together while retaining the unbound legacy editing path', () => {
    // 不迁移旧配置；通用组合缺任意半边时明确阻止保存。
    expect(agentReadBindingValidation(draft, catalog)).toEqual([])
    expect(agentReadBindingValidation({ ...draft, role: 'producer' }, catalog).length).toBeGreaterThan(0)
    expect(agentReadBindingValidation({ ...draft, bindings: [binding] }, catalog).length).toBeGreaterThan(0)
    expect(agentReadBindingValidation(null, catalog)).toEqual([])
  })
})

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
    const read = vi.fn((
      /* 管理任务实际调用的公开查询方法。 */ _method: string,
      /* 对应查询的冻结参数。 */ _params: unknown,
      /* 由组件作用域管理的查询取消信号。 */ _signal?: AbortSignal,
    ) => /* 延迟查询结果，供作用域销毁后交付。 */ pending.promise)
    const task = scope.run(() =>
      /* 在测试作用域中创建管理任务，以验证自动释放绑定。 */
      useManagementTask({ gateway: { read } as unknown as ClientGateway, onUnauthorized: vi.fn() }))!
    const reading = task.read('workspace.get', { workspaceId: 'old-workspace' }, accept)
    scope.stop()
    pending.resolve({ id: 'old-workspace' })
    expect(await reading).toBeNull()
    expect(accept).not.toHaveBeenCalled()
    expect(read.mock.calls[0][2]?.aborted).toBe(true)
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
      metadata: { variables: {} } }
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
