// 验证诊断脱敏与轮转，以及真实进程的致命故障退出和关闭期限。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { diagnosticCreateReporter, diagnosticReadLine } from '../../platform/node/diagnostics'

/**
 * 启动指定故障模式的子进程，暴露退出等待和累计日志给测试断言。
 *
 * @param mode 选择未捕获异常、未处理拒绝、启动失败或关闭挂起的子进程场景。
 */
function diagnosticsRunChild(mode: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('tests/fixtures/process-boundary.ts'), mode], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', chunk => {
    // 收集子进程标准输出以观察就绪信号。
     stdout += chunk })
  child.stderr.on('data', chunk => {
    // 收集子进程诊断输出以检查故障类型与脱敏。
     stderr += chunk })
  const exited = new Promise<number | null>((resolve, reject) => {
    // 等待真实子进程退出，并传播进程创建错误。
     child.once('error', reject); child.once('exit', resolve) })
  return { child, exited, output: () => /* 返回当前累计的标准输出和错误输出。 */  ({ stdout, stderr }) }
}

describe('fatal process and diagnostic boundaries', () => {
  // 组织结构化日志、故障边界和关闭超时的回归场景。
  it('removes arbitrary messages, credentials and local paths while retaining bounded diagnostic structure', () => {
    // 验证诊断不读取危险 getter，也不泄漏原始错误消息、凭据或本机路径。
    const secret = 'secret-value', error = new Error(`Bearer ${secret} at ${process.cwd()}/private.ts`)
    Object.defineProperty(error, 'cause', { get() {
      // 模拟一旦被访问就抛错的 cause 属性，确认诊断器不会执行它。
       throw new Error('getter-secret') } })
    const output = diagnosticReadLine('test', 'instance', { name: 'request.failed', severity: 'error',
      context: { requestId: 'request', route: '/api/v1/query', reason: 'Bearer ' + secret }, error }).line
    expect(output).not.toContain(secret)
    expect(output).not.toContain(process.cwd())
    expect(output).not.toContain('getter-secret')
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.parse(output)).toMatchObject({ name: 'request.failed', component: 'test', errorId: expect.any(String),
      context: { requestId: 'request', route: '/api/v1/query' }, failure: { type: 'Error', stack: expect.any(Array) } })
  })

  it('rotates bounded desktop logs and tolerates an unavailable sink without throwing', async () => {
    // 验证日志达到上限后轮转，关闭后写入或输出路径故障均不向调用方抛错。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-diagnostics-'))
    try {
      const filename = path.join(directory, 'service.log')
      await writeFile(filename, Buffer.alloc(5 * 1024 * 1024, 120))
      const reporter = diagnosticCreateReporter({ component: 'desktop-service', filename, instanceId: 'instance' })
      expect(() => /* 向可写输出器记录错误，检查日志写入不会抛错。 */  reporter.report({ name: 'service.failed', severity: 'error', error: new Error('private') })).not.toThrow()
      expect((await readFile(filename + '.1')).byteLength).toBe(5 * 1024 * 1024)
      expect(JSON.parse(await readFile(filename, 'utf8'))).toMatchObject({ name: 'service.failed', component: 'desktop-service' })
      await reporter.close()
      expect(() => /* 向已关闭输出器写入，检查迟到事件不会抛错。 */  reporter.report({ name: 'late', severity: 'error' })).not.toThrow()
      const broken = diagnosticCreateReporter({ component: 'broken', filename: path.join(directory, 'missing', 'log') })
      expect(() => /* 向无效文件路径的输出器写入，检查日志失败被收敛。 */  broken.report({ name: 'write.failed', severity: 'error' })).not.toThrow()
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['uncaught', 'rejection', 'startup'])('exits a real child nonzero for %s without leaking its error message', async mode => {
    // 验证未捕获异常、未处理拒绝及启动失败均使真实进程非零退出且隐藏敏感消息。
    const child = diagnosticsRunChild(mode)
    expect(await child.exited).toBe(1)
    expect(child.output().stderr).toContain(mode === 'startup' ? 'process.start.failed' : 'process.fatal')
    expect(child.output().stderr).not.toContain('private-token-value')
  })

  it('bounds controlled shutdown from the moment the signal arrives', async () => {
    // 验证从终止信号到达开始计时，永不完成的关闭会在期限内报告失败并退出。
    const child = diagnosticsRunChild('shutdown')
    await expect.poll(() => /* 读取子进程输出，等待就绪后再发终止信号。 */  child.output().stdout).toContain('ready')
    const started = performance.now()
    child.child.kill('SIGTERM')
    expect(await child.exited).toBe(1)
    expect(performance.now() - started).toBeLessThan(1000)
    expect(child.output().stderr).toContain('shutdown.failed')
  })
})
