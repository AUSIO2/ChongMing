// 验证 preview 获取真实工厂资源后、临时目录创建失败时立即承担清理责任。
import { afterEach, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => {
  // 测试仅注入工厂和文件系统两个既有异步边界，preview 本身使用实际实现。
  return { close: vi.fn(async () => { /* 自有服务关闭完成。 */ }), mkdir: vi.fn() }
})
vi.mock('node:fs/promises', async (/* 真实文件系统加载入口。 */ original) => {
  // 只控制临时目录创建失败，其余文件函数保持真实实现。
  return { ...await original<typeof import('node:fs/promises')>(), mkdtemp: fixture.mkdir }
})
vi.mock('../../experiments/evidence-library-tests/ui-fixture', () => ({
  /* 交还 preview 本次拥有的服务。 */ evidenceCreateUiFixture: async () => ({ close: fixture.close }),
}))
vi.mock('../../experiments/evidence-library-tests/relations-fixture', () => ({
  /* 交还 relation preview 本次拥有的服务。 */ evidenceCreateRelationFixture: async () => ({ close: fixture.close }),
}))
vi.mock('../../experiments/evidence-library-tests/usage-fixture', () => ({
  /* 交还 usage preview 本次拥有的服务。 */ evidenceCreateUsageFixture: async () => ({ close: fixture.close }),
}))
const priorExitCode = process.exitCode
afterEach(() => {
  // 退出状态属于启动脚本，避免故障注入影响本测试进程。
  process.exitCode = priorExitCode
  vi.restoreAllMocks()
})

it.each(['ui', 'relations', 'usage'])('closes %s preview when temporary directory creation fails', async (
  /* 三个实际预览入口的稳定文件名前缀。 */ name,
) => {
  // 已取得 fixture 后的真实可拒绝 FS 阶段，不能绕过清理直接退出。
  vi.resetModules()
  fixture.close.mockClear()
  const primary = new Error('temporary directory unavailable')
  fixture.mkdir.mockRejectedValueOnce(primary)
  const report = vi.spyOn(console, 'error').mockImplementation(() => { /* 只捕获诊断，不打印受控故障。 */ })
  await import(`../../experiments/evidence-library-tests/${name}-preview.ts`)
  await vi.waitFor(() => /* 等待入口的已观察拒绝完成清理及诊断。 */ expect(report).toHaveBeenCalledWith(primary))
  expect(fixture.close).toHaveBeenCalledOnce()
})
