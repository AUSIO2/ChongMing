// 检查性能报告只保留固定元信息和全部合法数字样本，不以丢样本掩盖故障。
import { describe, expect, it } from 'vitest'
import { workspaceReadPerformanceReport } from '../browser/workspace-performance-report'

const canary = 'm00-performance-canary-must-not-be-public'

/** 构造与真实 P03 相同的受控附件形状，不装配浏览器或业务服务。 */
function performanceCreateReport() {
  return {
    schemaVersion: 1, caseId: 'M00-P03', profile: 'calibration', storage: 'sqlite', thresholdStatus: 'proposed',
    measurementClock: 'driver-monotonic-with-browser-raf',
    counts: { nodes: 200, edges: 800, derivedReferences: 100, payloadBytes: 400_000, jsonBytes: 600_000 },
    metrics: [
      { name: 'stress8_operation_ms', unit: 'ms', values: [1.25, 7, 30_000], unavailable: false },
      { name: 'stress8_operation_status', unit: 'count', values: [0, 0, 2], unavailable: false },
      { name: 'service_memory_bytes', unit: 'bytes', values: [], unavailable: true },
      { name: 'browser_js_heap_bytes', unit: 'bytes', values: [10_000_000, 12_000_000], unavailable: false },
    ],
    environment: { nodeVersion: 'v24.0.0', chromiumVersion: '142.0.1.2', platform: 'darwin', arch: 'arm64',
      viewportWidth: 1440, viewportHeight: 900, deviceScaleFactor: 2, gpuMode: 'software' },
    load: { formalDuration: 0, targetReadPercent: 80, targetWritePercent: 20, enduranceTargetRate: 3,
      browserContexts: 2, browserObservationRate: 1, stress8Scheduled: 3, stress8Completed: 3,
      stress8TargetDurationMs: 3_000, stress8ActualDurationMs: 3_100, stress8Status0: 2, stress8Status2: 1,
      stress8ConcurrencyLimit: 8, stress8OperationLimit: 40, stress8UiFailures: 0 },
  }
}

