// 验证桌面凭据存储依赖系统加密且在损坏或不可用时不会退回明文。
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCreateStorage } from '../../../apps/desktop/credential-store'
const directories: string[] = []
afterEach(async () => {
  // 并行删除本轮测试创建的全部凭据目录。
   await Promise.all(directories.splice(0).map(directory => /* 删除单个临时凭据目录。 */  rm(directory, { recursive: true, force: true }))) })
/**
 * 按平台和密钥后端能力创建受控存储夹具，暴露加解密调用供断言。
 *
 * @param platform 被模拟的平台，默认 macOS；Linux 用于覆盖密钥后端限制。
 * @param available 系统加密可用性的测试开关，缺省为可用。
 * @param backend 模拟 Linux 密钥后端名称，缺省使用可信 libsecret。
 */
async function fixture(platform: NodeJS.Platform = 'darwin', available = true, backend = 'gnome_libsecret') {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-client-store-'))
  directories.push(directory)
  const secure = { isEncryptionAvailable: () => /* 返回用例指定的系统加密可用状态。 */  available, getSelectedStorageBackend: () => /* 返回用例指定的 Linux 密钥后端。 */  backend,
    encryptString: vi.fn(() => /* 用固定密文字节模拟系统加密，并保留调用记录。 */  Buffer.from('os-encrypted-payload')), decryptString: vi.fn(() => /* 用固定令牌模拟系统解密结果。 */  'secret-token') }
  return { directory, secure, store: clientCreateStorage({ directory, secure, platform }) }
}
describe('OS-backed desktop login storage', () => {
  // 组织凭据持久化、加密能力和故障退化场景。
  it('allows login after damaged JSON but surfaces unexpected filesystem failures', async () => {
    // 验证损坏 JSON 可视为无配置，而意外文件系统错误必须传播。
    const f = await fixture()
    const filename = path.join(f.directory, 'client-connection.json')
    await writeFile(filename, '{broken')
    expect(await f.store.load()).toBeNull()
    await rm(filename)
    await mkdir(filename)
    await expect(f.store.load()).rejects.toMatchObject({ code: 'EISDIR' })
  })

  it('stores only OS-encrypted credentials and a non-secret origin, then clears them on logout', async () => {
    // 验证文件只保存密文和地址，权限受限，退出清理后不再恢复令牌。
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
    // 验证加密不可用或 Linux 后端不可信时只保存地址且不调用加密器。
    for (const f of [await fixture('darwin', false), await fixture('linux', true, 'basic_text'), await fixture('linux', true, 'unknown')]) {
      expect(f.store.canRemember()).toBe(false)
      expect(await f.store.save({ baseUrl: 'http://localhost:4320', token: 'secret-token', remember: true })).toBe(false)
      expect(f.secure.encryptString).not.toHaveBeenCalled()
      expect(await readFile(path.join(f.directory, 'client-connection.json'), 'utf8')).not.toContain('secret-token')
      expect(await f.store.load()).toEqual({ baseUrl: 'http://localhost:4320', token: null, remembered: false })
    }
  })
  it('returns no token when OS decryption fails, without falling back to plaintext', async () => {
    // 验证系统解密失败时只恢复地址，不尝试任何明文回退。
    const f = await fixture()
    await f.store.save({ baseUrl: 'https://example.test', token: 'secret-token', remember: true })
    f.secure.decryptString.mockImplementation(() => {
      // 模拟密钥链不可用导致的解密失败。
       throw new Error('keychain unavailable') })
    expect(await f.store.load()).toEqual({ baseUrl: 'https://example.test', token: null, remembered: false })
  })
})
