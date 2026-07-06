import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpDir = path.join(os.tmpdir(), `chongming-app-settings-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}))

describe('app-settings', () => {
  beforeEach(() => {
    mkdirSync(path.join(tmpDir, 'settings'), { recursive: true })
    delete process.env.DEEPSEEK_API_KEY
    delete process.env.DEEPSEEK_BASE_URL
    delete process.env.DEEPSEEK_MODEL
    delete process.env.TAVILY_API_KEY
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('appReadLlmResolved 优先 userData 再 env', async () => {
    const { appWriteSettings, appReadLlmResolved } = await import('../../electron/shared/app-settings')
    appWriteSettings({
      llm: { apiKey: 'user-key', model: 'user-model' },
    })
    process.env.DEEPSEEK_API_KEY = 'env-key'
    process.env.DEEPSEEK_MODEL = 'env-model'
    const resolved = appReadLlmResolved()
    expect(resolved.apiKey).toBe('user-key')
    expect(resolved.model).toBe('user-model')
  })

  it('appReadLlmResolved overrideModel 覆盖全局 model', async () => {
    const { appWriteSettings, appReadLlmResolved } = await import('../../electron/shared/app-settings')
    appWriteSettings({ llm: { apiKey: 'k', model: 'global' } })
    expect(appReadLlmResolved('agent-model').model).toBe('agent-model')
  })

  it('appReadLlmResolved overrideBaseUrl 覆盖全局 baseUrl', async () => {
    const { appWriteSettings, appReadLlmResolved } = await import('../../electron/shared/app-settings')
    appWriteSettings({ llm: { apiKey: 'k', baseUrl: 'https://global.example' } })
    expect(appReadLlmResolved(undefined, 'https://agent.example').baseUrl)
      .toBe('https://agent.example')
  })

  it('appReadTavilyKey 合并 userData 与 env', async () => {
    const { appWriteSettings, appReadTavilyKey } = await import('../../electron/shared/app-settings')
    appWriteSettings({ skills: { tavilyApiKey: 't-user' } })
    expect(appReadTavilyKey()).toBe('t-user')
    process.env.TAVILY_API_KEY = 't-env'
    const { appReadTavilyKey: readAgain } = await import('../../electron/shared/app-settings')
    expect(readAgain()).toBe('t-user')
  })
})
