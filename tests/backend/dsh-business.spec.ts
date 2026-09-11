import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataRead, GraphReport } from '../../contracts/graph'
import { verificationConfiguration, verificationSlots } from './fixtures/verification'

interface Agent {
  id: string
  session: { header: { parentSession?: string } }
  ctx: {
    tools: { restrict(input: { allow: string[] }): void }
    systemPrompt: { section: ReturnType<typeof vi.fn>; getSectionOrder(name: string): number }
  }
  whenIdle(): Promise<void>
}
interface Execution { agent?: Agent; name?: string; signal: AbortSignal }
interface Tool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: unknown, exec: Execution): Promise<unknown>
  isConcurrencySafe?(): boolean
}
interface StartSpec {
  childId: string
  request: { parent: Agent; prompt: unknown; persona: string; agentOptions: { provider: string; model: string }; toolFilter: { allow: string[] }; maxDepth: number }
  signal: AbortSignal
}
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
  vi.unstubAllEnvs()
})

async function fixture(options: { approved?: boolean; missingTools?: boolean; slotName?: string } = {}) {
  const configuration = verificationConfiguration()
  const slots = verificationSlots(1)
  if (options.slotName) slots[0].id = options.slotName
  const view: GraphDataRead = {
    mapId: 'map-1', runId: 'run-1', operationId: 'op-1',
    claim: { id: 'claim-1', revision: 0, data: { kind: 'claim', content: 'A testable statement', category: null }, createdAt: '', updatedAt: '' },
    context: [], configuration,
    route: { revision: 2, reason: 'one custom angle', slots, approved: options.approved ?? true },
    reports: [], draft: null, review: null,
    phase: options.approved === false ? 'waiting' : 'workers', proposalId: 'op-1:route',
  }
  const received: Array<{ path: string; body: Record<string, unknown>; role: string; slot?: string; authorization?: string }> = []
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    const role = String(request.headers['x-dsh-role'])
    const slot = request.headers['x-dsh-slot'] as string | undefined
    received.push({ path: request.url!, body, role, slot, authorization: request.headers.authorization })
    if (request.url?.endsWith('/propose')) {
      if (body.kind === 'report') {
        view.reports.push({
          id: String(body.id), slotId: String(body.slotId), routeRevision: Number(body.routeRevision),
          agentId: slots[0].agentId, agentName: 'Archive expert', angle: slots[0].angle, tools: slots[0].tools,
          score: body.score as GraphReport['score'], reason: String(body.reason), createdAt: '',
        })
        view.phase = 'merge'
      } else if (body.kind === 'merge') {
        view.draft = { id: String(body.id), routeRevision: 2, reportIds: body.reportIds as string[], score: body.score as 0 | 0.5 | 1, reason: String(body.reason) }
        view.phase = 'done'
      }
    }
    const proposalId = role === 'router' ? 'op-1:route' : role === 'worker' ? 'op-1:report:2:' + slot : 'op-1:merge:2'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, data: { ...view, proposalId } }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Test API did not bind')
  vi.stubEnv('CHONGMING_DATA_API', 'http://127.0.0.1:' + address.port)
  vi.stubEnv('CHONGMING_DATA_TOKEN', 'test-only-bridge-token')

  const tools = new Map<string, Tool>()
  const agents = new Map<string, Agent>()
  const allowed = new Map<string, string[]>()
  const guards: Array<(exec: Execution) => string | undefined> = []
  const created: Array<(event: { agent: Agent }) => void> = []
  const starts: StartSpec[] = []
  const signal = new AbortController().signal
  let childWork: (agent: Agent, spec: StartSpec) => Promise<void>
  function createAgent(id: string, parent?: Agent): Agent {
    const agent: Agent = {
      id, session: { header: { parentSession: parent?.id } },
      ctx: {
        tools: { restrict: input => { allowed.set(id, input.allow) } },
        systemPrompt: { section: vi.fn(), getSectionOrder: () => 0 },
      },
      whenIdle: async () => {},
    }
    agents.set(id, agent)
    for (const listener of created) listener({ agent })
    return agent
  }
  const ctx = {
    tools: {
      register: (tool: Tool) => { tools.set(tool.name, tool) },
      get: (name: string, agent?: Agent) => !agent || !allowed.has(agent.id) || allowed.get(agent.id)!.includes(name) ? tools.get(name) : undefined,
      guard: (guard: (exec: Execution) => string | undefined) => { guards.push(guard) },
    },
    agents: {
      get: (id: string) => agents.get(id),
      isOwnedBy: (id: string, owner: Agent) => agents.get(id)?.session.header.parentSession === owner.id,
    },
    subagents: {
      async startContinuable(spec: StartSpec) {
        starts.push(spec)
        const child = createAgent(spec.childId, spec.request.parent)
        child.whenIdle = () => childWork(child, spec)
        return { childId: child.id, messageId: 'message-' + child.id }
      },
      sendMessage: vi.fn(),
      interrupt: vi.fn(),
    },
    on: (_event: string, listener: (event: { agent: Agent }) => void) => { created.push(listener) },
  }
  if (!options.missingTools) for (const name of ['archive_lookup', 'ledger_query', 'subagent', 'workflow', 'cordis_run']) {
    tools.set(name, { name, parameters: { properties: {} }, execute: async () => 'fixture' })
  }
  const modulePath = '../../backend/dsh-business-plugin.mjs'
  const plugin = await import(modulePath) as { apply(ctx: unknown, config?: unknown): void }
  plugin.apply(ctx, { mapId: view.mapId, operationId: view.operationId, rootSessionId: 'root-1', configuration })
  const root = createAgent('root-1')
  async function execute(name: string, agent: Agent, args: unknown) {
    const exec = { name, agent, signal }
    for (const guard of guards) {
      const reason = guard(exec)
      if (reason) throw new Error(reason)
    }
    return tools.get(name)!.execute(args, exec)
  }
  childWork = async (child, spec) => {
    await execute('data_read', child, {})
    if (spec.request.persona === configuration.merger.content) {
      await execute('data_propose', child, { proposal: { kind: 'merge', reportIds: view.reports.map(report => report.id), score: 1, reason: 'synthesized evidence' } })
    } else {
      await execute('data_propose', child, { proposal: { kind: 'report', score: 1, reason: 'primary record' } })
    }
  }
  return { plugin, ctx, view, configuration, root, starts, received, agents, allowed, tools, execute, created }
}

