import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  catalogCreate,
  catalogDelete,
  catalogGet,
  catalogListAll,
  catalogReload,
  catalogUpdate,
} from '../../electron/api/catalog-service'
import { promptUpdateConfigRoot } from '../../electron/shared/prompt-loader'
import { promptReadSlotIds } from '../../electron/shared/prompt-vars'

let tmpRoot = ''

function seedAgent(
  moduleDir: string,
  slug: string,
  data: Record<string, unknown>,
) {
  const dir = path.join(tmpRoot, moduleDir)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `${slug}.json`),
    `${JSON.stringify(data, null, 2)}\n`,
    'utf-8',
  )
}

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `chongming-catalog-${Date.now()}`)
  mkdirSync(path.join(tmpRoot, 'fact-extractor/sub-agents'), { recursive: true })
  mkdirSync(path.join(tmpRoot, 'fact-verifier/sub-agents'), { recursive: true })
  promptUpdateConfigRoot(tmpRoot)
})

afterEach(() => {
  const moduleDir = path.dirname(new URL(import.meta.url).pathname)
  promptUpdateConfigRoot(path.join(moduleDir, '../../subagentconfig'))
})

describe('catalog-service CRUD', () => {
  it('list / create / get / update / delete / reload', () => {
    seedAgent('fact-extractor/sub-agents', 'existing', {
      agentName: 'existing',
      displayLabel: '已有',
      content: 'prompt',
    })

    const before = catalogListAll()
    expect(before.split.map(a => a.agentName)).toContain('existing')

    const created = catalogCreate('split', {
      agentName: 'test-agent',
      displayLabel: '测试',
      content: 'hello',
      defaultPriority: 'high',
      description: 'desc',
      claimCategory: 'quote',
    })
    expect(created.agentName).toBe('test-agent')

    const detail = catalogGet('split', 'test-agent')
    expect(detail.content).toBe('hello')
    expect(detail.promptVars).toEqual(promptReadSlotIds('splitSubAgent'))
    expect(detail.claimCategory).toBe('quote')
    expect(detail.defaultPriority).toBe('high')

    catalogUpdate('split', 'test-agent', {
      displayLabel: '测试改',
      content: 'updated',
      promptVars: ['hint', 'content'],
      model: 'deepseek-chat',
    })
    expect(catalogGet('split', 'test-agent').displayLabel).toBe('测试改')
    expect(catalogGet('split', 'test-agent').model).toBe('deepseek-chat')
    expect(catalogGet('split', 'test-agent').promptVars).toEqual(['hint', 'content'])

    catalogDelete('split', 'test-agent')
    expect(catalogListAll().split.map(a => a.agentName)).not.toContain('test-agent')

    catalogReload()
    expect(catalogListAll().split.map(a => a.agentName)).toContain('existing')
  })
})
