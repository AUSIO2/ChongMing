import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGraphApi, type TestGraphApi } from '../../backend/fixtures/graph-api'

let api: TestGraphApi, directory: string
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'chongming-cli-'))
  api = await createGraphApi()
}, 90_000)
afterAll(async () => { await api?.close(); await rm(directory, { recursive: true, force: true }) }, 30_000)

function cliCreateProcess(args: string[], token = api.userToken) {
  return spawn(process.execPath, ['--import', 'tsx', 'apps/cli/main.ts', ...args], {
    cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHONGMING_GRAPH_API: api.url, CHONGMING_USER_TOKEN: token,
      // If help or commands accidentally bootstrap the old DB this unreachable URI would fail.
      MONGO_URI: 'mongodb://127.0.0.1:1/forbidden', CHONGMING_MONGO_URI: 'mongodb://127.0.0.1:1/forbidden' },
  })
}
async function cliReadResult(args: string[], input?: unknown, token?: string) {
  const child = cliCreateProcess(args, token)
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000)
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
    return { code, stdout, stderr }
  } finally { clearTimeout(timer) }
}

describe('Headless authenticated client', () => {
  it('prints help without credentials or a database and rejects legacy/invalid commands before connecting', async () => {
    const help = await cliReadResult(['--help'], undefined, '')
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('read METHOD')
    expect(help.stdout + help.stderr).not.toContain('[db]')
    for (const args of [['run', randomUUID()], ['read', 'missing'], ['dispatch', 'map.create'], ['watch', 'invalid']]) {
      const result = await cliReadResult(args, undefined, '')
      expect(result.code).toBe(2)
      expect(JSON.parse(result.stderr).error.code).toBe('CLI_USAGE')
    }
  })

  it('uses real API permissions, revisions and stable request IDs for writes', async () => {
    const workspace = await api.createWorkspace(), mapId = randomUUID(), requestId = randomUUID()
    const body = { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'CLI graph' }
    const args = ['dispatch', 'map.create', '--request-id', requestId, '--input', '-']
    const first = await cliReadResult(args, body)
    expect(first.code).toBe(0)
    expect(JSON.parse(first.stdout)).toMatchObject({ requestId, replayed: false, data: { snapshot: { mapId, revision: 0 } } })
    const replay = await cliReadResult(args, body)
    expect(replay.code, replay.stderr).toBe(0)
    expect(JSON.parse(replay.stdout)).toMatchObject({ replayed: true })
    const query = await cliReadResult(['read', 'map.get', '--input', '-'], { mapId })
    expect(JSON.parse(query.stdout).data.mapId).toBe(mapId)
    const invalid = await cliReadResult(['read', 'map.get', '--input', '-'], { mapId }, 'invalid-token')
    expect(invalid.code).toBe(1)
    expect(JSON.parse(invalid.stderr).error.status).toBe(401)
    const outsider = await api.auth.createUser({ id: randomUUID(), displayName: 'Other', hostAdmin: false })
    const { token } = await api.auth.createToken(outsider.userId)
    const forbidden = await cliReadResult(['read', 'map.get', '--input', '-'], { mapId }, token)
    expect(forbidden.code).toBe(1)
    expect([403, 404]).toContain(JSON.parse(forbidden.stderr).error.status)
    const conflict = await cliReadResult(['dispatch', 'graph.apply', '--request-id', randomUUID(), '--input', '-'],
      { mapId, expectedRevision: 99, changes: { name: 'Wrong revision' } })
    expect(JSON.parse(conflict.stderr).error.code).toBe('REVISION_CONFLICT')
  }, 20_000)

  it('streams a full baseline and graph updates; stopping the CLI leaves shared work running', async () => {
    const { mapId } = await api.createRun()
    const child = cliCreateProcess(['watch', mapId])
    child.stdin.end()
    let stdout = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    const ended = new Promise<number | null>(resolve => child.once('exit', resolve))
    try {
      await expect.poll(() => stdout, { timeout: 5000 }).toContain('"type":"snapshot"')
      const prior = await api.snapshot(mapId)
      await api.command('run.pause', { mapId, runId: prior.run.id, expectedRevision: prior.revision })
      await expect.poll(() => stdout, { timeout: 5000 }).toContain('"paused":true')
      const paused = await api.snapshot(mapId)
      await api.command('run.resume', { mapId, runId: paused.run.id, expectedRevision: paused.revision })
      await expect.poll(() => stdout.includes('"revision":' + (paused.revision + 1)), { timeout: 5000 }).toBe(true)
      child.kill('SIGINT')
      expect(await ended).toBe(130)
      expect((await api.snapshot(mapId)).run.status).toBe('running')
    } finally { child.kill('SIGKILL'); await ended }
  })

  it('uploads and downloads via the shared file channel without overwriting local files', async () => {
    const workspace = await api.createWorkspace(), source = path.join(directory, 'source.txt'), output = path.join(directory, 'download.txt')
    await writeFile(source, 'CLI file roundtrip', { mode: 0o600 })
    const uploaded = await cliReadResult(['upload', '--workspace', workspace.id, '--file', source, '--request-id', randomUUID(), '--media-type', 'text/plain'])
    expect(uploaded.code).toBe(0)
    const assetId = JSON.parse(uploaded.stdout).data.id
    const result = await cliReadResult(['download', 'asset', assetId, '--output', output])
    expect(result.code).toBe(0)
    expect(await readFile(output, 'utf8')).toBe('CLI file roundtrip')
    const exists = await cliReadResult(['download', 'asset', assetId, '--output', output])
    expect(exists.code).toBe(1)
    expect(await readFile(output, 'utf8')).toBe('CLI file roundtrip')
  }, 15_000)
})
