// 文件职责：把 DSH 根 Agent 绑定到一份冻结阶段 Work，并生成对应 data_propose 工具合同。
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'chongming-data-tools'
export const inject = ['tools', 'agents', 'systemPrompt']
/** @enum {string} Kept local because DSH loads this uncompiled ESM file directly. */
const RuntimeMessage = Object.freeze({
  AGENT_HAS_NO_TRUSTED_WORK_BINDING: 'Agent has no trusted work binding',
  BUSINESS_TOOL_REQUIRES_BOUND_AGENT: 'Business tool requires the exact bound work Agent',
  BUSINESS_TOOLS_REQUIRE_COMPLETE_GRANT: 'Business tools require a complete generic work grant',
  CONFIGURED_TOOL_NOT_REGISTERED: 'Configured tool is not registered: {0}',
  DATA_API_RETURNED_DIFFERENT_BINDING: 'Data API returned a different generic work binding',
  DATA_API_RETURNED_STATUS: 'Data API returned status {0}',
  DATA_API_URL_MUST_USE_HTTP: 'Generic data API must use HTTP(S)',
  DATA_TOKEN_REQUIRED: 'Generic data tool token must be configured',
  PROPOSAL_DOES_NOT_MATCH_CONTRACT: 'Proposal does not match the frozen output contract',
  REMOTE_ERROR_WITH_CODE: '{0}: {1}',
  TOOL_IS_NOT_ALLOWED: 'Tool is not an allowed stage capability: {0}',
  TOOL_OUTSIDE_CAPABILITY_SET: 'Tool is outside this stage capability set',
})
const messageFormat = (template, ...values) => template.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)]))
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const bypassTools = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'workflow', 'run_code', 'send_message', 'interrupt_agent', 'list_agents'])

function toolSchema(schema, required = false, root = schema) {
  // 把受支持的 draft-07 子集转换为 DSH 工具参数形状；服务端仍执行完整 schema 校验。
  if (schema.$ref?.startsWith('#/definitions/')) {
    const resolved = root.definitions?.[schema.$ref.slice('#/definitions/'.length)]
    if (resolved) return toolSchema(resolved, required, root)
  }
  if (Array.isArray(schema.type)) {
    const matches = (value, type) => type === 'null' ? value === null : type === 'array' ? Array.isArray(value)
      : type === 'object' ? !!value && typeof value === 'object' && !Array.isArray(value)
        : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type
    const branches = schema.type.flatMap(type => {
      if (schema.const !== undefined && !matches(schema.const, type)) return []
      const values = schema.enum?.filter(value => matches(value, type))
      if (schema.enum && !values?.length) return []
      return [toolSchema({ ...schema, type, ...(values ? { enum: values } : {}) }, false, root)]
    })
    return { oneOf: branches, ...(required ? { required: true } : {}) }
  }
  const result = {}
  for (const key of ['type', 'enum', 'const', 'description', 'title', 'default']) {
    if (schema[key] !== undefined) result[key] = structuredClone(schema[key])
  }
  if (required) result.required = true
  if (schema.oneOf) result.oneOf = schema.oneOf.map(item => toolSchema(item, false, root))
  if (schema.items) result.items = toolSchema(schema.items, false, root)
  if (schema.properties) {
    const requiredNames = new Set(schema.required ?? [])
    result.properties = Object.fromEntries(Object.entries(schema.properties).map(([name, item]) => [name, toolSchema(item, requiredNames.has(name), root)]))
  }
  if (schema.additionalProperties !== undefined) result.additionalProperties = typeof schema.additionalProperties === 'object'
    ? true : schema.additionalProperties
  return result
}

function refSchema(ref) {
  return {
    type: 'object', additionalProperties: false,
    properties: {
      id: { type: 'string', const: ref.id, required: true },
      version: { type: 'integer', const: ref.version, required: true },
    },
  }
}