describe('M00 safe performance reports', () => {
  // 合法结果保留与非法报告拒绝分别测试，避免只以字符串替换冒充白名单投影。
  it('preserves real metrics, failure samples, environment classification and unavailable measurements', () => {
    // 超时样本仍存在，未知 GPU/服务端观测保持 unavailable 而不是零值。
    const input = performanceCreateReport()
    const safe = workspaceReadPerformanceReport(input, 'M00-P03')
    expect(safe).toEqual(input)
    expect(safe?.metrics[0]?.values).not.toBe(input.metrics[0]?.values)
    expect(safe?.metrics[0]?.values).toHaveLength(3)
  })

  it('projects fixed fields and drops canaries contained only in unknown diagnostic fields', () => {
    // 未知自由文本从任何层级都不复制，已登记的数值原样保留。
    const input = performanceCreateReport()
    const safe = workspaceReadPerformanceReport({ ...input, token: canary, message: canary,
      environment: { ...input.environment, stack: canary },
      counts: { ...input.counts, secret: canary }, load: { ...input.load, secret: canary },
      metrics: input.metrics.map((/* 一条真实指标。 */ metric) => ({ ...metric, actual: canary, path: canary })),
    }, 'M00-P03')
    expect(safe !== null).toBe(true)
    expect(JSON.stringify(safe).includes(canary)).toBe(false)
    expect(safe).toEqual(input)
  })

  it('rejects secret strings and invalid enums in known fields instead of emitting them', () => {
    // 已知字段不能通过嵌入自由参数逃过枚举、版本或数值检查。
    const input = performanceCreateReport()
    const invalid: unknown[] = [
      { ...input, profile: canary }, { ...input, storage: canary }, { ...input, thresholdStatus: canary },
      { ...input, measurementClock: canary }, { ...input, counts: { ...input.counts, nodes: canary } },
      { ...input, load: { stress8Scheduled: canary } },
      { ...input, environment: { ...input.environment, nodeVersion: canary } },
      { ...input, environment: { ...input.environment, chromiumVersion: `142.0.${canary}` } },
      { ...input, environment: { ...input.environment, platform: canary } },
      { ...input, environment: { ...input.environment, arch: canary } },
      { ...input, environment: { ...input.environment, gpuMode: canary } },
      { ...input, metrics: [{ name: canary, unit: 'ms', values: [1], unavailable: false }] },
      { ...input, metrics: [{ name: 'round_trip_ms', unit: canary, values: [1], unavailable: false }] },
    ]
    for (const value of invalid) expect(workspaceReadPerformanceReport(value, 'M00-P03') === null).toBe(true)
  })

  it('rejects ID mismatches and unsupported schema versions', () => {
    // 不能用别的附件冒充当前用例，也不接受任意 M00 编号或未知版本。
    const input = performanceCreateReport()
    expect(workspaceReadPerformanceReport(input, 'M00-P01')).toBeNull()
    expect(workspaceReadPerformanceReport({ ...input, caseId: 'M00-P04' }, 'M00-P04')).toBeNull()
    expect(workspaceReadPerformanceReport({ ...input, schemaVersion: 2 }, 'M00-P03')).toBeNull()
    expect(workspaceReadPerformanceReport(null, 'M00-P03')).toBeNull()
    expect(workspaceReadPerformanceReport([], 'M00-P03')).toBeNull()
  })

  it('rejects invalid raw samples, mismatched units, duplicates and contradictory unavailable flags', () => {
    // NaN/Infinity/负数/字符串均导致整份拒绝，不先 filter 再伪装样本完整。
    const input = performanceCreateReport()
    const metrics: unknown[] = [
      { name: 'round_trip_ms', unit: 'ms', values: [1, Number.NaN, 3], unavailable: false },
      { name: 'round_trip_ms', unit: 'ms', values: [Number.POSITIVE_INFINITY], unavailable: false },
      { name: 'round_trip_ms', unit: 'ms', values: [-1], unavailable: false },
      { name: 'round_trip_ms', unit: 'ms', values: [canary], unavailable: false },
      { name: 'round_trip_ms', unit: 'bytes', values: [1], unavailable: false },
      { name: 'round_trip_ms', unit: 'ms', values: [], unavailable: false },
      { name: 'round_trip_ms', unit: 'ms', values: [1], unavailable: true },
    ]
    for (const metric of metrics) expect(workspaceReadPerformanceReport({ ...input, metrics: [metric] }, 'M00-P03') === null).toBe(true)
    expect(workspaceReadPerformanceReport({ ...input, metrics: [input.metrics[0], input.metrics[0]] }, 'M00-P03')).toBeNull()
    expect(workspaceReadPerformanceReport({ ...input, load: { formalDuration: Number.NaN } }, 'M00-P03')).toBeNull()
    expect(workspaceReadPerformanceReport({ ...input, counts: { ...input.counts, nodes: -1 } }, 'M00-P03')).toBeNull()
  })

  it('enforces metric, per-metric and total raw-sample limits without truncation', () => {
    // 大小上限是明确拒绝，不删除尾部样本后报告成功。
    const input = performanceCreateReport()
    const metric = { name: 'round_trip_ms', unit: 'ms', values: [1], unavailable: false }
    expect(workspaceReadPerformanceReport({ ...input, metrics: Array.from({ length: 121 }, () => { /* 超过固定指标数量。 */ return metric }) }, 'M00-P03')).toBeNull()
    expect(workspaceReadPerformanceReport({ ...input, metrics: [{ ...metric, values: Array<number>(50_001).fill(1) }] }, 'M00-P03')).toBeNull()
    const names = ['stress8_operation_ms', 'stress8_read_ms', 'stress8_write_ms', 'stress8_auxiliary_http_ms',
      'stress8_ui_round_trip_ms', 'stress8_operation_started_ms', 'stress8_operation_ended_ms',
      'stress16_operation_ms', 'stress16_read_ms', 'stress16_write_ms', 'stress16_auxiliary_http_ms']
    expect(workspaceReadPerformanceReport({ ...input, metrics: names.map((/* 已登记但总体超限的指标名。 */ name) =>
      ({ name, unit: 'ms', values: Array<number>(50_000).fill(1), unavailable: false })) }, 'M00-P03')).toBeNull()
    const boundary = workspaceReadPerformanceReport({ ...input, metrics: [{ ...metric, values: Array<number>(50_000).fill(1) }] }, 'M00-P03')
    expect(boundary?.metrics[0]?.values).toHaveLength(50_000)
  })
})
