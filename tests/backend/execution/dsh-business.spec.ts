// 文件职责：验证 DSH 业务插件将根 Agent、角色、工具和提案绑定到可信授权。
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataActor, GraphDataRead, GraphOperation, GraphWorkGrant } from '../../../contracts/graph'
import { verificationConfiguration, verificationSlots } from '../fixtures/verification'

interface Agent {
  id: string
  ctx: {
    tools: {
      // 将该 Agent 可调用的工具限制为指定白名单。
      restrict(/* 插件请求设置的工具白名单对象，夹具记录 allow 内容。 */ input: { allow: string[] }): void
    }
    systemPrompt: { section: ReturnType<typeof vi.fn>; variable: ReturnType<typeof vi.fn>;
      // 取得提示词段的排序值，供插件插入部署角色说明。
      getSectionOrder(/* 插件查询的系统提示词段名，夹具返回固定排序值。 */ name: string): number
    }
  }
}
interface Execution { agent?: Agent; name?: string; signal: AbortSignal;
  // 提案被接纳后结束当前原生执行轮，测试通过调用记录验证这一副作用。
  concludeTurn(): void
}
interface Tool {
  name: string
  parameters: { properties: Record<string, unknown> }
  // 模拟原生工具调用接口；执行前由夹具运行插件登记的身份及能力守卫。
  execute(/* 模型传来的未经信任工具参数，交给工具自身 schema 与业务逻辑验证。 */ args: unknown, /* 原生执行上下文，携带 Agent 对象、工具名、取消信号及结束本轮操作。 */ exec: Execution): Promise<unknown>
}
const servers: Server[] = []
afterEach(async () => {
  // 关闭全部测试 API 并恢复插件读取的环境变量。
  await Promise.all(servers.splice(0).map(/* 本用例启动并登记的本地 HTTP 服务器，需要在结束时关闭。 */ server => /* 为每个测试服务器创建关闭等待。 */  new Promise<void>((/* 测试服务器关闭成功后的清理完成回调。 */ resolve, /* 测试服务器关闭失败后的清理拒绝回调。 */ reject) => /* 将 HTTP 关闭回调转换为可等待结果。 */  server.close(/* HTTP 关闭返回的可选错误，存在时不应被清理过程隐藏。 */ error => /* 传递服务器关闭错误，避免清理失败被隐藏。 */  error ? reject(error) : resolve()))))
  vi.unstubAllEnvs()
})

