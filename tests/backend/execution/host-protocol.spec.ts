// 使用既有队列与执行器 seam，验证未知 HTTP 授权先建立字符串身份再交给 runner。
import { afterEach, expect, it, vi } from 'vitest'

import { hostCreateWorker } from '../../../backend/execution/host-worker'
import type { WorkChannel } from '../../../backend/ports/messaging'

// 每个用例独占 fetch 替身，结束后恢复真实网络入口。
afterEach(() => /* 撤销当前用例的网络替身。 */ vi.unstubAllGlobals())

it.each(['runId', 'operationId', 'stageId', 'slotId', 'specHash', null])('validates initial grant field %s before execution', async (
  /* 数字故障注入字段；null 是同一完整授权的合法对照。 */ invalidField,
) => {
  // 两份响应中的字段即使相同，也不能把真值数字当作授权字符串。
  const controller = new AbortController()
  const methods: string[] = []
  const closed = new Promise<void>((/* 通道关闭后的完成回调。 */ resolve) => {
    controller.signal.addEventListener('abort', () => /* 本通道没有其他异步资源。 */ resolve(), { once: true })
  })
  const channel: WorkChannel = {
    signal: controller.signal, closed,
    async consumeWork(/* Host 的真实投递处理器。 */ handler, /* Host 生命周期信号。 */ stop) {
      // 投递一次实际 notice；成功路径等 Host 主动关闭，永久错误由 Host 自己停止。
      await handler({ version: 1, deploymentId: 'deployment', mapId: 'map', workId: 'work' }, controller.signal)
      if (!stop?.aborted) await new Promise<void>((/* Host 停止后的消费完成回调。 */ resolve) => {
        stop?.addEventListener('abort', () => /* 停止信号结束本次消费。 */ resolve(), { once: true })
      })
    },
    async close() {
      // 结束本通道独占的通知与投递生命周期。
      controller.abort()
    },
  }
  vi.stubGlobal('fetch', vi.fn(async (/* 请求地址，区分消息配置与工作命令。 */ url, /* 工作命令携带的请求体。 */ init) => {
    // 返回真实序列化后的未知响应，由 Host 实际 HTTP 入口读取。
    if (String(url).endsWith('/messaging')) return Response.json({ ok: true, data: { version: 1, deploymentId: 'deployment', namespace: 'test.deployment', enabled: true } })
    const command = JSON.parse(String(init.body))
    methods.push(command.method)
    const grant = { mapId: 'map', workId: 'work', runId: 'run', operationId: 'operation', stageId: 'stage', slotId: 'slot', specHash: 'spec',
      hostId: 'host', holderId: command.params.holderId, fence: 1, leaseMs: 5000, expiresAt: '2026-10-20T00:00:00.000Z' }
    if (invalidField !== null) Object.assign(grant, { [invalidField]: 17 })
    return Response.json({ ok: true, data: command.method === 'claim' ? { status: 'claimed', grant } : { released: true } })
  }))
  const runner = vi.fn(async (/* 已通过 Host 边界的完整执行输入。 */ input) => {
    // 合法对照完成工作，故障输入不得进入此处。
    return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
  })
  const worker = hostCreateWorker({ hostId: 'host', dataApiUrl: 'http://127.0.0.1', token: 'fixture', dshHome: '/unused',
    queue: { namespace: 'test', open: async () => /* 返回本例独占通道。 */ channel } }, runner)
  try {
    await worker.start()
    if (invalidField === null) {
      await vi.waitFor(() => /* 等待合法授权完成执行并释放。 */ expect(methods).toContain('release'))
      expect(runner).toHaveBeenCalledOnce()
    } else {
      expect(await worker.finished()).toMatchObject({ name: 'HostProtocolError' })
      expect(runner).not.toHaveBeenCalled()
      expect(methods).toEqual(['claim'])
    }
  } finally { await worker.close() }
})

