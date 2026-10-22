// 在Docker初始化和目录回收既有边界制造双失败，不启动真实容器。
import { afterEach, expect, it, vi } from 'vitest'

const faults = vi.hoisted(() => ({
  primary: new Error('controlled broker initialization failure'), secondary: new Error('controlled directory cleanup failure'),
  closeFails: false, removed: vi.fn(),
}))
vi.mock('node:util', async (/* 真实工具模块。 */ original) => {
  // 只替换本fixture的execFile Promise适配边界，避免运行外部Docker。
  const actual = await original<typeof import('node:util')>()
  return { ...actual, promisify: () => async (/* 被测引擎命令。 */ _file: string, /* 确定启动阶段的命令参数。 */ args: string[]) => {
    if (args[0] === 'context') return { stdout: 'unix:///unused-test-engine' }
    if (args[0] === 'info') return { stdout: 'test-engine' }
    throw faults.primary
  } }
})
vi.mock('node:fs/promises', async (/* 实际文件系统。 */ original) => {
  // 清理自己的真实临时目录后才抛次错，测试结束不留资源。
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (/* fixture实际取得的临时目录。 */ target, /* 原始删除选项。 */ options) => {
    await actual.rm(target, options)
    faults.removed()
    if (faults.closeFails) throw faults.secondary
  } }
})
import { rabbitCreateBroker } from './rabbitmq'
afterEach(() => /* 恢复共享代理环境变量。 */ vi.unstubAllEnvs())

it.each([false, true])('preserves broker startup failure with cleanup failure=%s', async (
  /* 真实目录移除后是否仍报告清理错误。 */ closeFails,
) => {
  // 没有次错时抛原对象；双失败按顺序保留原始错误及清理失败。
  vi.stubEnv('CHONGMING_TEST_BROKER_FILE', undefined)
  faults.removed.mockClear()
  faults.closeFails = closeFails
  const problem = await rabbitCreateBroker().then(
    () => { /* Docker启动故障必须拒绝。 */ throw new Error('Expected broker startup failure') },
    (/* 被测fixture实际拒绝值。 */ error: unknown) => /* 原样保留其错误身份。 */ error,
  )
  expect(faults.removed).toHaveBeenCalledOnce()
  if (!closeFails) expect(problem).toBe(faults.primary)
  else {
    expect(problem).toBeInstanceOf(AggregateError)
    if (!(problem instanceof AggregateError)) throw new Error('Expected aggregated broker failure')
    expect(problem.errors[0]).toBe(faults.primary)
    expect(problem.errors[1].errors).toEqual([faults.secondary])
  }
})
