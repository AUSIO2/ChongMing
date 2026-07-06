import { ChatOpenAI } from '@langchain/openai'
import { connect } from 'node:net'
import { app } from 'electron'
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

export interface AppEndpointPing {
  ok: boolean
  latencyMs: number
  host: string
  baseUrl: string
  error?: string
}

function appReadPingTarget(baseUrl: string): {
  host: string
  port: number
  baseUrl: string
} {
  const parsed = new URL(baseUrl)
  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === 'https:' ? 443 : 80
  return { host: parsed.hostname, port, baseUrl }
}

function appTcpPing(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const socket = connect({ host, port, timeout: timeoutMs }, () => {
      const latencyMs = Date.now() - start
      socket.destroy()
      resolve(latencyMs)
    })
    socket.on('error', reject)
    socket.on('timeout', () => {
      socket.destroy()
      reject(new Error('连接超时'))
    })
  })
}

export function appGetVersion(): string {
  return app.getVersion()
}

export async function appPingEndpoint(): Promise<AppEndpointPing> {
  const { baseUrl } = appReadLlmResolved()
  let target: ReturnType<typeof appReadPingTarget>
  try {
    target = appReadPingTarget(baseUrl)
  } catch {
    return {
      ok: false,
      latencyMs: 0,
      host: baseUrl,
      baseUrl,
      error: '无效的 baseUrl',
    }
  }

  try {
    const latencyMs = await appTcpPing(target.host, target.port, 5_000)
    return {
      ok: true,
      latencyMs,
      host: target.host,
      baseUrl: target.baseUrl,
    }
  } catch (e) {
    return {
      ok: false,
      latencyMs: 0,
      host: target.host,
      baseUrl: target.baseUrl,
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
