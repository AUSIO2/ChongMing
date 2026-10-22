// 从真实进程入口交接 seam 调用启动函数，保留原错误并观察实际诊断序列化。
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  primary: Object.assign(new Error('controlled graph initialization failure'), { code: 'CONTROLLED_START_FAILED' }),
  secondary: Object.assign(new Error('controlled connection cleanup failure'), { code: 'CONTROLLED_CLOSE_FAILED' }),
  close: vi.fn(), start: vi.fn(), lines: [] as Array<{ name: string; failure?: { code?: string } }>,
}))
vi.mock('../../../backend/adapters/storage/mongo/connection', () => ({
  /* 仅替换外部连接，启动与清理的编排仍执行实际入口。 */ storeCreateConnection: async () => ({ close: state.close }),
}))
vi.mock('../../../apps/graph-server/application', () => ({
  /* 初始化在真实可拒绝的异步边界失败，构造函数自身不抛错。 */ applicationCreateService: () => ({ initialize: async () => { throw state.primary } }),
}))
vi.mock('../../../apps/config/local-settings', () => ({
  /* 不读取本机用户配置，部署地址由本例明确提供。 */ localReadConfiguration: async () => ({ settings: {}, secrets: {} }),
}))
vi.mock('../../../platform/node/process-boundary', () => ({
  /* 保存进程入口接到的实际start回调，不注册全局退出监听。 */ processRunEntry: (/* 实际入口参数。 */ input) => { state.start.mockImplementation(input.start) },
  /* 第一阶段初始化失败不会进入后续关闭期限流程。 */ processRunClose: vi.fn(),
}))
vi.mock('../../../platform/node/diagnostics', async (/* 真实诊断模块。 */ original) => {
  const actual = await original<typeof import('../../../platform/node/diagnostics')>()
  return { ...actual, diagnosticCreateReporter: () => ({
    report(/* 真实启动代码上报的错误。 */ event) {
      // 保留生产脱敏/编码规则，只把输出收进本例内存。
      const output = actual.diagnosticReadLine('graph-test', 'test', event)
      state.lines.push(JSON.parse(output.line))
      return output.errorId
    }, close: async () => { /* 没有文件句柄。 */ },
  }) }
})
afterEach(() => /* 恢复部署变量。 */ vi.unstubAllEnvs())

it.each([false, true])('preserves graph startup failure when connection close fails=%s', async (
  /* 主失败之后连接清理是否也失败。 */ closeFails,
) => {
  // 清理诊断要可见，入口本身继续抛同一原始初始化对象。
  vi.resetModules()
  state.lines.length = 0
  state.close.mockReset()
  if (closeFails) state.close.mockRejectedValueOnce(state.secondary)
  else state.close.mockResolvedValueOnce(undefined)
  vi.stubEnv('CHONGMING_AMQP_URL', 'amqp://unused-fixture')
  await import('../../../apps/graph-server/main')
  await expect(state.start()).rejects.toBe(state.primary)
  expect(state.close).toHaveBeenCalledOnce()
  if (closeFails) expect(state.lines).toContainEqual(expect.objectContaining({
    name: 'startup.connection.close.failed', failure: expect.objectContaining({ code: state.secondary.code }),
  }))
  else expect(state.lines).toEqual([])
})
