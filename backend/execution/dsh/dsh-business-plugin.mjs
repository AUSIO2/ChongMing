import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'chongming-data-tools'
export const inject = ['tools', 'agents', 'systemPrompt']
/** @enum {string} Kept local because DSH loads this uncompiled ESM file directly. */
const RuntimeMessage = Object.freeze({
  AGENT_HAS_NO_TRUSTED_WORK_BINDING: 'Agent has no trusted work binding',
  BUSINESS_TOOL_REQUIRES_BOUND_AGENT: 'Business tool requires the exact bound work Agent',
  BUSINESS_TOOLS_REQUIRE_COMPLETE_GRANT: 'Business tools require a complete work grant',
  CONFIGURED_TOOL_NOT_REGISTERED: 'Configured tool is not registered: {0}',
  DATA_API_RETURNED_DIFFERENT_BINDING: 'Data API returned a different work binding',
  DATA_API_RETURNED_STATUS: 'Data API returned {0}',
  DATA_API_URL_MUST_USE_HTTP: 'Data API must use HTTP(S)',
  DATA_TOKEN_REQUIRED: 'CHONGMING_DATA_TOKEN must be configured',
  PARSE_WORK_REQUIRES_PARSER: 'Parse work requires its parser identity',
  PROPOSAL_DOES_NOT_MATCH_ROLE: 'Proposal does not match the work role',
  REMOTE_ERROR_WITH_CODE: '{0}: {1}',
  SLOT_EXCEEDS_AGENT_CAPABILITIES: 'Slot exceeds its Agent capability set',
  TOOL_IS_NOT_ALLOWED: 'Tool is not an allowed work capability: {0}',
  TOOL_OUTSIDE_CAPABILITY_SET: 'Tool is outside this work capability set',
  UNKNOWN_WORK_ROLE: 'Unknown work role',
  WORK_GRANT_REQUIRES_APPROVED_ROUTE: 'Work grant requires the matching approved route',
  WORKER_HAS_NO_VALID_SLOT: 'Worker grant has no valid configured slot',
})
const messageFormat = (template, ...values) => template.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)]))
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
// 用途：处理当前模块相关工作，并把结果交给调用方。
export function apply(ctx, config = {}) {
  const grant = structuredClone(config.grant)
  if (!grant?.workId || !grant.mapId || !grant.operationId || !grant.runId || !grant.holderId
    || !Number.isSafeInteger(grant.fence) || grant.fence < 1 || !config.rootSessionId || !config.configuration || !config.proposalId
    || !['parse', 'split', 'verify'].includes(config.operationKind)
    || typeof config.persona !== 'string' || !config.persona.trim()) {
    throw new Error(RuntimeMessage.BUSINESS_TOOLS_REQUIRE_COMPLETE_GRANT)
  }
  const token = process.env.CHONGMING_DATA_TOKEN
  if (!token) throw new Error(RuntimeMessage.DATA_TOKEN_REQUIRED)
  const apiUrl = new URL(process.env.CHONGMING_DATA_API ?? 'http://127.0.0.1:4320')
  if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error(RuntimeMessage.DATA_API_URL_MUST_USE_HTTP)
  const configuration = structuredClone(config.configuration)
  const operationKind = config.operationKind
  const proposalId = config.proposalId
  const group = operationKind === 'split' ? configuration.split : configuration
  const persona = config.persona
  const actor = grant.actor
  let profile
  let selectedTools
  if (operationKind === 'parse') {
    if (actor?.role !== 'parse') throw new Error(RuntimeMessage.PARSE_WORK_REQUIRES_PARSER)
    profile = configuration.parse
  }
  else if (actor?.role === 'router') profile = group?.router
  else if (actor?.role === 'merge') profile = group?.merger
  else if (actor?.role === 'worker') {
    const slot = config.route?.slots.find(slot => slot.id === actor.slotId)
    profile = group?.agents.find(agent => agent.id === slot?.agentId)
    if (!slot || !profile || slot.tools.some(tool => !profile.tools.includes(tool))) throw new Error(RuntimeMessage.WORKER_HAS_NO_VALID_SLOT)
    selectedTools = slot.tools
  }
  if (!profile) throw new Error(RuntimeMessage.UNKNOWN_WORK_ROLE)
  if (actor.role !== 'router' && actor.role !== 'parse' && (!config.route?.approved || config.route.revision !== grant.routeRevision)) {
    throw new Error(RuntimeMessage.WORK_GRANT_REQUIRES_APPROVED_ROUTE)
  }
  selectedTools = [...(selectedTools ?? profile.tools)]
  const catalog = new Set(configuration.tools.map(tool => tool.name))
  for (const tool of selectedTools) {
    if (!catalog.has(tool) || bypassTools.has(tool) || tool.startsWith('cordis_')) throw new Error(messageFormat(RuntimeMessage.TOOL_IS_NOT_ALLOWED, tool))
  }
  const allow = ['data_read', 'data_propose', ...selectedTools]
  const proposalKind = actor.role === 'parse' ? 'parse' : actor.role === 'router' ? 'route'
    : operationKind === 'split' ? (actor.role === 'worker' ? 'split-report' : 'split-merge')
    : actor.role === 'worker' ? 'report' : 'merge'

  // 用途：读取Agent，并把结构化结果交给调用方。
  function businessReadAgent(exec) {
    const agent = exec.agent
    if (!agent || agent.id !== config.rootSessionId || ctx.agents.get(agent.id) !== agent) {
      throw new Error(RuntimeMessage.BUSINESS_TOOL_REQUIRES_BOUND_AGENT)
    }
    return agent
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
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
    if (!response.ok || result.ok !== true) throw new Error(result.error?.code
      ? messageFormat(RuntimeMessage.REMOTE_ERROR_WITH_CODE, result.error.code, result.error.message)
      : messageFormat(RuntimeMessage.DATA_API_RETURNED_STATUS, response.status))
    return result.data
  }
  // 用途：读取数据，并把结构化结果交给调用方。
  async function businessReadData(signal) {
    const data = await businessCall('/internal/v1/data/read', {}, signal)
    if (data.mapId !== grant.mapId || data.operationId !== grant.operationId || data.runId !== grant.runId
      || data.operationKind !== operationKind || data.proposalId !== proposalId
      || data.work?.id !== grant.workId || data.work.routeRevision !== grant.routeRevision
      || JSON.stringify(data.work.actor) !== JSON.stringify(actor)
      || JSON.stringify(data.configuration) !== JSON.stringify(configuration)) {
      throw new Error(RuntimeMessage.DATA_API_RETURNED_DIFFERENT_BINDING)
    }
    return data
  }
  // DSH aborts publication on a synchronous throw; an async listener rejection only gets logged.
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== config.rootSessionId) return
    for (const tool of allow) if (!ctx.tools.get(tool, agent)) throw new Error(messageFormat(RuntimeMessage.CONFIGURED_TOOL_NOT_REGISTERED, tool))
    agent.ctx.tools.restrict({ allow })
    // DSH substitutes a variable value once: application/user {{...}} text stays literal afterwards.
    agent.ctx.systemPrompt.variable('chongming_persona', () => persona)
    agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: '{{chongming_persona}}',
    })
  })
  ctx.tools.guard(exec => {
    try { businessReadAgent(exec); return allow.includes(exec.name) ? undefined : RuntimeMessage.TOOL_OUTSIDE_CAPABILITY_SET }
    catch { return RuntimeMessage.AGENT_HAS_NO_TRUSTED_WORK_BINDING }
  })

  ctx.tools.register(defineTool({
    name: 'data_read', description: 'Read the assigned operation target, work, source text, frozen configuration, approved route and accepted reports.',
    parameters: {}, output,
    execute: (_args, exec) => { businessReadAgent(exec); return businessReadData(exec.signal) },
  }))
  const properties = {
    kind: { type: 'string', const: proposalKind, required: true },
    reason: { type: 'string', required: true },
    ...(actor.role === 'router' ? { slots: { type: 'array', required: true, items: slotSchema } } : {}),
    ...(operationKind === 'verify' && actor.role !== 'router' ? { score } : {}),
    ...(actor.role === 'merge' ? { reportIds: { type: 'array', required: true, items: { type: 'string' } } } : {}),
    ...(operationKind === 'parse' ? { news: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        content: { type: 'string', required: true },
        context: { type: 'object', additionalProperties: true, required: true,
          description: 'Named context fields, each containing a string value and boolean visibleToAI. Use {} when absent.' },
      },
    } } } : {}),
    ...(proposalKind === 'split-report' ? { claims: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        content: { type: 'string', required: true },
        category: profile.claimCategory ? { type: 'string', const: profile.claimCategory, required: true }
          : { oneOf: [{ type: 'string' }, { type: 'null' }], required: true },
      },
    } } } : {}),
    ...(proposalKind === 'split-merge' ? { selected: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false, properties: {
        reportId: { type: 'string', required: true }, index: { type: 'integer', required: true },
      },
    } } } : {}),
  }
  ctx.tools.register(defineTool({
    name: 'data_propose', description: 'Submit this work result. Identity, slot and route version come from the trusted work grant.',
    parameters: { proposal: { type: 'object', additionalProperties: false, required: true, properties } }, output,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async execute({ proposal }, exec) {
      businessReadAgent(exec)
      if (proposal.kind !== proposalKind) throw new Error(RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_ROLE)
      await businessReadData(exec.signal)
      if (proposal.kind === 'route') for (const slot of proposal.slots) {
        const candidate = group.agents.find(agent => agent.id === slot.agentId)
        if (!candidate || slot.tools.some(tool => !candidate.tools.includes(tool))) throw new Error(RuntimeMessage.SLOT_EXCEEDS_AGENT_CAPABILITIES)
      }
      await businessCall('/internal/v1/data/propose', {
        ...proposal, id: proposalId,
        ...(actor.role !== 'router' && actor.role !== 'parse' ? { routeRevision: grant.routeRevision } : {}),
        ...(actor.role === 'worker' ? { slotId: actor.slotId } : {}),
      }, exec.signal)
      exec.concludeTurn()
      return { work: { id: grant.workId, actor, routeRevision: grant.routeRevision, status: 'accepted' } }
    },
  }))
}
