// 验证执行期 Agent、工具和路由配置，禁止调用宿主保留能力。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphAgentProfile, GraphRouteSlot, GraphRunConfiguration } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { inputReadArray, inputReadNames, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'
export type GraphSeedConfiguration = GraphRunConfiguration & {
  parse: GraphAgentProfile
  split: NonNullable<GraphRunConfiguration['split']>
}

const reserved = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'run_code', 'cordis_define', 'cordis_run'])

function configurationReadName(/* 尚未验证字符范围和长度的运行时名称。 */ value: unknown): string {
  // 限制运行时标识的字符集和长度，使 Agent 与工具名可安全作为配置键使用。
  const name = inputReadString(value, 'name')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.INVALID_NAME_VALUE, name))
  return name
}

function configurationValidateIds(/* 需要保证互不重复的一组工具或 Agent 标识。 */ ids: string[], /* 用于重复值错误信息的配置对象名称。 */ label: string): void {
  // 拒绝工具或 Agent 集合中的重复身份，避免运行时引用含混。
  if (new Set(ids).size !== ids.length) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.DUPLICATE_VALUE, label))
}

function configurationReadProfile(/* 尚未解析为执行期 Agent 配置的输入。 */ value: unknown): GraphAgentProfile {
  // 逐字段解析执行期 Agent 配置，验证工具唯一性和可选优先级、类别。
  const item = inputReadObject(value, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model', 'promptVars', 'defaultPriority', 'claimCategory'], 'profile')
  const tools = inputReadNames(item.tools, 'profile.tools')
  configurationValidateIds(tools, 'profile tool')
  const promptVars = item.promptVars === undefined ? undefined : inputReadNames(item.promptVars, 'profile.promptVars')
  if (item.defaultPriority !== undefined && !['high', 'medium', 'low'].includes(String(item.defaultPriority))) throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.INVALID_DEFAULTPRIORITY)
  if (item.claimCategory !== undefined && item.claimCategory !== null && !['data', 'quote', 'causal'].includes(String(item.claimCategory))) throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.INVALID_CLAIMCATEGORY)
  return {
    id: configurationReadName(item.id), name: inputReadString(item.name, 'profile.name'),
    description: inputReadString(item.description, 'profile.description'),
    content: inputReadString(item.content, 'profile.content'), tools,
    provider: inputReadString(item.provider, 'profile.provider'), model: inputReadString(item.model, 'profile.model'),
    ...(promptVars === undefined ? {} : { promptVars }),
    ...(item.defaultPriority === undefined ? {} : { defaultPriority: item.defaultPriority as GraphAgentProfile['defaultPriority'] }),
    ...(item.claimCategory === undefined ? {} : { claimCategory: item.claimCategory as GraphAgentProfile['claimCategory'] }),
  }
}

