import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import type { SubAgentConfig } from '../shared/types'
import type { SplitGraphConfig } from '../fact-extractor/types'
import type { VerifyGraphConfig } from '../fact-verifier/types'

/** 创建默认 ChatModel（从环境变量读取配置） */
export function createDefaultModel(): BaseChatModel {
  return new ChatOpenAI({
    model: process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    apiKey: process.env.OPENAI_API_KEY,
    temperature: 0,
  })
}

export const SPLIT_SUB_AGENTS: SubAgentConfig[] = [
  {
    name: '数据事实',
    promptPath: 'fact-extractor/sub-agents/data-claims',
  },
  {
    name: '引用观点',
    promptPath: 'fact-extractor/sub-agents/quote-claims',
  },
  {
    name: '因果关系',
    promptPath: 'fact-extractor/sub-agents/causal-claims',
  },
]

export const VERIFY_SUB_AGENTS: SubAgentConfig[] = [
  {
    name: '来源可信度',
    promptPath: 'fact-verifier/sub-agents/source-credibility',
  },
  {
    name: '逻辑一致性',
    promptPath: 'fact-verifier/sub-agents/logic-consistency',
  },
  {
    name: '数据可验证性',
    promptPath: 'fact-verifier/sub-agents/data-verifiability',
  },
]

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
