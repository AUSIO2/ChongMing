import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { localReadConfiguration, localReadUri, localUpdateSecret, localUpdateSettings } from '../../backend/local-settings'
import { createGraphApi } from './fixtures/graph-api'

const directories: string[] = []
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

it('keeps local secrets private and exposes only redacted configuration through the admin CLI', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-local-'))
  directories.push(directory)
  vi.stubEnv('CHONGMING_CONFIG_DIR', directory)
  await expect(localUpdateSecret('DEEPSEEK_API_KEY', 'local-test-secret')).resolves.toEqual({ configured: true })
  expect((await stat(path.join(directory, 'secrets.json'))).mode & 0o777).toBe(0o600)
  await localUpdateSettings({ mongoUri: 'mongodb://owner:private-pass@127.0.0.1:27017/test' })
  expect(localReadUri('mongodb+srv://owner:private-pass@example.test/test')).toBe('mongodb+srv://***@example.test/test')
  expect(localReadUri('mongodb://host/test?tlsCertificateKeyFilePassword=query-secret&proxyPassword=proxy-secret')).not.toMatch(/query-secret|proxy-secret/)
  expect(localReadUri('mongodb://owner:invalid/unescaped@host/test')).toBe('<invalid Mongo URI>')
  const inputFile = path.join(directory, 'input.json')
  await writeFile(inputFile, '{}')
  const result = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', path.resolve('backend/admin-main.ts'), 'settings.read', '--input', inputFile],
    { env: { ...process.env, CHONGMING_CONFIG_DIR: directory, CHONGMING_MONGO_URI: undefined, DEEPSEEK_API_KEY: undefined } })
  expect(JSON.parse(result.stdout)).toMatchObject({ mongoUri: 'mongodb://***@127.0.0.1:27017/test', secrets: { DEEPSEEK_API_KEY: true } })
  expect(result.stdout + result.stderr).not.toMatch(/local-test-secret|private-pass/)
  expect(await localUpdateSecret('DEEPSEEK_API_KEY', null)).toEqual({ configured: false })
  expect((await localReadConfiguration()).secrets).not.toHaveProperty('DEEPSEEK_API_KEY')
  await expect(localUpdateSecret('PATH', 'unexpected')).rejects.toThrow('Unknown Host secret')
  expect(await readFile(path.join(directory, 'secrets.json'), 'utf8')).not.toContain('PATH')
}, 10_000)

it('does not silently lose a successful concurrent secret update', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-local-race-'))
  directories.push(directory)
  vi.stubEnv('CHONGMING_CONFIG_DIR', directory)
  const names = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY']
  const results = await Promise.allSettled(names.map(name => localUpdateSecret(name, `fixture-${name}`)))
  const { secrets } = await localReadConfiguration()
  expect(results.some(result => result.status === 'fulfilled')).toBe(true)
  for (let index = 0; index < results.length; index++) {
    const result = results[index]
    if (result.status === 'fulfilled') expect(secrets[names[index]]).toBe(`fixture-${names[index]}`)
    else expect(result.reason).toMatchObject({ code: 'LOCAL_SETTINGS_BUSY' })
  }
})

it('initializes a usable administrator token and a private Host token through the real CLI', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-admin-init-'))
  directories.push(directory)
  vi.stubEnv('CHONGMING_CONFIG_DIR', directory)
  const api = await createGraphApi()
  try {
    const inputFile = path.join(directory, 'input.json')
    await writeFile(inputFile, JSON.stringify({ displayName: 'Local CLI Admin' }))
    const result = await promisify(execFile)(process.execPath,
      ['--import', 'tsx', path.resolve('backend/admin-main.ts'), 'init', '--input', inputFile],
      { env: { ...process.env, CHONGMING_CONFIG_DIR: directory, CHONGMING_MONGO_URI: api.uri, CHONGMING_DATA_TOKEN: undefined } })
    const created = JSON.parse(result.stdout)
    expect((await api.auth.read(created.token)).actor).toEqual(created.user)
    const local = await localReadConfiguration()
    expect(local.secrets.CHONGMING_DATA_TOKEN.length).toBeGreaterThan(32)
    expect(result.stdout + result.stderr).not.toContain(local.secrets.CHONGMING_DATA_TOKEN)
    expect((await stat(path.join(directory, 'secrets.json'))).mode & 0o777).toBe(0o600)
  } finally { await api.close() }
}, 30_000)
