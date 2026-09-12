import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCreateStorage } from '../../electron/client-storage'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })
async function fixture(platform: NodeJS.Platform = 'darwin', available = true, backend = 'gnome_libsecret') {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-client-store-'))
  directories.push(directory)
  const secure = { isEncryptionAvailable: () => available, getSelectedStorageBackend: () => backend,
    encryptString: vi.fn(() => Buffer.from('os-encrypted-payload')), decryptString: vi.fn(() => 'secret-token') }
  return { directory, secure, store: clientCreateStorage({ directory, secure, platform }) }
}
describe('OS-backed desktop login storage', () => {
  it('stores only OS-encrypted credentials and a non-secret origin, then clears them on logout', async () => {
    const f = await fixture()
    expect(await f.store.save({ baseUrl: 'https://example.test', token: 'secret-token', remember: true })).toBe(true)
    const filename = path.join(f.directory, 'client-connection.json')
    const text = await readFile(filename, 'utf8')
    expect(text).not.toContain('secret-token')
    expect(f.secure.encryptString).toHaveBeenCalledWith('secret-token')
    if (process.platform !== 'win32') expect((await stat(filename)).mode & 0o777).toBe(0o600)
    expect(await f.store.load()).toEqual({ baseUrl: 'https://example.test', token: 'secret-token', remembered: true })
    await f.store.clear()
    expect(await f.store.load()).toBeNull()
  })
  it('never persists a token when encryption is unavailable or Linux selected basic_text', async () => {
    for (const f of [await fixture('darwin', false), await fixture('linux', true, 'basic_text'), await fixture('linux', true, 'unknown')]) {
      expect(f.store.canRemember()).toBe(false)
      expect(await f.store.save({ baseUrl: 'http://localhost:4320', token: 'secret-token', remember: true })).toBe(false)
      expect(f.secure.encryptString).not.toHaveBeenCalled()
      expect(await readFile(path.join(f.directory, 'client-connection.json'), 'utf8')).not.toContain('secret-token')
      expect(await f.store.load()).toEqual({ baseUrl: 'http://localhost:4320', token: null, remembered: false })
    }
  })
  it('returns no token when OS decryption fails, without falling back to plaintext', async () => {
    const f = await fixture()
    await f.store.save({ baseUrl: 'https://example.test', token: 'secret-token', remember: true })
    f.secure.decryptString.mockImplementation(() => { throw new Error('keychain unavailable') })
    expect(await f.store.load()).toEqual({ baseUrl: 'https://example.test', token: null, remembered: false })
  })
})
