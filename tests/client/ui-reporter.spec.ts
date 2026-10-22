// 验证 M00 报告只保留静态身份与结果，不将故障负载写入公开输出。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FullResult, TestCase, TestError, TestResult } from '@playwright/test/reporter'
import WorkspaceSafeReporter, { workspaceReadSafeResult } from '../browser/safe-reporter'

const repositoryRoot = fileURLToPath(new URL('../../', import.meta.url))
const canary = 'M00_CANARY_TOKEN_SHOULD_NEVER_REACH_REPORT'

/** 构造只读报告输入；故意附加含秘密的断言、附件与工作进程输出。 */
function reporterCreateInput() {
  return {
    title: `M00-Q07 故障检查 ${canary}`,
    project: 'local',
    location: { file: path.join(repositoryRoot, 'tests/browser/workspace-smoke.spec.ts'), line: 23, column: 5 },
    result: {
      status: 'failed', duration: 31.75,
      errors: [{ name: 'AssertionError', message: canary, stack: canary,
        matcherResult: { actual: canary, expected: canary, message: canary }, cause: { message: canary } }],
      error: { message: canary }, stdout: [canary], stderr: [Buffer.from(canary)],
      attachments: [{ name: canary, path: canary, body: Buffer.from(canary) }],
      annotations: [{ type: 'description', description: canary }],
    },
  }
}

/** 构造报告器实际回调使用的最小用例形状，不装配运行服务或假后端。 */
function reporterCreateTest() {
  const input = reporterCreateInput()
  return { title: input.title, location: input.location, parent: {
    /** 仅提供固定项目身份，模拟 Playwright 的父套件项目读取。 */
    project: () => ({ name: 'local' }),
  } } as unknown as TestCase
}

afterEach(() => {
  // 每例后恢复进程写入方法，避免影响其他 Vitest 用例。
  vi.restoreAllMocks()
})

