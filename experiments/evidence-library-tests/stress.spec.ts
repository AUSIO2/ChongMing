// 只注册未来运行的压测用例；无真实目标时加载失败，不使用模拟存储。
import { it } from 'vitest'
import { STRESS_SCENARIOS } from './scenarios'
import { runStressCase } from './stress'
import { HarnessMessage } from './test-contract'

const selected = process.env.EVIDENCE_STRESS_SCENARIO
const concurrencyFilter = process.env.EVIDENCE_STRESS_CONCURRENCY
const selectedConcurrency = concurrencyFilter === undefined ? undefined : Number(concurrencyFilter)
if (selectedConcurrency !== undefined && ![1, 4, 8, 16, 32].includes(selectedConcurrency)) {
  throw new Error(HarnessMessage.OPTION_INVALID)
}
if (selected && !STRESS_SCENARIOS.some(
  /* 一份已定义的合成负载。 */ scenario => /* 限制筛选为明确场景，不允许空测试假通过。 */ scenario.name === selected,
)) throw new Error(HarnessMessage.OPTION_INVALID)

for (const scenario of STRESS_SCENARIOS) {
  if (selected && selected !== scenario.name) continue
  if (selected && selectedConcurrency !== undefined && !scenario.concurrency.includes(selectedConcurrency)) {
    throw new Error(HarnessMessage.OPTION_INVALID)
  }
  for (const concurrency of scenario.concurrency) {
    if (selectedConcurrency !== undefined && selectedConcurrency !== concurrency) continue
    it(`${scenario.name}: ${scenario.entries}条目/${scenario.usages}关系/${concurrency}并发`, async () => {
      // 真正运行时，驱动检查正确性、失败数和每种操作的独立性能门槛。
      await runStressCase(scenario, concurrency)
    }, scenario.setupTimeoutMs * 3 + scenario.roundTimeoutMs * (scenario.rounds + 1) + scenario.cleanupTimeoutMs * 2)
  }
}
