// 验证提示词只消费 ExecutionSpec 已投影的具名变量，不包含业务类型分支。
import { expect, it } from 'vitest'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'
import { promptReadWork } from '../../../backend/execution/dsh/prompt-renderer'

function fixture() {
  const profile = { id: 'agent', name: 'Agent', description: '', content: 'Summarize {{body}}; keep {{private}} literal.', tools: [],
    provider: 'fixture', model: 'fixture', promptVars: ['body', 'prior'] }
  const grant = { workId: 'op:summarize:slot', mapId: 'map', runId: 'run', operationId: 'op', stageId: 'summarize', slotId: 'slot',
    specHash: 'spec', priority: 'medium', holderId: 'holder', hostId: 'host', fence: 1, expiresAt: '', leaseMs: 1 } satisfies GraphWorkGrant
  const data = { mapId: 'map', runId: 'run', operationId: 'op', transitionRef: { id: 'demo.summarize', version: 1 }, specHash: 'spec',
    inputs: {}, context: {}, priorStageResults: [], promptVariables: { body: 'Text with {{prior}} marker', prior: '[{"key":"candidate"}]' },
    stage: { id: 'summarize', slotId: 'slot', agent: { ref: { id: 'agent', version: 1 }, profile }, tools: [] },
    outputContract: { mode: 'outputs', ports: [] }, proposalId: grant.workId,
    work: { id: grant.workId, stageId: 'summarize', slotId: 'slot', specHash: 'spec', status: 'ready' },
  } satisfies GraphDataRead
  return { profile, grant, data }
}

it('renders frozen prompt variables in profile order with one substitution pass', () => {
  const { profile, grant, data } = fixture()
  const prompt = promptReadWork(profile, data, grant)
  expect(prompt).toMatch(/^Summarize Text with \{\{prior\}\} marker; keep \{\{private\}\} literal\./)
  expect(prompt.indexOf('body:\n')).toBeLessThan(prompt.indexOf('prior:\n'))
  expect(prompt).toContain('[{"key":"candidate"}]')
})

it('rejects missing variables and another frozen stage binding', () => {
  const { profile, grant, data } = fixture()
  expect(() => promptReadWork({ ...profile, promptVars: ['missing'] }, data, grant)).toThrow('Unsupported summarize prompt variable')
  expect(() => promptReadWork(profile, { ...data, specHash: 'another' }, grant)).toThrow('another work grant')
})
