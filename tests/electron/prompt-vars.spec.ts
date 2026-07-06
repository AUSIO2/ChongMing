import { describe, expect, it } from 'vitest'
import { promptMigrateContent } from '../../electron/shared/prompt-migrate'
import {
  promptAssemble,
  promptReadSlotIds,
  promptRender,
} from '../../electron/shared/prompt-vars'

describe('prompt-vars', () => {
  it('assembles injection blocks in promptVars order', () => {
    const body = '你是拆分 SubAgent。'
    const assembled = promptAssemble(body, ['context', 'hint'], 'splitSubAgent')
    expect(assembled).toContain('你是拆分 SubAgent。')
    expect(assembled.indexOf('【上下文】')).toBeLessThan(assembled.indexOf('【协调者提示】'))
    expect(assembled).toContain('{{context}}')
    expect(assembled).toContain('{{hint}}')
    expect(assembled).toContain('【返回格式】')
  })

  it('renders assembled template with runtime vars', () => {
    const out = promptRender(
      '正文',
      ['content', 'hint'],
      'splitSubAgent',
      { content: '新闻A', hint: '优先数据' },
    )
    expect(out).toContain('新闻A')
    expect(out).toContain('优先数据')
    expect(out).not.toContain('{{content}}')
  })

  it('migrate strips known injection blocks', () => {
    const raw = [
      '你是核查 SubAgent。',
      '',
      '【协调者提示】',
      '{{hint}}',
      '',
      '【待核查事实】',
      '{{claimContent}}',
      '',
      '评分枚举',
    ].join('\n')
    const { content, promptVars } = promptMigrateContent(raw, 'verifySubAgent')
    expect(content).toContain('你是核查 SubAgent。')
    expect(content).not.toContain('{{hint}}')
    expect(promptVars).toEqual(['hint', 'claimContent'])
    expect(promptReadSlotIds('verifySubAgent')).toContain('originalContent')
  })
})