describe('DSH business bridge', () => {
  it('rejects a business runtime without an operation binding', async () => {
    const modulePath = '../../backend/dsh-business-plugin.mjs'
    const plugin = await import(modulePath)
    const register = vi.fn()
    expect(() => plugin.apply({ tools: { register } })).toThrow('complete operation binding')
    expect(register).not.toHaveBeenCalled()
  })

  it('uses the approved dynamic profile, model and tool filter and binds report identity outside model input', async () => {
    const f = await fixture()
    expect(f.allowed.get(f.root.id)).toEqual(['data_read', 'data_propose', 'data_delegate'])
    expect(f.root.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ text: f.configuration.router.content }))
    await expect(f.execute('data_delegate', f.root, { kind: 'worker', slotId: 'angle-1' })).resolves.toMatchObject({ state: 'reported' })
    expect(f.starts).toHaveLength(1)
    const spec = f.starts[0]
    expect(spec.request).toMatchObject({
      parent: f.root, persona: f.configuration.agents[0].content,
      agentOptions: { provider: 'openai', model: 'fixture-model' },
      toolFilter: { allow: ['data_read', 'data_propose', 'archive_lookup'] }, maxDepth: 1,
    })
    const child = f.agents.get(spec.childId)!
    await expect(f.execute('archive_lookup', child, {})).resolves.toBe('fixture')
    await expect(f.execute('ledger_query', child, {})).rejects.toThrow('capability')
    const report = f.received.find(call => call.path.endsWith('/propose'))!
    expect(report).toMatchObject({
      role: 'worker', slot: 'angle-1', authorization: 'Bearer test-only-bridge-token',
      body: { mapId: 'map-1', operationId: 'op-1', id: 'op-1:report:2:angle-1', kind: 'report', slotId: 'angle-1', routeRevision: 2 },
    })
    expect(Object.keys(f.tools.get('data_read')!.parameters.properties)).toEqual([])
    expect(Object.keys(f.tools.get('data_propose')!.parameters.properties)).toEqual(['proposal'])
    await expect(f.execute('data_propose', child, { proposal: { kind: 'report', score: 1, reason: 'spoof', slotId: 'another' } })).rejects.toThrow()
    await expect(f.execute('data_propose', f.root, { proposal: { kind: 'report', score: 1, reason: 'spoof' } })).rejects.toThrow('role')
    await expect(f.execute('data_read', { ...child }, {})).rejects.toThrow('binding')
  })

  it('rejects invalid delegations and unregistered capabilities before child execution', async () => {
    const f = await fixture({ approved: false })
    await expect(f.execute('data_delegate', f.root, { kind: 'worker', slotId: 'angle-1' })).rejects.toThrow('approved')
    f.view.route!.approved = true
    f.view.phase = 'workers'
    await expect(f.execute('data_delegate', f.root, { kind: 'worker', slotId: 'invented' })).rejects.toThrow('slot')
    await expect(f.execute('data_delegate', f.root, { kind: 'merge' })).rejects.toThrow('reports')
    expect(f.starts).toEqual([])
    f.tools.delete('archive_lookup')
    await expect(f.execute('data_delegate', f.root, { kind: 'worker', slotId: 'angle-1' })).rejects.toThrow('not registered')
    expect(f.received.some(call => call.body.kind === 'report')).toBe(false)
  })

  it('cannot bypass the allowlist through native delegation, workflow, Cordis or a late tool', async () => {
    const f = await fixture()
    for (const name of ['subagent', 'workflow', 'cordis_run', 'archive_lookup']) {
      await expect(f.execute(name, f.root, {})).rejects.toThrow('capability')
    }
    f.tools.set('later_tool', { name: 'later_tool', parameters: { properties: {} }, execute: async () => 'should not run' })
    await expect(f.execute('later_tool', f.root, {})).rejects.toThrow('capability')
    const invalid = structuredClone(f.configuration)
    invalid.router.tools = ['subagent']
    invalid.tools.push({ name: 'subagent', description: 'bypass' })
    expect(() => f.plugin.apply(f.ctx, { mapId: 'map-1', operationId: 'op-1', rootSessionId: 'other', configuration: invalid })).toThrow('capability')
  })

  it('reuses a saved report and gives merger its own identity even when a worker slot is named merge', async () => {
    const f = await fixture({ slotName: 'merge' })
    await Promise.all([
      f.execute('data_delegate', f.root, { kind: 'worker', slotId: 'merge' }),
      f.execute('data_delegate', f.root, { kind: 'worker', slotId: 'merge' }),
    ])
    expect(f.starts).toHaveLength(1)
    await f.execute('data_delegate', f.root, { kind: 'worker', slotId: 'merge' })
    expect(f.starts).toHaveLength(1)
    await expect(f.execute('data_delegate', f.root, { kind: 'merge' })).resolves.toMatchObject({ state: 'done' })
    expect(f.starts).toHaveLength(2)
    expect(f.starts[1].request.persona).toBe(f.configuration.merger.content)
    expect(f.starts[1].request.toolFilter.allow).toEqual(['data_read', 'data_propose'])
    expect(f.received.find(call => call.body.kind === 'merge')).toMatchObject({ role: 'merge', slot: undefined, body: { id: 'op-1:merge:2', reportIds: ['op-1:report:2:merge'] } })
  })
})
