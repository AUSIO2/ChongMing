// 验证本机配置的文件权限、脱敏输出、并发锁与管理命令初始化。
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { localReadConfiguration, localUpdateSecret, localUpdateSettings } from '../../../apps/config/local-settings'
import { localReadUri } from '../../../backend/adapters/storage/mongo/connection'
import { createGraphApi } from '../../backend/fixtures/graph-api'

const directories: string[] = []
afterEach(async () => {
  // 恢复环境变量替身并并行删除每个用例创建的配置目录。
   vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(/* 当前用例创建并登记的临时配置目录。 */ dir => /* 删除单个临时配置目录及其文件。 */  rm(dir, { recursive: true, force: true }))) })

it('keeps local secrets private and exposes only redacted configuration through the admin CLI', async () => {
  // 验证密钥仅落入私有文件，管理查询只暴露脱敏信息且删除与名称校验生效。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-local-'))
  directories.push(directory)
  vi.stubEnv('CHONGMING_CONFIG_DIR', directory)
  await expect(localUpdateSecret('DEEPSEEK_API_KEY', 'local-test-secret')).resolves.toEqual({ configured: true })
  await expect(localUpdateSecret('CHONGMING_AMQP_URL', 'amqp://fixture:broker-private@127.0.0.1:5672')).resolves.toEqual({ configured: true })
  expect((await stat(path.join(directory, 'secrets.json'))).mode & 0o777).toBe(0o600)
  await localUpdateSettings({ mongoUri: 'mongodb://owner:private-pass@127.0.0.1:27017/test' })
  expect(localReadUri('mongodb+srv://owner:private-pass@example.test/test')).toBe('mongodb+srv://***@example.test/test')
  expect(localReadUri('mongodb://host/test?tlsCertificateKeyFilePassword=query-secret&proxyPassword=proxy-secret')).not.toMatch(/query-secret|proxy-secret/)
  expect(localReadUri('mongodb://owner:invalid/unescaped@host/test')).toBe('<invalid Mongo URI>')
  const inputFile = path.join(directory, 'input.json')
  await writeFile(inputFile, '{}')
  const result = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', path.resolve('apps/graph-server/admin.ts'), 'settings.read', '--input', inputFile],
    { env: { ...process.env, CHONGMING_CONFIG_DIR: directory, CHONGMING_MONGO_URI: undefined, DEEPSEEK_API_KEY: undefined } })
  expect(JSON.parse(result.stdout)).toMatchObject({ mongoUri: 'mongodb://***@127.0.0.1:27017/test', secrets: { DEEPSEEK_API_KEY: true, CHONGMING_AMQP_URL: true } })
  expect(result.stdout + result.stderr).not.toMatch(/local-test-secret|private-pass|broker-private/)
  expect(await localUpdateSecret('DEEPSEEK_API_KEY', null)).toEqual({ configured: false })
  expect((await localReadConfiguration()).secrets).not.toHaveProperty('DEEPSEEK_API_KEY')
  await expect(localUpdateSecret('PATH', 'unexpected')).rejects.toThrow('Unknown Host secret')
  expect(await readFile(path.join(directory, 'secrets.json'), 'utf8')).not.toContain('PATH')
}, 10_000)

it('does not silently lose a successful concurrent secret update', async () => {
  // 验证并发密钥更新要么成功保留，要么明确报告忙碌，不能静默丢失已成功更新。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-local-race-'))
  directories.push(directory)
  vi.stubEnv('CHONGMING_CONFIG_DIR', directory)
  const names = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']
  const results = await Promise.allSettled(names.map(/* 本次并发测试要写入的允许密钥名称，用于形成各自测试值。 */ name => /* 为不同密钥同时发起写入以制造配置锁竞争。 */  localUpdateSecret(name, `fixture-${name}`)))
  const { secrets } = await localReadConfiguration()
  expect(results.some(/* 一次并发写入的 settled 结果，用于检查至少一项成功。 */ result => /* 检查至少一项并发更新成功完成。 */  result.status === 'fulfilled')).toBe(true)
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.status === 'fulfilled') expect(secrets[names[index]]).toBe(`fixture-${names[index]}`)
    else expect(result.reason).toMatchObject({ code: 'LOCAL_SETTINGS_BUSY' })
  }
})

it('initializes a usable administrator token and a private Host token through the real CLI', async () => {
  // 使用真实管理命令初始化用户令牌和私有 Host 令牌，并验证后者不出现在输出中。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-admin-init-'))
  directories.push(directory)
  vi.stubEnv('CHONGMING_CONFIG_DIR', directory)
  const api = await createGraphApi()
  try {
    const inputFile = path.join(directory, 'input.json')
    await writeFile(inputFile, JSON.stringify({ displayName: 'Local CLI Admin' }))
    const result = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', path.resolve('apps/graph-server/admin.ts'), 'init', '--input', inputFile],
      { env: { ...process.env, CHONGMING_CONFIG_DIR: directory, CHONGMING_MONGO_URI: api.uri, CHONGMING_DATA_TOKEN: undefined } })
    const created = JSON.parse(result.stdout)
    expect((await api.auth.read(created.token)).actor).toEqual(created.user)
    const local = await localReadConfiguration()
    expect(local.secrets.CHONGMING_DATA_TOKEN.length).toBeGreaterThan(32)
    expect(result.stdout + result.stderr).not.toContain(local.secrets.CHONGMING_DATA_TOKEN)
    expect((await stat(path.join(directory, 'secrets.json'))).mode & 0o777).toBe(0o600)
  } finally { await api.close() }
}, 30_000)
