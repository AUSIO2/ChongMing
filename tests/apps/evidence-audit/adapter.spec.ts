// 通过真实假二进制验证跨语言协议、资源边界和只读CLI入口，不测试仓颉检查算法。
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AUDIT_INPUT_LIMIT_BYTES, auditNormalizeInput, auditRunCangjie } from '../../../apps/evidence-audit/audit-process'

let directory: string, binaryPath: string
const graph = { mapId: '6d326c8a-bd2c-4b70-a72d-f74c6f2c6fa1', workspaceId: 'c3babec5-2cd1-430a-9b9a-005cf818659a',
  name: '图审计测试', revision: 0, nodes: [], edges: [] }

beforeEach(async () => {
  // 为每个用例建立独立可执行文件，脚本路径可包含空格以验证未使用shell。
  directory = await mkdtemp(path.join(tmpdir(), 'audit adapter test '))
  binaryPath = path.join(directory, 'fake audit')
  const source = await readFile('tests/apps/evidence-audit/fixtures/fake-audit.mjs', 'utf8')
  await writeFile(binaryPath, '#!' + process.execPath + '\n' + source)
  await chmod(binaryPath, 0o700)
})
afterEach(async () => {
  // 删除用例自有文件并恢复环境变量，避免将测试令牌留给后续用例。
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

async function cli(/* 传给实际Node入口的命令行参数。 */ args: string[],
  /* 仅本用例子进程使用的环境覆盖。 */ env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // 启动真实入口并收集输出；所有被审计任务都由当前用例的假仓颉二进制执行。
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/evidence-audit/main.ts', ...args], {
    env: { ...process.env, CHONGMING_CANGJIE_AUDIT_BIN: binaryPath, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (/* 子进程标准输出块。 */ chunk: Buffer) => { /* 汇总CLI业务输出。 */ stdout += chunk.toString() })
  child.stderr.on('data', (/* 子进程错误输出块。 */ chunk: Buffer) => { /* 汇总受控CLI错误。 */ stderr += chunk.toString() })
  return new Promise((/* 进程已关闭时的完整结果。 */ resolve, /* 创建进程失败。 */ reject) => {
    // 以close等待管道结束，避免丢失退出前的最后输出。
    child.once('error', reject)
    child.once('close', (/* 入口的最终退出码。 */ code) => /* 返回同一进程的完整记录。 */ resolve({ code, stdout, stderr }))
  })
}

async function inputFile(/* 当前用例的JSON输入，默认正常空图。 */ input: unknown = graph): Promise<string> {
  // 写入调用方文件；审计不得改变它，临时文件由adapter独立管理。
  const file = path.join(directory, 'input.json')
  await writeFile(file, JSON.stringify(input))
  return file
}

describe('Cangjie evidence audit adapter', () => {
  // 验证进程协议及公开CLI的安全边界，不接触真实模型或生产API。
  it('accepts pass, warning, structural failure and invalid results without losing their status', async () => {
    // 结构失败仍保留报告，待完成警告不变成异常，invalid与exit2保持一致。
    for (const mode of ['pass', 'warning', 'fail', 'invalid']) {
      const result = await auditRunCangjie({ input: { ...graph, fixtureMode: mode }, binaryPath })
      expect(result.status).toBe(mode)
    }
  })
  it('uses a private temporary file, excludes secrets from child env and cleans up after success', async () => {
    // 检查实际子进程收到的文件权限、argv和环境白名单，并验证返回后文件已被删除。
    vi.stubEnv('CHONGMING_USER_TOKEN', 'secret-user-token')
    vi.stubEnv('OPENAI_API_KEY', 'secret-model-key')
    vi.stubEnv('NODE_OPTIONS', '--trace-warnings')
    const result = await auditRunCangjie({ input: { ...graph, fixtureMode: 'inspect' }, binaryPath })
    expect(result.status).toBe('pass')
    if (result.status === 'invalid') throw new Error('Expected fixture report')
    const observed = JSON.parse(result.markdown)
    expect(observed.directoryMode).toBe(0o700); expect(observed.fileMode).toBe(0o600)
    expect(observed.args).toEqual(['--input', observed.inputPath])
    expect(observed.env.CHONGMING_USER_TOKEN).toBeUndefined()
    expect(observed.env.OPENAI_API_KEY).toBeUndefined(); expect(observed.env.NODE_OPTIONS).toBeUndefined()
    expect(observed.input).toEqual({ ...graph, fixtureMode: 'inspect' })
    await expect(stat(observed.inputPath)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('rejects broken JSON, inconsistent exit codes and a missing binary as execution failures', async () => {
    // 不将退出码非零但status成功、截断输出或不存在的程序解释为审计通过。
    for (const mode of ['badjson', 'mismatch']) {
      await expect(auditRunCangjie({ input: { ...graph, fixtureMode: mode }, binaryPath })).rejects.toMatchObject({ code: 'AUDIT_PROTOCOL_INVALID', exitCode: 3 })
    }
    await expect(auditRunCangjie({ input: graph, binaryPath: path.join(directory, 'missing') })).rejects.toMatchObject({ code: 'AUDIT_BINARY_FAILED', exitCode: 3 })
  })
  it('bounds execution time and cancellation even when the child ignores SIGTERM', async () => {
    // 确保超时与主动取消最终回收子进程，调用不会无限等待。
    await expect(auditRunCangjie({ input: { ...graph, fixtureMode: 'hang' }, binaryPath, timeoutMs: 200 })).rejects.toMatchObject({ code: 'AUDIT_TIMEOUT' })
    const controller = new AbortController()
    const result = auditRunCangjie({ input: { ...graph, fixtureMode: 'hang' }, binaryPath, signal: controller.signal })
    const timer = setTimeout(() => /* 在进程启动后触发主动取消。 */ controller.abort(), 200)
    try { await expect(result).rejects.toMatchObject({ code: 'AUDIT_CANCELLED' }) }
    finally { clearTimeout(timer) }
  })
  it('rejects oversized input before starting and terminates unbounded output', async () => {
    // 输入和输出的资源预算分别在实际边界生效，不依赖子进程自律。
    await expect(auditRunCangjie({ input: { ...graph, text: 'x'.repeat(AUDIT_INPUT_LIMIT_BYTES) }, binaryPath })).rejects.toMatchObject({ code: 'AUDIT_INPUT_TOO_LARGE', exitCode: 2 })
    await expect(auditRunCangjie({ input: { ...graph, fixtureMode: 'huge' }, binaryPath })).rejects.toMatchObject({ code: 'AUDIT_OUTPUT_TOO_LARGE', exitCode: 3 })
  })
  it('unwraps existing CLI success replies and rejects failed replies and export bundles', () => {
    // 只识别已约定的成功信封，避免误把失败或另一种导出格式变为空图。
    expect(auditNormalizeInput({ ok: true, data: graph })).toEqual(graph)
    expect(() => /* 验证失败响应被拒绝。 */ auditNormalizeInput({ ok: false, error: {} })).toThrow()
    expect(() => /* 验证v4数据包被拒绝。 */ auditNormalizeInput({ format: 'chongming-map', version: 4, map: graph })).toThrow()
  })
  it('exports markdown without changing input and refuses to overwrite an existing report', async () => {
    // 验证实际CLI文件路径的端到端输出及wx不覆盖行为。
    const input = await inputFile({ ok: true, data: graph }), before = await readFile(input)
    const output = path.join(directory, 'report.md')
    const result = await cli(['--input', input, '--format', 'markdown', '--output', output])
    expect(result.code, result.stderr).toBe(0)
    expect(await readFile(output, 'utf8')).toBe('# 仓颉协议测试\n')
    expect(await readFile(input)).toEqual(before)
    const duplicate = await cli(['--input', input, '--output', output])
    expect(duplicate.code).toBe(3); expect(duplicate.stderr).toContain('AUDIT_OUTPUT_FAILED')
    expect(await readFile(output, 'utf8')).toBe('# 仓颉协议测试\n')
  })
  it('rejects ambiguous arguments, bad JSON and failed envelopes before spawning', async () => {
    // 缺少或混合来源、坏JSON与失败响应都产生输入错误，而非成功报告。
    const input = await inputFile({ ok: false, error: { message: 'secret' } })
    for (const args of [[], ['--input', input, '--map-id', graph.mapId], ['--input', input, '--url', 'http://example.com'], ['--input', input]]) {
      const result = await cli(args)
      expect(result.code).toBe(2); expect(result.stdout).toBe(''); expect(result.stderr).not.toContain('secret')
    }
    await writeFile(input, '{bad')
    expect((await cli(['--input', input])).code).toBe(2)
    await writeFile(input, Buffer.from([0xff, 0xfe]))
    const invalidEncoding = await cli(['--input', input])
    expect(invalidEncoding.code).toBe(2)
    expect(JSON.parse(invalidEncoding.stderr).status).toBe('invalid')
  })
  it('reports a closed stdout pipe as execution failure without an uncaught stack', async () => {
    // 接收方仅读取首块后关闭真实管道，验证大型报告写入不会误用结构错误退出码1。
    const input = await inputFile({ ...graph, fixtureMode: 'inspect', text: 'x'.repeat(2 * 1024 * 1024) })
    const child = spawn(process.execPath, ['--import', 'tsx', 'apps/evidence-audit/main.ts', '--input', input], {
      env: { ...process.env, CHONGMING_CANGJIE_AUDIT_BIN: binaryPath }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stderr = '', received = false
    child.stdout.once('data', () => {
      // 模拟head读取足够数据后离开，剩余输出必须触发受控EPIPE处理。
      received = true; child.stdout.destroy()
    })
    child.stderr.on('data', (/* CLI受控错误输出块。 */ chunk: Buffer) => { /* 收集诊断并检查没有未捕获堆栈。 */ stderr += chunk.toString() })
    const exited = new Promise<number | null>((/* 子进程退出且管道关闭后返回退出码。 */ resolve, /* 进程启动失败。 */ reject) => {
      // 等待close而非exit，确保stderr尾部已经全部读完。
      child.once('error', reject)
      child.once('close', (/* CLI实际退出码。 */ code) => /* 交回真实进程结果。 */ resolve(code))
    })
    try {
      expect(await exited).toBe(3)
      expect(received).toBe(true)
      expect(JSON.parse(stderr)).toMatchObject({ status: 'execution-error', error: { code: 'AUDIT_STDOUT_FAILED' } })
      expect(stderr).not.toContain('Unhandled'); expect(stderr).not.toContain('node:events')
    } finally { child.kill('SIGKILL'); await exited }
  })
  it('reads only map.get through the existing public client and never passes the token to Cangjie', async () => {
    // 用本机隔离HTTP夹具核对查询协议与认证，不向真实图服务发送请求。
    const requests: Array<{ url: string | undefined; method: string | undefined; authorization: string | undefined; body: unknown }> = []
    const server = createServer(async (/* 隔离夹具收到的HTTP请求。 */ request, /* 仅本次请求的响应。 */ response) => {
      // 记录唯一的只读查询，返回满足公共客户端合同的合成快照。
      let body = ''; for await (const chunk of request) body += chunk.toString()
      requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body: JSON.parse(body) })
      const snapshot = { ...graph, fixtureMode: 'inspect', runs: [], ownershipRevision: 0, ownerships: [], runControls: [], updatedAt: '2026-10-22T00:00:00.000Z' }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, requestId: 'fixture-read', replayed: false, data: snapshot }))
    })
    await new Promise<void>((/* HTTP夹具开始监听后继续测试。 */ resolve) => /* 仅绑定回环随机端口。 */ server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP fixture')
    try {
      const result = await cli(['--map-id', graph.mapId, '--url', `http://127.0.0.1:${address.port}`], { CHONGMING_USER_TOKEN: 'fixture-user-token' })
      expect(result.code, result.stderr).toBe(0)
      expect(requests).toEqual([{ url: '/api/v1/query', method: 'POST', authorization: 'Bearer fixture-user-token', body: { method: 'map.get', params: { mapId: graph.mapId } } }])
      expect(JSON.parse(JSON.parse(result.stdout).markdown).env.CHONGMING_USER_TOKEN).toBeUndefined()
    } finally { await new Promise<void>((/* 等到夹具服务完全关闭。 */ resolve) => /* 释放测试HTTP监听器。 */ server.close(() => resolve())) }
  })
})
