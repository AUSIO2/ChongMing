// 文件职责：将 DSH 根 Agent 绑定到可信工作授权，限制工具并提交对应阶段产物。
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
const messageFormat = (/* 包含数字占位符的本地错误消息模板。 */ template, /* 依占位符索引提供的替换值，转换为字符串后插入。 */ ...values) => /* 按编号替换本地错误消息模板的参数占位符。 */  template.replace(/\{(\d+)\}/g, (/* 正则匹配到的完整占位符，此回调只使用捕获的索引。 */ _match, /* 占位符中的十进制索引文本，用于选取替换值。 */ index) => /* 用对应位置的参数文本替换当前编号占位符。 */  String(values[Number(index)]))
const output = { schema: { type: 'json' }, render: (/* 工具输出渲染器收到的原始调用参数，此处不用于生成结果文本。 */ _args, /* 工具执行返回的业务结果，将序列化为 JSON 文本。 */ value) => /* 将业务工具返回值渲染为 JSON 文本结果。 */  [{ type: 'text', text: JSON.stringify(value) }] }
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
export function apply(/* DSH 插件上下文，提供工具、Agent 和系统提示词注册能力。 */ ctx, /* 可信部署补丁传入的工作配置，默认空对象但必须通过完整授权检查。 */ config = {}) {
  // 校验可信工作绑定，选择角色能力，并注册受限的数据读取与提案工具。
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
    const slot = config.route?.slots.find(/* 已批准路由的槽位候选，与授权中固定的 worker 身份匹配。 */ slot => /* 定位授权 worker 的路由槽位。 */  slot.id === actor.slotId)
    profile = group?.agents.find(/* 冻结 Agent 配置候选，按槽位指定的 agentId 查找。 */ agent => /* 取得路由槽位对应的 Agent 配置。 */  agent.id === slot?.agentId)
    if (!slot || !profile || slot.tools.some(/* 槽位声明的工具名称，不能超过对应 Agent 的能力集合。 */ tool => /* 检查槽位是否请求了 Agent 未声明的工具。 */  !profile.tools.includes(tool))) throw new Error(RuntimeMessage.WORKER_HAS_NO_VALID_SLOT)
    selectedTools = slot.tools
  }
  if (!profile) throw new Error(RuntimeMessage.UNKNOWN_WORK_ROLE)
  if (actor.role !== 'router' && actor.role !== 'parse' && (!config.route?.approved || config.route.revision !== grant.routeRevision)) {
    throw new Error(RuntimeMessage.WORK_GRANT_REQUIRES_APPROVED_ROUTE)
  }
  selectedTools = [...(selectedTools ?? profile.tools)]
  const catalog = new Set(configuration.tools.map(/* 冻结共享工具目录中的声明，提取名称建立允许集合。 */ tool => /* 从共享工具声明建立允许名称目录。 */  tool.name))
  for (const tool of selectedTools) {
    if (!catalog.has(tool) || bypassTools.has(tool) || tool.startsWith('cordis_')) throw new Error(messageFormat(RuntimeMessage.TOOL_IS_NOT_ALLOWED, tool))
  }
  const allow = ['data_read', 'data_propose', ...selectedTools]
  const proposalKind = actor.role === 'parse' ? 'parse' : actor.role === 'router' ? 'route'
    : operationKind === 'split' ? (actor.role === 'worker' ? 'split-report' : 'split-merge')
    : actor.role === 'worker' ? 'report' : 'merge'
  function businessReadAgent(/* DSH 当前工具执行上下文，Agent 对象必须是已注册根会话本体。 */ exec) {
    // 确认工具由当前注册的根 Agent 本体调用，拒绝其他会话或伪造对象。
    const agent = exec.agent
    if (!agent || agent.id !== config.rootSessionId || ctx.agents.get(agent.id) !== agent) {
      throw new Error(RuntimeMessage.BUSINESS_TOOL_REQUIRES_BOUND_AGENT)
    }
    return agent
  }
  async function businessCall(/* 插件固定选择的数据服务内部路径，不由模型参数决定。 */ path, /* 工具构造的请求内容，图和 Operation 身份会被可信授权覆盖。 */ body, /* 本轮工具执行的取消信号，传给网络请求。 */ signal) {
    // 把可信图和 Operation 身份覆盖到请求中，携带内部令牌及租约调用数据 API。
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
  async function businessReadData(/* 当前工具执行取消信号，用于终止授权视图读取。 */ signal) {
    // 读取执行输入，并逐项核对工作绑定、提案身份和冻结配置没有变化。
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
  ctx.on('agent/created', (/* Agent 创建事件中的实际对象，只对可信根会话设置工具限制和角色提示词。 */ { agent }) => {
    // 根 Agent 创建时同步验证工具均已注册，限制能力并注入部署提示词。
    if (agent.id !== config.rootSessionId) return
    for (const tool of allow) if (!ctx.tools.get(tool, agent)) throw new Error(messageFormat(RuntimeMessage.CONFIGURED_TOOL_NOT_REGISTERED, tool))
    agent.ctx.tools.restrict({ allow })
    // DSH substitutes a variable value once: application/user {{...}} text stays literal afterwards.
    agent.ctx.systemPrompt.variable('chongming_persona', () => /* 以变量形式返回可信提示词，使其中模板文本不被再次展开。 */  persona)
    agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: '{{chongming_persona}}',
    })
  })
  ctx.tools.guard(/* 待调用工具的执行上下文，核对 Agent 本体和工具名白名单。 */ exec => {
    // 在执行前核对根 Agent 身份及工具白名单，返回明确的拒绝原因。
    try { businessReadAgent(exec); return allow.includes(exec.name) ? undefined : RuntimeMessage.TOOL_OUTSIDE_CAPABILITY_SET }
    catch { return RuntimeMessage.AGENT_HAS_NO_TRUSTED_WORK_BINDING }
  })

  ctx.tools.register(defineTool({
    name: 'data_read', description: 'Read the assigned operation target, work, source text, frozen configuration, approved route and accepted reports.',
    parameters: {}, output,
    execute: (/* 模型传入的读取工具参数，此工具无需业务输入，不采用其中内容。 */ _args, /* 原生执行上下文，提供可信 Agent 对象及取消信号。 */ exec) => {
      // 验证调用 Agent 后返回该工作授权的数据视图。
       businessReadAgent(exec); return businessReadData(exec.signal) },
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
    async execute(/* 模型工具参数中的提案对象，仍需验证角色、路由及能力范围。 */ { proposal }, /* 当前原生执行上下文，提供取消、身份验证和提交成功后的结束本轮操作。 */ exec) {
      // 核对提案角色和最新绑定，使用可信槽位与版本提交结果，成功后结束当前轮。
      businessReadAgent(exec)
      if (proposal.kind !== proposalKind) throw new Error(RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_ROLE)
      await businessReadData(exec.signal)
      if (proposal.kind === 'route') for (const slot of proposal.slots) {
        const candidate = group.agents.find(/* 冻结能力组中的候选 Agent，用于校验路由提案引用。 */ agent => /* 查找路由提案指定的候选 Agent。 */  agent.id === slot.agentId)
        if (!candidate || slot.tools.some(/* 模型所选槽位的工具名，必须属于候选 Agent 声明的能力。 */ tool => /* 拒绝路由槽位超出候选 Agent 声明的工具能力。 */  !candidate.tools.includes(tool))) throw new Error(RuntimeMessage.SLOT_EXCEEDS_AGENT_CAPABILITIES)
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
