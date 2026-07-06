import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  promptConfigGet,
  promptConfigList,
  promptConfigUpdate,
  promptVarsList,
} from '../../electron/api/prompt-config-service'
import { promptUpdateConfigRoot } from '../../electron/shared/prompt-loader'

let tmpRoot = ''

function seedPrompt(relativePath: string, data: Record<string, unknown>) {
  const full = path.join(tmpRoot, `${relativePath}.json`)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `chongming-prompt-${Date.now()}`)
  mkdirSync(tmpRoot, { recursive: true })
  for (const relativePath of [
    'fact-extractor/main-agent-route',
    'fact-extractor/main-agent-merge',
    'fact-verifier/main-agent-route',
    'fact-verifier/main-agent-merge',
    'fact-parser/extract',
  ]) {
    seedPrompt(relativePath, {
      description: relativePath,
      content: `${relativePath} body`,
      promptVars: [],
    })
  }
  promptUpdateConfigRoot(tmpRoot)
})

afterEach(() => {
  const moduleDir = path.dirname(new URL(import.meta.url).pathname)
  promptUpdateConfigRoot(path.join(moduleDir, '../../subagentconfig'))
})

describe('prompt-config-service', () => {
  it('lists slots and updates main-agent prompts', () => {
    const slots = promptVarsList('splitRoute')
    expect(slots.map(s => s.id)).toContain('availableAgents')

    const list = promptConfigList()
    expect(list.length).toBeGreaterThanOrEqual(2)

    const entry = promptConfigGet('fact-parser/extract')
    expect(entry.content).toBe('fact-parser/extract body')
    expect(entry.promptVars).toEqual([])

    const updated = promptConfigUpdate('fact-parser/extract', {
      content: 'new body',
      promptVars: [],
    })
    expect(updated.content).toBe('new body')
    expect(updated.promptVars).toEqual([])
  })
})
