// 用真实文件和密码算法验证模型密钥可跨重启恢复，且密文损坏不会回退明文。
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { modelCreateSecretCodec, modelLoadSecretCodec } from '../../../../backend/adapters/identity/model-secrets'

const directories: string[] = []
afterEach(async () => {
  // 只移除本例独占的加密主密钥目录。
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('同一Key每次生成不同密文，篡改密文或使用另一主密钥均拒绝解密', () => {
  // 不把密钥编码或固定IV误当成加密，验证完整性和加密上下文的隔离。
  const first = modelCreateSecretCodec(Buffer.alloc(32, 1)), other = modelCreateSecretCodec(Buffer.alloc(32, 2))
  const plain = 'fixture-model-api-key-110', sealed = first.seal(plain)
  expect(first.open(sealed)).toBe(plain)
  expect(first.seal(plain)).not.toBe(sealed)
  expect(sealed.includes(plain)).toBe(false)
  expect(() => other.open(sealed)).toThrow()
  const parts = sealed.split(':')
  parts[2] = Buffer.from('changed ciphertext').toString('base64url')
  expect(() => first.open(parts.join(':'))).toThrow()
  expect(() => first.open(plain)).toThrow()
})

it('首次初始化只建立一份0600主密钥，第二实例可解密既有数据', async () => {
  // 两个初始化并发使用同一路径，重启不能产生新主密钥使已存Key失效。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-model-key-'))
  directories.push(directory)
  const [first, second] = await Promise.all([modelLoadSecretCodec(directory), modelLoadSecretCodec(directory)])
  const cipher = first.seal('fixture-key-before-restart')
  expect(second.open(cipher)).toBe('fixture-key-before-restart')
  const again = await modelLoadSecretCodec(directory)
  expect(again.open(cipher)).toBe('fixture-key-before-restart')
  const keyFile = path.join(directory, 'model-encryption.key')
  expect((await readFile(keyFile)).length).toBe(32)
  expect((await stat(keyFile)).mode & 0o777).toBe(0o600)
})

it('损坏的既有主密钥会中止加载，不静默覆盖为另一份', async () => {
  // 自动重置会破坏工作区已保存的密文，必须保留原文件供恢复。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-model-key-'))
  directories.push(directory)
  const keyFile = path.join(directory, 'model-encryption.key')
  await writeFile(keyFile, 'invalid', { mode: 0o600 })
  await expect(modelLoadSecretCodec(directory)).rejects.toThrow()
  expect(await readFile(keyFile, 'utf8')).toBe('invalid')
})
