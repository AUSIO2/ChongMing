import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'chongming-data-tools'
export const inject = ['tools', 'agents', 'systemPrompt']
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const score = { type: 'number', enum: [0, 0.5, 1], required: true }
const slotSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    id: { type: 'string', required: true }, agentId: { type: 'string', required: true },
    angle: { type: 'string', required: true }, hint: { type: 'string', required: true },
    priority: { type: 'string', required: true, enum: ['high', 'medium', 'low'] },
    tools: { type: 'array', required: true, items: { type: 'string' } },
  },
}
const bypassTools = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'workflow', 'run_code', 'send_message', 'interrupt_agent', 'list_agents'])

/** One trusted work grant owns one DSH root, regardless of its business role. */
export function apply(ctx, config = {}) {
  const grant = structuredClone(config.grant)
  if (!grant?.workId || !grant.mapId || !grant.operationId || !grant.runId || !grant.holderId
    || !Number.isSafeInteger(grant.fence) || grant.fence < 1 || !config.rootSessionId || !config.configuration) {
    throw new Error('Business tools require a complete work grant')
  }
  const token = process.env.CHONGMING_DATA_TOKEN
  if (!token) throw new Error('CHONGMING_DATA_TOKEN must be configured')
  const apiUrl = new URL(process.env.CHONGMING_DATA_API ?? 'http://127.0.0.1:4320')
  if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error('Data API must use HTTP(S)')
  const configuration = structuredClone(config.configuration)
  const actor = grant.actor
  let profile
  let selectedTools
  if (actor?.role === 'router') profile = configuration.router
  else if (actor?.role === 'merge') profile = configuration.merger
  else if (actor?.role === 'worker') {
    const slot = config.route?.slots.find(slot => slot.id === actor.slotId)
    profile = configuration.agents.find(agent => agent.id === slot?.agentId)
    if (!slot || !profile || slot.tools.some(tool => !profile.tools.includes(tool))) throw new Error('Worker grant has no valid configured slot')
    selectedTools = slot.tools
  }
  if (!profile) throw new Error('Unknown work role')
  if (actor.role !== 'router' && (!config.route?.approved || config.route.revision !== grant.routeRevision)) {
    throw new Error('Work grant requires the matching approved route')
  }
  selectedTools = [...(selectedTools ?? profile.tools)]
  const catalog = new Set(configuration.tools.map(tool => tool.name))
  for (const tool of selectedTools) {
    if (!catalog.has(tool) || bypassTools.has(tool) || tool.startsWith('cordis_')) throw new Error('Tool is not an allowed work capability: ' + tool)
  }
  const allow = ['data_read', 'data_propose', ...selectedTools]
  const proposalKind = { router: 'route', worker: 'report', merge: 'merge' }[actor.role]

  function businessReadAgent(exec) {
    const agent = exec.agent
    if (!agent || agent.id !== config.rootSessionId || ctx.agents.get(agent.id) !== agent) {
      throw new Error('Business tool requires the exact bound work Agent')
    }
    return agent
  }
  async function businessCall(path, body, signal) {
    const response = await fetch(new URL(path, apiUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: 'Bearer ' + token,
        'x-work-id': grant.workId, 'x-work-holder': grant.holderId, 'x-work-fence': String(grant.fence),
      },
      body: JSON.stringify({ ...body, mapId: grant.mapId, operationId: grant.operationId }), signal,
    })
    const result = await response.json()
    if (!response.ok || result.ok !== true) throw new Error(result.error?.code ? result.error.code + ': ' + result.error.message : 'Data API returned ' + response.status)
    return result.data
  }
  async function businessReadData(signal) {
    const data = await businessCall('/internal/v1/data/read', {}, signal)
    if (data.mapId !== grant.mapId || data.operationId !== grant.operationId || data.runId !== grant.runId
      || data.work?.id !== grant.workId || data.work.routeRevision !== grant.routeRevision
      || JSON.stringify(data.work.actor) !== JSON.stringify(actor)
      || JSON.stringify(data.configuration) !== JSON.stringify(configuration)) {
      throw new Error('Data API returned a different work binding')
    }
    return data
  }
  // DSH aborts publication on a synchronous throw; an async listener rejection only gets logged.
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== config.rootSessionId) return
    for (const tool of allow) if (!ctx.tools.get(tool, agent)) throw new Error('Configured tool is not registered: ' + tool)
    agent.ctx.tools.restrict({ allow })
    agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: profile.content,
    })
  })
  ctx.tools.guard(exec => {
    try { businessReadAgent(exec); return allow.includes(exec.name) ? undefined : 'Tool is outside this work capability set' }
    catch { return 'Agent has no trusted work binding' }
  })

  ctx.tools.register(defineTool({
    name: 'data_read', description: 'Read the assigned work, input, frozen configuration, approved route and accepted reports.',
    parameters: {}, output,
    execute: (_args, exec) => { businessReadAgent(exec); return businessReadData(exec.signal) },
  }))
  const properties = {
    kind: { type: 'string', const: proposalKind, required: true },
    reason: { type: 'string', required: true },
    ...(actor.role === 'router' ? { slots: { type: 'array', required: true, items: slotSchema } } : { score }),
    ...(actor.role === 'merge' ? { reportIds: { type: 'array', required: true, items: { type: 'string' } } } : {}),
  }
  ctx.tools.register(defineTool({
    name: 'data_propose', description: 'Submit this work result. Identity, slot and route version come from the trusted work grant.',
    parameters: { proposal: { type: 'object', additionalProperties: false, required: true, properties } }, output,
    async execute({ proposal }, exec) {
      businessReadAgent(exec)
      if (proposal.kind !== proposalKind) throw new Error('Proposal does not match the work role')
      await businessReadData(exec.signal)
      if (proposal.kind === 'route') for (const slot of proposal.slots) {
        const candidate = configuration.agents.find(agent => agent.id === slot.agentId)
        if (!candidate || slot.tools.some(tool => !candidate.tools.includes(tool))) throw new Error('Slot exceeds its Agent capability set')
      }
      await businessCall('/internal/v1/data/propose', {
        ...proposal, id: grant.workId,
        ...(actor.role !== 'router' ? { routeRevision: grant.routeRevision } : {}),
        ...(actor.role === 'worker' ? { slotId: actor.slotId } : {}),
      }, exec.signal)
      exec.concludeTurn()
      return { work: { id: grant.workId, actor, routeRevision: grant.routeRevision, status: 'accepted' } }
    },
  }))
}
