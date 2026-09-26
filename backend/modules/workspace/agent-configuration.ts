import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphAgentProfile, GraphRouteSlot, GraphRunConfiguration } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { inputReadArray, inputReadNames, inputReadObject, inputReadRevision, inputReadString } from '../shared/input-validation'
export type GraphSeedConfiguration = GraphRunConfiguration & {
  parse: GraphAgentProfile
  split: NonNullable<GraphRunConfiguration['split']>
}

const reserved = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'run_code', 'cordis_define', 'cordis_run'])

// 用途：读取名称，并把结构化结果交给调用方。
function configurationReadName(value: unknown): string {
  const name = inputReadString(value, 'name')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.INVALID_NAME_VALUE, name))
  return name
}

// 用途：校验标识输入，发现不符合约束时立即报错。
function configurationValidateIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.DUPLICATE_VALUE, label))
}

// 用途：读取配置，并把结构化结果交给调用方。
function configurationReadProfile(value: unknown): GraphAgentProfile {
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

// 用途：读取配置，并把结构化结果交给调用方。
export function configurationRead(value: unknown): GraphRunConfiguration {
  const item = inputReadObject(value, ['parse', 'split', 'router', 'merger', 'agents', 'tools', 'maxSlots'], 'configuration')
  const tools = inputReadArray(item.tools, 'configuration.tools').map(value => {
    const tool = inputReadObject(value, ['name', 'description'], 'tool')
    const name = configurationReadName(tool.name)
    if (reserved.has(name) || name.startsWith('cordis_')) {
      throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.TOOL_IS_RESERVED_VALUE, name))
    }
    return { name, description: inputReadString(tool.description, 'tool.description') }
  })
  configurationValidateIds(tools.map(tool => tool.name), 'tool')
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
  configurationValidateIds(profiles.map(agent => agent.id), 'agent id')
  for (const agent of profiles) {
    for (const name of agent.tools) {
      if (!tools.some(tool => tool.name === name)) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.UNKNOWN_TOOL_VALUE_FOR_VALUE, name, agent.id))
    }
  }
  return { router, merger, agents, tools, maxSlots, ...(parse ? { parse } : {}), ...(split ? { split } : {}) }
}

// 用途：读取配置，并把结构化结果交给调用方。
export function configurationReadSeed(value: unknown): GraphSeedConfiguration {
  const configuration = configurationRead(value)
  if (!configuration.parse || !configuration.split) {
    throw new GraphError(500, 'DEFAULT_CONFIGURATION_INVALID', RuntimeMessage.DEFAULT_CONFIGURATION_REQUIRES_PARSE_AND_SPLIT)
  }
  return { ...configuration, parse: configuration.parse, split: configuration.split }
}

// 用途：读取槽位，并把结构化结果交给调用方。
export function configurationReadSlots(value: unknown): GraphRouteSlot[] {
  return inputReadArray(value, 'route.slots').map(value => {
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