async function fixture(/* 测试工作角色及可选槽位，默认路由角色，用于生成可信授权。 */ actor: GraphDataActor = { role: 'router' }, /* 是否故意省略证据工具注册，默认 false；用于验证执行前能力检查。 */ missingTool = false, /* 测试 Operation 种类，默认 verify，决定目标形状及配置组。 */ operationKind: GraphOperation['kind'] = 'verify') {
  // 创建角色专属配置、可信授权、假 API 和工具注册上下文供插件测试。
  const configuration = verificationConfiguration()
  configuration.parse = { ...configuration.agents[0], id: 'parser', content: 'Parse shared source', promptVars: ['rawContent'] }
  configuration.split = {
    router: { ...configuration.router, id: 'split-router', content: 'Select split workers' },
    merger: { ...configuration.merger, id: 'split-merger', content: 'Select worker claims' },
    agents: configuration.agents.map(/* 核查 Agent 的基础测试配置，复制后转换为拆分 Agent。 */ agent => /* 生成只产出固定分类事实的拆分 Agent 配置。 */  ({ ...agent, id: 'split-' + agent.id, content: 'Extract claims', claimCategory: 'data' })),
  }
  const slots = verificationSlots(2).map(/* 基础路由槽位，按当前 Operation 种类转换引用的 Agent 身份。 */ slot => /* 根据 Operation 种类把路由槽位映射到正确的 Agent 组。 */  ({ ...slot, agentId: (operationKind === 'split' ? 'split-' : '') + slot.agentId }))
  const routeRevision = actor.role === 'router' || actor.role === 'parse' ? 0 : 2
  const workId = actor.role === 'parse' ? 'op-1:parse' : actor.role === 'router' ? 'op-1:route'
    : actor.role === 'merge' ? 'op-1:merge:2' : 'op-1:report:2:' + actor.slotId
  const grant: GraphWorkGrant = {
    workId, mapId: 'map-1', runId: 'run-1', operationId: 'op-1',
    actor, routeRevision, hostId: 'host-a', holderId: 'holder-original', fence: 7,
    expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30000,
  }
  const view: GraphDataRead = {
    mapId: 'map-1', runId: 'run-1', operationId: 'op-1', operationKind,
    target: { id: 'target-1', revision: 0, data: operationKind === 'parse'
      ? { kind: 'source', locator: { kind: 'asset', assetId: 'asset-1', mediaType: 'text/plain' }, label: null }
      : operationKind === 'split' ? { kind: 'news', content: 'News to split', context: {} }
      : { kind: 'claim', content: 'A testable statement', category: null }, createdAt: '', updatedAt: '' },
    ...(operationKind === 'parse' ? { rawContent: 'Shared source text' } : {}),
    context: [], configuration,
    route: actor.role === 'router' || actor.role === 'parse' ? null : { revision: 2, reason: 'custom angles', slots, approved: true },
    reports: [], splitReports: [], contentDraft: null, draft: null, review: null,
    phase: actor.role === 'parse' ? 'parse' : actor.role === 'router' ? 'route' : actor.role === 'worker' ? 'workers' : 'merge',
    proposalId: workId, work: { id: workId, actor, routeRevision, status: 'ready' },
  }
  const received: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = []
  let denied = false
  const server = createServer(async (/* 插件发来的 HTTP 请求，夹具记录路径、正文及租约头。 */ request, /* 用于返回固定视图或模拟 LEASE_LOST 的 HTTP 响应。 */ response) => {
    // 记录插件请求，按开关模拟失租，或返回并更新授权视图。
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    received.push({ path: request.url!, body, headers: request.headers })
    if (denied) {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'LEASE_LOST', message: 'This work lease expired' } }))
      return
    }
    if (request.url?.endsWith('/propose')) view.work.status = 'accepted'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, data: view }))
  })
  servers.push(server)
  await new Promise<void>(/* 本地数据 API 监听成功后的启动兑现函数。 */ resolve => /* 等待插件数据 API 夹具在本地绑定端口。 */  server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test API did not bind')
  vi.stubEnv('CHONGMING_DATA_API', 'http://127.0.0.1:' + address.port)
  vi.stubEnv('CHONGMING_DATA_TOKEN', 'test-only-bridge-token')

  const tools = new Map<string, Tool>()
  const agents = new Map<string, Agent>()
  const allowed = new Map<string, string[]>()
  const guards: Array<(/* 能力守卫收到的待调用工具上下文，含实际 Agent 对象。 */ exec: Execution) => string | undefined> = []
  const created: Array<(/* 创建事件载荷，携带即将被绑定和限制能力的 Agent 本体。 */ event: { agent: Agent }) => void> = []
  const concludeTurn = vi.fn()
  const ctx = {
    tools: {
      register: (/* 插件注册的原生工具定义，按其 name 保存。 */ tool: Tool) => {
        // 按工具名保存插件注册的工具定义。
         tools.set(tool.name, tool) },
      get: (/* 需要查询的工具名称。 */ name: string, /* 可选发起查询的 Agent；提供时按其已记录白名单过滤可见工具。 */ agent?: Agent) => /* 模拟 Agent 工具限制，只返回其可见能力。 */  !agent || !allowed.has(agent.id) || allowed.get(agent.id)!.includes(name) ? tools.get(name) : undefined,
      guard: (/* 插件登记的能力检查函数，返回字符串表示拒绝原因。 */ guard: (/* 待检查的原生执行上下文，用于核对 Agent 及工具能力。 */ exec: Execution) => string | undefined) => {
        // 保存插件登记的执行前能力守卫。
         guards.push(guard) },
    },
    agents: { get: (/* 查找已注册 Agent 对象的会话身份。 */ id: string) => /* 返回已注册 Agent 的实际对象，用于检测对象冒用。 */  agents.get(id) },
    on: (/* 插件监听的事件名，此简化夹具仅收集创建监听而不按名字分组。 */ _event: string, /* 接收 Agent 创建事件的监听函数，保存后由用例显式触发。 */ listener: (/* 模拟创建事件载荷，携带同一已注册根 Agent 对象。 */ event: { agent: Agent }) => void) => {
      // 收集 Agent 创建监听器，供测试显式触发。
       created.push(listener) },
  }
  for (const name of ['archive_lookup', 'ledger_query', 'subagent', 'workflow', 'cordis_run']) {
    if (missingTool && name === 'archive_lookup') continue
    tools.set(name, { name, parameters: { properties: {} }, execute: async () => /* 为测试外部工具返回固定结果。 */  'fixture' })
  }
  const modulePath = '../../../backend/execution/dsh/dsh-business-plugin.mjs'
  const plugin = await import(modulePath) as {
    // 根据可信工作配置注册业务工具、身份守卫及根 Agent 创建监听。
    apply(/* 模拟 DSH 插件上下文，提供工具、Agent 和事件注册入口。 */ ctx: unknown, /* 可选可信部署配置，测试可省略或破坏字段来验证初始化拒绝。 */ config?: unknown): void
  }
  const group = operationKind === 'split' ? configuration.split : configuration
  const profile = actor.role === 'parse' ? configuration.parse : actor.role === 'router' ? group.router : actor.role === 'merge' ? group.merger : group.agents[0]
  const config = { grant, rootSessionId: 'work-session', operationKind, proposalId: view.proposalId, configuration, route: view.route, persona: profile.content }
  plugin.apply(ctx, config)
  const agent: Agent = {
    id: 'work-session',
    ctx: {
      tools: { restrict: /* 插件为根 Agent 设置的白名单对象，保存 allow 供能力断言。 */ input => {
        // 记录根 Agent 被限制后的工具白名单。
         allowed.set('work-session', input.allow) } },
      systemPrompt: { section: vi.fn(), variable: vi.fn(), getSectionOrder: () => /* 为测试提示词段返回固定排序值。 */  0 },
    },
  }
  agents.set(agent.id, agent)
  const publish = () => {
    // 向所有创建监听器发布本测试根 Agent。
     for (const listener of created) listener({ agent }) }
  async function execute(/* 用例要求调用的工具名，先经过已注册守卫检查。 */ name: string, /* 用例指定的调用 Agent 对象，可替换为伪造副本验证身份边界。 */ sender: Agent, /* 提交给工具的模型参数，测试可故意带越权或协议外字段。 */ args: unknown) {
    // 先运行全部能力守卫，再以指定 Agent 和参数调用注册工具。
    const exec = { name, agent: sender, signal: new AbortController().signal, concludeTurn }
    for (const guard of guards) {
      const reason = guard(exec)
      if (reason) throw new Error(reason)
    }
    return tools.get(name)!.execute(args, exec)
  }
  return { plugin, ctx, config, grant, view, configuration, agent, publish, received, allowed, tools, execute, concludeTurn, deny: () => {
    // 让后续 API 请求统一返回租约丢失。
     denied = true } }
}

