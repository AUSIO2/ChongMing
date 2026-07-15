import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { AgentDoc, AgentRuntimeConfig, GraphConfig } from '../shared/types'
import { llmCreateChatModel } from '../shared/llm-model'
import { promptUpdateOverlay } from '../shared/prompt-loader'
import { toolRead } from '../tools'
import {
  catalogRead,
  type CatalogSubAgentEntry,
} from './sub-agent-catalog'
import { workspaceReadForMap } from './workspace-service'

function agentCreateModel(overrides?: { model?: string, baseUrl?: string }): BaseChatModel {
  return llmCreateChatModel(overrides)
}

function toSubAgentConfig(entry: CatalogSubAgentEntry): AgentRuntimeConfig {
  const config: AgentRuntimeConfig = {
    name: entry.agentName,
    promptPath: entry.promptPath,
    tools: toolRead(entry.tools),
  }
  if (entry.model?.trim() || entry.baseUrl?.trim()) {
    config.model = agentCreateModel({
      model: entry.model,
      baseUrl: entry.baseUrl,
    })
  }
  return config
}

function agentDocToRuntime(agent: AgentDoc): AgentRuntimeConfig | null {
  if (!agent.agentName?.trim()) return null
  const config: AgentRuntimeConfig = {
    name: agent.agentName,
    promptPath: agent.promptPath,
    tools: toolRead(agent.tools),
  }
  if (agent.model?.trim() || agent.baseUrl?.trim()) {
    config.model = agentCreateModel({
      model: agent.model,
      baseUrl: agent.baseUrl,
    })
  }
  return config
}

export function agentReadSplitAgentsFromDocs(agents: AgentDoc[]): AgentRuntimeConfig[] {
  return agents
    .filter(a => a.agentType === 'split')
    .map(agentDocToRuntime)
    .filter((a): a is AgentRuntimeConfig => a !== null)
}

export function agentReadVerifyAgentsFromDocs(agents: AgentDoc[]): AgentRuntimeConfig[] {
  return agents
    .filter(a => a.agentType === 'verify')
    .map(agentDocToRuntime)
    .filter((a): a is AgentRuntimeConfig => a !== null)
}

export function agentReadSplitConfigFromDocs(agents: AgentDoc[]): Omit<GraphConfig, 'mode'> {
  return {
    defaultModel: agentCreateModel(),
    availableAgents: agentReadSplitAgentsFromDocs(agents),
    routePromptPath: 'fact-extractor/main-agent-route',
    mergePromptPath: 'fact-extractor/main-agent-merge',
    maxConcurrency: 3,
  }
}

export function agentReadVerifyConfigFromDocs(agents: AgentDoc[]): GraphConfig {
  return {
    defaultModel: agentCreateModel(),
    availableAgents: agentReadVerifyAgentsFromDocs(agents),
    routePromptPath: 'fact-verifier/main-agent-route',
    mergePromptPath: 'fact-verifier/main-agent-merge',
    maxConcurrency: 3,
  }
}

/** 激活工作区 Agent：写入 prompt overlay，并返回该工作区文档列表 */
export function agentActivateWorkspace(agents: AgentDoc[]): void {
  promptUpdateOverlay(agents)
}

/** 磁盘后备（测试 / 无工作区时） */
export function agentReadSplitAgents(): AgentRuntimeConfig[] {
  return catalogRead('split').map(toSubAgentConfig)
}

export function agentReadVerifyAgents(): AgentRuntimeConfig[] {
  return catalogRead('verify').map(toSubAgentConfig)
}

export function agentReadSplitConfig(): Omit<GraphConfig, 'mode'> {
  return {
    defaultModel: agentCreateModel(),
    availableAgents: agentReadSplitAgents(),
    routePromptPath: 'fact-extractor/main-agent-route',
    mergePromptPath: 'fact-extractor/main-agent-merge',
    maxConcurrency: 3,
  }
}

export function agentReadVerifyConfig(): GraphConfig {
  return {
    defaultModel: agentCreateModel(),
    availableAgents: agentReadVerifyAgents(),
    routePromptPath: 'fact-verifier/main-agent-route',
    mergePromptPath: 'fact-verifier/main-agent-merge',
    maxConcurrency: 3,
  }
}

/** 按 Map 所属工作区加载 Agent 并激活 overlay */
export async function agentActivateForMap(mapId: string): Promise<AgentDoc[]> {
  const ws = await workspaceReadForMap(mapId)
  agentActivateWorkspace(ws.agents)
  return ws.agents
}

export { agentReadMaxSubAgent, AGENT_DEFAULT_MAX_SUB_AGENT } from '../shared/agent-limits'

export function agentReadParseConfig(): import('../fact-parser/types').ParseGraphConfig {
  return {
    defaultModel: agentCreateModel(),
    extractPromptPath: 'fact-parser/extract',
  }
}

export { agentCreateModel }
