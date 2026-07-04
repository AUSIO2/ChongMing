import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { StructuredToolInterface } from '@langchain/core/tools'
import { AppError, ErrorCode } from '../shared/errors'
import type { GraphConfig, AgentRuntimeConfig } from '../shared/types'
import { webSearchTool } from '../tools'
import {
  SPLIT_SUB_AGENT_CATALOG,
  VERIFY_SUB_AGENT_CATALOG,
  type CatalogSubAgentEntry,
} from './sub-agent-catalog'

/** 需要外网检索的 SubAgent（按 agentName） */
const AGENT_TOOLS: Partial<Record<string, StructuredToolInterface[]>> = {
  来源可信度: [webSearchTool],
  数据可验证性: [webSearchTool],
}

function toSubAgentConfig(entry: CatalogSubAgentEntry): AgentRuntimeConfig {
  return {
    name: entry.agentName,
    promptPath: entry.promptPath,
    tools: AGENT_TOOLS[entry.agentName],
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

export const SPLIT_SUB_AGENTS: AgentRuntimeConfig[] = SPLIT_SUB_AGENT_CATALOG.map(toSubAgentConfig)

export const VERIFY_SUB_AGENTS: AgentRuntimeConfig[] = VERIFY_SUB_AGENT_CATALOG.map(toSubAgentConfig)

export function getSplitGraphConfig(): Omit<GraphConfig, 'mode'> {
  return {
    defaultModel: createDefaultModel(),
    availableAgents: SPLIT_SUB_AGENTS,
    routePromptPath: 'fact-extractor/main-agent-route',
    mergePromptPath: 'fact-extractor/main-agent-merge',
    maxConcurrency: 3,
  }
}

export function getVerifyGraphConfig(): GraphConfig {
  return {
    defaultModel: createDefaultModel(),
    availableAgents: VERIFY_SUB_AGENTS,
    routePromptPath: 'fact-verifier/main-agent-route',
    mergePromptPath: 'fact-verifier/main-agent-merge',
    maxConcurrency: 3,
  }
}
