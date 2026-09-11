import type { GraphAgentProfile, GraphRouteSlot, GraphRunConfiguration } from '../contracts/graph'
import { GraphError } from './graph-error'
import { inputReadArray, inputReadNames, inputReadObject, inputReadRevision, inputReadString } from './input'
import defaults from './prompts/verify/configuration.json'
import router from './prompts/verify/router.json'
import merger from './prompts/verify/merger.json'
import sources from './prompts/verify/agents/sources.json'
import logic from './prompts/verify/agents/logic.json'
import numbers from './prompts/verify/agents/numbers.json'

export const DEFAULT_VERIFY_CONFIGURATION: GraphRunConfiguration = {
  ...defaults, router, merger, agents: [sources, logic, numbers],
}

const reserved = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'run_code', 'cordis_define', 'cordis_run'])

function configurationReadName(value: unknown): string {
  const name = inputReadString(value, 'name')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new GraphError(400, 'INVALID_CONFIGURATION', `Invalid name: ${name}`)
  return name
}

function configurationValidateIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new GraphError(400, 'INVALID_CONFIGURATION', `Duplicate ${label}`)
}

function configurationReadProfile(value: unknown): GraphAgentProfile {
  const item = inputReadObject(value, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model', 'promptVars', 'defaultPriority', 'claimCategory'], 'profile')
  const tools = inputReadNames(item.tools, 'profile.tools')
  configurationValidateIds(tools, 'profile tool')
  const promptVars = item.promptVars === undefined ? undefined : inputReadNames(item.promptVars, 'profile.promptVars')
  if (item.defaultPriority !== undefined && !['high', 'medium', 'low'].includes(String(item.defaultPriority))) throw new GraphError(400, 'INVALID_CONFIGURATION', 'Invalid defaultPriority')
  if (item.claimCategory !== undefined && item.claimCategory !== null && !['data', 'quote', 'causal'].includes(String(item.claimCategory))) throw new GraphError(400, 'INVALID_CONFIGURATION', 'Invalid claimCategory')
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

export function configurationRead(value: unknown): GraphRunConfiguration {
  const item = inputReadObject(value, ['router', 'merger', 'agents', 'tools', 'maxSlots'], 'configuration')
  const tools = inputReadArray(item.tools, 'configuration.tools').map(value => {
    const tool = inputReadObject(value, ['name', 'description'], 'tool')
    const name = configurationReadName(tool.name)
    if (reserved.has(name) || name.startsWith('cordis_')) {
      throw new GraphError(400, 'INVALID_CONFIGURATION', `Tool is reserved: ${name}`)
    }
    return { name, description: inputReadString(tool.description, 'tool.description') }
  })
  configurationValidateIds(tools.map(tool => tool.name), 'tool')
  const router = configurationReadProfile(item.router)
  const merger = configurationReadProfile(item.merger)
  const agents = inputReadArray(item.agents, 'configuration.agents').map(configurationReadProfile)
  const maxSlots = inputReadRevision(item.maxSlots, 'configuration.maxSlots')
  if (!agents.length || agents.length > 64 || maxSlots < 1 || maxSlots > 32) throw new GraphError(400, 'INVALID_CONFIGURATION', 'Provide 1–64 agents and maxSlots between 1 and 32')
  configurationValidateIds([router, merger, ...agents].map(agent => agent.id), 'agent id')
  for (const agent of [router, merger, ...agents]) {
    for (const name of agent.tools) {
      if (!tools.some(tool => tool.name === name)) throw new GraphError(400, 'INVALID_CONFIGURATION', `Unknown tool ${name} for ${agent.id}`)
    }
  }
  return { router, merger, agents, tools, maxSlots }
}

export function configurationReadSlots(value: unknown): GraphRouteSlot[] {
  return inputReadArray(value, 'route.slots').map(value => {
    const slot = inputReadObject(value, ['id', 'agentId', 'angle', 'priority', 'hint', 'tools'], 'slot')
    if (slot.priority !== 'high' && slot.priority !== 'medium' && slot.priority !== 'low') throw new GraphError(400, 'INVALID_ROUTE', 'Invalid slot priority')
    if (typeof slot.hint !== 'string') throw new GraphError(400, 'INVALID_ROUTE', 'slot.hint must be a string')
    return {
      id: configurationReadName(slot.id), agentId: configurationReadName(slot.agentId),
      angle: inputReadString(slot.angle, 'slot.angle'), priority: slot.priority,
      hint: slot.hint, tools: inputReadNames(slot.tools, 'slot.tools'),
    }
  })
}
