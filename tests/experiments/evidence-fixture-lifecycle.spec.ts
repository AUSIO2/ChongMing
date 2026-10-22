// 实际实验工厂在已存在的 Mongo 启停 seam 同时失败时保留原错误。
import { expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => {
  // 每个工厂调用都创建同样的受控进程边界，不连接真实 Mongo。
  return { primary: new Error('fixture startup failed'), secondary: new Error('fixture shutdown failed'), stopped: vi.fn() }
})
vi.mock('mongodb-memory-server', () => {
  // 仅替换第三方进程生命周期，工厂的所有权与 catch/close 仍执行实际源码。
  return { MongoMemoryReplSet: class {
    async start() { /* 模拟真实 mongod 启动拒绝。 */ throw faults.primary }
    async stop() { /* 模拟关闭也失败并记录已尝试释放。 */ faults.stopped(); throw faults.secondary }
  } }
})

import { evidenceCreateUiFixture } from '../../experiments/evidence-library-tests/ui-fixture'
import { evidenceCreateRelationFixture } from '../../experiments/evidence-library-tests/relations-fixture'

it.each([evidenceCreateUiFixture, evidenceCreateRelationFixture])('keeps both lifecycle failures from %s', async (
  /* 实际 UI 或关系工厂，不复制其清理实现。 */ create,
) => {
  // 主错误为 errors 首项，次生清理保留在其后，不能伪装初始化成功。
  faults.stopped.mockClear()
  const problem = await create().then(
    () => { /* 受控进程启动必须失败。 */ throw new Error('Expected fixture startup rejection') },
    (/* 真实工厂抛出的聚合错误。 */ error: unknown) => /* 保持错误身份不经字符串化。 */ error,
  )
  expect(problem).toBeInstanceOf(AggregateError)
  if (!(problem instanceof AggregateError)) throw new Error('Expected aggregated fixture failure')
  expect(problem.errors[0]).toBe(faults.primary)
  expect(problem.errors[1]).toBeInstanceOf(AggregateError)
  expect(problem.errors[1].errors).toContain(faults.secondary)
  expect(faults.stopped).toHaveBeenCalledOnce()
})
