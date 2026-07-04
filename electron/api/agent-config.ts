import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AppError, ErrorCode } from '../shared/errors'
import type { GraphConfig, AgentRuntimeConfig } from '../shared/types'
import { resolveTools } from '../tools'
import {
  getSubAgentCatalog,
  type CatalogSubAgentEntry,
} from './sub-agent-catalog'

function toSubAgentConfig(entry: CatalogSubAgentEntry): AgentRuntimeConfig {
  return {
    name: entry.agentName,
    promptPath: entry.promptPath,
    tools: resolveTools(entry.tools),
  }
}

/** 创建默认 ChatModel — DeepSeek OpenAI 兼容接口 */
export function createDefaultModel(): BaseChatModel {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new AppError(
      ErrorCode.CONFIG_API_KEY_MISSING,
      'DEEPSEEK_API_KEY 未设置，请在项目根目录 .env 中配置',
    )
  }

  return new ChatOpenAI({
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    apiKey,
    temperature: 0,
    timeout: 60_000,
    maxRetries: 1,
    configuration: {
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    },
  })
}

export function getSplitSubAgents(): AgentRuntimeConfig[] {
  return getSubAgentCatalog('split').map(toSubAgentConfig)
}

export function getVerifySubAgents(): AgentRuntimeConfig[] {
  return getSubAgentCatalog('verify').map(toSubAgentConfig)
}

export function getSplitGraphConfig(): Omit<GraphConfig, 'mode'> {
  return {
    defaultModel: createDefaultModel(),
    availableAgents: getSplitSubAgents(),
    routePromptPath: 'fact-extractor/main-agent-route',
    mergePromptPath: 'fact-extractor/main-agent-merge',
    maxConcurrency: 3,
  }
}

export function getVerifyGraphConfig(): GraphConfig {
  return {
    defaultModel: createDefaultModel(),
    availableAgents: getVerifySubAgents(),
    routePromptPath: 'fact-verifier/main-agent-route',
    mergePromptPath: 'fact-verifier/main-agent-merge',
    maxConcurrency: 3,
  }
}
