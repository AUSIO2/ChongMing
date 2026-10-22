// M00 性能规模、候选阈值与运行许可；短校准不代表正式容量或耐久成绩。
export type WorkspaceLoadProfileName = 'calibration' | 'standard' | 'capacity'
export type WorkspaceLoadDuration = 'calibration' | '5m' | '30m'

export interface WorkspaceLoadProfile {
  name: WorkspaceLoadProfileName
  nodeCount: number
  edgeCount: number
  seed: number
}

interface WorkspaceCandidateThresholds { graphDomMs: number; interactionMs: number; rafMedianMs: number; rafP95Ms: number }
export interface WorkspaceLoadSettings {
  profile: WorkspaceLoadProfile
  duration: WorkspaceLoadDuration
  enforceCandidates: boolean
  thresholds: WorkspaceCandidateThresholds
  firstOpenSamples: number
  roundTrips: number
  rotationDurationMs: number
  requestDeadlineMs: number
  stressDurationMs: number
  stressOperationLimit: number
  enduranceDurationMs: number
  enduranceOperationLimit: number
  enduranceRate: number
  maxQueueDelayMs: number
}

export const WORKSPACE_LOAD_PROFILES: Readonly<Record<WorkspaceLoadProfileName, WorkspaceLoadProfile>> = {
  calibration: { name: 'calibration', nodeCount: 200, edgeCount: 800, seed: 20261018 },
  standard: { name: 'standard', nodeCount: 1_000, edgeCount: 10_000, seed: 20261018 },
  capacity: { name: 'capacity', nodeCount: 10_000, edgeCount: 50_000, seed: 20261018 },
}

enum WorkspaceLoadError {
  UNKNOWN_PROFILE = 'M00 性能规模只能选择 calibration、standard 或 capacity。',
  LARGE_PROFILE_NOT_AUTHORIZED = 'M00 standard/capacity 需要明确设置 CHONGMING_UI_PERF_ALLOW_LARGE=1。',
  UNKNOWN_DURATION = 'M00 负载时长只能选择 calibration、5m 或 30m。',
  LONG_RUN_NOT_AUTHORIZED = 'M00 五分钟或三十分钟负载需要明确设置 CHONGMING_UI_PERF_ALLOW_LONG=1。',
  REFERENCE_NOT_CONFIRMED = 'M00 执行候选阈值前需要明确确认参考设备。',
  INVALID_FLAG = 'M00 性能许可与阈值标志只能为 0、1 或省略。',
}

/** 读取当前 M00 明确约定的布尔开关，拒绝模糊值而不输出原始环境文本。 */
function workspaceReadFlag(
  /* 本轮入口的环境记录，只读取明确列出的键。 */ environment: NodeJS.ProcessEnv,
  /* 本模块声明的固定开关键。 */ name: 'CHONGMING_UI_PERF_ALLOW_LARGE' | 'CHONGMING_UI_PERF_ALLOW_LONG'
    | 'CHONGMING_UI_PERF_ENFORCE' | 'CHONGMING_UI_PERF_REFERENCE',
): boolean {
  const value = environment[name]
  if (value !== undefined && value !== '0' && value !== '1') throw new Error(WorkspaceLoadError.INVALID_FLAG)
  return value === '1'
}

/** 每个用例开始时冻结规模和节拍；失败后不自动改规模、缩时或放宽阈值。 */
export function workspaceReadLoadSettings(
  /* 测试入口显式提供的运行环境，默认仅执行小规模短校准。 */ environment: NodeJS.ProcessEnv = process.env,
): WorkspaceLoadSettings {
  const allowLarge = workspaceReadFlag(environment, 'CHONGMING_UI_PERF_ALLOW_LARGE')
  const allowLong = workspaceReadFlag(environment, 'CHONGMING_UI_PERF_ALLOW_LONG')
  const enforceCandidates = workspaceReadFlag(environment, 'CHONGMING_UI_PERF_ENFORCE')
  const referenceConfirmed = workspaceReadFlag(environment, 'CHONGMING_UI_PERF_REFERENCE')
  const profileName = environment.CHONGMING_UI_LOAD_PROFILE ?? 'calibration'
  if (profileName !== 'calibration' && profileName !== 'standard' && profileName !== 'capacity') throw new Error(WorkspaceLoadError.UNKNOWN_PROFILE)
  if (profileName !== 'calibration' && !allowLarge) throw new Error(WorkspaceLoadError.LARGE_PROFILE_NOT_AUTHORIZED)
  const duration = environment.CHONGMING_UI_LOAD_DURATION ?? 'calibration'
  if (duration !== 'calibration' && duration !== '5m' && duration !== '30m') throw new Error(WorkspaceLoadError.UNKNOWN_DURATION)
  if (duration !== 'calibration' && !allowLong) throw new Error(WorkspaceLoadError.LONG_RUN_NOT_AUTHORIZED)
  if (enforceCandidates && !referenceConfirmed) throw new Error(WorkspaceLoadError.REFERENCE_NOT_CONFIRMED)
  const short = duration === 'calibration'
  return {
    profile: { ...WORKSPACE_LOAD_PROFILES[profileName] }, duration, enforceCandidates,
    thresholds: { graphDomMs: profileName === 'capacity' ? 10_000 : 5_000,
      interactionMs: profileName === 'capacity' ? 500 : 250, rafMedianMs: 33, rafP95Ms: 50 },
    firstOpenSamples: 5, roundTrips: 20, rotationDurationMs: 10_000,
    requestDeadlineMs: 30_000, stressDurationMs: short ? 3_000 : 300_000,
    stressOperationLimit: short ? 40 : 10_000,
    enduranceDurationMs: short ? 6_000 : duration === '30m' ? 1_800_000 : 300_000,
    enduranceOperationLimit: short ? 30 : duration === '30m' ? 6_000 : 1_000,
    enduranceRate: 3, maxQueueDelayMs: short ? 5_000 : 30_000,
  }
}
