import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { SubAgentConfig } from '../shared/types'
import type { SplitGraphConfig } from '../fact-extractor/types'
import type { VerifyGraphConfig } from '../fact-verifier/types'
import {
  SPLIT_SUB_AGENT_CATALOG,
  VERIFY_SUB_AGENT_CATALOG,
} from './sub-agent-catalog'

function toSubAgentConfig(entry: { name: string; promptPath: string }): SubAgentConfig {
  return { name: entry.name, promptPath: entry.promptPath }
}

/** 创建默认 ChatModel — DeepSeek OpenAI 兼容接口 */
export function createDefaultModel(): BaseChatModel {
  const apiKey = process.env.DEEPSEEK_API_KEY
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY 未设置，请在项目根目录 .env 中配置')
  }

  return new ChatOpenAI({
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-v4-flash',
    apiKey,
    temperature: 0,
    configuration: {
      baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    },
  })
}

export const SPLIT_SUB_AGENTS: SubAgentConfig[] = SPLIT_SUB_AGENT_CATALOG.map(toSubAgentConfig)

export const VERIFY_SUB_AGENTS: SubAgentConfig[] = VERIFY_SUB_AGENT_CATALOG.map(toSubAgentConfig)

export function getSplitGraphConfig(): Omit<SplitGraphConfig, 'mode'> {
  return {
    defaultModel: createDefaultModel(),
    availableAgents: SPLIT_SUB_AGENTS,
    routePromptPath: 'fact-extractor/main-agent-route',
    mergePromptPath: 'fact-extractor/main-agent-merge',
    maxConcurrency: 3,
  }
}

export function getVerifyGraphConfig(): VerifyGraphConfig {
  return {
    defaultModel: createDefaultModel(),
    availableAgents: VERIFY_SUB_AGENTS,
    routePromptPath: 'fact-verifier/main-agent-route',
    mergePromptPath: 'fact-verifier/main-agent-merge',
    maxConcurrency: 3,
  }
}
