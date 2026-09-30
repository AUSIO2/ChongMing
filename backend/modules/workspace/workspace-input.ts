// 解析工作区、成员、偏好和 Agent 管理协议，检查字段范围与枚举值。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { AgentBinding, AgentInput, AgentRole, AgentScope, ControlCommand, ControlQuery, PromptKind, Role } from '../../../contracts/control'
import { definitionsReadPackage } from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import { inputReadArray, inputReadId, inputReadNames, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'

export const CONTROL_PROMPT_KINDS: PromptKind[] = ['parseExtract', 'splitRoute', 'splitSubAgent', 'splitMerge', 'verifyRoute', 'verifySubAgent', 'verifyMerge']
export const CONTROL_PROMPT_VARIABLES: Record<PromptKind, string[]> = {
  parseExtract: ['rawContent'], splitRoute: ['availableAgents', 'context', 'content'],
  splitSubAgent: ['hint', 'context', 'content'], splitMerge: ['content', 'subResults'],
  verifyRoute: ['availableAgents', 'context', 'claimContent', 'originalContent'],
  verifySubAgent: ['hint', 'context', 'claimContent', 'originalContent'], verifyMerge: ['claimContent', 'originalContent', 'opinions'],
}
const reservedTools = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'run_code'])

/**
 * 接受允许为空的文本字段，同时拒绝非字符串值。
 *
 * @param value 允许为空、但尚未验证类型的文本字段。
 * @param label 写入错误信息的文本字段路径。
 */
function controlReadText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_MUST_BE_A_STRING, label))
  return value
}

/**
 * 限制管理协议中的运行时名称字符和长度，保留原合法名称。
 *
 * @param value 尚未验证运行时字符和长度约束的名称。
 * @param label 写入错误信息的名称字段路径。
 */
function controlReadName(value: unknown, label: string): string {
  const name = inputReadString(value, label)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_IS_NOT_A_VALID_RUNTIME_NAME, label))
  return name
}

/**
 * 校验非空名称列表并拒绝重复值，供工具、变量和复制选择使用。
 *
 * @param value 尚未验证元素和重复值的名称列表。
 * @param label 写入错误信息的名称列表字段路径。
 */
function controlReadNames(value: unknown, label: string): string[] {
  const names = inputReadNames(value, label)
  if (new Set(names).size !== names.length) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTAINS_DUPLICATE_VALUES, label))
  return names
}

/**
 * 将外部提示词类型收窄为稳定名称；业务阶段许可改由注册转换绑定决定。
 *
 * @param value 尚未收窄到支持阶段枚举的提示词类型。
 */
export function controlReadKind(value: unknown): PromptKind {
  return controlReadName(value, 'agent.kind')
}

/**
 * 解析 Agent 可参与的精确转换阶段，并拒绝重复绑定。
 *
 * @param value 来自 Agent 管理输入、尚未解析的转换阶段绑定。
 */
function controlReadBindings(value: unknown): AgentBinding[] {
  const bindings = inputReadArray(value, 'agent.bindings').map((item, index) => {
    // 解析一项精确转换引用和阶段身份。
    const binding = inputReadObject(item, ['transition', 'stageId'], `agent.bindings[${index}]`)
    const transition = inputReadObject(binding.transition, ['id', 'version'], `agent.bindings[${index}].transition`)
    const version = inputReadRevision(transition.version, `agent.bindings[${index}].transition.version`)
    if (version < 1) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, 'Agent binding transition version must be positive'))
    return { transition: { id: inputReadString(transition.id, `agent.bindings[${index}].transition.id`), version },
      stageId: controlReadName(binding.stageId, `agent.bindings[${index}].stageId`) }
  })
  const keys = bindings.map(binding => /* 同时使用转换身份、版本和阶段身份判断重复。 */ `${binding.transition.id}\u0000${binding.transition.version}\u0000${binding.stageId}`)
  if (new Set(keys).size !== keys.length) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, 'Agent bindings contain duplicates'))
  return bindings
}

/**
 * 解析 Agent 编辑内容，检查阶段变量、工具保留名及可空模型配置。
 *
 * @param value 来自管理命令、尚未验证字段的 Agent 定义。
 */
