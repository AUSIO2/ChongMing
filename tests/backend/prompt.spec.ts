import { expect, it } from 'vitest'
import type { GraphDataRead, GraphWorkGrant } from '../../contracts/graph'
import { promptReadWork } from '../../backend/prompt'
import { verificationConfiguration } from './fixtures/verification'

it('uses the frozen variable order and substitutes only selected variables in the custom prompt', () => {
  const profile = { ...verificationConfiguration().agents[0], content: 'Check {{claimContent}}; leave {{opinions}}.', promptVars: ['hint', 'claimContent', 'context'] }
  const grant = { actor: { role: 'worker', slotId: 'angle-a' } } as GraphWorkGrant
  const data = {
    claim: { data: { content: 'A verifiable claim' } },
    context: [{ id: 'news', content: 'Original report', context: { source: { value: 'public source', visibleToAI: true } } }],
    configuration: verificationConfiguration(), reports: [], route: { slots: [{ id: 'angle-a', hint: 'Check dates first' }] },
  } as unknown as GraphDataRead
  const prompt = promptReadWork(profile, data, grant)
  expect(prompt).toMatch(/^Check A verifiable claim; leave \{\{opinions\}\}\./)
  expect(prompt.indexOf('hint:\nCheck dates first')).toBeLessThan(prompt.indexOf('claimContent:\nA verifiable claim'))
  expect(prompt.indexOf('claimContent:\nA verifiable claim')).toBeLessThan(prompt.indexOf('context:\n'))
  expect(prompt).toContain('public source')
  expect(() => promptReadWork({ ...profile, promptVars: ['unavailable'] }, data, grant)).toThrow('Unsupported verification prompt variable')
})
