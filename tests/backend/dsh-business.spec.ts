import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataActor, GraphDataRead, GraphWorkGrant } from '../../contracts/graph'
import { verificationConfiguration, verificationSlots } from './fixtures/verification'

interface Agent {
  id: string
  ctx: {
    tools: { restrict(input: { allow: string[] }): void }
    systemPrompt: { section: ReturnType<typeof vi.fn>; getSectionOrder(name: string): number }
  }
}
interface Execution { agent?: Agent; name?: string; signal: AbortSignal; concludeTurn(): void }
interface Tool {
  name: string
  parameters: { properties: Record<string, unknown> }
  execute(args: unknown, exec: Execution): Promise<unknown>
}
const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
  vi.unstubAllEnvs()
})

async function fixture(actor: GraphDataActor = { role: 'router' }, missingTool = false) {
  const configuration = verificationConfiguration()
  const slots = verificationSlots(2)
  const routeRevision = actor.role === 'router' ? 0 : 2
  const workId = actor.role === 'router' ? 'op-1:route' : actor.role === 'merge' ? 'op-1:merge:2' : 'op-1:report:2:' + actor.slotId
  const grant: GraphWorkGrant = {
    workId, mapId: 'map-1', runId: 'run-1', operationId: 'op-1',
    actor, routeRevision, hostId: 'host-a', holderId: 'holder-original', fence: 7,
    expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30000,
  }
  const view: GraphDataRead = {
    mapId: 'map-1', runId: 'run-1', operationId: 'op-1',
    claim: { id: 'claim-1', revision: 0, data: { kind: 'claim', content: 'A testable statement', category: null }, createdAt: '', updatedAt: '' },
    context: [], configuration,
    route: actor.role === 'router' ? null : { revision: 2, reason: 'custom angles', slots, approved: true },
    reports: [], draft: null, review: null,
    phase: actor.role === 'router' ? 'route' : actor.role === 'worker' ? 'workers' : 'merge',
    proposalId: workId, work: { id: workId, actor, routeRevision, status: 'ready' },
  }
  const received: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = []
  let denied = false
  const server = createServer(async (request, response) => {
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
  const concludeTurn = vi.fn()
  const ctx = {
    tools: {
      register: (tool: Tool) => { tools.set(tool.name, tool) },
      get: (name: string, agent?: Agent) => !agent || !allowed.has(agent.id) || allowed.get(agent.id)!.includes(name) ? tools.get(name) : undefined,
      guard: (guard: (exec: Execution) => string | undefined) => { guards.push(guard) },
    },
    agents: { get: (id: string) => agents.get(id) },
    on: (_event: string, listener: (event: { agent: Agent }) => void) => { created.push(listener) },
  }
  for (const name of ['archive_lookup', 'ledger_query', 'subagent', 'workflow', 'cordis_run']) {
    if (missingTool && name === 'archive_lookup') continue
    tools.set(name, { name, parameters: { properties: {} }, execute: async () => 'fixture' })
  }
  const modulePath = '../../backend/dsh-business-plugin.mjs'
  const plugin = await import(modulePath) as { apply(ctx: unknown, config?: unknown): void }
  const config = { grant, rootSessionId: 'work-session', configuration, route: view.route }
  plugin.apply(ctx, config)
  const agent: Agent = {
    id: 'work-session',
    ctx: {
      tools: { restrict: input => { allowed.set('work-session', input.allow) } },
      systemPrompt: { section: vi.fn(), getSectionOrder: () => 0 },
    },
  }
  agents.set(agent.id, agent)
  const publish = () => { for (const listener of created) listener({ agent }) }
  async function execute(name: string, sender: Agent, args: unknown) {
    const exec = { name, agent: sender, signal: new AbortController().signal, concludeTurn }
    for (const guard of guards) {
      const reason = guard(exec)
      if (reason) throw new Error(reason)
    }
    return tools.get(name)!.execute(args, exec)
  }
  return { plugin, ctx, config, grant, view, configuration, agent, publish, received, allowed, tools, execute, concludeTurn, deny: () => { denied = true } }
}

describe('DSH work bridge', () => {
  it('requires a complete grant instead of accepting an unleased operation', async () => {
    const modulePath = '../../backend/dsh-business-plugin.mjs'
    const plugin = await import(modulePath)
    expect(() => plugin.apply({})).toThrow('complete work grant')
    expect(() => plugin.apply({}, { mapId: 'map', operationId: 'op', rootSessionId: 'root', configuration: {} })).toThrow('complete work grant')
  })

  it('runs a worker as its own root with its selected custom tools and a fixed proof', async () => {
    const f = await fixture({ role: 'worker', slotId: 'angle-1' })
    f.publish()
    expect(f.allowed.get(f.agent.id)).toEqual(['data_read', 'data_propose', 'archive_lookup'])
    expect(f.agent.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ text: f.configuration.agents[0].content }))
    await expect(f.execute('archive_lookup', f.agent, {})).resolves.toBe('fixture')
    await expect(f.execute('ledger_query', f.agent, {})).rejects.toThrow('capability')
    // A later renewal/reassignment must never rewrite an already-created bridge's authority.
    f.grant.holderId = 'holder-new'
    f.grant.fence = 99
    await expect(f.execute('data_propose', f.agent, { proposal: { kind: 'report', score: 1, reason: 'primary evidence' } })).resolves.toEqual({
      work: { id: 'op-1:report:2:angle-1', actor: { role: 'worker', slotId: 'angle-1' }, routeRevision: 2, status: 'accepted' },
    })
    expect(f.received.map(call => call.path)).toEqual(['/internal/v1/data/read', '/internal/v1/data/propose'])
    const report = f.received.find(call => call.path.endsWith('/propose'))!
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
    for (const actor of [{ role: 'router' }, { role: 'merge' }] as const) {
      const f = await fixture(actor)
      f.publish()
      expect(f.allowed.get(f.agent.id)).toEqual(['data_read', 'data_propose'])
      const profile = actor.role === 'router' ? f.configuration.router : f.configuration.merger
      expect(f.agent.ctx.systemPrompt.section).toHaveBeenCalledWith(expect.objectContaining({ text: profile.content }))
      const proposal = actor.role === 'router'
        ? { kind: 'route', reason: 'dynamic angle', slots: verificationSlots(2) }
        : { kind: 'merge', score: 0.5, reason: 'inconclusive', reportIds: ['report-a', 'report-b'] }
      await f.execute('data_propose', f.agent, { proposal })
      const saved = f.received.find(call => call.path.endsWith('/propose'))!
      expect(saved.body.id).toBe(f.grant.workId)
      expect(saved.body.slotId).toBeUndefined()
      expect(f.concludeTurn).toHaveBeenCalledOnce()
    }
  })

  it('fails before execution for a missing registered tool or mismatched route', async () => {
    const f = await fixture({ role: 'worker', slotId: 'angle-1' }, true)
    expect(f.publish).toThrow('not registered')
    expect(f.received).toEqual([])
    const invalid = { ...f.config, grant: { ...f.grant, routeRevision: 100 } }
    expect(() => f.plugin.apply(f.ctx, invalid)).toThrow('matching approved route')
    const bypass = structuredClone(f.configuration)
    bypass.router.tools = ['subagent']
    bypass.tools.push({ name: 'subagent', description: 'escape' })
    expect(() => f.plugin.apply(f.ctx, { ...f.config, grant: { ...f.grant, actor: { role: 'router' }, routeRevision: 0 }, configuration: bypass })).toThrow('capability')
  })

  it('propagates loss of the fixed lease without retrying under another grant', async () => {
    const f = await fixture({ role: 'worker', slotId: 'angle-1' })
    f.publish()
    f.deny()
    await expect(f.execute('data_propose', f.agent, { proposal: { kind: 'report', score: 1, reason: 'late result' } })).rejects.toThrow('LEASE_LOST')
    expect(f.received).toHaveLength(1)
    expect(f.received[0].path).toContain('/read')
    expect(f.concludeTurn).not.toHaveBeenCalled()
  })
})