export function controlReadAgent(value: unknown): AgentInput {
  const agent = inputReadObject(value, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model', 'promptPath', 'kind', 'promptVars', 'defaultPriority', 'claimCategory', 'role', 'bindings'], 'agent')
  const kind = controlReadKind(agent.kind)
  const promptVars = controlReadNames(agent.promptVars, 'agent.promptVars')
  const legacyVariables = CONTROL_PROMPT_VARIABLES[kind]
  if (legacyVariables && promptVars.some(id => /* 保持旧配置的变量白名单，新转换由定义绑定校验。 */ !legacyVariables.includes(id))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.PROMPT_VARIABLE_IS_NOT_AVAILABLE_FOR_THIS_KIND)
  const role = agent.role as AgentRole | undefined
  if (role !== undefined && role !== 'producer' && role !== 'planner' && role !== 'selector') throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, 'Agent role is invalid'))
  const bindings = agent.bindings === undefined ? undefined : controlReadBindings(agent.bindings)
  if ((role === undefined) !== (bindings === undefined) || bindings?.length === 0) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, 'Agent role and non-empty bindings must be provided together'))
  const tools = controlReadNames(agent.tools, 'agent.tools').map(tool => /* 验证每项工具名称符合运行时标识格式。 */ controlReadName(tool, 'agent.tools'))
  if (tools.some(tool => /* 检测宿主保留工具或 cordis 能力，防止作为普通 Agent 工具配置。 */ reservedTools.has(tool) || tool.startsWith('cordis_'))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.RESERVED_TOOL_CANNOT_BE_AN_AGENT_CAPABILITY)
  if (!['high', 'medium', 'low'].includes(agent.defaultPriority as string)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_DEFAULTPRIORITY)
  if (agent.claimCategory !== null && !['data', 'quote', 'causal'].includes(agent.claimCategory as string)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_CLAIMCATEGORY)
  return {
    id: controlReadName(agent.id, 'agent.id'), name: inputReadString(agent.name, 'agent.name').trim(),
    description: inputReadString(agent.description, 'agent.description'), content: inputReadString(agent.content, 'agent.content'),
    promptPath: inputReadString(agent.promptPath, 'agent.promptPath').trim(), kind, tools, promptVars,
    provider: agent.provider === null ? null : inputReadString(agent.provider, 'agent.provider').trim(),
    model: agent.model === null ? null : inputReadString(agent.model, 'agent.model').trim(),
    defaultPriority: agent.defaultPriority as AgentInput['defaultPriority'], claimCategory: agent.claimCategory as AgentInput['claimCategory'],
    ...(role === undefined ? {} : { role }), ...(bindings === undefined ? {} : { bindings }),
  }
}

/**
 * 区分全局库与工作区范围，并要求工作区范围携带合法 UUID。
 *
 * @param value 尚未解析为全局库或工作区范围的输入。
 */
function controlReadScope(value: unknown): AgentScope {
  const scope = inputReadObject(value, ['kind', 'workspaceId'], 'scope')
  if (scope.kind === 'library') {
    inputReadObject(value, ['kind'], 'scope')
    return { kind: 'library' }
  }
  if (scope.kind === 'workspace') return { kind: 'workspace', workspaceId: inputReadId(scope.workspaceId, 'scope.workspaceId') }
  throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.UNKNOWN_AGENT_SCOPE)
}

/**
 * 按管理查询方法解析参数，限制分页大小并拒绝未知查询。
 *
 * @param value 来自公共查询边界、尚未按方法解析的输入。
 */
