import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  registryCreate,
  registryGet,
  registryList,
  registryPreviewOutput,
  registryUpdate,
} from '../../electron/api/agent-registry-service'
import { promptUpdateConfigRoot } from '../../electron/shared/prompt-loader'

let tmpRoot = ''

function seed(relativePath: string, data: Record<string, unknown>) {
  const full = path.join(tmpRoot, `${relativePath}.json`)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

beforeEach(() => {
  tmpRoot = path.join(os.tmpdir(), `chongming-registry-${Date.now()}`)
  mkdirSync(path.join(tmpRoot, 'fact-extractor/sub-agents'), { recursive: true })
  mkdirSync(path.join(tmpRoot, 'fact-verifier/sub-agents'), { recursive: true })
  for (const p of [
    'fact-extractor/main-agent-route',
    'fact-extractor/main-agent-merge',
    'fact-verifier/main-agent-route',
    'fact-verifier/main-agent-merge',
    'fact-parser/extract',
  ]) {
    seed(p, { description: p, content: 'body', promptVars: [] })
  }
  promptUpdateConfigRoot(tmpRoot)
})

afterEach(() => {
  const moduleDir = path.dirname(new URL(import.meta.url).pathname)
  promptUpdateConfigRoot(path.join(moduleDir, '../../subagentconfig'))
})

describe('agent-registry-service', () => {
  it('lists subagents and fixed coordinator/parse entries', () => {
    seed('fact-extractor/sub-agents/demo', {
      agentName: 'demo',
      displayLabel: '演示',
      content: 'x',
      promptVars: [],
      claimCategory: 'data',
    })
    const list = registryList()
    expect(list.some(a => a.agentType === 'split' && a.agentName === 'demo')).toBe(true)
    expect(list.some(a => a.agentType === 'coordinator')).toBe(true)
    expect(list.some(a => a.agentType === 'parse')).toBe(true)
  })

  it('creates split agent with claimCategory and previews output', () => {
    registryCreate({
      agentType: 'split',
      agentName: 'new-agent',
      displayLabel: '新',
      content: 'body',
      endpointSlug: 'new-agent',
      claimCategory: 'causal',
    })
    const detail = registryGet('fact-extractor/sub-agents/new-agent')
    expect(detail.claimCategory).toBe('causal')
    const preview = registryPreviewOutput('splitSubAgent', { claimCategory: 'causal' })
    expect(preview).toContain('causal')
    registryUpdate('fact-extractor/sub-agents/new-agent', { claimCategory: 'quote' })
    expect(registryGet('fact-extractor/sub-agents/new-agent').claimCategory).toBe('quote')
  })
})
