import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RuntimeMessage, messageFormat } from '../../contracts/messages'

describe('runtime messages', () => {
  it('keeps enum values unique and formats dynamic fields without changing the template', () => {
    const values = Object.values(RuntimeMessage)
    expect(new Set(values).size).toBe(values.length)
    expect(messageFormat(RuntimeMessage.EXPECTED_REVISION_VALUE_FOUND_VALUE, 7, 9)).toBe('Expected revision 7, found 9')
  })

  it('rejects a newly hard-coded exception message', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-messages-'))
    try {
      const fixture = path.join(directory, 'invalid.ts')
      await writeFile(fixture, "throw new Error('hard-coded failure')\n")
      expect(() => execFileSync(process.execPath, ['scripts/check-runtime-messages.mjs', fixture], {
        cwd: path.resolve('.'), stdio: 'pipe',
      })).toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
