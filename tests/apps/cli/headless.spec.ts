// 通过真实子进程与 API 验证命令行权限、幂等写入、订阅和文件传输。
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createGraphApi, type TestGraphApi } from '../../backend/fixtures/graph-api'

let api: TestGraphApi, directory: string
beforeAll(async () => {
  // 创建命令行用例共用的临时目录与真实图 API 夹具。
  directory = await mkdtemp(path.join(tmpdir(), 'chongming-cli-'))
  api = await createGraphApi()
}, 90_000)
afterAll(async () => {
  // 关闭图 API 并删除命令行测试目录。
   await api?.close(); await rm(directory, { recursive: true, force: true }) }, 30_000)

function cliCreateProcess(/* 传给被测 CLI 的子命令和选项列表，不含 Node 与脚本路径。 */ args: string[], /* 子进程使用的测试用户令牌；省略时用夹具用户，空字符串用于验证无凭据行为。 */ token = api.userToken) {
  // 拉起使用测试 API 的命令行进程，并将数据库地址设为不可达以发现错误依赖。
  return spawn(process.execPath, ['--import', 'tsx', 'apps/cli/main.ts', ...args], {
    cwd: path.resolve('.'), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CHONGMING_GRAPH_API: api.url, CHONGMING_USER_TOKEN: token,
      // 故意设置不可达的数据库地址，确保帮助和客户端命令不会误启动旧数据库链路。
      MONGO_URI: 'mongodb://127.0.0.1:1/forbidden', CHONGMING_MONGO_URI: 'mongodb://127.0.0.1:1/forbidden' },
  })
}
async function cliReadResult(/* 本次子进程要执行的 CLI 参数列表。 */ args: string[], /* 可选标准输入对象，提供时编码为 JSON，省略时发送空输入。 */ input?: unknown, /* 可选测试令牌，省略时由进程创建助手选择夹具默认用户。 */ token?: string) {
  // 向命令行输入 JSON，收集输出与退出码，并为子进程设置运行上限。
  const child = cliCreateProcess(args, token)
  const timer = setTimeout(() => /* 子进程超时后强制退出，避免用例无限等待。 */  child.kill('SIGKILL'), 8000)
  let stdout = '', stderr = ''
  child.stdout.on('data', /* 子进程标准输出的一段字节，累计以解析 JSON 结果。 */ chunk => {
    // 累积命令行标准输出以解析结果。
     stdout += chunk })
  child.stderr.on('data', /* 子进程错误输出的一段字节，累计以核对错误协议。 */ chunk => {
    // 累积命令行错误输出以核对错误协议。
     stderr += chunk })
  child.stdin.end(input === undefined ? '' : JSON.stringify(input))
  try {
    const code = await new Promise<number | null>((/* 接收子进程退出码并完成等待的函数。 */ resolve, /* 进程创建失败时拒绝等待的函数。 */ reject) => {
      // 等待子进程退出，创建失败时拒绝等待。
       child.once('error', reject); child.once('exit', resolve) })
    return { code, stdout, stderr }
  } finally { clearTimeout(timer) }
}

describe('Headless authenticated client', () => {
  // 组织无界面客户端的离线用法、鉴权、流和文件行为回归用例。
  it('prints help without credentials or a database and rejects legacy/invalid commands before connecting', async () => {
    // 验证帮助无需凭据或数据库，旧命令与无效参数在联网前返回用法错误。
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
    // 验证命令行沿用真实 API 权限、版本冲突和相同请求编号重放语义。
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
    // 验证订阅输出快照及更新，取消命令行不会暂停或取消共享 Run。
    const { mapId } = await api.createRun()
    const child = cliCreateProcess(['watch', mapId])
    child.stdin.end()
    let stdout = ''
    child.stdout.on('data', /* 订阅子进程新输出的字节，累计供快照与版本断言轮询。 */ chunk => {
      // 持续收集订阅进程输出供异步断言检查。
       stdout += chunk })
    const ended = new Promise<number | null>(/* 接收订阅进程退出码，验证 SIGINT 产生预期取消状态。 */ resolve => /* 等待订阅进程退出并取得取消退出码。 */  child.once('exit', resolve))
    try {
      await expect.poll(() => /* 读取当前输出，等待首个快照到达。 */  stdout, { timeout: 5000 }).toContain('"type":"snapshot"')
      const prior = await api.snapshot(mapId)
      await api.command('run.pause', { mapId, runId: prior.run.id, expectedRevision: prior.revision })
      await expect.poll(() => /* 读取当前输出，等待暂停状态进入事件流。 */  stdout, { timeout: 5000 }).toContain('"paused":true')
      const paused = await api.snapshot(mapId)
      await api.command('run.resume', { mapId, runId: paused.run.id, expectedRevision: paused.revision })
      await expect.poll(() => /* 检测恢复操作产生的新版本是否已出现在输出中。 */  stdout.includes('"revision":' + (paused.revision + 1)), { timeout: 5000 }).toBe(true)
      child.kill('SIGINT')
      expect(await ended).toBe(130)
      expect((await api.snapshot(mapId)).run.status).toBe('running')
    } finally { child.kill('SIGKILL'); await ended }
  })

  it('uploads and downloads via the shared file channel without overwriting local files', async () => {
    // 验证通过公共文件端点上传下载，并拒绝覆盖已存在的本地文件。
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