export function controlReadQuery(value: unknown): ControlQuery {
  const query = inputReadObject(value, ['method', 'params'], 'query')
  if (query.method === 'app.bootstrap') { inputReadObject(query.params, [], 'params'); return { method: query.method, params: {} } }
  if (query.method === 'workspace.list' || query.method === 'asset.list') {
    const params = inputReadObject(query.params, query.method === 'asset.list' ? ['workspaceId', 'cursor', 'limit'] : ['cursor', 'limit'], 'params')
    const limit = params.limit === undefined ? undefined : inputReadRevision(params.limit, 'limit')
    if (limit !== undefined && (limit < 1 || limit > 200)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.LIMIT_MUST_BE_BETWEEN_1_AND_200)
    const page = { ...(limit === undefined ? {} : { limit }), ...(params.cursor === undefined ? {} : { cursor: inputReadString(params.cursor, 'cursor') }) }
    return query.method === 'asset.list'
      ? { method: query.method, params: { ...page, workspaceId: inputReadId(params.workspaceId, 'workspaceId') } }
      : { method: query.method, params: page }
  }
  if (query.method === 'workspace.get') {
    const params = inputReadObject(query.params, ['workspaceId'], 'params')
    return { method: query.method, params: { workspaceId: inputReadId(params.workspaceId, 'workspaceId') } }
  }
  if (query.method === 'agent.list') {
    const params = inputReadObject(query.params, ['scope', 'kind'], 'params')
    return { method: query.method, params: { scope: controlReadScope(params.scope), ...(params.kind === undefined ? {} : { kind: controlReadKind(params.kind) }) } }
  }
  if (query.method === 'definition.get') {
    const params = inputReadObject(query.params, ['workspaceId', 'packageId', 'packageVersion'], 'params')
    if ((params.packageId === undefined) !== (params.packageVersion === undefined)) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, 'packageId and packageVersion must be provided together'))
    const packageVersion = params.packageVersion === undefined ? undefined : inputReadRevision(params.packageVersion, 'packageVersion')
    if (packageVersion !== undefined && packageVersion < 1) throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.DEFINITION_INVALID_VALUE, 'packageVersion must be positive'))
    return { method: query.method, params: { workspaceId: inputReadId(params.workspaceId, 'workspaceId'),
      ...(params.packageId === undefined ? {} : { packageId: inputReadString(params.packageId, 'packageId'), packageVersion }) } }
  }
  throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_CONTROL_QUERY)
}

/**
 * 按写命令解析请求身份、预期版本和业务参数，拒绝多余字段及非法枚举。
 *
 * @param value 来自公共写入边界、尚未按命令方法解析的输入。
 */