describe('M00 safe reporter', () => {
  // 这些用例独立验证 DTO 白名单及 Playwright 回调的输出边界。
  it('preserves registered static identity, project, result and repository location only', () => {
    // 完整负载中的秘密不得跟随合法编号或失败结果进入 DTO。
    const result = workspaceReadSafeResult(reporterCreateInput())
    expect(JSON.stringify(result).includes(canary)).toBe(false)
    expect(result).toEqual({
      id: 'M00-Q07', project: 'local', status: 'failed', durationMs: 31.75,
      location: { file: 'tests/browser/workspace-smoke.spec.ts', line: 23, column: 5 },
      errorCounts: { assertion: 1, timeout: 0, interrupted: 0, other: 0 },
      errorLocations: [],
    })
  })

  it('extracts only registered IDs from parameterized titles and rejects arbitrary project text', () => {
    // 标题和项目的自由参数不可成为公开报告标签。
    const input = reporterCreateInput()
    const safe = workspaceReadSafeResult({ ...input, title: `M00-A01 token=${canary}`, project: `local-${canary}` })
    expect(safe.id).toBe('M00-A01')
    expect(safe.project).toBe('unknown')
    expect(JSON.stringify(safe).includes(canary)).toBe(false)
    expect(workspaceReadSafeResult({ ...input, title: `M00-A99 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M00-Q070 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M01-C02 ${canary}` }).id).toBe('M01-C02')
    expect(workspaceReadSafeResult({ ...input, title: `M01-C020 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M01-C03 ${canary}` }).id).toBe('M01-C03')
    expect(workspaceReadSafeResult({ ...input, title: `M01-C030 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M02-C04 ${canary}` }).id).toBe('M02-C04')
    expect(workspaceReadSafeResult({ ...input, title: `M02-C040 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M02-C05 ${canary}` }).id).toBe('M02-C05')
    expect(workspaceReadSafeResult({ ...input, title: `M02-C050 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M03-C06 ${canary}` }).id).toBe('M03-C06')
    expect(workspaceReadSafeResult({ ...input, title: `M03-C060 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M03-C07 ${canary}` }).id).toBe('M03-C07')
    expect(workspaceReadSafeResult({ ...input, title: `M03-C070 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M03-C08 ${canary}` }).id).toBe('M03-C08')
    expect(workspaceReadSafeResult({ ...input, title: `M03-C080 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M04-C10 ${canary}` }).id).toBe('M04-C10')
    expect(workspaceReadSafeResult({ ...input, title: `M04-C100 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M04-C09 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M05-C11 ${canary}` }).id).toBe('M05-C11')
    expect(workspaceReadSafeResult({ ...input, title: `M05-C110 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M05-C12 ${canary}` }).id).toBe('M05-C12')
    expect(workspaceReadSafeResult({ ...input, title: `M05-C120 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M06-C13 ${canary}` }).id).toBe('M06-C13')
    expect(workspaceReadSafeResult({ ...input, title: `M06-C130 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M06-C14 ${canary}` }).id).toBe('M06-C14')
    expect(workspaceReadSafeResult({ ...input, title: `M06-C140 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M06-C15 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M07-C15 ${canary}` }).id).toBe('M07-C15')
    expect(workspaceReadSafeResult({ ...input, title: `M07-C150 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M07-C16 ${canary}` }).id).toBe('M07-C16')
    expect(workspaceReadSafeResult({ ...input, title: `M07-C160 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M09-C20 ${canary}` }).id).toBe('M09-C20')
    expect(workspaceReadSafeResult({ ...input, title: `M10-C21 ${canary}` }).id).toBe('M10-C21')
    expect(workspaceReadSafeResult({ ...input, title: `M11-C22 ${canary}` }).id).toBe('M11-C22')
    expect(workspaceReadSafeResult({ ...input, title: `M09-C200 ${canary}` }).id).toBe('unregistered')
    expect(workspaceReadSafeResult({ ...input, title: `M07-C17 ${canary}` }).id).toBe('M07-C17')
    expect(workspaceReadSafeResult({ ...input, title: `M08-C18 ${canary}` }).id).toBe('M08-C18')
    expect(workspaceReadSafeResult({ ...input, title: `M09-C19 ${canary}` }).id).toBe('M09-C19')
    expect(workspaceReadSafeResult({ ...input, title: `M11-C23 ${canary}` }).id).toBe('unregistered')
  })

  it('rejects external, unregistered and invalid source locations without exposing their text', () => {
    // 路径只能来自本仓库已经登记的 M00 源文件。
    const input = reporterCreateInput()
    const files = [
      `/tmp/${canary}/tests/browser/workspace-smoke.spec.ts`,
      path.join(repositoryRoot, `tests/browser/${canary}.spec.ts`),
      path.join(repositoryRoot, 'tests/browser/fixtures/../../secrets.ts'),
    ]
    for (const file of files) {
      const safe = workspaceReadSafeResult({ ...input, location: { file, line: 1, column: 1 } })
      expect(safe.location).toBeNull()
      expect(JSON.stringify(safe).includes(canary)).toBe(false)
    }
    expect(workspaceReadSafeResult({ ...input, location: { ...input.location, line: 0 } }).location).toBeNull()
    expect(workspaceReadSafeResult({ ...input, location: { ...input.location, column: Number.NaN } }).location).toBeNull()
  })

  it('normalizes malformed results and counts fixed error categories without parsing messages', () => {
    // 相同错误消息不能改变类别；超时与中断由结构化状态确定。
    const input = reporterCreateInput()
    const result = workspaceReadSafeResult({ ...input, project: 'collab', result: {
      status: 'failed', duration: -1,
      errors: [{ message: 'expect(received).toBe(expected)' }, { name: 'AssertionError', message: canary },
        { name: 'TimeoutError', message: canary }, { message: canary }],
    } })
    expect(result).toMatchObject({ project: 'collab', durationMs: 0,
      errorCounts: { assertion: 1, timeout: 1, interrupted: 0, other: 2 } })
    expect(workspaceReadSafeResult({ ...input, result: { status: 'timedOut', duration: 50, errors: [{}] } }).errorCounts)
      .toEqual({ assertion: 0, timeout: 1, interrupted: 0, other: 0 })
    expect(workspaceReadSafeResult({ ...input, result: { status: 'interrupted', duration: 50, errors: [] } }).errorCounts)
      .toEqual({ assertion: 0, timeout: 0, interrupted: 1, other: 0 })
    expect(workspaceReadSafeResult({ ...input, result: { status: 'passed', duration: Number.POSITIVE_INFINITY, errors: [] } }))
      .toMatchObject({ durationMs: 0, errorCounts: { assertion: 0, timeout: 0, interrupted: 0, other: 0 } })
    expect(workspaceReadSafeResult(null)).toMatchObject({ id: 'unregistered', project: 'unknown', status: 'unknown', location: null })
  })

  it('preserves registered assertion locations while discarding external locations and raw diagnostic text', () => {
    // 单独保留断言所在源码行，使失败不只定位到 test 的定义行。
    const input = reporterCreateInput()
    const safe = workspaceReadSafeResult({ ...input, result: { ...input.result, errors: [
      { message: canary, stack: canary, matcherResult: { actual: canary }, location: {
        file: path.join(repositoryRoot, 'tests/browser/workspace-smoke.spec.ts'), line: 47, column: 9,
      } },
      { message: canary, location: { file: `/tmp/${canary}.ts`, line: 2, column: 1 } },
      { message: canary, location: { file: path.join(repositoryRoot, `tests/browser/${canary}.spec.ts`), line: 2, column: 1 } },
      { message: canary, location: { ...input.location, line: 0 } },
      { message: canary },
    ] } })
    expect(JSON.stringify(safe).includes(canary)).toBe(false)
    expect(safe).toMatchObject({
      location: { file: 'tests/browser/workspace-smoke.spec.ts', line: 23, column: 5 },
      errorLocations: [{ file: 'tests/browser/workspace-smoke.spec.ts', line: 47, column: 9 }],
      errorCounts: { assertion: 1, timeout: 0, interrupted: 0, other: 4 },
    })
  })

  it('writes JSON lines only and suppresses worker output, assertion actual values and framework errors', async () => {
    // 实际调用 reporter 回调，截取进程输出并只检查布尔泄漏结果。
    const lines: string[] = []
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((
      /* 报告器交给标准输出的受控 JSON 行。 */ chunk: string | Uint8Array,
    ) => { lines.push(String(chunk)); return true })
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      // 报告器不应向标准错误转发原始内容。
      return true
    })
    const reporter = new WorkspaceSafeReporter()
    const input = reporterCreateInput(), test = reporterCreateTest()
    reporter.onStdOut(`${canary}\n`, test, input.result as unknown as TestResult)
    reporter.onStdErr(Buffer.from(canary), test, input.result as unknown as TestResult)
    reporter.onTestEnd(test, input.result as unknown as TestResult)
    reporter.onError({ message: canary, stack: canary, value: canary,
      location: { file: `/tmp/${canary}.ts`, line: 1, column: 1 } } as TestError)
    await reporter.onEnd({ status: 'failed', duration: 99 } as FullResult)
    const stderrCalls = stderr.mock.calls.length
    stdout.mockRestore(); stderr.mockRestore()

    const output = lines.join('')
    expect(output.includes(canary)).toBe(false)
    expect(lines.every((/* 每个输出块必须是一条完整 JSON 行。 */ line) => line.endsWith('\n'))).toBe(true)
    const events: unknown[] = lines.map((/* 一条只含允许字段的输出行。 */ line) => JSON.parse(line))
    expect(events).toContainEqual({ type: 'test-end', ...workspaceReadSafeResult(input) })
    expect(events).toContainEqual({ type: 'framework-error', category: 'other', location: null })
    expect(events).toContainEqual({ type: 'suppressed-output', stdoutChunks: 1, stderrChunks: 1 })
    expect(events).toContainEqual({ type: 'run-end', status: 'failed', durationMs: 99 })
    expect(stderrCalls).toBe(0)
  })

  it('publishes only validated performance numbers and fails the run when an attachment is malformed', async () => {
    // 经过真实 reporter 回调验证合法附件保留样本，非法正文不泄漏且不能得到绿色整轮结果。
    const lines: string[] = []
    vi.spyOn(process.stdout, 'write').mockImplementation((
      /* 报告器最终写出的受控 JSON 行。 */ chunk: string | Uint8Array,
    ) => { lines.push(String(chunk)); return true })
    const reporter = new WorkspaceSafeReporter()
    const test = { ...reporterCreateTest(), title: `M00-P03 ${canary}` } as TestCase
    const payload = { schemaVersion: 1, caseId: 'M00-P03', profile: 'calibration', storage: 'sqlite',
      thresholdStatus: 'proposed', measurementClock: 'driver-monotonic-with-browser-raf', token: canary,
      counts: { nodes: 200, edges: 800, derivedReferences: 0, payloadBytes: 4000, jsonBytes: 6000 },
      metrics: [{ name: 'stress8_operation_ms', unit: 'ms', values: [12, 30_000], unavailable: false }] }
    const result = { ...reporterCreateInput().result, status: 'passed', errors: [],
      attachments: [{ name: 'm00-performance', contentType: 'application/json', body: Buffer.from(JSON.stringify(payload)) }] }
    reporter.onTestEnd(test, result as unknown as TestResult)
    reporter.onTestEnd(test, { ...result, attachments: [{ name: 'm00-performance', contentType: 'application/json',
      body: Buffer.from(`invalid-json-${canary}`) }] } as unknown as TestResult)
    reporter.onTestEnd(test, { ...result, attachments: [] } as unknown as TestResult)
    const final = await reporter.onEnd({ status: 'passed', duration: 90 } as FullResult)
    const events: unknown[] = lines.map((/* 最终输出的完整 JSON 行。 */ line) => JSON.parse(line))
    expect(lines.join('').includes(canary)).toBe(false)
    expect(events).toContainEqual({ type: 'performance', project: 'local', schemaVersion: 1, caseId: 'M00-P03',
      profile: 'calibration', storage: 'sqlite', thresholdStatus: 'proposed',
      measurementClock: 'driver-monotonic-with-browser-raf', counts: payload.counts, metrics: payload.metrics })
    expect(events).toContainEqual({ type: 'performance-rejected', id: 'M00-P03', project: 'local' })
    expect(events.filter((/* 一条经过报告器输出的 JSON 事件。 */ event) => event !== null && typeof event === 'object'
      && 'type' in event && event.type === 'performance-rejected')).toHaveLength(2)
    expect(events).toContainEqual({ type: 'run-end', status: 'failed', durationMs: 90 })
    expect(final).toEqual({ status: 'failed' })
  })
})
