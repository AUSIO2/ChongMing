// 在 Mongo 启动失败的真实资源边界验证图夹具归还刚取得的代理，并保留清理双失败。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ close: vi.fn<() => Promise<void>>(), startMongo: vi.fn() }))
vi.mock('./rabbitmq', () => ({ rabbitCreateFixture: async () => ({
  queue: { url: 'amqp://127.0.0.1', namespace: 'fixture-owned' }, close: state.close,
}) }))
vi.mock('mongodb-memory-server', () => ({ MongoMemoryReplSet: { create: state.startMongo } }))

import { createGraphApi } from './graph-api'

beforeEach(() => {
  // 每次故障注入独立，测试不建立真实代理或数据库进程。
  state.close.mockReset().mockResolvedValue()
  state.startMongo.mockReset()
})

describe('graph API fixture initialization ownership', () => {
  // 初始化未完成也已拥有代理，必须在拒绝前归还句柄。
  it('closes the broker when the subsequent Mongo startup rejects', async () => {
    // 原始错误保留身份，不用通用初始化文案替代原因。
    const primary = new Error('mongo startup failure')
    state.startMongo.mockRejectedValue(primary)
    await expect(createGraphApi()).rejects.toBe(primary)
    expect(state.close).toHaveBeenCalledOnce()
  })

  it('retains both startup and broker cleanup failures in order', async () => {
    // 双失败有独立可观察证据，清理拒绝不能覆盖原始初始化失败。
    const primary = new Error('mongo startup failure'), secondary = new Error('broker close failure')
    state.startMongo.mockRejectedValue(primary)
    state.close.mockRejectedValue(secondary)
    await expect(createGraphApi()).rejects.toMatchObject({ errors: [primary, expect.objectContaining({ errors: [secondary] })] })
    expect(state.close).toHaveBeenCalledOnce()
  })
})
