// 验证 DSH 业务插件使用冻结 stage/specHash 生成通用工具合同并保持租约身份。
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'

interface Agent {
  id: string
  concludeTurn(): void
  ctx: {
    tools: { restrict(input: { allow: string[] }): void }
    systemPrompt: { section: ReturnType<typeof vi.fn>; variable: ReturnType<typeof vi.fn>; getSectionOrder(name: string): number }
  }
}
interface Execution { agent?: Agent; name?: string; signal: AbortSignal; concludeTurn(): void }
interface Tool { name: string; parameters: { properties: Record<string, unknown> }; execute(args: any, exec: Execution): Promise<unknown> }

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))))
  vi.unstubAllEnvs()
})

async function fixture(missingTool = false, candidateReference = false, nullableEnum = false) {
  const profile = { id: 'demo.agent', name: 'Demo Agent', description: 'Creates summaries', content: 'Summarize', tools: ['archive_lookup'],
    provider: 'fixture', model: 'fixture', promptVars: [] }
  const schema = candidateReference
    ? { type: 'object' as const, properties: { opinionIds: { type: 'array' as const, items: { type: 'string' as const } } }, required: ['opinionIds'], additionalProperties: false }
    : nullableEnum ? { type: 'object' as const, properties: {
      category: { type: ['string', 'null'] as Array<'string' | 'null'>, enum: ['data', 'quote', 'causal', null] },
    }, required: ['category'], additionalProperties: false }
    : { type: 'object' as const, properties: { text: { type: 'string' as const, minLength: 1 } }, required: ['text'], additionalProperties: false }
  const outputContract = { mode: 'outputs' as const, ports: [{ port: 'summary', type: { id: 'demo.summary', version: 1 }, count: { min: 1, max: 1 },
    schema, references: candidateReference ? [{ path: '/opinionIds/*', target: { kind: 'node' as const, types: [{ id: 'demo.opinion', version: 1 }] } }] : [],
    successorOf: [{ source: 'input' as const, port: 'document' }] }] }
  const stage = { id: 'summarize', slotId: 'slot-a', agent: { ref: { id: profile.id, version: 1 }, profile },
    tools: [{ name: 'archive_lookup', description: 'Search archives' }] }
  const grant: GraphWorkGrant = { workId: 'op:summarize:slot-a', mapId: 'map-1', runId: 'run-1', operationId: 'op', stageId: stage.id,
    slotId: stage.slotId, specHash: 'spec-sha', priority: 'medium', hostId: 'host', holderId: 'holder-original', fence: 7,
    expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30_000 }
  const view: GraphDataRead = { mapId: grant.mapId, runId: grant.runId, operationId: grant.operationId,
    transitionRef: { id: 'demo.summarize', version: 1 }, specHash: grant.specHash, inputs: {}, context: {}, priorStageResults: [],
    promptVariables: {}, stage, outputContract, proposalId: grant.workId,
    work: { id: grant.workId, stageId: grant.stageId, slotId: grant.slotId, specHash: grant.specHash, status: 'ready' } }
  const received: Array<{ path: string; body: Record<string, unknown>; headers: Record<string, string | string[] | undefined> }> = []
  let denied = false
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
    received.push({ path: request.url!, body, headers: request.headers })
    if (denied) {
      response.writeHead(409, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: false, error: { code: 'LEASE_LOST', message: 'expired' } }))
      return
    }
    if (request.url?.endsWith('/propose')) view.work.status = 'accepted'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, data: view }))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture server missing')
  vi.stubEnv('CHONGMING_DATA_API', `http://127.0.0.1:${address.port}`)
  vi.stubEnv('CHONGMING_DATA_TOKEN', 'test-token')

  const tools = new Map<string, Tool>(), agents = new Map<string, Agent>(), allowed = new Map<string, string[]>()
  const guards: Array<(exec: Execution) => string | undefined> = [], created: Array<(event: { agent: Agent }) => void> = []
  const concludeTurn = vi.fn()
  const ctx = {
    tools: {
      register: (tool: Tool) => tools.set(tool.name, tool),
      get: (name: string, agent?: Agent) => !agent || !allowed.has(agent.id) || allowed.get(agent.id)!.includes(name) ? tools.get(name) : undefined,
      guard: (guard: (exec: Execution) => string | undefined) => guards.push(guard),
    },
    agents: { get: (id: string) => agents.get(id) },
    on: (_event: string, listener: (event: { agent: Agent }) => void) => created.push(listener),
  }
  if (!missingTool) tools.set('archive_lookup', { name: 'archive_lookup', parameters: { properties: {} }, execute: async () => 'fixture' })
  const plugin = await import('../../../backend/execution/dsh/dsh-business-plugin.mjs')
  const config = { grant, rootSessionId: 'work-session', proposalId: view.proposalId, specHash: grant.specHash,
    stage, outputContract, persona: profile.content }
  plugin.apply(ctx, config)
  const agent: Agent = { id: 'work-session', concludeTurn, ctx: { tools: { restrict: input => allowed.set('work-session', input.allow) },
    systemPrompt: { section: vi.fn(), variable: vi.fn(), getSectionOrder: () => 0 } } }
  agents.set(agent.id, agent)
  const publish = () => created.forEach(listener => listener({ agent }))
  async function execute(name: string, sender: Agent, args: unknown) {
    const exec = { name, agent: sender, signal: new AbortController().signal, concludeTurn }
    for (const guard of guards) { const reason = guard(exec); if (reason) throw new Error(reason) }
    return tools.get(name)!.execute(args, exec)
  }
  return { plugin, ctx, config, grant, view, stage, outputContract, agent, publish, received, allowed, tools, execute, concludeTurn,
    deny: () => { denied = true } }
}

