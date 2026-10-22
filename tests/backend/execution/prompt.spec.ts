// 验证提示词只消费 ExecutionSpec 已投影的具名变量，不包含业务类型分支。
import { expect, it } from 'vitest'
import type { GraphDataRead } from '../../../contracts/graph-work'
import { promptReadWork, promptReadWorkPersona } from '../../../backend/execution/dsh/prompt-renderer'

function fixture() {
  // 构造已由工作服务确认身份的冻结模板、变量及阶段输入。
  const profile = { id: 'agent', name: 'Agent', description: '', content: 'Summarize {{body}}; keep {{private}} literal.', tools: [],
    provider: 'fixture', model: 'fixture', promptVars: ['body', 'prior'] }
  const data = { mapId: 'map', runId: 'run', operationId: 'op', transitionRef: { id: 'demo.summarize', version: 1 }, specHash: 'spec',
    inputs: {}, context: {}, priorStageResults: [], promptVariables: { body: 'Text with {{prior}} marker', prior: '[{"key":"candidate"}]' },
    stage: { id: 'summarize', slotId: 'slot', agent: { ref: { id: 'agent', version: 1 }, profile }, tools: [] },
    outputContract: { mode: 'outputs', ports: [] }, proposalId: 'op:summarize:slot',
    work: { id: 'op:summarize:slot', stageId: 'summarize', slotId: 'slot', specHash: 'spec', status: 'ready' },
  } satisfies GraphDataRead
  return { profile, data }
}

it('renders frozen prompt variables in profile order with one substitution pass', () => {
  // 已投影变量按声明顺序展开，变量内容里的模板标记保持原文。
  const { profile, data } = fixture()
  const prompt = promptReadWork(promptReadWorkPersona(profile, data), data.libraryClaims)
  expect(prompt).toMatch(/^Summarize Text with \{\{prior\}\} marker; keep \{\{private\}\} literal\./)
  expect(prompt.indexOf('body:\n')).toBeLessThan(prompt.indexOf('prior:\n'))
  expect(prompt).toContain('[{"key":"candidate"}]')
})

it('rejects missing frozen prompt variables', () => {
  // 冻结模板声明但工作服务未提供的变量必须明确报错。
  const { profile, data } = fixture()
  expect(() => promptReadWorkPersona({ ...profile, promptVars: ['missing'] }, data)).toThrow('Unsupported summarize prompt variable')
})
