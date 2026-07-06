import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export interface AppLlmSettings {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface AppSkillSettings {
  tavilyApiKey?: string
}

export interface AppSettingsFile {
  llm?: AppLlmSettings
  skills?: AppSkillSettings
}

export interface AppLlmResolved {
  apiKey: string
  baseUrl: string
  model: string
}

export interface AppSettingsDto {
  llm: AppLlmSettings
  skills: AppSkillSettings
  defaults: {
    baseUrl: string
    model: string
  }
  configured: {
    llmApiKey: boolean
    tavilyApiKey: boolean
  }
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_MODEL = 'deepseek-v4-flash'

function appReadSettingsPath(): string {
  const dir = path.join(app.getPath('userData'), 'settings')
  mkdirSync(dir, { recursive: true })
  return path.join(dir, 'app-settings.json')
}

function appReadFile(): AppSettingsFile {
  try {
    return JSON.parse(readFileSync(appReadSettingsPath(), 'utf-8')) as AppSettingsFile
  } catch {
    return {}
  }
}

export function appReadLlmResolved(
  overrideModel?: string,
  overrideBaseUrl?: string,
): AppLlmResolved {
  const file = appReadFile()
  const apiKey = file.llm?.apiKey?.trim()
    || process.env.DEEPSEEK_API_KEY?.trim()
    || ''
  const baseUrl = overrideBaseUrl?.trim()
    || file.llm?.baseUrl?.trim()
    || process.env.DEEPSEEK_BASE_URL?.trim()
    || DEFAULT_BASE_URL
  const model = overrideModel?.trim()
    || file.llm?.model?.trim()
    || process.env.DEEPSEEK_MODEL?.trim()
    || DEFAULT_MODEL
  return { apiKey, baseUrl, model }
}

export function appReadTavilyKey(): string {
  const file = appReadFile()
  return file.skills?.tavilyApiKey?.trim()
    || process.env.TAVILY_API_KEY?.trim()
    || ''
}

export function appReadSettingsDto(): AppSettingsDto {
  const file = appReadFile()
  const llm: AppLlmSettings = {
    apiKey: file.llm?.apiKey ?? '',
    baseUrl: file.llm?.baseUrl ?? '',
    model: file.llm?.model ?? '',
  }
  const skills: AppSkillSettings = {
    tavilyApiKey: file.skills?.tavilyApiKey ?? '',
  }
  return {
    llm,
    skills,
    defaults: {
      baseUrl: process.env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL,
      model: process.env.DEEPSEEK_MODEL?.trim() || DEFAULT_MODEL,
    },
    configured: {
      llmApiKey: !!(llm.apiKey?.trim() || process.env.DEEPSEEK_API_KEY?.trim()),
      tavilyApiKey: !!(skills.tavilyApiKey?.trim() || process.env.TAVILY_API_KEY?.trim()),
    },
  }
}

export function appWriteSettings(patch: {
  llm?: AppLlmSettings
  skills?: AppSkillSettings
}): void {
  const current = appReadFile()
  const next: AppSettingsFile = {
    llm: {
      ...current.llm,
      ...patch.llm,
    },
    skills: {
      ...current.skills,
      ...patch.skills,
    },
  }
  writeFileSync(appReadSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
}
