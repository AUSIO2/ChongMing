import type { AgentInput, AgentScope, ControlCommand, ControlQuery, PromptKind, Role } from '../contracts/control'
import { GraphError } from './graph-error'
import { inputReadArray, inputReadId, inputReadNames, inputReadObject, inputReadRevision, inputReadString } from './input'

export const CONTROL_PROMPT_KINDS: PromptKind[] = ['parseExtract', 'splitRoute', 'splitSubAgent', 'splitMerge', 'verifyRoute', 'verifySubAgent', 'verifyMerge']
export const CONTROL_PROMPT_VARIABLES: Record<PromptKind, string[]> = {
  parseExtract: ['rawContent'], splitRoute: ['availableAgents', 'context', 'content'],
  splitSubAgent: ['hint', 'context', 'content'], splitMerge: ['content', 'subResults'],
  verifyRoute: ['availableAgents', 'context', 'claimContent', 'originalContent'],
  verifySubAgent: ['hint', 'context', 'claimContent', 'originalContent'], verifyMerge: ['claimContent', 'originalContent', 'opinions'],
}
const reservedTools = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'run_code'])

function controlReadText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GraphError(400, 'INVALID_ARGUMENT', `${label} must be a string`)
  return value
}

function controlReadName(value: unknown, label: string): string {
  const name = inputReadString(value, label)
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} is not a valid runtime name`)
  return name
}

function controlReadNames(value: unknown, label: string): string[] {
  const names = inputReadNames(value, label)
  if (new Set(names).size !== names.length) throw new GraphError(400, 'INVALID_ARGUMENT', `${label} contains duplicate values`)
  return names
}

export function controlReadKind(value: unknown): PromptKind {
  if (!CONTROL_PROMPT_KINDS.includes(value as PromptKind)) throw new GraphError(400, 'INVALID_ARGUMENT', 'Unknown prompt kind')
  return value as PromptKind
}

export function controlReadAgent(value: unknown): AgentInput {
  const agent = inputReadObject(value, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model', 'promptPath', 'kind', 'promptVars', 'defaultPriority', 'claimCategory'], 'agent')
  const kind = controlReadKind(agent.kind)
  const promptVars = controlReadNames(agent.promptVars, 'agent.promptVars')
  if (promptVars.some(id => !CONTROL_PROMPT_VARIABLES[kind].includes(id))) throw new GraphError(400, 'INVALID_ARGUMENT', 'Prompt variable is not available for this kind')
  const tools = controlReadNames(agent.tools, 'agent.tools').map(tool => controlReadName(tool, 'agent.tools'))
  if (tools.some(tool => reservedTools.has(tool) || tool.startsWith('cordis_'))) throw new GraphError(400, 'INVALID_ARGUMENT', 'Reserved tool cannot be an Agent capability')
  if (!['high', 'medium', 'low'].includes(agent.defaultPriority as string)) throw new GraphError(400, 'INVALID_ARGUMENT', 'Invalid defaultPriority')
  if (agent.claimCategory !== null && !['data', 'quote', 'causal'].includes(agent.claimCategory as string)) throw new GraphError(400, 'INVALID_ARGUMENT', 'Invalid claimCategory')
  return {
    id: controlReadName(agent.id, 'agent.id'), name: inputReadString(agent.name, 'agent.name').trim(),
    description: inputReadString(agent.description, 'agent.description'), content: inputReadString(agent.content, 'agent.content'),
    promptPath: inputReadString(agent.promptPath, 'agent.promptPath').trim(), kind, tools, promptVars,
    provider: agent.provider === null ? null : inputReadString(agent.provider, 'agent.provider').trim(),
    model: agent.model === null ? null : inputReadString(agent.model, 'agent.model').trim(),
    defaultPriority: agent.defaultPriority as AgentInput['defaultPriority'], claimCategory: agent.claimCategory as AgentInput['claimCategory'],
  }
}

function controlReadScope(value: unknown): AgentScope {
  const scope = inputReadObject(value, ['kind', 'workspaceId'], 'scope')
  if (scope.kind === 'library') {
    inputReadObject(value, ['kind'], 'scope')
    return { kind: 'library' }
  }
  if (scope.kind === 'workspace') return { kind: 'workspace', workspaceId: inputReadId(scope.workspaceId, 'scope.workspaceId') }
  throw new GraphError(400, 'INVALID_ARGUMENT', 'Unknown Agent scope')
}

export function controlReadQuery(value: unknown): ControlQuery {
  const query = inputReadObject(value, ['method', 'params'], 'query')
  if (query.method === 'app.bootstrap') { inputReadObject(query.params, [], 'params'); return { method: query.method, params: {} } }
  if (query.method === 'workspace.list') {
    const params = inputReadObject(query.params, ['cursor', 'limit'], 'params')
    const limit = params.limit === undefined ? undefined : inputReadRevision(params.limit, 'limit')
    if (limit !== undefined && (limit < 1 || limit > 200)) throw new GraphError(400, 'INVALID_ARGUMENT', 'limit must be between 1 and 200')
    return { method: query.method, params: { ...(limit === undefined ? {} : { limit }), ...(params.cursor === undefined ? {} : { cursor: inputReadString(params.cursor, 'cursor') }) } }
  }
  if (query.method === 'workspace.get') {
    const params = inputReadObject(query.params, ['workspaceId'], 'params')
    return { method: query.method, params: { workspaceId: inputReadId(params.workspaceId, 'workspaceId') } }
  }
  if (query.method === 'agent.list') {
    const params = inputReadObject(query.params, ['scope', 'kind'], 'params')
    return { method: query.method, params: { scope: controlReadScope(params.scope), ...(params.kind === undefined ? {} : { kind: controlReadKind(params.kind) }) } }
  }
  throw new GraphError(400, 'UNKNOWN_METHOD', 'Unknown Control query')
}

export function controlReadCommand(value: unknown): ControlCommand {
  const command = inputReadObject(value, ['requestId', 'method', 'params'], 'command')
  const requestId = inputReadId(command.requestId, 'requestId')
  const method = command.method
  if (method === 'workspace.create') {
    const p = inputReadObject(command.params, ['id', 'name', 'description', 'agentSource'], 'params')
    if (p.agentSource !== 'empty' && p.agentSource !== 'library') throw new GraphError(400, 'INVALID_ARGUMENT', 'Invalid agentSource')
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
      if (p.role !== null && !['owner', 'editor', 'viewer'].includes(p.role as string)) throw new GraphError(400, 'INVALID_ARGUMENT', 'Invalid member role')
      return { requestId, method, params: { ...base, userId: inputReadId(p.userId, 'userId'), role: p.role as Role | null } }
    }
    if (method === 'agent.copy') {
      if (p.mode !== 'merge' && p.mode !== 'replace') throw new GraphError(400, 'INVALID_ARGUMENT', 'Invalid copy mode')
      return { requestId, method, params: { ...base, libraryRevision: inputReadRevision(p.libraryRevision, 'libraryRevision'), agentIds: controlReadNames(p.agentIds, 'agentIds'), mode: p.mode } }
    }
    const openMapIds = controlReadNames(p.openMapIds, 'openMapIds').map(id => inputReadId(id, 'openMapIds'))
    const rawSelection = p.nodeSelection
    if (!rawSelection || typeof rawSelection !== 'object' || Array.isArray(rawSelection)) throw new GraphError(400, 'INVALID_ARGUMENT', 'nodeSelection must be an object')
    const nodeSelection = Object.fromEntries(Object.entries(rawSelection).map(([id, node]) => [inputReadId(id, 'nodeSelection map'), node === null ? null : inputReadId(node, 'nodeSelection node')]))
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
  if (method === 'settings.update') {
    const p = inputReadObject(command.params, ['expectedRevision', 'llm', 'tools', 'limits'], 'params')
    const llm = inputReadObject(p.llm, ['provider', 'model'], 'llm')
    const limits = inputReadObject(p.limits, ['maxAgentSlots'], 'limits')
    const maxAgentSlots = inputReadRevision(limits.maxAgentSlots, 'maxAgentSlots')
    if (maxAgentSlots < 1 || maxAgentSlots > 32) throw new GraphError(400, 'INVALID_ARGUMENT', 'maxAgentSlots must be between 1 and 32')
    const tools = inputReadArray(p.tools, 'tools').map(value => {
      const tool = inputReadObject(value, ['name', 'description'], 'tool')
      const name = controlReadName(tool.name, 'tool.name')
      if (reservedTools.has(name) || name.startsWith('cordis_')) throw new GraphError(400, 'INVALID_ARGUMENT', 'Reserved tool name')
      return { name, description: inputReadString(tool.description, 'tool.description') }
    })
    controlReadNames(tools.map(tool => tool.name), 'tools')
    return { requestId, method, params: { expectedRevision: inputReadRevision(p.expectedRevision, 'expectedRevision'), llm: { provider: inputReadString(llm.provider, 'provider').trim(), model: inputReadString(llm.model, 'model').trim() }, tools, limits: { maxAgentSlots } } }
  }
  throw new GraphError(400, 'UNKNOWN_METHOD', 'Unknown Control command')
}