describe('DSH work bridge', () => {
  // 覆盖可信工作绑定、角色能力和各类提案结构约束。
  it('requires a complete grant instead of accepting an unleased operation', async () => {
    // 验证缺少完整租约配置时插件直接拒绝注册。
    const modulePath = '../../../backend/execution/dsh/dsh-business-plugin.mjs'
    const plugin = await import(modulePath)
    expect(() => /* 不提供工作配置以触发完整授权校验。 */  plugin.apply({})).toThrow('complete work grant')
    expect(() => /* 只提供操作身份而没有租约，验证不能代替可信工作授权。 */  plugin.apply({}, { mapId: 'map', operationId: 'op', rootSessionId: 'root', configuration: {} })).toThrow('complete work grant')
  })

  it('runs a worker as its own root with its selected custom tools and a fixed proof', async () => {
    // 验证 worker 使用自有根会话和槽位工具，后续外部授权对象变更不会改变请求凭证。
    const f = await fixture({ role: 'worker', slotId: 'angle-1' })
    f.publish()
    expect(f.allowed.get(f.agent.id)).toEqual(['data_read', 'data_propose', 'archive_lookup'])
    expect(f.agent.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ text: '{{chongming_persona}}' }))
    expect(f.agent.ctx.systemPrompt.variable.mock.calls[0][1]()).toBe(f.configuration.agents[0].content)
    await expect(f.execute('archive_lookup', f.agent, {})).resolves.toBe('fixture')
    await expect(f.execute('ledger_query', f.agent, {})).rejects.toThrow('capability')
    // A later renewal/reassignment must never rewrite an already-created bridge's authority.
    f.grant.holderId = 'holder-new'
    f.grant.fence = 99
    await expect(f.execute('data_propose', f.agent, { proposal: { kind: 'report', score: 1, reason: 'primary evidence' } })).resolves.toEqual({
      work: { id: 'op-1:report:2:angle-1', actor: { role: 'worker', slotId: 'angle-1' }, routeRevision: 2, status: 'accepted' },
    })
    expect(f.received.map(/* 已记录的插件 HTTP 调用，提取 path 验证请求顺序。 */ call => /* 提取插件请求路径以核对先读取再提交的顺序。 */  call.path)).toEqual(['/internal/v1/data/read', '/internal/v1/data/propose'])
    const report = f.received.find(/* 已记录的 HTTP 调用，查找真正的提案请求核对身份与凭据。 */ call => /* 定位实际提案请求，核对可信身份和请求头。 */  call.path.endsWith('/propose'))!
    expect(report).toMatchObject({
      headers: { authorization: 'Bearer test-only-bridge-token', 'x-work-id': 'op-1:report:2:angle-1', 'x-work-holder': 'holder-original', 'x-work-fence': '7' },
      body: { mapId: 'map-1', operationId: 'op-1', id: 'op-1:report:2:angle-1', kind: 'report', slotId: 'angle-1', routeRevision: 2 },
    })
    expect(report.headers['x-dsh-role']).toBeUndefined()
    expect(report.headers['x-dsh-slot']).toBeUndefined()
    expect(f.concludeTurn).toHaveBeenCalledOnce()
    expect(Object.keys(f.tools.get('data_read')!.parameters.properties)).toEqual([])
    expect(Object.keys(f.tools.get('data_propose')!.parameters.properties)).toEqual(['proposal'])
  })

  it('rejects role, slot and Agent impersonation and never registers unleased delegation', async () => {
    // 验证角色、槽位及 Agent 对象冒用被拒绝，插件不提供无租约委派能力。
    const f = await fixture({ role: 'worker', slotId: 'angle-1' })
    f.publish()
    expect(f.tools.has('data_delegate')).toBe(false)
    await expect(f.execute('data_propose', f.agent, { proposal: { kind: 'merge', score: 1, reason: 'spoof', reportIds: [] } })).rejects.toThrow()
    await expect(f.execute('data_propose', f.agent, { proposal: { kind: 'report', score: 1, reason: 'spoof', slotId: 'angle-2' } })).rejects.toThrow()
    await expect(f.execute('data_read', { ...f.agent }, {})).rejects.toThrow('binding')
    for (const name of ['data_delegate', 'subagent', 'workflow', 'cordis_run']) {
      await expect(f.execute(name, f.agent, {})).rejects.toThrow('capability')
    }
    expect(f.received).toEqual([])
  })

  it('selects router and merger profiles without granting them worker identity', async () => {
    // 验证路由和汇总采用自身配置且提交中不出现 worker 槽位身份。
    for (const actor of [{ role: 'router' }, { role: 'merge' }] as const) {
      const f = await fixture(actor)
      f.publish()
      expect(f.allowed.get(f.agent.id)).toEqual(['data_read', 'data_propose'])
      const profile = actor.role === 'router' ? f.configuration.router : f.configuration.merger
      expect(f.agent.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ text: '{{chongming_persona}}' }))
      expect(f.agent.ctx.systemPrompt.variable.mock.calls[0][1]()).toBe(profile.content)
      const proposal = actor.role === 'router'
        ? { kind: 'route', reason: 'dynamic angle', slots: verificationSlots(2) }
        : { kind: 'merge', score: 0.5, reason: 'inconclusive', reportIds: ['report-a', 'report-b'] }
      await f.execute('data_propose', f.agent, { proposal })
      const saved = f.received.find(/* 路由或汇总期间记录的 HTTP 请求，定位提案载荷。 */ call => /* 定位路由或汇总提案，检查其可信提交身份。 */  call.path.endsWith('/propose'))!
      expect(saved.body.id).toBe(f.grant.workId)
      expect(saved.body.slotId).toBeUndefined()
      expect(f.concludeTurn).toHaveBeenCalledOnce()
    }
  })

  it('fails before execution for a missing registered tool or mismatched route', async () => {
    // 验证缺失注册工具、错路由版本和绕过能力在执行前被拒绝。
    const f = await fixture({ role: 'worker', slotId: 'angle-1' }, true)
    expect(f.publish).toThrow('not registered')
    expect(f.received).toEqual([])
    const invalid = { ...f.config, grant: { ...f.grant, routeRevision: 100 } }
    expect(() => /* 以不匹配的路由版本重新注册插件，触发授权校验。 */  f.plugin.apply(f.ctx, invalid)).toThrow('matching approved route')
    const bypass = structuredClone(f.configuration)
    bypass.router.tools = ['subagent']
    bypass.tools.push({ name: 'subagent', description: 'escape' })
    expect(() => /* 给路由配置加入委派能力，验证禁止工具不能借配置获得授权。 */  f.plugin.apply(f.ctx, { ...f.config, grant: { ...f.grant, actor: { role: 'router' }, routeRevision: 0 }, configuration: bypass })).toThrow('capability')
  })

  it('propagates loss of the fixed lease without retrying under another grant', async () => {
    // 模拟固定授权丢失，验证插件直接传播错误而不借其他授权重试。
    const f = await fixture({ role: 'worker', slotId: 'angle-1' })
    f.publish()
    f.deny()
    await expect(f.execute('data_propose', f.agent, { proposal: { kind: 'report', score: 1, reason: 'late result' } })).rejects.toThrow('LEASE_LOST')
    expect(f.received).toHaveLength(1)
    expect(f.received[0].path).toContain('/read')
    expect(f.concludeTurn).not.toHaveBeenCalled()
  })

  it('parses shared source text with the configured parser and trusted operation identity', async () => {
    // 验证解析角色只能读取共享正文并提交新闻，不能伪造槽位或改成路由角色。
    const f = await fixture({ role: 'parse' }, false, 'parse')
    f.publish()
    expect(f.allowed.get(f.agent.id)).toEqual(['data_read', 'data_propose', 'archive_lookup'])
    expect(f.agent.ctx.systemPrompt.variable.mock.calls[0][1]()).toBe('Parse shared source')
    const result = await f.execute('data_read', f.agent, {}) as GraphDataRead
    expect(result.rawContent).toBe('Shared source text')
    const proposal = { kind: 'parse', reason: 'Removed formatting', news: [{ content: 'First news', context: {} },
      { content: 'Second news', context: { source: { value: 'original', visibleToAI: true } } }] }
    await f.execute('data_propose', f.agent, { proposal })
    expect(f.received.at(-1)!.body).toEqual({ ...proposal, id: f.view.proposalId, mapId: 'map-1', operationId: 'op-1' })
    await expect(f.execute('data_propose', f.agent, { proposal: { ...proposal, slotId: 'forged' } })).rejects.toThrow()
    expect(() => /* 将解析工作伪装为路由角色，确认初始化拒绝。 */  f.plugin.apply(f.ctx, { ...f.config, grant: { ...f.grant, actor: { role: 'router' } } })).toThrow('parser identity')
  })

  it('keeps split router, workers and merger separate and submits only selected report references', async () => {
    // 验证拆分路由、worker 和汇总各自能力与结构，汇总只选择已提交候选引用。
    const router = await fixture({ role: 'router' }, false, 'split')
    router.publish()
    expect(router.agent.ctx.systemPrompt.variable.mock.calls[0][1]()).toBe('Select split workers')
    await expect(router.execute('data_propose', router.agent, { proposal: { kind: 'route', reason: 'wrong group', slots: verificationSlots(1) } })).rejects.toThrow('capability')
    const slots = verificationSlots(2).map(/* 合法基础路由槽位，复制后引用拆分配置组中的 Agent。 */ slot => /* 将合法路由槽位切换为拆分专属 Agent。 */  ({ ...slot, agentId: 'split-' + slot.agentId }))
    await router.execute('data_propose', router.agent, { proposal: { kind: 'route', reason: 'independent extractors', slots } })

    const worker = await fixture({ role: 'worker', slotId: 'angle-1' }, false, 'split')
    worker.publish()
    expect(worker.agent.ctx.systemPrompt.variable.mock.calls[0][1]()).toBe('Extract claims')
    expect(worker.allowed.get(worker.agent.id)).toEqual(['data_read', 'data_propose', 'archive_lookup'])
    await expect(worker.execute('data_propose', worker.agent, { proposal: { kind: 'split-report', reason: 'wrong category', claims: [{ content: 'Fact', category: 'quote' }] } })).rejects.toThrow()
    const claims = [{ content: 'Fact retained exactly', category: 'data' }]
    await worker.execute('data_propose', worker.agent, { proposal: { kind: 'split-report', reason: 'Extracted facts', claims } })
    expect(worker.received.at(-1)!.body).toMatchObject({ kind: 'split-report', claims, routeRevision: 2, slotId: 'angle-1' })

    const merger = await fixture({ role: 'merge' }, false, 'split')
    merger.publish()
    expect(merger.agent.ctx.systemPrompt.variable.mock.calls[0][1]()).toBe('Select worker claims')
    const selected = [{ reportId: 'report-1', index: 0 }]
    await merger.execute('data_propose', merger.agent, { proposal: { kind: 'split-merge', reason: 'Removed duplicates', reportIds: ['report-1', 'report-2'], selected } })
    expect(merger.received.at(-1)!.body).toMatchObject({ kind: 'split-merge', selected, routeRevision: 2 })
    await expect(merger.execute('data_propose', merger.agent, { proposal: { kind: 'split-merge', reason: 'forged', reportIds: [], selected, claims } })).rejects.toThrow()
    expect(merger.received.at(-1)!.body).not.toHaveProperty('score')
  })

  it('rejects a read projection whose operation kind changed beneath the fixed grant', async () => {
    // 改变 API 返回的 Operation 种类，验证固定工作绑定复核拒绝该视图。
    const f = await fixture({ role: 'router' }, false, 'split')
    f.publish()
    f.view.operationKind = 'verify'
    await expect(f.execute('data_read', f.agent, {})).rejects.toThrow('different work binding')
  })
})