export function configurationRead(/* 尚未解析为完整运行配置的输入。 */ value: unknown): GraphRunConfiguration {
  // 验证工具注册、Agent 组和槽位限制，并保证所有 Agent 工具引用均已声明。
  const item = inputReadObject(value, ['parse', 'split', 'router', 'merger', 'agents', 'tools', 'maxSlots'], 'configuration')
  const tools = inputReadArray(item.tools, 'configuration.tools').map(/* 工具目录中当前尚未校验的工具定义。 */ value => {
    // 解析单项工具定义，并拒绝运行时保留名称及 cordis 前缀。
    const tool = inputReadObject(value, ['name', 'description'], 'tool')
    const name = configurationReadName(tool.name)
    if (reserved.has(name) || name.startsWith('cordis_')) {
      throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.TOOL_IS_RESERVED_VALUE, name))
    }
    return { name, description: inputReadString(tool.description, 'tool.description') }
  })
  configurationValidateIds(tools.map(/* 已解析工具目录中当前用于查重的工具。 */ tool => /* 提取工具名称以检查注册表是否存在重名。 */ tool.name), 'tool')
  const router = configurationReadProfile(item.router)
  const merger = configurationReadProfile(item.merger)
  const agents = inputReadArray(item.agents, 'configuration.agents').map(configurationReadProfile)
  const parse = item.parse === undefined ? undefined : configurationReadProfile(item.parse)
  let split: GraphRunConfiguration['split']
  if (item.split !== undefined) {
    const group = inputReadObject(item.split, ['router', 'merger', 'agents'], 'configuration.split')
    split = { router: configurationReadProfile(group.router), merger: configurationReadProfile(group.merger),
      agents: inputReadArray(group.agents, 'configuration.split.agents').map(configurationReadProfile) }
    if (!split.agents.length || split.agents.length > 64) throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.PROVIDE_1_64_SPLIT_AGENTS)
  }
  const maxSlots = inputReadRevision(item.maxSlots, 'configuration.maxSlots')
  if (!agents.length || agents.length > 64 || maxSlots < 1 || maxSlots > 32) throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.PROVIDE_1_64_AGENTS_AND_MAXSLOTS_BETWEEN_1_AND_32)
  const profiles = [router, merger, ...agents, ...(parse ? [parse] : []), ...(split ? [split.router, split.merger, ...split.agents] : [])]
  configurationValidateIds(profiles.map(/* 跨解析、拆分和核查阶段当前用于查重的 Agent。 */ agent => /* 收集所有阶段的 Agent 标识，检查跨阶段的身份冲突。 */ agent.id), 'agent id')
  for (const agent of profiles) {
    for (const name of agent.tools) {
      if (!tools.some(/* 正在与某个 Agent 工具引用匹配的已注册工具。 */ tool => /* 确认 Agent 引用的工具存在于本次执行配置。 */ tool.name === name)) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.UNKNOWN_TOOL_VALUE_FOR_VALUE, name, agent.id))
    }
  }
  return { router, merger, agents, tools, maxSlots, ...(parse ? { parse } : {}), ...(split ? { split } : {}) }
}

export function configurationReadSeed(/* 来自部署默认配置、尚未确认完整阶段能力的输入。 */ value: unknown): GraphSeedConfiguration {
  // 在通用配置校验后要求默认配置同时具备解析与拆分能力。
  const configuration = configurationRead(value)
  if (!configuration.parse || !configuration.split) {
    throw new GraphError(500, 'DEFAULT_CONFIGURATION_INVALID', RuntimeMessage.DEFAULT_CONFIGURATION_REQUIRES_PARSE_AND_SPLIT)
  }
  return { ...configuration, parse: configuration.parse, split: configuration.split }
}

export function configurationReadSlots(/* 来自路由提案、尚未解析的槽位数组。 */ value: unknown): GraphRouteSlot[] {
  // 按输入顺序解析路由槽位，供后续校验槽位归属和可用工具。
  return inputReadArray(value, 'route.slots').map(/* 路由数组中当前尚未验证的槽位定义。 */ value => {
    // 验证槽位身份、Agent、角度、优先级、提示及工具列表，返回收窄后的路由项。
    const slot = inputReadObject(value, ['id', 'agentId', 'angle', 'priority', 'hint', 'tools'], 'slot')
    if (slot.priority !== 'high' && slot.priority !== 'medium' && slot.priority !== 'low') throw new GraphError(400, 'INVALID_ROUTE', RuntimeMessage.INVALID_SLOT_PRIORITY)
    if (typeof slot.hint !== 'string') throw new GraphError(400, 'INVALID_ROUTE', RuntimeMessage.SLOT_HINT_MUST_BE_A_STRING)
    return {
      id: configurationReadName(slot.id), agentId: configurationReadName(slot.agentId),
      angle: inputReadString(slot.angle, 'slot.angle'), priority: slot.priority,
      hint: slot.hint, tools: inputReadNames(slot.tools, 'slot.tools'),
    }
  })
}
