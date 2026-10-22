// 用真实 Playwright 故障子进程检查终端和最终报告产物，不装配业务后端。
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, readdir, readlink, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'

interface RunnerResult { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }
interface ObservedChild { child: ChildProcess; hasClosed: boolean; closed: Promise<void>; dispose: () => void }

enum ReporterArtifactError {
  RUNNER_TIMEOUT = 'M00 故障子 runner 未在 25 秒内结束',
  START_FAILED = 'M00 故障子 runner 启动失败',
  STOP_FAILED = 'M00 故障子 runner 收尾失败',
  CLOSE_TIMEOUT = 'M00 故障子 runner 未在收尾期限内确认结束，保留临时目录',
  NON_OBJECT_EVENT = 'M00 非对象报告事件',
  INVALID_OUTPUT = 'M00 故障子 runner 输出包含非 JSON 事件',
}

/** 从创建时开始观察本轮 child 的实际 close，不根据 PID 或退出请求推断结束。 */
function reporterObserveChild(/* 本用例刚创建、尚未等待的独立子进程。 */ child: ChildProcess): ObservedChild {
  let resolveClosed: () => void = () => { /* 创建 Promise 后立即替换完成通知。 */ }
  const closed = new Promise<void>((/* child 真正 close 后的完成通知。 */ resolve) => { resolveClosed = resolve })
  /** close 已包含标准流关闭，只在此时允许移除自有目录。 */
  function acceptClose(): void { observed.hasClosed = true; resolveClosed() }
  const observed: ObservedChild = { child, hasClosed: false, closed,
    /** 移除本轮观察监听；正常 close 的 once 监听已经自动释放。 */
    dispose: () => { child.off('close', acceptClose) },
  }
  child.once('close', acceptClose)
  return observed
}

/** 仅读取新建私有目录中的相对路径和文件字节；符号链接只检查目标文本而不跟随。 */
async function reporterArtifactsContainCanary(
  /* 本用例拥有的临时输出目录，递归始终限制在其内部。 */ directory: string,
  /* 本轮随机秘密哨兵，仅用于布尔比较，不写进断言消息。 */ canary: string,
): Promise<boolean> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.includes(canary)) return true
    const filename = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (await reporterArtifactsContainCanary(filename, canary)) return true
    } else if (entry.isSymbolicLink()) {
      if ((await readlink(filename)).includes(canary)) return true
    } else if (entry.isFile() && (await readFile(filename)).includes(Buffer.from(canary))) return true
  }
  return false
}

/** 将子进程输出留在内存，超时或启动错误只抛固定说明，不转发原始错误。 */
function reporterReadChild(
  /* 本用例刚创建的独立进程组首进程。 */ child: ChildProcess,
): Promise<RunnerResult> {
  return new Promise((
    /* 接纳子 runner 的退出状态和内存输出。 */ resolve,
    /* 拒绝基础设施故障，异常正文使用固定中文说明。 */ reject,
  ) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = []
    /** 只在内存保存标准输出，不向外层测试转发。 */
    function acceptStdout(/* 本轮 child 的标准输出块。 */ chunk: Buffer): void { stdout.push(chunk) }
    /** 只在内存保存标准错误，不向外层测试转发。 */
    function acceptStderr(/* 本轮 child 的标准错误块。 */ chunk: Buffer): void { stderr.push(chunk) }
    /** 解除本轮结果读取持有的所有监听和超时计时器。 */
    function cleanup(): void {
      clearTimeout(timer)
      child.stdout?.off('data', acceptStdout); child.stderr?.off('data', acceptStderr)
      child.off('error', acceptError); child.off('close', acceptClose)
    }
    /** 用固定文案报告启动错误，不复制 spawn 的 message 或 stack。 */
    function acceptError(): void { cleanup(); reject(new Error(ReporterArtifactError.START_FAILED)) }
    /** 标准流已关闭后一次性接纳结果，避免扫描尚未完成的产物。 */
    function acceptClose(
      /* 子进程的实际退出码。 */ code: number | null,
      /* 子进程退出时收到的终止信号。 */ signal: NodeJS.Signals | null,
    ): void {
      cleanup()
      resolve({ code, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
    }
    const timer = setTimeout(() => {
      // 有界等待后交由外层 finally 结束自有进程组。
      cleanup(); reject(new Error(ReporterArtifactError.RUNNER_TIMEOUT))
    }, 25_000)
    child.stdout?.on('data', acceptStdout); child.stderr?.on('data', acceptStderr)
    child.once('error', acceptError); child.once('close', acceptClose)
  })
}

/** 仅向本用例创建的进程组发信号，已结束的组视作完成。 */
function reporterSignalChild(
  /* 本用例创建的子进程观察记录，PID 不来自用户输入或全局进程扫描。 */ observed: ObservedChild,
  /* 有界收尾使用的固定终止信号。 */ signal: 'SIGTERM' | 'SIGKILL',
): void {
  const child = observed.child
  if (observed.hasClosed || !child.pid || child.exitCode !== null || child.signalCode !== null) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (cause) {
    // 只有进程已经结束可忽略；其他终止失败保留为固定诊断。
    if ((cause as NodeJS.ErrnoException).code !== 'ESRCH') throw new Error(ReporterArtifactError.STOP_FAILED)
  }
}

/** 等待实际 close 或当前阶段时限，结束后立即释放受限计时器。 */
async function reporterWaitForClose(
  /* 本轮 child 的实际 close 观察记录。 */ observed: ObservedChild,
  /* 当前阶段剩余等待毫秒数，由统一收尾期限计算。 */ timeoutMs: number,
): Promise<boolean> {
  if (observed.hasClosed) return true
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      observed.closed.then(() => { /* 只有实际 close 才返回成功。 */ return true }),
      new Promise<boolean>((/* 阶段超时只返回未结束，不伪造 close。 */ resolve) => {
        timer = setTimeout(() => { /* 等待已用完当前阶段时间。 */ resolve(false) }, Math.max(0, timeoutMs))
      }),
    ])
  } finally { clearTimeout(timer) }
}

