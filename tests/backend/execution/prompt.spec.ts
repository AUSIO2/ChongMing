// 文件职责：验证各执行阶段提示词只使用授权变量并保留配置顺序。
import { expect, it } from 'vitest'
import type { GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'
import { promptReadWork } from '../../../backend/execution/dsh/prompt-renderer'
import { verificationConfiguration } from '../fixtures/verification'

it('uses the frozen variable order and substitutes only selected variables in the custom prompt', () => {
  // 验证核查提示词只替换声明变量，并按冻结配置追加变量区块。
  const profile = { ...verificationConfiguration().agents[0], content: 'Check {{claimContent}}; leave {{opinions}}.', promptVars: ['hint', 'claimContent', 'context'] }
  const grant = { actor: { role: 'worker', slotId: 'angle-a' } } as GraphWorkGrant
  const data = {
    operationKind: 'verify', target: { data: { kind: 'claim', content: 'A verifiable claim' } },
    context: [{ id: 'news', content: 'Original report', context: { source: { value: 'public source', visibleToAI: true } } }],
    configuration: verificationConfiguration(), reports: [], route: { slots: [{ id: 'angle-a', hint: 'Check dates first' }] },
  } as unknown as GraphDataRead
  const prompt = promptReadWork(profile, data, grant)
  expect(prompt).toMatch(/^Check A verifiable claim; leave \{\{opinions\}\}\./)
  expect(prompt.indexOf('hint:\nCheck dates first')).toBeLessThan(prompt.indexOf('claimContent:\nA verifiable claim'))
  expect(prompt.indexOf('claimContent:\nA verifiable claim')).toBeLessThan(prompt.indexOf('context:\n'))
  expect(prompt).toContain('public source')
  expect(() => /* 使用不存在的核查变量触发明确配置错误。 */  promptReadWork({ ...profile, promptVars: ['unavailable'] }, data, grant)).toThrow('Unsupported verify prompt variable')
})

it('renders source text and split reports from the authorized operation while preserving custom variable order', () => {
  // 验证拆分使用自身 Agent 与报告，解析正文中的模板文字不再递归展开。
  const configuration = verificationConfiguration()
  const profile = { ...configuration.agents[0], id: 'custom-split', content: 'Read {{content}}; {{claimContent}} stays literal.', promptVars: ['subResults', 'content', 'availableAgents'] }
  configuration.split = { router: { ...profile, id: 'split-router' }, merger: { ...profile, id: 'split-merger' }, agents: [profile] }
  const data = {
    operationKind: 'split', target: { data: { kind: 'news', content: 'Independent news' } },
    context: [], configuration, route: null,
    splitReports: [{ id: 'report-one', claims: [{ content: 'Extracted fact', category: 'data' }] }],
  } as unknown as GraphDataRead
  const grant = { actor: { role: 'merge' } } as GraphWorkGrant
  const rendered = promptReadWork(profile, data, grant)
  expect(rendered).toMatch(/^Read Independent news; \{\{claimContent\}\} stays literal\./)
  expect(rendered).toContain('"id":"report-one"')
  expect(rendered).toContain('"id":"custom-split"')
  expect(rendered).not.toContain('"id":"archive-expert"')
  expect(rendered.indexOf('subResults:\n')).toBeLessThan(rendered.indexOf('content:\nIndependent news'))
  const parse = { ...profile, content: 'Source {{rawContent}}', promptVars: ['rawContent'] }
  expect(promptReadWork(parse, { ...data, operationKind: 'parse', rawContent: 'shared text {{content}}' }, { ...grant, actor: { role: 'parse' } }))
    .toBe('Source shared text {{content}}\n\nrawContent:\nshared text {{content}}')
  expect(() => /* 在拆分提示词中请求核查专属变量，确认被拒绝。 */  promptReadWork({ ...profile, promptVars: ['claimContent'] }, data, grant)).toThrow('Unsupported split prompt variable')
})
