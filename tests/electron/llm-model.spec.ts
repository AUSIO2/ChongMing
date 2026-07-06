import { describe, expect, it } from 'vitest'
import { llmResolvePromptModel } from '../../electron/shared/llm-model'
import type { PromptConfig } from '../../electron/shared/types'

describe('llm-model', () => {
  it('llmResolvePromptModel 无覆盖时返回 defaultModel', () => {
    const defaultModel = { invoke: async () => ({}) } as never
    const config: Pick<PromptConfig, 'model' | 'baseUrl'> = {}
    expect(llmResolvePromptModel(config, defaultModel)).toBe(defaultModel)
  })
})