/** 观察本轮 child 的实际 close；统一五秒期限内按需要升级终止，不向已结束进程发信号。 */
async function reporterStopChild(/* 本用例创建、需要确认收尾的子进程记录。 */ observed: ObservedChild): Promise<void> {
  if (observed.hasClosed) return
  const deadline = performance.now() + 5_000
  reporterSignalChild(observed, 'SIGTERM')
  if (await reporterWaitForClose(observed, Math.min(2_500, deadline - performance.now()))) return
  reporterSignalChild(observed, 'SIGKILL')
  if (!await reporterWaitForClose(observed, deadline - performance.now())) throw new Error(ReporterArtifactError.CLOSE_TIMEOUT)
}

/** 只将 JSON 对象接纳为安全事件；无效输出不在错误中重放。 */
function reporterReadEvents(/* 子 runner 的内存标准输出，不交给外层报告。 */ stdout: string): Record<string, unknown>[] {
  const events: Record<string, unknown>[] = []
  for (const line of stdout.split('\n').filter(Boolean)) {
    try {
      const value: unknown = JSON.parse(line)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(ReporterArtifactError.NON_OBJECT_EVENT)
      events.push(value as Record<string, unknown>)
    } catch { throw new Error(ReporterArtifactError.INVALID_OUTPUT) }
  }
  return events
}

it('M00-Q07 keeps the deliberate browser failure while final output and artifacts contain no secret canary', async () => {
  // 真实运行密码输入和断言失败；只以布尔值检查泄漏，避免外层失败反向泄漏秘密。
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chongming-m00-report-'))
  let observed: ObservedChild | undefined
  try {
    await chmod(directory, 0o700)
    const outputDir = path.join(directory, 'output')
    await mkdir(outputDir, { mode: 0o700 })
    const canary = `m00-canary-${randomBytes(16).toString('hex')}`
    expect((await stat(directory)).mode & 0o777).toBe(0o700)
    const repositoryRoot = path.resolve(process.cwd())
    const child = spawn(process.execPath, [path.join(repositoryRoot, 'node_modules/playwright/cli.js'),
      'test', '--config', path.join(repositoryRoot, 'tests/browser/fixtures/playwright-fault.config.ts')], {
      cwd: repositoryRoot, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, SystemRoot: process.env.SystemRoot,
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH,
        TMPDIR: directory, TMP: directory, TEMP: directory, CI: '1', FORCE_COLOR: '0',
        CHONGMING_M00_FAULT_OUTPUT_DIR: outputDir, CHONGMING_M00_REPORT_CANARY: canary,
      },
    })
    observed = reporterObserveChild(child)
    const result = await reporterReadChild(child)
    expect(result.stdout.includes(canary)).toBe(false)
    expect(result.stderr.includes(canary)).toBe(false)
    expect(result.code).toBe(1)
    expect(result.signal === null).toBe(true)
    const events = reporterReadEvents(result.stdout)
    expect(events.some((/* 安全报告中的一次测试结果。 */ event) => event.type === 'test-end'
      && event.id === 'M00-Q07' && event.project === 'local' && event.status === 'failed')).toBe(true)
    expect(events.some((/* 输出块计数证明已执行页面填值后的故障步骤。 */ event) => event.type === 'suppressed-output'
      && typeof event.stdoutChunks === 'number' && event.stdoutChunks >= 1
      && typeof event.stderrChunks === 'number' && event.stderrChunks >= 1)).toBe(true)
    expect(await reporterArtifactsContainCanary(outputDir, canary)).toBe(false)
  } finally {
    // 只有实际 close 后才删除私有目录；未确认收尾则保留目录并使测试失败。
    try {
      if (observed) await reporterStopChild(observed)
      await rm(directory, { recursive: true, force: true })
    } finally { observed?.dispose() }
  }
  expect(observed?.hasClosed).toBe(true)
  expect(await stat(directory).then(() => { /* 目录仍存在即未完成清理。 */ return false },
    (/* 仅将目录确已不存在视作清理成功，不输出原始系统错误。 */ cause: unknown) =>
      (cause as NodeJS.ErrnoException).code === 'ENOENT')).toBe(true)
}, 35_000)
