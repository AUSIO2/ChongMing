// M00 唯一性能附件的显式白名单投影；拒绝非法样本，不复制正文、凭据或任意诊断文本。
const BASE_METRIC_UNITS = {
  graph_dom_available_ms: 'ms', graph_dom_available_median_ms: 'ms', graph_dom_available_max_ms: 'ms', graph_dom_sample_status: 'count',
  node_selection_ms: 'ms', node_selection_median_ms: 'ms', node_selection_max_ms: 'ms', node_selection_sample_status: 'count',
  page_content_ms: 'ms', page_content_median_ms: 'ms', page_content_max_ms: 'ms', page_content_sample_status: 'count',
  round_trip_ms: 'ms', round_trip_status: 'count', raf_interval_ms: 'ms', raf_interval_median_ms: 'ms', raf_interval_p95_ms: 'ms',
  browser_js_heap_bytes: 'bytes', browser_js_heap_limit_bytes: 'bytes', service_memory_bytes: 'bytes', gpu_render_complete_ms: 'ms',
  scene_declared_nodes: 'count', scene_declared_edges: 'count', gpu_drawn_nodes: 'count', camera_projection_available: 'count',
  logical_api_p95_ms: 'ms', logical_api_p99_ms: 'ms',
} as const
const PHASE_METRIC_UNITS = {
  operation_ms: 'ms', read_ms: 'ms', write_ms: 'ms', operation_status: 'count', auxiliary_http_ms: 'ms',
  ui_round_trip_ms: 'ms', client_http_concurrency: 'count', logical_concurrency: 'count', operation_index: 'count',
  operation_started_ms: 'ms', operation_ended_ms: 'ms', operation_kind: 'count',
} as const
const PHASES = ['stress8', 'stress16', 'endurance'] as const
const LOAD_BASE_KEYS = ['formalDuration', 'targetReadPercent', 'targetWritePercent', 'enduranceTargetRate', 'browserContexts', 'browserObservationRate'] as const
const LOAD_PHASE_KEYS = ['TargetDurationMs', 'ActualDurationMs', 'Scheduled', 'Completed', 'ReadCount', 'WriteCount', 'AuxiliaryCount',
  'Incomplete', 'UiFailures', 'MaxQueueDelayMs', 'ActualRate', 'Status0', 'Status1', 'Status2', 'Status3', 'Status4', 'ConcurrencyLimit', 'OperationLimit'] as const

type SafePhase = typeof PHASES[number]
type SafeMetricName = keyof typeof BASE_METRIC_UNITS | `${SafePhase}_${keyof typeof PHASE_METRIC_UNITS}`
type SafeMetricUnit = 'ms' | 'bytes' | 'count'
type SafeLoadKey = typeof LOAD_BASE_KEYS[number] | `${SafePhase}${typeof LOAD_PHASE_KEYS[number]}`
type SafePlatform = 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux' | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd'
type SafeArchitecture = 'arm' | 'arm64' | 'ia32' | 'loong64' | 'mips' | 'mipsel' | 'ppc' | 'ppc64' | 'riscv64' | 's390' | 's390x' | 'x64'

export interface SafePerformanceReport {
  schemaVersion: 1
  caseId: 'M00-P01' | 'M00-P02' | 'M00-P03'
  profile: 'calibration' | 'standard' | 'capacity'
  storage: 'sqlite' | 'mongo'
  thresholdStatus: 'proposed'
  measurementClock: 'driver-monotonic-with-browser-raf'
  counts: { nodes: number; edges: number; derivedReferences: number; payloadBytes: number; jsonBytes: number }
  metrics: Array<{ name: SafeMetricName; unit: SafeMetricUnit; values: number[]; unavailable: boolean }>
  environment?: { nodeVersion: string; chromiumVersion: string; platform: SafePlatform; arch: SafeArchitecture;
    viewportWidth: number; viewportHeight: number; deviceScaleFactor: number; gpuMode: 'unavailable' | 'software' | 'hardware' | 'unknown' }
  load?: Partial<Record<SafeLoadKey, number>>
}

const metricUnits = new Map<string, SafeMetricUnit>(Object.entries(BASE_METRIC_UNITS))
for (const phase of PHASES) for (const [suffix, unit] of Object.entries(PHASE_METRIC_UNITS)) metricUnits.set(`${phase}_${suffix}`, unit)
const loadKeys: readonly SafeLoadKey[] = [
  ...LOAD_BASE_KEYS,
  ...PHASES.flatMap((/* 本模块固定登记的负载阶段。 */ phase) => LOAD_PHASE_KEYS.map((/* 本阶段允许的数值统计键。 */ suffix) => `${phase}${suffix}` as SafeLoadKey)),
]
const platforms = new Set<string>(['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'])
const architectures = new Set<string>(['arm', 'arm64', 'ia32', 'loong64', 'mips', 'mipsel', 'ppc', 'ppc64', 'riscv64', 's390', 's390x', 'x64'])