function candidateRefSchema() {
  // 候选引用只携带可信 Work 身份和候选 key；正式节点 ID 由服务端审核发布时回填。
  return {
    type: 'object', additionalProperties: false,
    properties: { candidate: { type: 'object', required: true, additionalProperties: false, properties: {
      workId: { type: 'string', required: true }, key: { type: 'string', required: true },
    } } },
  }
}

function outputPayloadSchema(port) {
  // 只在类型定义明确声明的节点引用字段接受候选占位；普通字符串仍维持原 schema。
  const schema = toolSchema(port.schema)
  for (const reference of port.references ?? []) {
    if (reference.target?.kind !== 'node') continue
    const parts = reference.path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'))
    let current = schema
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      const parent = current
      const next = part === '*' ? (parent.items ?? (typeof parent.additionalProperties === 'object' ? parent.additionalProperties : undefined))
        : parent.properties?.[part]
      if (!next) break
      if (index === parts.length - 1) {
        const required = next.required === true
        const { required: _required, ...original } = next
        const widened = { oneOf: [original, candidateRefSchema()], ...(required ? { required: true } : {}) }
        if (part === '*') {
          if (parent.items) parent.items = widened
          else parent.additionalProperties = widened
        } else parent.properties[part] = widened
      } else current = next
    }
  }
  return schema
}

function outputItemSchema(contract) {
  const variants = contract.ports.map(port => ({
    type: 'object', additionalProperties: false,
    properties: {
      key: { type: 'string', required: true },
      port: { type: 'string', const: port.port, required: true },
      typeRef: { ...refSchema(port.type), required: true },
      payload: { ...outputPayloadSchema(port), required: true },
      sourceKeys: { type: 'array', items: { type: 'string' } },
    },
  }))
  return variants.length === 1 ? variants[0] : { oneOf: variants }
}

function proposalSchema(stage) {
  const common = {
    kind: { type: 'string', const: stage.outputContract.mode, required: true },
    reason: { type: 'string', required: true },
  }
  if (stage.outputContract.mode === 'outputs') return {
    type: 'object', additionalProperties: false,
    properties: { ...common, outputs: { type: 'array', required: true, items: outputItemSchema(stage.outputContract) } },
  }
  if (stage.outputContract.mode === 'selection') return {
    type: 'object', additionalProperties: false,
    properties: { ...common, selection: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false,
      properties: { workId: { type: 'string', required: true }, key: { type: 'string', required: true } },
    } } },
  }
  const allowedStages = stage.plan?.stageIds ?? []
  const allowedAgents = stage.plan?.agents.map(agent => agent.ref) ?? []
  const agentRef = allowedAgents.length === 1 ? refSchema(allowedAgents[0]) : { oneOf: allowedAgents.map(refSchema) }
  return {
    type: 'object', additionalProperties: false,
    properties: { ...common, slots: { type: 'array', required: true, items: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', required: true },
        stageId: { type: 'string', required: true, enum: allowedStages },
        agentRef: { ...agentRef, required: true },
        angle: { type: 'string', required: true },
        hint: { type: 'string', required: true },
        priority: { type: 'string', required: true, enum: ['high', 'medium', 'low'] },
        tools: { type: 'array', required: true, items: { type: 'string' } },
      },
    } } },
  }
}

