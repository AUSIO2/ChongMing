// 验证错误文案枚举唯一性、占位符格式化与内联文案检查脚本。
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeMessage, messageFormat } from '../../contracts/messages'

describe('runtime messages', () => {
  // 组织运行文案约束及扫描器拒绝硬编码文案的回归场景。
  it('keeps enum values unique and formats dynamic fields without changing the template', () => {
    // 验证枚举值不重复，并按传入参数正确替换占位符。
    const values = Object.values(RuntimeMessage)
    expect(new Set(values).size).toBe(values.length)
    expect(messageFormat(RuntimeMessage.EXPECTED_REVISION_VALUE_FOUND_VALUE, 7, 9)).toBe('Expected revision 7, found 9')
  })

  it('rejects a newly hard-coded exception message', async () => {
    // 创建含内联错误文案的临时源码，验证检查脚本以失败状态退出。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-messages-'))
    try {
      const fixture = path.join(directory, 'invalid.ts')
      await writeFile(fixture, "throw new Error('hard-coded failure')\n")
      expect(() => /* 运行文案扫描器，供断言确认违规源码会导致命令失败。 */  execFileSync(process.execPath, ['scripts/check-runtime-messages.mjs', fixture], {
        cwd: path.resolve('.'), stdio: 'pipe',
      })).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
