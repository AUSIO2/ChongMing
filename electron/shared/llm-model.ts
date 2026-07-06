import { ChatOpenAI } from '@langchain/openai'
import type { BaseChatModel } from '@langchain/core/language_models/chat_models'
import { AppError, ErrorCode } from './errors'
import { appReadLlmResolved } from './app-settings'
import type { PromptConfig } from './types'

export function llmCreateChatModel(overrides?: {
  model?: string
  baseUrl?: string
}): BaseChatModel {
  const resolved = appReadLlmResolved(overrides?.model, overrides?.baseUrl)
  if (!resolved.apiKey) {
    throw new AppError(
      ErrorCode.CONFIG_API_KEY_MISSING,
      'DeepSeek API Key 未设置，请在智能体设置或 .env 中配置',
    )
  }

  return new ChatOpenAI({
    model: resolved.model,
    apiKey: resolved.apiKey,
    temperature: 0,
    timeout: 60_000,
    maxRetries: 1,
    configuration: {
      baseURL: resolved.baseUrl,
    },
  })
}

export function llmResolvePromptModel(
  config: Pick<PromptConfig, 'model' | 'baseUrl'>,
  defaultModel: BaseChatModel,
): BaseChatModel {
  if (!config.model?.trim() && !config.baseUrl?.trim()) return defaultModel
  return llmCreateChatModel({ model: config.model, baseUrl: config.baseUrl })
}
