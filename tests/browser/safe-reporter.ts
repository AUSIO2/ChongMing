// M00 专用报告器：显式投影允许字段，原始故障、附件与 worker 输出均不进入终端。
import path from 'node:path'
import type { FullResult, Reporter, TestCase, TestError, TestResult } from '@playwright/test/reporter'
import { workspaceReadPerformanceReport } from './workspace-performance-report'

// npm 的测试入口在仓库根运行，避免为报告器改动整个工程的 CJS/ESM 模式。
const repositoryRoot = path.resolve(process.cwd())
const sourceFiles = new Set([
  'tests/browser/workspace-smoke.spec.ts',
  'tests/browser/workspace-acceptance.spec.ts',
  'tests/browser/workspace-reliability.spec.ts',
  'tests/browser/canvas-workspace-layout.spec.ts',
  'tests/browser/canvas-library-layout.spec.ts',
  'tests/browser/canvas-panels.spec.ts',
  'tests/browser/canvas-geometry.spec.ts',
  'tests/browser/fixtures/canvas-panels.html',
  'tests/browser/fixtures/canvas-geometry.html',
  'tests/browser/workspace-grant-reliability.spec.ts',
  'tests/browser/workspace-editing-reliability.spec.ts',
  'tests/browser/workspace-grant-relay.ts',
  'tests/browser/workspace-concurrency.spec.ts',
  'tests/browser/workspace-recovery.spec.ts',
  'tests/browser/workspace-recovery-lifecycle.spec.ts',
  'tests/browser/workspace-performance.spec.ts',
  'tests/browser/workspace-fixture.ts',
  'tests/browser/workspace-recovery-fixture.ts',
  'tests/browser/workspace-vite.ts',
  'tests/client/ui-fixture.ts',
  'tests/backend/fixtures/rabbitmq.ts',
  'tests/browser/fixtures/workspace-recovery-process.ts',
  'tests/browser/fixtures/workspace-startup-diagnostic.ts',
  'tests/browser/fixtures/runner-fault.spec.ts',
])

type ErrorCategory = 'assertion' | 'timeout' | 'interrupted' | 'other'
type TestStatus = TestResult['status'] | 'unknown'
interface SafeLocation { file: string; line: number; column: number }
interface SafeResult {
  id: string
  project: 'local' | 'collab' | 'unknown'
  status: TestStatus
  durationMs: number
  location: SafeLocation | null
  errorCounts: Record<ErrorCategory, number>
  errorLocations: SafeLocation[]
}

/** 只读取非数组对象，其他输入使用空记录；不遍历或复制原始字段。 */
function workspaceReadRecord(/* 待检查的报告元数据。 */ value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

/** 将来源限制为仓库内已登记的 M00 文件，并只返回相对静态名称。 */
function workspaceReadLocation(/* 不可信来源位置，路径和行列号分别检查。 */ value: unknown): SafeLocation | null {
  const location = workspaceReadRecord(value)
  if (typeof location.file !== 'string' || location.file.length > 4096 || /[\x00-\x1f]/.test(location.file)) return null
  const file = path.relative(repositoryRoot, path.resolve(repositoryRoot, location.file)).split(path.sep).join('/')
  if (!sourceFiles.has(file)) return null
  const line = location.line, column = location.column
  if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1 || line > 10_000_000
    || typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1 || column > 10_000_000) return null
  return { file, line, column }
}

/** 将有限非负毫秒值投影为数字，禁止 NaN、无穷与字符串穿透。 */
function workspaceReadDuration(/* 框架报告的运行毫秒数。 */ value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : 0
}

/** 仅根据结构化状态及固定错误名称分类，不解析或输出 message/stack/实际值。 */
function workspaceReadErrorCategory(
  /* 框架错误的结构化字段；正文和调用日志不读取。 */ value: unknown,
  /* 当前测试的已验证状态，超时/中断以框架状态为准。 */ status: TestStatus = 'unknown',
): ErrorCategory {
  if (status === 'timedOut') return 'timeout'
  if (status === 'interrupted') return 'interrupted'
  const error = workspaceReadRecord(value)
  if (error.name === 'AssertionError' || error.matcherResult !== undefined) return 'assertion'
  if (error.name === 'TimeoutError') return 'timeout'
  return 'other'
}

/** 从不可信测试结果构造安全 DTO；标题只提取登记编号，其他自由文本不复制。 */
export function workspaceReadSafeResult(/* 包含 title、project、location 和 result 的本次测试元数据。 */ input: unknown): SafeResult {
  const metadata = workspaceReadRecord(input), result = workspaceReadRecord(metadata.result)
  const id = typeof metadata.title === 'string' && metadata.title.length <= 4096
    ? metadata.title.match(/\b(?:M00-(?:A0[1-4]|R0[1-6]|P0[1-3]|Q0[1-7])|M01-C0[23]|M02-C0[45]|M03-C0[6-8]|M04-C10|M05-C1[12]|M06-C1[34]|M07-C1[567]|M08-C18|M09-C(?:19|20)|M10-C21|M11-C22)\b/)?.[0] ?? 'unregistered' : 'unregistered'
  const project = metadata.project === 'local' || metadata.project === 'collab' ? metadata.project : 'unknown'
  const status: TestStatus = result.status === 'passed' || result.status === 'failed' || result.status === 'timedOut'
    || result.status === 'skipped' || result.status === 'interrupted' ? result.status : 'unknown'
  const errorCounts: Record<ErrorCategory, number> = { assertion: 0, timeout: 0, interrupted: 0, other: 0 }
  const errorLocations: SafeLocation[] = []
  const errors: unknown[] = Array.isArray(result.errors) && result.errors.length ? result.errors : result.error === undefined ? [] : [result.error]
  for (const error of errors) {
    errorCounts[workspaceReadErrorCategory(error, status)] += 1
    const location = workspaceReadLocation(workspaceReadRecord(error).location)
    if (location) errorLocations.push(location)
  }
  if (!errors.length && (status === 'failed' || status === 'timedOut' || status === 'interrupted')) {
    errorCounts[workspaceReadErrorCategory(undefined, status)] = 1
  }
  return { id, project, status, durationMs: workspaceReadDuration(result.duration),
    location: workspaceReadLocation(metadata.location), errorCounts, errorLocations }
}