it.each(['invalid-duration', 'changed-slot'])('preserves renewal failure classification for %s', async (
  /* 租约时长非法保持可重投，身份变更保持致命协议错误。 */ problem,
) => {
  // 续租不再创建整份冻结 grant，仍区分时长错误与不可变身份错误。
  const controller = new AbortController(), errors: unknown[] = []
  const closed = new Promise<void>((/* 通道关闭后的完成回调。 */ resolve) => {
    controller.signal.addEventListener('abort', () => /* 本通道没有其他异步资源。 */ resolve(), { once: true })
  })
  const channel: WorkChannel = { signal: controller.signal, closed,
    async consumeWork(/* Host实际处理器。 */ handler, /* Host停止信号。 */ stop) {
      // 有效领取后保持消费生命周期，等待续租取消及Host最终停止。
      await handler({ version: 1, deploymentId: 'deployment', mapId: 'map', workId: 'work' }, controller.signal)
      if (!stop?.aborted) await new Promise<void>((/* 消费停止后完成。 */ resolve) => {
        stop?.addEventListener('abort', () => /* Host结束消费。 */ resolve(), { once: true })
      })
    },
    async close() { /* 本通道拥有全部通知资源。 */ controller.abort() },
  }
  let grant: Record<string, unknown>
  vi.stubGlobal('fetch', vi.fn(async (/* 消息配置或Work路由。 */ url, /* 请求体内的真实holder与方法。 */ init) => {
    // 每个回复都经过实际Response字节解码；续租只破坏一个目标条件。
    if (String(url).endsWith('/messaging')) return Response.json({ ok: true, data: { version: 1, deploymentId: 'deployment', namespace: 'test.deployment', enabled: true } })
    const command = JSON.parse(String(init.body))
    if (command.method === 'claim') {
      grant = { mapId: 'map', workId: 'work', runId: 'run', operationId: 'operation', stageId: 'stage', slotId: 'slot', specHash: 'spec',
        hostId: 'host', holderId: command.params.holderId, fence: 1, leaseMs: 180, expiresAt: '2026-10-20T00:00:00.000Z' }
      return Response.json({ ok: true, data: { status: 'claimed', grant } })
    }
    if (command.method === 'renew') return Response.json({ ok: true, data: { ...grant, ...(problem === 'invalid-duration' ? { leaseMs: 0 } : { slotId: 'different-slot' }) } })
    return Response.json({ ok: true, data: { released: true } })
  }))
  const worker = hostCreateWorker({ hostId: 'host', dataApiUrl: 'http://127.0.0.1', token: 'fixture', dshHome: '/unused',
    queue: { namespace: 'test', open: async () => /* 当前唯一连接。 */ channel },
    reporter: { report: (/* 当前Host诊断，保留原错误身份。 */ event) => {
      // 只观察实际续租错误，不能以错误文本猜分类。
      if (event.name === 'host.lease.renew.failed') errors.push(event.error)
      return 'test-event'
    }, close: async () => { /* 报告器没有外部资源。 */ } },
  }, async (/* 实际Host建立的执行与取消信号。 */ input) => {
    // 与真实runner一样等待取消，再把同一取消原因向Host传播。
    await new Promise<void>((/* 取消后的执行完成入口。 */ resolve) => {
      input.signal?.addEventListener('abort', () => /* 结束等待。 */ resolve(), { once: true })
    })
    throw input.signal?.reason
  })
  let finished = false
  try {
    await worker.start()
    void worker.finished().then(() => { /* 标记Host是否因协议错误终止。 */ finished = true })
    await vi.waitFor(() => /* 等待真实续租定时器及响应处理完成。 */ expect(errors).toHaveLength(1))
    expect(errors[0]).toMatchObject({ name: problem === 'invalid-duration' ? 'Error' : 'HostProtocolError' })
    if (problem === 'changed-slot') {
      expect(await worker.finished()).toBe(errors[0])
    } else {
      await new Promise<void>((/* 下一事件轮次供退出状态结算。 */ resolve) => /* 不等待任意固定延迟。 */ setImmediate(resolve))
      expect(finished).toBe(false)
    }
  } finally { await worker.close() }
})
