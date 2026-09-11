import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'chongming-data-tools'
export const inject = ['tools', 'agents', 'subagents', 'systemPrompt']
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const score = { type: 'number', enum: [0, 0.5, 1] }
const slotSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, agentId: { type: 'string', required: true },
    angle: { type: 'string', required: true }, hint: { type: 'string', required: true },
    priority: { type: 'string', required: true, enum: ['high', 'medium', 'low'] },
    tools: { type: 'array', required: true, items: { type: 'string' } },
  },
}
const businessTools = ['data_read', 'data_propose', 'data_delegate']
const bypassTools = new Set(['subagent', 'subagent_fork', 'workflow', 'run_code', 'send_message', 'interrupt_agent', 'list_agents'])

function businessReadToolNames(profile, catalog) {
  if (!profile || !Array.isArray(profile.tools)) throw new Error('Invalid Agent profile')
  for (const tool of profile.tools) {
    if (!catalog.has(tool) || businessTools.includes(tool) || bypassTools.has(tool) || tool.startsWith('cordis_')) {
      throw new Error('Agent tool is not an allowed business capability: ' + tool)
    }
  }
  return profile.tools
}

/** Operation and role bindings are trusted launcher data, never model arguments. */
export function apply(ctx, config = {}) {
  if (!config.mapId || !config.operationId || !config.rootSessionId || !config.configuration) throw new Error('Business tools require a complete operation binding')
  const token = process.env.CHONGMING_DATA_TOKEN
  if (!token) throw new Error('CHONGMING_DATA_TOKEN must be configured')
  const apiUrl = new URL(process.env.CHONGMING_DATA_API ?? 'http://127.0.0.1:4320')
  if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error('Data API must use HTTP(S)')
  const configuration = structuredClone(config.configuration)
  const catalog = new Set(configuration.tools.map(tool => tool.name))
  for (const profile of [configuration.router, configuration.merger, ...configuration.agents]) businessReadToolNames(profile, catalog)
  const bindings = new Map([[config.rootSessionId, { role: 'router', profile: configuration.router, tools: configuration.router.tools }]])
  // Only correlate native identities and concurrent tool calls; DSH owns scheduling and child lifecycle.
  const children = new Map()
  const delegates = new Map()

  function businessReadBinding(exec) {
    const agent = exec.agent
    if (!agent || ctx.agents.get(agent.id) !== agent) throw new Error('Business tool requires the exact live Agent')
    const binding = bindings.get(agent.id)
    if (!binding) throw new Error('Agent is not bound to this operation')
    if (binding.role !== 'router') {
      const root = ctx.agents.get(config.rootSessionId)
      if (!root || !ctx.agents.isOwnedBy(agent.id, root) || agent.session.header.parentSession !== root.id) throw new Error('Agent is not an owned operation child')
    }
    return binding
  }
  function businessReadAllow(binding) {
    return ['data_read', 'data_propose', ...(binding.role === 'router' ? ['data_delegate'] : []), ...binding.tools]
  }
  async function businessCall(path, binding, body, signal) {
    const response = await fetch(new URL(path, apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + token,
        'x-dsh-role': binding.role, ...(binding.role === 'worker' ? { 'x-dsh-slot': binding.slotId } : {}),
      },
      body: JSON.stringify({ ...body, mapId: config.mapId, operationId: config.operationId }), signal,
    })
    const result = await response.json()
    if (!response.ok || result.ok !== true) throw new Error(result.error?.code ? result.error.code + ': ' + result.error.message : 'Data API returned ' + response.status)
    return result.data
  }
  async function businessReadData(binding, signal) {
    const data = await businessCall('/internal/v1/data/read', binding, {}, signal)
    if (data.mapId !== config.mapId || data.operationId !== config.operationId || JSON.stringify(data.configuration) !== JSON.stringify(configuration)) throw new Error('Operation configuration differs from this runtime binding')
    if (binding.role !== 'router' && data.route?.revision !== binding.routeRevision) throw new Error('Child belongs to an obsolete route')
    return data
  }
  // Keep synchronous: DSH aborts creation on a throw; async listener rejections only get logged.
  function businessRegisterAgent({ agent }) {
    const binding = bindings.get(agent.id)
    if (!binding) return
    const allow = businessReadAllow(binding)
    for (const tool of allow) if (!ctx.tools.get(tool, agent)) throw new Error('Configured tool is not registered: ' + tool)
    agent.ctx.tools.restrict({ allow })
    if (binding.role === 'router') agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: binding.profile.content,
    })
  }
  ctx.tools.guard(exec => {
    try { return businessReadAllow(businessReadBinding(exec)).includes(exec.name) ? undefined : 'Tool is outside this Agent capability set' }
    catch { return 'Agent has no trusted operation binding' }
  })
  ctx.on('agent/created', businessRegisterAgent)

  ctx.tools.register(defineTool({
    name: 'data_read',
    description: 'Read assigned verification input, frozen Agent/tool catalog, approved route, reports and phase.',
    parameters: {}, output,
    execute: (_args, exec) => businessReadData(businessReadBinding(exec), exec.signal),
  }))
  ctx.tools.register(defineTool({
    name: 'data_propose',
    description: 'Submit the proposal allowed by your role: router selects slots; worker reports its own slot; merger cites all reports.',
    parameters: { proposal: {
      required: true,
      oneOf: [
        { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', const: 'route', required: true }, reason: { type: 'string', required: true },
          slots: { type: 'array', required: true, items: slotSchema },
        } },
        { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', const: 'report', required: true },
          score: { ...score, required: true }, reason: { type: 'string', required: true },
        } },
        { type: 'object', additionalProperties: false, properties: {
          kind: { type: 'string', const: 'merge', required: true },
          reportIds: { type: 'array', required: true, items: { type: 'string' } },
          score: { ...score, required: true }, reason: { type: 'string', required: true },
        } },
      ],
    } },
    output, isConcurrencySafe: () => true,
    async execute({ proposal }, exec) {
      const binding = businessReadBinding(exec)
      if (proposal.kind !== { router: 'route', worker: 'report', merge: 'merge' }[binding.role]) throw new Error('Proposal does not match the bound Agent role')
      const data = await businessReadData(binding, exec.signal)
      if (proposal.kind === 'route') for (const slot of proposal.slots) {
        const profile = configuration.agents.find(agent => agent.id === slot.agentId)
        if (!profile || slot.tools.some(tool => !profile.tools.includes(tool))) throw new Error('Slot exceeds its Agent capability set')
      }
      await businessCall('/internal/v1/data/propose', binding, {
        ...proposal, id: data.proposalId,
        ...(proposal.kind !== 'route' ? { routeRevision: binding.routeRevision ?? data.route?.revision } : {}),
        ...(binding.role === 'worker' ? { slotId: binding.slotId } : {}),
      }, exec.signal)
      return businessReadData(binding, exec.signal)
    },
  }))
  ctx.tools.register(defineTool({
    name: 'data_delegate',
    description: 'Run an approved worker slot or the merger through DSH. Independent worker calls may run together. Returns after the child submits its report.',
    parameters: {
      kind: { type: 'string', required: true, enum: ['worker', 'merge'] },
      slotId: { type: 'string', description: 'Approved slot for kind=worker; omit for merge.' },
    },
    output, isConcurrencySafe: () => true,
    async execute({ kind, slotId }, exec) {
      const router = businessReadBinding(exec)
      if (router.role !== 'router') throw new Error('Only the router may delegate')
      const data = await businessReadData(router, exec.signal)
      if (!data.route?.approved || !['workers', 'merge'].includes(data.phase)) throw new Error('Delegation requires an approved, running route')
      const slot = kind === 'worker' ? data.route.slots.find(item => item.id === slotId) : undefined
      if (kind === 'worker' && !slot) throw new Error('Unknown approved slot')
      if (kind === 'merge' && slotId !== undefined) throw new Error('Merger delegation has no slot')
      const priorReport = slot && data.reports.find(report => report.slotId === slot.id && report.routeRevision === data.route.revision)
      if (priorReport) return { state: 'reported', report: priorReport }
      if (kind === 'merge' && !data.route.slots.every(item => data.reports.some(report => report.slotId === item.id && report.routeRevision === data.route.revision))) throw new Error('All approved slot reports are required before merger delegation')
      const profile = kind === 'merge' ? configuration.merger : configuration.agents.find(agent => agent.id === slot.agentId)
      if (!profile) throw new Error('Unknown delegated Agent')
      const allowed = kind === 'merge' ? profile.tools : slot.tools
      if (allowed.some(tool => !profile.tools.includes(tool))) throw new Error('Invalid delegated capability set')
      const key = data.route.revision + ':' + kind + ':' + (slot?.id ?? '')
      if (delegates.has(key)) return delegates.get(key)
      const task = (async () => {
        let childId = children.get(key)
        const prompt = [{ type: 'text', text: JSON.stringify({ claim: data.claim, context: data.context, assignment: slot ?? { kind: 'merge', reports: data.reports } }) }]
        if (childId) await ctx.subagents.sendMessage(exec.agent, childId, prompt, { signal: exec.signal })
        else {
          childId = randomUUID()
          bindings.set(childId, { role: kind === 'merge' ? 'merge' : 'worker', slotId: slot?.id, routeRevision: data.route.revision, profile, tools: allowed })
          try {
            await ctx.subagents.startContinuable({
              provider: 'spawn', label: profile.name + (slot ? ': ' + slot.angle : ''), childId,
              request: {
                parent: exec.agent, prompt, persona: profile.content,
                agentOptions: { provider: profile.provider, model: profile.model },
                toolFilter: { allow: ['data_read', 'data_propose', ...allowed] }, maxDepth: 1,
              },
              signal: exec.signal,
            })
            children.set(key, childId)
          } catch (error) { bindings.delete(childId); throw error }
        }
        const abort = () => ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: exec.agent })
        exec.signal.addEventListener('abort', abort, { once: true })
        try {
          if (exec.signal.aborted) abort()
          await ctx.agents.get(childId)?.whenIdle()
          exec.signal.throwIfAborted()
          const result = await businessReadData(router, exec.signal)
          if (slot) {
            const report = result.reports.find(item => item.slotId === slot.id && item.routeRevision === data.route.revision)
            if (!report) throw new Error('Worker stopped without submitting its report')
            return { state: 'reported', report }
          }
          if (!result.draft) throw new Error('Merger stopped without submitting its conclusion')
          return { state: result.phase, draft: result.draft, review: result.review }
        } finally { exec.signal.removeEventListener('abort', abort) }
      })()
      delegates.set(key, task)
      try { return await task } finally { delegates.delete(key) }
    },
  }))
}