/** 只序列化本模块已经显式构造的安全事件，每次输出一条 JSON 行。 */
function workspaceWriteEvent(/* 无原始错误、附件或自由文本的受控事件。 */ event: object): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

/** 使用 Playwright 原生生命周期，抑制 worker 文本并报告最小结果。 */
export default class WorkspaceSafeReporter implements Reporter {
  private stdoutChunks = 0
  private stderrChunks = 0
  private hasRejectedPerformance = false

  /** 宣告由此报告器负责终端输出，避免框架附加默认文本报告器。 */
  printsToStdio(): boolean { return true }

  /** 测试结束时只发送静态编号、项目、结果、耗时、源码位置和类别计数。 */
  onTestEnd(
    /* 框架用例；标题不会完整输出，项目只允许 local/collab。 */ test: TestCase,
    /* 框架本次结果；原始错误、附件及输出不复制。 */ result: TestResult,
  ): void {
    // 先报告受限测试结果，再单独校验唯一性能附件，非法样本不能被静默丢弃。
    const safe = workspaceReadSafeResult({ title: test.title, project: test.parent.project()?.name, location: test.location, result })
    workspaceWriteEvent({ type: 'test-end', ...safe })
    const reports = result.attachments.filter(
      /* 只接受性能用例明确登记的唯一 JSON 附件。 */ attachment => attachment.name === 'm00-performance',
    )
    if (!reports.length) {
      if (/^M00-P0[1-3]$/.test(safe.id) && safe.status === 'passed') {
        this.hasRejectedPerformance = true
        workspaceWriteEvent({ type: 'performance-rejected', id: safe.id, project: safe.project })
      }
      return
    }
    const attachment = reports[0]
    let report: ReturnType<typeof workspaceReadPerformanceReport> = null
    if (reports.length === 1 && attachment.contentType === 'application/json'
      && Buffer.isBuffer(attachment.body) && attachment.body.length <= 8 * 1024 * 1024) {
      try {
        const payload: unknown = JSON.parse(attachment.body.toString('utf8'))
        report = workspaceReadPerformanceReport(payload, safe.id)
      } catch {
        // 无效 JSON 整份拒绝，不输出正文、解析错误或原路径。
      }
    }
    if (report && (safe.project === 'local' && report.storage === 'sqlite'
      || safe.project === 'collab' && report.storage === 'mongo')) {
      workspaceWriteEvent({ type: 'performance', project: safe.project, ...report })
    } else {
      this.hasRejectedPerformance = true
      workspaceWriteEvent({ type: 'performance-rejected', id: safe.id, project: safe.project })
    }
  }

  /** 只统计被抑制的标准输出块，不读取或转发其内容。 */
  onStdOut(
    /* 被抑制的 worker 标准输出。 */ _chunk: string | Buffer,
    /* 输出所属用例；不传播其标题或其他字段。 */ _test?: TestCase | void,
    /* 输出所属结果；不序列化运行负载。 */ _result?: TestResult | void,
  ): void { this.stdoutChunks += 1 }

  /** 只统计被抑制的标准错误块，不读取或转发其内容。 */
  onStdErr(
    /* 被抑制的 worker 标准错误。 */ _chunk: string | Buffer,
    /* 输出所属用例；不传播其标题或其他字段。 */ _test?: TestCase | void,
    /* 输出所属结果；不序列化运行负载。 */ _result?: TestResult | void,
  ): void { this.stderrChunks += 1 }

  /** 框架错误仅保留固定类别及允许的源位置，不打印消息与堆栈。 */
  onError(/* 框架级错误；仅检查结构化分类与受限位置。 */ error: TestError): void {
    workspaceWriteEvent({ type: 'framework-error', category: workspaceReadErrorCategory(error), location: workspaceReadLocation(error.location) })
  }

  /** 整轮结束时报告抑制数量；非法性能附件必须使整轮失败，避免丢掉样本后仍报通过。 */
  async onEnd(/* 框架整轮结果；只采用枚举状态和有限耗时。 */ result: FullResult): Promise<{ status?: FullResult['status'] } | undefined> {
    // 抑制工作进程自由文本，并让报告格式错误影响真实退出结果。
    workspaceWriteEvent({ type: 'suppressed-output', stdoutChunks: this.stdoutChunks, stderrChunks: this.stderrChunks })
    const status = this.hasRejectedPerformance ? 'failed' : result.status === 'passed' || result.status === 'failed' || result.status === 'timedout'
      || result.status === 'interrupted' ? result.status : 'unknown'
    workspaceWriteEvent({ type: 'run-end', status, durationMs: workspaceReadDuration(result.duration) })
    return this.hasRejectedPerformance ? { status: 'failed' } : undefined
  }
}