/** 接纳可投影的对象形状；数组和 null 不参与字段读取。 */
function performanceReadRecord(/* 附件内尚未验证的对象。 */ value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 数值必须有限且非负；不靠过滤、字符串转换或默认零值继续报告。 */
function performanceIsNumber(/* 尚未验证的样本或统计值。 */ value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** 版本只允许有限长度的数字、点与开头的 v，拒绝自由环境文本。 */
function performanceIsVersion(/* 浏览器或 Node 自报的版本字段。 */ value: unknown): value is string {
  return typeof value === 'string' && value.length <= 64 && /^v?\d+(?:\.\d+){0,3}$/.test(value)
}

/** 环境只有固定枚举、版本及数值，不输出渲染器原名、路径或主机名。 */
function performanceReadEnvironment(/* 不可信环境对象。 */ input: unknown): SafePerformanceReport['environment'] | null {
  const value = performanceReadRecord(input)
  if (!value || !performanceIsVersion(value.nodeVersion) || !performanceIsVersion(value.chromiumVersion)
    || typeof value.platform !== 'string' || !platforms.has(value.platform)
    || typeof value.arch !== 'string' || !architectures.has(value.arch)
    || !performanceIsNumber(value.viewportWidth) || !Number.isSafeInteger(value.viewportWidth) || value.viewportWidth === 0
    || !performanceIsNumber(value.viewportHeight) || !Number.isSafeInteger(value.viewportHeight) || value.viewportHeight === 0
    || !performanceIsNumber(value.deviceScaleFactor) || value.deviceScaleFactor === 0
    || value.gpuMode !== 'unavailable' && value.gpuMode !== 'software' && value.gpuMode !== 'hardware' && value.gpuMode !== 'unknown') return null
  return { nodeVersion: value.nodeVersion, chromiumVersion: value.chromiumVersion, platform: value.platform as SafePlatform,
    arch: value.arch as SafeArchitecture, viewportWidth: value.viewportWidth, viewportHeight: value.viewportHeight,
    deviceScaleFactor: value.deviceScaleFactor, gpuMode: value.gpuMode }
}

/** 在已登记 M00 场景之间投影唯一性能 DTO；未知字段丢弃，恶意已知字段整份拒绝。 */
export function workspaceReadPerformanceReport(
  /* 来自唯一 m00-performance 附件正文的 JSON 对象。 */ value: unknown,
  /* 当前真实 test-end 已提取的静态用例编号，不能由附件自己改写。 */ expectedCaseId: string,
): SafePerformanceReport | null {
  try {
    const input = performanceReadRecord(value)
    if (!input || expectedCaseId !== 'M00-P01' && expectedCaseId !== 'M00-P02' && expectedCaseId !== 'M00-P03'
      || input.schemaVersion !== 1 || input.caseId !== expectedCaseId
      || input.profile !== 'calibration' && input.profile !== 'standard' && input.profile !== 'capacity'
      || input.storage !== 'sqlite' && input.storage !== 'mongo' || input.thresholdStatus !== 'proposed'
      || input.measurementClock !== 'driver-monotonic-with-browser-raf') return null
    const rawCounts = performanceReadRecord(input.counts)
    if (!rawCounts) return null
    const counts = { nodes: 0, edges: 0, derivedReferences: 0, payloadBytes: 0, jsonBytes: 0 }
    for (const key of ['nodes', 'edges', 'derivedReferences', 'payloadBytes', 'jsonBytes'] as const) {
      const count = rawCounts[key]
      if (!performanceIsNumber(count) || !Number.isSafeInteger(count)) return null
      counts[key] = count
    }
    if (!Array.isArray(input.metrics) || input.metrics.length > 120) return null
    const metrics: SafePerformanceReport['metrics'] = [], seen = new Set<string>()
    let sampleCount = 0
    for (const item of input.metrics) {
      const metric = performanceReadRecord(item)
      if (!metric || typeof metric.name !== 'string' || !metricUnits.has(metric.name) || seen.has(metric.name)
        || metric.unit !== metricUnits.get(metric.name) || !Array.isArray(metric.values) || metric.values.length > 50_000
        || typeof metric.unavailable !== 'boolean' || metric.unavailable !== (metric.values.length === 0)) return null
      sampleCount += metric.values.length
      if (sampleCount > 500_000) return null
      const values: number[] = []
      for (const sample of metric.values) {
        if (!performanceIsNumber(sample) || metric.unit === 'count' && !Number.isSafeInteger(sample)) return null
        values.push(sample)
      }
      seen.add(metric.name)
      metrics.push({ name: metric.name as SafeMetricName, unit: metric.unit as SafeMetricUnit, values, unavailable: metric.unavailable })
    }
    const result: SafePerformanceReport = { schemaVersion: 1, caseId: expectedCaseId, profile: input.profile, storage: input.storage,
      thresholdStatus: 'proposed', measurementClock: 'driver-monotonic-with-browser-raf', counts, metrics }
    if (input.environment !== undefined) {
      const environment = performanceReadEnvironment(input.environment)
      if (!environment) return null
      result.environment = environment
    }
    if (input.load !== undefined) {
      const rawLoad = performanceReadRecord(input.load)
      if (!rawLoad) return null
      const load: NonNullable<SafePerformanceReport['load']> = {}
      for (const key of loadKeys) {
        if (!Object.prototype.hasOwnProperty.call(rawLoad, key)) continue
        const number = rawLoad[key]
        if (!performanceIsNumber(number)) return null
        load[key] = number
      }
      result.load = load
    }
    return result
  } catch {
    // 附件只能提供 JSON；异常访问器也不允许把原始 message/stack 带入报告链。
    return null
  }
}
