// 压测数据与门槛均为待执行的工程目标，不是已测容量或成绩。
export type Operation = 'search' | 'get' | 'collect' | 'cite' | 'snapshot'
export interface StressScenario {
  name: 'small' | 'medium' | 'large' | 'hotspot' | 'large-text' | 'zero-hit' | 'high-hit' | 'first-use' | 'soak'
  entries: number
  usages: number
  seed: number
  textBytes: number
  hitEvery: number
  queryMode: 'hit' | 'miss'
  hotSetSize: number | null
  concurrency: number[]
  warmupOperations: number
  operationsPerRound: number
  rounds: number
  maxOperationsPerSecond: number
  requestTimeoutMs: number
  setupTimeoutMs: number
  roundTimeoutMs: number
  cleanupTimeoutMs: number
  thresholds: {
    minSuccessOperationsPerSecond: number
    maxDriverRssBytes: number
    maxSampledTargetRssBytes: number
    maxP95Ms: Record<Operation, number>
    maxP99Ms: Record<Operation, number>
  }
}

// 每二十个业务操作的固定组成：搜索40%、读取30%、收录10%、引用15%、快照5%。
export const OPERATION_MIX: readonly Operation[] = [
  'search', 'get', 'search', 'get', 'collect', 'search', 'get', 'cite', 'search', 'get',
  'snapshot', 'search', 'get', 'cite', 'search', 'get', 'collect', 'search', 'get', 'cite',
]

function scenario(
  /* 合成场景的稳定名称。 */ name: StressScenario['name'],
  /* 预置的显式收录条目数。 */ entries: number,
  /* 预置的真实使用关系数。 */ usages: number,
): StressScenario {
  // 保持各档请求组成一致，容量只调整预置数据；初测后可显式修订门槛。
  return {
    name, entries, usages, seed: 20261006, textBytes: 512, hitEvery: 5, queryMode: 'hit', hotSetSize: null,
    concurrency: [1, 4, 8, 16, 32], warmupOperations: 100, operationsPerRound: 1_000,
    rounds: 3, maxOperationsPerSecond: 200, requestTimeoutMs: 5_000,
    setupTimeoutMs: 600_000, roundTimeoutMs: 120_000, cleanupTimeoutMs: 10_000,
    thresholds: {
      minSuccessOperationsPerSecond: 10, maxDriverRssBytes: 512 * 1024 * 1024,
      maxSampledTargetRssBytes: 1024 * 1024 * 1024,
      maxP95Ms: { search: 250, get: 100, collect: 300, cite: 500, snapshot: 500 },
      maxP99Ms: { search: 500, get: 250, collect: 600, cite: 1_000, snapshot: 1_000 },
    },
  }
}

export const STRESS_SCENARIOS: readonly StressScenario[] = [
  scenario('small', 1_000, 10_000), scenario('medium', 10_000, 50_000), scenario('large', 50_000, 200_000),
  { ...scenario('hotspot', 10_000, 50_000), hotSetSize: 8, concurrency: [8, 32] },
  { ...scenario('large-text', 10_000, 50_000), textBytes: 8_192, concurrency: [1, 8] },
  { ...scenario('zero-hit', 10_000, 50_000), queryMode: 'miss', concurrency: [8] },
  { ...scenario('high-hit', 10_000, 50_000), hitEvery: 1, concurrency: [8] },
  { ...scenario('first-use', 10_000, 50_000), warmupOperations: 0, concurrency: [1] },
  { ...scenario('soak', 10_000, 50_000), rounds: 10, operationsPerRound: 10_000, concurrency: [8] },
]
