import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { GraphConfig, AgentRuntimeConfig } from '../shared/types'
import { llmCreateChatModel } from '../shared/llm-model'
import { toolRead } from '../tools'
import {
  catalogRead,
  type CatalogSubAgentEntry,
} from './sub-agent-catalog'

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

export { agentReadMaxSubAgent, AGENT_DEFAULT_MAX_SUB_AGENT } from '../shared/agent-limits'

export function agentReadParseConfig(): import('../fact-parser/types').ParseGraphConfig {
  return {
    defaultModel: agentCreateModel(),
    extractPromptPath: 'fact-parser/extract',
  }
}

export { agentCreateModel }