describe('generic DSH work bridge', () => {
  it('requires a complete stage grant', async () => {
    const plugin = await import('../../../backend/execution/dsh/dsh-business-plugin.mjs')
    expect(() => plugin.apply({})).toThrow('complete generic work grant')
  })

  it('binds capabilities and submits outputs with trusted work identity', async () => {
    const f = await fixture()
    f.publish()
    expect(f.allowed.get(f.agent.id)).toEqual(['data_read', 'data_propose', 'archive_lookup'])
    await expect(f.execute('archive_lookup', f.agent, {})).resolves.toBe('fixture')
    f.grant.holderId = 'changed'; f.grant.fence = 99
    const proposal = { kind: 'outputs', reason: 'done', outputs: [{ key: 'summary', port: 'summary',
      typeRef: { id: 'demo.summary', version: 1 }, payload: { text: 'Short' } }] }
    await f.execute('data_propose', f.agent, { proposal })
    expect(f.received.map(call => call.path)).toEqual(['/internal/v1/data/read', '/internal/v1/data/propose'])
    expect(f.received[1]).toMatchObject({ body: { ...proposal, id: f.grant.workId, specHash: 'spec-sha', mapId: 'map-1', operationId: 'op' },
      headers: { 'x-work-holder': 'holder-original', 'x-work-fence': '7' } })
    expect(f.concludeTurn).toHaveBeenCalledOnce()
  })

  it('builds data_propose from the frozen output schema', async () => {
    const f = await fixture()
    const proposal = f.tools.get('data_propose')!.parameters.properties.proposal as any
    expect(proposal.properties.kind).toMatchObject({ const: 'outputs' })
    expect(proposal.required).toContain('kind')
    const item = proposal.properties.outputs.items
    expect(item.properties).toMatchObject({ port: { const: 'summary' }, typeRef: { properties: { id: { const: 'demo.summary' }, version: { const: 1 } } },
      payload: { properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } })
  })

  it('allows candidate placeholders only at declared node-reference fields', async () => {
    const f = await fixture(false, true)
    const proposal = f.tools.get('data_propose')!.parameters.properties.proposal as any
    const payload = proposal.properties.outputs.items.properties.payload
    expect(payload.properties.opinionIds.items.oneOf[0]).toMatchObject({ type: 'string' })
    expect(payload.properties.opinionIds.items.oneOf[1]).toMatchObject({ properties: {
      candidate: { properties: { workId: { type: 'string' }, key: { type: 'string' } } },
    } })
  })

  it('splits nullable enums into type-correct DSH schema branches', async () => {
    const f = await fixture(false, false, true)
    const proposal = f.tools.get('data_propose')!.parameters.properties.proposal as any
    const category = proposal.properties.outputs.items.properties.payload.properties.category
    expect(category.oneOf).toEqual([
      expect.objectContaining({ type: 'string', enum: ['data', 'quote', 'causal'] }),
      expect.objectContaining({ type: 'null', enum: [null] }),
    ])
  })

  it('rejects another Agent and loss of the fixed lease', async () => {
    const f = await fixture()
    f.publish()
    await expect(f.execute('data_read', { ...f.agent }, {})).rejects.toThrow('binding')
    f.deny()
    await expect(f.execute('data_read', f.agent, {})).rejects.toThrow('LEASE_LOST')
  })

  it('fails publication when a frozen capability is unavailable', async () => {
    const f = await fixture(true)
    expect(f.publish).toThrow('not registered')
  })
})