export function controlReadCommand(value: unknown): ControlCommand {
  const command = inputReadObject(value, ['requestId', 'method', 'params'], 'command')
  const requestId = inputReadId(command.requestId, 'requestId')
  const method = command.method
  if (method === 'workspace.create') {
    const p = inputReadObject(command.params, ['id', 'name', 'description', 'agentSource'], 'params')
    if (p.agentSource !== 'empty' && p.agentSource !== 'library') throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_AGENTSOURCE)
    return { requestId, method, params: { id: inputReadId(p.id, 'id'), name: inputReadString(p.name, 'name').trim(), description: controlReadText(p.description, 'description'), agentSource: p.agentSource } }
  }
  if (method === 'workspace.update' || method === 'workspace.delete' || method === 'member.set' || method === 'agent.copy' || method === 'preferences.set') {
    const extra = method === 'workspace.update' ? ['name', 'description'] : method === 'member.set' ? ['userId', 'role']
      : method === 'agent.copy' ? ['libraryRevision', 'agentIds', 'mode'] : method === 'preferences.set' ? ['openMapIds', 'currentMapId', 'nodeSelection'] : []
    const p = inputReadObject(command.params, ['workspaceId', 'expectedRevision', ...extra], 'params')
    const base = { workspaceId: inputReadId(p.workspaceId, 'workspaceId'), expectedRevision: inputReadRevision(p.expectedRevision, 'expectedRevision') }
    if (method === 'workspace.update') return { requestId, method, params: { ...base, name: inputReadString(p.name, 'name').trim(), description: controlReadText(p.description, 'description') } }
    if (method === 'workspace.delete') return { requestId, method, params: base }
    if (method === 'member.set') {
      if (p.role !== null && !['owner', 'editor', 'viewer'].includes(p.role as string)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_MEMBER_ROLE)
      return { requestId, method, params: { ...base, userId: inputReadId(p.userId, 'userId'), role: p.role as Role | null } }
    }
    if (method === 'agent.copy') {
      if (p.mode !== 'merge' && p.mode !== 'replace') throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.INVALID_COPY_MODE)
      return { requestId, method, params: { ...base, libraryRevision: inputReadRevision(p.libraryRevision, 'libraryRevision'), agentIds: controlReadNames(p.agentIds, 'agentIds'), mode: p.mode } }
    }
    const openMapIds = controlReadNames(p.openMapIds, 'openMapIds').map(id => /* 验证保存的每个打开标签页都是合法图标识。 */ inputReadId(id, 'openMapIds'))
    const rawSelection = p.nodeSelection
    if (!rawSelection || typeof rawSelection !== 'object' || Array.isArray(rawSelection)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.NODESELECTION_MUST_BE_AN_OBJECT)
    const nodeSelection = Object.fromEntries(Object.entries(rawSelection).map(([id, node]) => /* 校验图到节点选择的映射，允许用 null 表示未选节点。 */ [inputReadId(id, 'nodeSelection map'), node === null ? null : inputReadId(node, 'nodeSelection node')]))
    return { requestId, method, params: { ...base, openMapIds, currentMapId: p.currentMapId === null ? null : inputReadId(p.currentMapId, 'currentMapId'), nodeSelection } }
  }
  if (method === 'agent.create' || method === 'agent.update' || method === 'agent.delete') {
    const p = inputReadObject(command.params, ['scope', 'expectedRevision', ...(method === 'agent.create' ? ['agent'] : method === 'agent.update' ? ['agentId', 'expectedAgentRevision', 'agent'] : ['agentId', 'expectedAgentRevision'])], 'params')
    const base = { scope: controlReadScope(p.scope), expectedRevision: inputReadRevision(p.expectedRevision, 'expectedRevision') }
    if (method === 'agent.create') return { requestId, method, params: { ...base, agent: controlReadAgent(p.agent) } }
    const target = { agentId: controlReadName(p.agentId, 'agentId'), expectedAgentRevision: inputReadRevision(p.expectedAgentRevision, 'expectedAgentRevision') }
    if (method === 'agent.update') return { requestId, method, params: { ...base, ...target, agent: controlReadAgent(p.agent) } }
    return { requestId, method, params: { ...base, ...target } }
  }
  if (method === 'definition.publish') {
    const p = inputReadObject(command.params, ['workspaceId', 'expectedRevision', 'package'], 'params')
    return { requestId, method, params: { workspaceId: inputReadId(p.workspaceId, 'workspaceId'),
      expectedRevision: inputReadRevision(p.expectedRevision, 'expectedRevision'), package: definitionsReadPackage(p.package) } }
  }
  if (method === 'settings.update') {
    const p = inputReadObject(command.params, ['expectedRevision', 'llm', 'tools', 'limits'], 'params')
    const llm = inputReadObject(p.llm, ['provider', 'model'], 'llm')
    const limits = inputReadObject(p.limits, ['maxAgentSlots'], 'limits')
    const maxAgentSlots = inputReadRevision(limits.maxAgentSlots, 'maxAgentSlots')
    if (maxAgentSlots < 1 || maxAgentSlots > 32) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.MAXAGENTSLOTS_MUST_BE_BETWEEN_1_AND_32)
    const tools = inputReadArray(p.tools, 'tools').map(value => {
      // 解析共享工具定义并拒绝保留能力名称。
      const tool = inputReadObject(value, ['name', 'description'], 'tool')
      const name = controlReadName(tool.name, 'tool.name')
      if (reservedTools.has(name) || name.startsWith('cordis_')) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.RESERVED_TOOL_NAME)
      return { name, description: inputReadString(tool.description, 'tool.description') }
    })
    controlReadNames(tools.map(tool => /* 提取共享工具名，复用名称列表校验防止重复注册。 */ tool.name), 'tools')
    return { requestId, method, params: { expectedRevision: inputReadRevision(p.expectedRevision, 'expectedRevision'), llm: { provider: inputReadString(llm.provider, 'provider').trim(), model: inputReadString(llm.model, 'model').trim() }, tools, limits: { maxAgentSlots } } }
  }
  throw new GraphError(400, 'UNKNOWN_METHOD', RuntimeMessage.UNKNOWN_CONTROL_COMMAND)
}
