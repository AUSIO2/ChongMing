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
  PROPOSAL_CONTAINS_MODEL_CREDENTIAL: 'Proposal contains a model credential',
  REMOTE_ERROR_WITH_CODE: '{0}: {1}',
  TOOL_IS_NOT_ALLOWED: 'Tool is not an allowed stage capability: {0}',
  TOOL_OUTSIDE_CAPABILITY_SET: 'Tool is outside this stage capability set',
})
const messageFormat = (template, ...values) => template.replace(/\{(\d+)\}/g, (_match, index) => String(values[Number(index)]))
const output = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
const bypassTools = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'workflow', 'run_code', 'send_message', 'interrupt_agent', 'list_agents'])

function businessContainsModelKey(
  /* 即将发送的已解码提案；检查不转换合法业务内容。 */ value,
  /* 本工作进程单独持有的模型凭据。 */ apiKey,
) {
  // JSON字符串可以转义密钥字符，因此递归检查实际键和值，不能只搜索序列化字节。
  if (!apiKey) return false
  if (typeof value === 'string') return value.includes(apiKey)
  if (Array.isArray(value)) return value.some(item => businessContainsModelKey(item, apiKey))
  return !!value && typeof value === 'object' && Object.entries(value).some(([key, item]) => key.includes(apiKey) || businessContainsModelKey(item, apiKey))
}

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
      const next = part === '*' ? parent.items : parent.properties?.[part]
      if (!next) break
      if (index === parts.length - 1) {
        const required = next.required === true
        const { required: _required, ...original } = next
        const widened = { oneOf: [original, candidateRefSchema()], ...(required ? { required: true } : {}) }
        if (part === '*') parent.items = widened
        else parent.properties[part] = widened
      } else current = next
    }
  }
  return schema
}

function libraryReferenceSchema() {
  // 库引用属于通用输出元信息，固定身份和非空使用理由不会改写已发布payload schema。
  // DSH参数DSL不支持maxItems/minLength，真实执行入口与图服务仍强制这些业务边界。
  return { type: 'array', description: 'At most 32 selected library entries, each with its exact digest and a non-empty usage reason.',
    items: { type: 'object', additionalProperties: false, properties: {
    entryId: { type: 'string', required: true },
    contentDigest: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  } } }
}

function businessValidateLibraryUses(
  /* 模型实际提交的输出提案，SDK之外仍须守住数量和字段边界。 */ proposal,
) {
  // 参数DSL无法表达集合上限；在第一次网络调用前拒绝超限或不完整的引用元信息。
  if (proposal.kind !== 'outputs') return
  if (!Array.isArray(proposal.outputs)) throw new Error(RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_CONTRACT)
  for (const output of proposal.outputs) {
    const refs = output?.libraryClaimRefs
    if (refs === undefined) continue
    if (!Array.isArray(refs) || refs.length > 32) throw new Error(RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_CONTRACT)
    const entryIds = new Set()
    for (const ref of refs) {
      if (!ref || typeof ref !== 'object' || Array.isArray(ref) || typeof ref.entryId !== 'string' || !ref.entryId.trim()
        || typeof ref.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.contentDigest)
        || typeof ref.reason !== 'string' || !ref.reason.trim() || entryIds.has(ref.entryId)
        || Object.keys(ref).some((/* 模型提交的引用字段。 */ key) => /* 元信息只能携带固定身份与本次理由。 */ !['entryId', 'contentDigest', 'reason'].includes(key))) {
        throw new Error(RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_CONTRACT)
      }
      entryIds.add(ref.entryId)
    }
  }
}

function outputItemSchema(
  /* 当前冻结阶段获准发布的精确输出端口合同。 */ contract,
) {
  // 输出payload仍沿用不可变类型定义，库使用声明作为并列可选字段。
  const variants = contract.ports.map((/* 一个实际获准输出端口。 */ port) => /* 建立对应端口的工具输出变体。 */ ({
    type: 'object', additionalProperties: false,
    properties: {
      key: { type: 'string', required: true },
      port: { type: 'string', const: port.port, required: true },
      typeRef: { ...refSchema(port.type), required: true },
      payload: { ...outputPayloadSchema(port), required: true },
      sourceKeys: { type: 'array', items: { type: 'string' } },
      libraryClaimRefs: libraryReferenceSchema(),
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
  const libraryClaimRefs = structuredClone(config.libraryClaimRefs ?? [])
  if (!grant?.workId || !grant.mapId || !grant.operationId || !grant.runId || !grant.stageId || !grant.slotId || !grant.specHash
    || !grant.holderId || !Number.isSafeInteger(grant.fence) || grant.fence < 1 || !config.rootSessionId || !config.proposalId
    || !stage?.id || stage.id !== grant.stageId || stage.slotId !== grant.slotId || !stage.agent?.profile || !stage.outputContract
    || typeof config.persona !== 'string' || !config.persona.trim() || !Array.isArray(libraryClaimRefs)
    || libraryClaimRefs.length > 32 || libraryClaimRefs.some((/* 已冻结且由部署补丁提供的材料身份。 */ ref) =>
      /* 缺失身份不被工具配置当成已获权材料。 */ !ref || typeof ref.entryId !== 'string' || !ref.entryId
        || typeof ref.contentDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.contentDigest))) {
    throw new Error(RuntimeMessage.BUSINESS_TOOLS_REQUIRE_COMPLETE_GRANT)
  }
  const token = process.env.CHONGMING_DATA_TOKEN
  const modelKey = process.env.CHONGMING_MODEL_API_KEY
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
    const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await response.arrayBuffer()))
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
      || data.libraryClaims !== undefined && !Array.isArray(data.libraryClaims)
      || JSON.stringify((data.libraryClaims ?? []).map((/* 工作服务返回的已获权材料。 */ material) =>
        /* 与补丁冻结选择身份逐项核对，不读取当前来源图。 */ material?.ref)) !== JSON.stringify(libraryClaimRefs)
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
      if (businessContainsModelKey(proposal, modelKey)) throw new Error(RuntimeMessage.PROPOSAL_CONTAINS_MODEL_CREDENTIAL)
      if (proposal?.kind !== stage.outputContract.mode) throw new Error(RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_CONTRACT)
      businessValidateLibraryUses(proposal)
      await businessReadData(exec.signal)
      const result = await businessCall('/internal/v1/data/propose', {
        ...proposal, id: config.proposalId, specHash: grant.specHash,
      }, exec.signal)
      exec.concludeTurn()
      return result
    },
  }))
}
