import { ChatOpenAI } from '@langchain/openai'
import { AppError, ErrorCode } from '../shared/errors'
import {
  appReadLlmResolved,
  appReadSettingsDto,
  appWriteSettings,
  type AppLlmSettings,
  type AppSkillSettings,
  type AppSettingsDto,
} from '../shared/app-settings'

export function appGetSettings(): AppSettingsDto {
  return appReadSettingsDto()
}

export function appSaveSettings(input: {
  llm?: AppLlmSettings
  skills?: AppSkillSettings
}): void {
  appWriteSettings(input)
}

export async function appTestLlm(): Promise<{ ok: boolean, error?: string }> {
  const resolved = appReadLlmResolved()
  if (!resolved.apiKey) {
    return { ok: false, error: '未配置 DeepSeek API Key' }
  }
  try {
    const model = new ChatOpenAI({
      model: resolved.model,
      apiKey: resolved.apiKey,
      temperature: 0,
      timeout: 30_000,
      maxRetries: 0,
      configuration: { baseURL: resolved.baseUrl },
    })
    const response = await model.invoke('ping')
    const text = typeof response.content === 'string'
      ? response.content
      : JSON.stringify(response.content)
    if (!text) return { ok: false, error: '模型返回为空' }
    return { ok: true }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}

export function appRequireLlmKey(): string {
  const { apiKey } = appReadLlmResolved()
  if (!apiKey) {
    throw new AppError(
      ErrorCode.CONFIG_API_KEY_MISSING,
      'DeepSeek API Key 未设置，请在智能体设置或 .env 中配置',
    )
  }
  return apiKey
}
