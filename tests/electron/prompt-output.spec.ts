import { describe, expect, it } from 'vitest'
import { promptAssembleOutput, promptFormatOutput } from '../../electron/shared/prompt-output'
import { promptAssemble } from '../../electron/shared/prompt-vars'

describe('prompt-output', () => {
  it('formats splitSubAgent with claimCategory', () => {
    const out = promptFormatOutput('splitSubAgent', { claimCategory: 'quote' })
    expect(out).toContain('"category": "quote"')
    expect(out).toContain('JSON 数组')
  })

  it('assembles output block after injection vars', () => {
    const assembled = promptAssemble(
      '你是拆分 SubAgent。',
      ['content'],
      'splitSubAgent',
      { claimCategory: 'data' },
    )
    expect(assembled).toContain('【新闻正文】')
    expect(assembled).toContain('【返回格式】')
    expect(assembled.indexOf('【新闻正文】')).toBeLessThan(assembled.indexOf('【返回格式】'))
  })

  it('includes output header in assembleOutput', () => {
    expect(promptAssembleOutput('verifySubAgent')).toContain('【返回格式】')
    expect(promptAssembleOutput('parseExtract')).toContain('纯文本')
  })
})