/** One trusted work grant owns one DSH root, regardless of its registered data types. */
export function apply(ctx, config = {}) {
  const grant = structuredClone(config.grant)
  const stage = { ...structuredClone(config.stage), outputContract: structuredClone(config.outputContract) }
  if (!grant?.workId || !grant.mapId || !grant.operationId || !grant.runId || !grant.stageId || !grant.slotId || !grant.specHash
    || !grant.holderId || !Number.isSafeInteger(grant.fence) || grant.fence < 1 || !config.rootSessionId || !config.proposalId
    || !stage?.id || stage.id !== grant.stageId || stage.slotId !== grant.slotId || !stage.agent?.profile || !stage.outputContract
    || typeof config.persona !== 'string' || !config.persona.trim()) throw new Error(RuntimeMessage.BUSINESS_TOOLS_REQUIRE_COMPLETE_GRANT)
  const token = process.env.CHONGMING_DATA_TOKEN
  if (!token) throw new Error(RuntimeMessage.DATA_TOKEN_REQUIRED)
  const apiUrl = new URL(process.env.CHONGMING_DATA_API ?? 'http://127.0.0.1:4320')
  if (!['http:', 'https:'].includes(apiUrl.protocol)) throw new Error(RuntimeMessage.DATA_API_URL_MUST_USE_HTTP)
  const selectedTools = stage.tools.map(tool => tool.name)
  for (const tool of selectedTools) {
    if (!stage.agent.profile.tools.includes(tool) || bypassTools.has(tool) || tool.startsWith('cordis_')) {
      throw new Error(messageFormat(RuntimeMessage.TOOL_IS_NOT_ALLOWED, tool))
    }
  }
  const allow = ['data_read', 'data_propose', ...selectedTools]
  function businessReadAgent(exec) {
    const agent = exec.agent
    if (!agent || agent.id !== config.rootSessionId || ctx.agents.get(agent.id) !== agent) throw new Error(RuntimeMessage.BUSINESS_TOOL_REQUIRES_BOUND_AGENT)
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
    if (!response.ok || result.ok !== true) throw new Error(result.error?.code
      ? messageFormat(RuntimeMessage.REMOTE_ERROR_WITH_CODE, result.error.code, result.error.message)
      : messageFormat(RuntimeMessage.DATA_API_RETURNED_STATUS, response.status))
    return result.data
  }
  async function businessReadData(signal) {
    const data = await businessCall('/internal/v1/data/read', {}, signal)
    if (data.mapId !== grant.mapId || data.operationId !== grant.operationId || data.runId !== grant.runId
      || data.specHash !== grant.specHash || data.proposalId !== config.proposalId
      || data.stage?.id !== grant.stageId || data.stage.slotId !== grant.slotId
      || data.work?.id !== grant.workId || data.work.specHash !== grant.specHash
      || data.work.stageId !== grant.stageId || data.work.slotId !== grant.slotId
      || JSON.stringify(data.outputContract) !== JSON.stringify(stage.outputContract)
      || JSON.stringify(data.stage.agent) !== JSON.stringify(stage.agent)) throw new Error(RuntimeMessage.DATA_API_RETURNED_DIFFERENT_BINDING)
    return data
  }
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id !== config.rootSessionId) return
    for (const tool of allow) if (!ctx.tools.get(tool, agent)) throw new Error(messageFormat(RuntimeMessage.CONFIGURED_TOOL_NOT_REGISTERED, tool))
    agent.ctx.tools.restrict({ allow })
    agent.ctx.systemPrompt.variable('chongming_persona', () => config.persona)
    agent.ctx.systemPrompt.section({
      name: 'deployment:persona-prefix', order: agent.ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'), text: '{{chongming_persona}}',
    })
  })
  ctx.tools.guard(exec => {
    try { businessReadAgent(exec); return allow.includes(exec.name) ? undefined : RuntimeMessage.TOOL_OUTSIDE_CAPABILITY_SET }
    catch { return RuntimeMessage.AGENT_HAS_NO_TRUSTED_WORK_BINDING }
  })
  ctx.tools.register(defineTool({
    name: 'data_read', description: 'Read the named inputs, context, dependency results and frozen output contract for this work.',
    parameters: {}, output,
    execute: (_args, exec) => { businessReadAgent(exec); return businessReadData(exec.signal) },
  }))
  ctx.tools.register(defineTool({
    name: 'data_propose', description: 'Submit the outputs, selection or bounded plan allowed by this frozen stage.',
    parameters: { proposal: { ...proposalSchema(stage), required: true } }, output,
    execute: async ({ proposal }, exec) => {
      businessReadAgent(exec)
      if (proposal?.kind !== stage.outputContract.mode) throw new Error(RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_CONTRACT)
      await businessReadData(exec.signal)
      const result = await businessCall('/internal/v1/data/propose', {
        ...proposal, id: config.proposalId, specHash: grant.specHash,
      }, exec.signal)
      exec.concludeTurn()
      return result
    },
  }))
}
