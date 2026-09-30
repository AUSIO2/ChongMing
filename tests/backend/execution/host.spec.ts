// 文件职责：通过真实 RabbitMQ 与可控工作 API 验证 Host 领取、续租、重试和排空。
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphWorkGrant } from '../../../contracts/graph'
import type { DshWorkInput } from '../../../backend/execution/dsh/work-executor'
import { hostCreateWorker, type HostExecutionEvent } from '../../../backend/execution/host-worker'
import { queueOpen, queueCreateTransport } from '../../../backend/adapters/messaging/rabbitmq'
import { rabbitCreateFixture } from '../fixtures/rabbitmq'

afterEach(() => /* 每个用例结束后恢复日志及执行器替身。 */  vi.restoreAllMocks())

/**
 * 建立真实消息队列、可控工作 API 和可选断线代理，返回授予工作与清理工具。
 *
 * @param handler 用例提供的工作 API 行为，按方法和载荷返回授权、状态或错误。
 * @param proxy 是否启用可断开的 TCP 代理，默认 false 直接连接真实 broker。
 */
async function hostCreateFixture(handler: (method: string, params: Record<string, string>) => { status?: number; data?: unknown; error?: unknown }, proxy = false) {
  const broker = await rabbitCreateFixture()
  const deploymentId = randomUUID(), mapId = randomUUID(), runId = randomUUID(), hostId = randomUUID()
  const queue = broker.queue
  const link = await queueOpen({ ...queue, namespace: queue.namespace + '.' + deploymentId })
  const sockets = new Set<Socket>()
  const address = new URL(queue.url)
  const brokerPort = Number(address.port || 5672), brokerHost = address.hostname
  const tunnel = proxy ? createTcpServer(socket => {
    // 把代理客户端双向转发到 broker，并记录两端连接以支持强制断线。
    const upstream = connect(brokerPort, brokerHost)
    sockets.add(socket); sockets.add(upstream)
    for (const current of [socket, upstream]) {
      current.on('error', () => {
        // 任一代理端出错时同步销毁两端套接字。
         socket.destroy(); upstream.destroy() })
      current.on('close', () => {
        // 移除已关闭套接字并结束其关联上游连接。
         sockets.delete(current); socket.destroy(); upstream.destroy() })
    }
    socket.pipe(upstream); upstream.pipe(socket)
  }) : undefined
  if (tunnel) {
    await new Promise<void>(resolve => /* 等待 AMQP 测试代理监听本地临时端口。 */  tunnel.listen(0, '127.0.0.1', resolve))
    const binding = tunnel.address()
    if (!binding || typeof binding === 'string') throw new Error('AMQP test tunnel did not bind')
    address.hostname = '127.0.0.1'; address.port = String(binding.port)
  }
  const workId = 'route'
  const server = createServer(async (request, response) => {
    // 返回固定消息身份，或将工作命令交给用例指定处理器。
    response.setHeader('content-type', 'application/json')
    if (request.url === '/internal/v1/messaging') {
      response.end(JSON.stringify({ ok: true, data: { version: 1, deploymentId, namespace: queue.namespace + '.' + deploymentId, enabled: true } }))
      return
    }
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const command = JSON.parse(Buffer.concat(chunks).toString())
    const result = handler(command.method, command.params)
    response.statusCode = result.status ?? 200
    response.end(JSON.stringify({ ok: !result.error, ...result }))
  })
  await new Promise<void>(resolve => /* 等待工作 API 测试服务器绑定临时端口。 */  server.listen(0, '127.0.0.1', resolve))
  const binding = server.address()
  if (!binding || typeof binding === 'string') throw new Error('Test server did not bind')
  return {
    input: { hostId, dataApiUrl: `http://127.0.0.1:${binding.port}`, token: 'host-test-token', dshHome: '/unused-host-test', queue: queueCreateTransport({ ...queue, url: address.toString() }) },
    disconnect: () => {
      // 强制销毁全部代理连接以模拟 broker 断流。
       for (const socket of sockets) socket.destroy() },
    /**
     * 构造绑定本夹具部署和图的工作授权，可调整租约时长。
     *
     * @param holderId 本次 claim 请求的持有者身份，夹具授权必须原样回显。
     * @param leaseMs 测试租约时长，单位毫秒，默认 30000；失租用例可缩短。
     * @param grantedWorkId 本次授权对应的工作身份；省略时沿用旧用例的 route。
     */
    grant(holderId: string, leaseMs = 30_000, grantedWorkId = workId): GraphWorkGrant {
      return { workId: grantedWorkId, mapId, runId, operationId: `${runId}:verify:${grantedWorkId}`,
        stageId: 'route', slotId: 'route', specHash: 'fixture-spec',
        hostId, holderId, fence: 1, leaseMs, expiresAt: new Date(Date.now() + leaseMs).toISOString() }
    },
    /**
     * @param publishedWorkId 可选工作编号；省略时发布旧用例使用的 route。
     */
    publish: (publishedWorkId = workId) => /* 向本夹具命名空间发布指定工作的领取通知。 */  link.publishWork({ version: 1, deploymentId, mapId, workId: publishedWorkId }),
    async close() {
      // 关闭发布连接、代理和 HTTP 服务，再清理队列命名空间与 broker 夹具。
      await link.close()
      for (const socket of sockets) socket.destroy()
      if (tunnel) await new Promise<void>((resolve, reject) => /* 等待 AMQP 代理停止监听。 */  tunnel.close(error => /* 传递 AMQP 代理关闭的成功或失败结果。 */  error ? reject(error) : resolve()))
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => /* 等待工作 API HTTP 服务器关闭。 */  server.close(error => /* 传递工作 API 服务器关闭的成功或失败结果。 */  error ? reject(error) : resolve()))
      await broker.deleteNamespace(queue.namespace + '.' + deploymentId)
      await broker.close()
    },
  }
}

describe('Host work lifecycle through RabbitMQ', () => {
  // 覆盖 Host 在真实投递生命周期中的确认、失租、断线与永久故障。
  it('releases and retries a delivery after transient work access errors without failing the Run', async () => {
    // 验证暂时数据访问失败会先释放再重新领取，且不把 Run 标记失败。
    const methods: string[] = []
    const fixture = await hostCreateFixture((method, params) => {
      // 第一次领取授予工作，后续重投视为过时，并记录调用顺序。
      methods.push(method)
      if (method === 'claim') return { data: methods.length === 1
        ? { status: 'claimed', grant: fixture.grant(params.holderId) } : { status: 'obsolete' } }
      return { data: { released: true } }
    })
    const runner = vi.fn(async () => {
      // 模拟执行中发生暂时数据访问错误。
       throw Object.assign(new Error('Data API temporarily unavailable'), { name: 'WorkAccessError' }) })
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => /* 等待观察到领取、释放、重领的完整顺序。 */  expect(methods).toEqual(['claim', 'release', 'claim']), { timeout: 5000 })
      await worker.close()
      expect(runner).toHaveBeenCalledTimes(1)
    } finally { await worker.close(); await fixture.close() }
  })

  it('aborts on lease loss and waits for DSH cleanup before releasing or completing close', async () => {
    // 验证失租会取消执行，Host 关闭须等 DSH 清理后才释放授权。
    vi.spyOn(console, 'error').mockImplementation(() => {
      // 抑制本用例预期失租产生的控制台错误输出。
    })
    const events: string[] = []
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => {
      // 保存允许模拟 DSH 完成清理的释放回调。
       finishCleanup = resolve })
    const fixture = await hostCreateFixture((method, params) => {
      // 授予短租约并在续租时返回失租，驱动执行取消路径。
      events.push(method)
      if (method === 'claim') return { data: { status: 'claimed', grant: fixture.grant(params.holderId, 900) } }
      if (method === 'renew') return { status: 409, error: { code: 'LEASE_LOST', message: 'Lease was taken over' } }
      return { data: { released: true } }
    })
    const worker = hostCreateWorker({ ...fixture.input, requestTimeoutMs: 1000 }, async input => {
      // 检查传给执行器的身份，等待失租取消后延迟完成清理。
      expect(input.grant.hostId).toBe(fixture.input.hostId)
      expect(input.grant.holderId).toMatch(/^[0-9a-f-]{36}$/)
      expect(input.env?.CHONGMING_HOST_ID).toBe(fixture.input.hostId)
      await new Promise<void>(resolve => {
        // 等待执行取消，已取消时立即继续清理流程。
        if (input.signal!.aborted) resolve()
        else input.signal!.addEventListener('abort', () => /* 收到执行取消时解除等待。 */  resolve(), { once: true })
      })
      events.push('runner.aborted')
      await cleanup
      events.push('runner.exited')
      throw input.signal!.reason
    })
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => /* 等待执行器确实收到租约取消。 */  expect(events).toContain('runner.aborted'))
      expect(events).toContain('renew')
      expect(events).not.toContain('release')
      const closing = worker.close()
      expect(worker.close()).toBe(closing)
      let closed = false
      const observedClose = closing.then(() => {
        // 记录 Host 关闭 Promise 已完成，用来验证关闭不会抢先结束。
         closed = true })
      await new Promise<void>(resolve => /* 让出一个事件循环轮次，检查清理未完成时关闭仍在等待。 */  setImmediate(resolve))
      expect(closed).toBe(false)
      expect(events).not.toContain('release')
      finishCleanup()
      await observedClose
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('runner.exited'))
      expect(events.filter(event => /* 统计领取事件，确认清理期间未开始下一份执行。 */  event === 'claim')).toHaveLength(1)
      expect(events).not.toContain('fail')
    } finally { finishCleanup(); await worker.close(); await fixture.close() }
  })

  it('retains a busy delivery until its lease expires and ignores already accepted duplicates', async () => {
    // 验证 busy 投递等待服务器期限后重试，已接纳重复消息不会再次执行。
    const claims: number[] = []
    let accepted = false
    const fixture = await hostCreateFixture((method, params) => {
      // 首次领取返回 busy，后续根据是否已接纳返回授权或过时状态。
      if (method !== 'claim') return { data: { released: true } }
      claims.push(performance.now())
      if (claims.length === 1) return { data: { status: 'busy', retryAfterMs: 200 } }
      return { data: accepted ? { status: 'obsolete' } : { status: 'claimed', grant: fixture.grant(params.holderId) } }
    })
    const runner = vi.fn(async (input: DshWorkInput) => {
      // 模拟执行成功并将服务端状态切换为已接纳。
      accepted = true
      return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
    })
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => /* 等待首次执行完成并确认仅调用一次。 */  expect(runner).toHaveBeenCalledTimes(1), { timeout: 3000 })
      expect(claims[1] - claims[0]).toBeGreaterThanOrEqual(190)
      await fixture.publish()
      await vi.waitFor(() => /* 等待重复消息触发第三次领取查询。 */  expect(claims).toHaveLength(3))
      await delay(50)
      expect(runner).toHaveBeenCalledTimes(1)
    } finally { await worker.close(); await fixture.close() }
  })

  it('runs distinct work up to its configured capacity, coalesces duplicates and attributes events to slots', async () => {
    // 验证一个 Host 的两个执行槽并行领取不同工作，同一 Work 只领取一次且事件带完整槽位身份。
    const claims = new Map<string, number>()
    const fixture = await hostCreateFixture((method, params) => {
      // 为每个不同工作返回独立授权，并统计重复通知是否造成重复领取。
      if (method === 'claim') {
        claims.set(params.workId, (claims.get(params.workId) ?? 0) + 1)
        return { data: { status: 'claimed', grant: fixture.grant(params.holderId, 30_000, params.workId) } }
      }
      return { data: { released: true } }
    })
    const releases = new Map<string, () => void>(), started: string[] = [], events: HostExecutionEvent[] = []
    let active = 0, maximum = 0
    const runner = vi.fn(async (input: DshWorkInput) => {
      // 发出一条可归属事件并等待用例乱序释放，以观察真实并发上限。
      started.push(input.grant.workId); active++; maximum = Math.max(maximum, active)
      input.onEvent?.({ method: 'session.status', params: { status: 'running' } })
      await new Promise<void>(resolve => {
        // 登记当前工作对应的释放回调。
        releases.set(input.grant.workId, resolve)
      })
      active--
      return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
    })
    const worker = hostCreateWorker({ ...fixture.input, concurrency: 2,
                                                                        /**
                                                                         * 收集并发执行事件的 Host、槽位和租约包装。
                                                                         *
                                                                         * @param event 已包装的 Host 执行事件，保存后核对身份。
                                                                         */
                                                                        onEvent: event => {
      events.push(event)
    } }, runner)
    try {
      expect(worker.concurrency).toBe(2)
      await worker.start()
      await fixture.publish('work-a'); await fixture.publish('work-a')
      await fixture.publish('work-b'); await fixture.publish('work-c')
      await vi.waitFor(() => /* 等待两个执行槽都开始工作。 */ expect(started).toHaveLength(2), { timeout: 3000 })
      expect(maximum).toBe(2)
      expect(claims.get('work-a')).toBe(1)
      const finishedEarly = started.find(id => /* 找到另一个并发任务。 */ id !== 'work-a')!
      releases.get(finishedEarly)!()
      await vi.waitFor(() => /* 等待第三个不同工作取得刚归还的槽位。 */ expect(started).toContain('work-c'), { timeout: 3000 })
      for (const id of ['work-a', 'work-b', 'work-c']) releases.get(id)?.()
      await vi.waitFor(() => /* 等待三个工作均完成并调用 release。 */ expect(active).toBe(0))
      expect(new Set(started)).toEqual(new Set(['work-a', 'work-b', 'work-c']))
      expect(events).toHaveLength(3)
      expect(new Set(events.map(event => /* 返回事件所属槽位。 */ event.executionSlotId)).size).toBe(2)
      for (const event of events) expect(event).toMatchObject({ hostId: fixture.input.hostId, workId: expect.any(String),
        holderId: expect.any(String), fence: 1, event: { method: 'session.status', params: { status: 'running' } } })
    } finally {
      for (const release of releases.values()) release()
      await worker.close(); await fixture.close()
    }
  })

  it('isolates one lost lease without cancelling another slot', async () => {
    // 让一个并发工作续租失败，验证另一个执行槽保持运行且 Host 继续消费。
    vi.spyOn(console, 'error').mockImplementation(() => {
      // 抑制本用例预期失租诊断。
    })
    const claims = new Map<string, number>(), aborted: string[] = []
    const fixture = await hostCreateFixture((method, params) => {
      // lost 工作首次授权后续租失败，重投时过时；survivor 工作正常续租与释放。
      if (method === 'claim') {
        const count = (claims.get(params.workId) ?? 0) + 1
        claims.set(params.workId, count)
        if (params.workId === 'lost' && count > 1) return { data: { status: 'obsolete' } }
        return { data: { status: 'claimed', grant: fixture.grant(params.holderId, 300, params.workId) } }
      }
      if (method === 'renew' && params.workId === 'lost') return { status: 409, error: { code: 'LEASE_LOST', message: 'taken over' } }
      if (method === 'renew') return { data: fixture.grant(params.holderId, 300, params.workId) }
      return { data: { released: true } }
    })
    let survivorSignal: AbortSignal | undefined, finishSurvivor!: () => void
    const survivorDone = new Promise<void>(resolve => {
      // 保存 survivor 的完成回调。
      finishSurvivor = resolve
    })
    const runner = vi.fn(async (input: DshWorkInput) => {
      // lost 等待并记录自身取消；survivor 保持活动直到用例确认隔离成功。
      if (input.grant.workId === 'lost') {
        await new Promise<void>(resolve => {
          // 等待租约续租失败触发当前工作信号。
          input.signal!.addEventListener('abort', () => /* 记录取消到达后解除等待。 */ resolve(), { once: true })
        })
        aborted.push('lost')
        throw input.signal!.reason
      }
      survivorSignal = input.signal
      await survivorDone
      return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
    })
    const worker = hostCreateWorker({ ...fixture.input, concurrency: 2, requestTimeoutMs: 1000 }, runner)
    try {
      await worker.start(); await fixture.publish('lost'); await fixture.publish('survivor')
      await vi.waitFor(() => /* 等待 lost 的续租失败只取消其自身执行。 */ expect(aborted).toEqual(['lost']), { timeout: 3000 })
      expect(survivorSignal?.aborted).toBe(false)
      let ended = false
      void worker.finished().then(() => {
        // 标记 Host 消费循环意外结束，隔离成功时该值应保持 false。
        ended = true
      })
      await delay(50)
      expect(ended).toBe(false)
    } finally {
      finishSurvivor()
      await worker.close(); await fixture.close()
    }
  })

  it('defaults to one slot and rejects capacities outside 1..64', async () => {
    // 验证兼容默认容量及配置上限在打开任何队列连接前生效。
    const fixture = await hostCreateFixture(() => {
      // 容量校验用例不应调用工作 API。
      throw new Error('Unexpected API call')
    })
    try {
      expect(hostCreateWorker(fixture.input).concurrency).toBe(1)
      for (const concurrency of [0, 65, 1.5, Number.NaN]) {
        expect(() => /* 以当前非法容量创建 Host，必须同步拒绝。 */ hostCreateWorker({ ...fixture.input, concurrency })).toThrow('1 to 64')
      }
    } finally { await fixture.close() }
  })

  it('rejects a different API namespace before consuming work', async () => {
    // 验证 API 与 Host 的命名空间不一致时在消费前失败。
    const fixture = await hostCreateFixture(() => {
      // 若命名空间校验失败后仍尝试领取，立即令测试失败。
       throw new Error('Unexpected claim') })
    const worker = hostCreateWorker({ ...fixture.input, queue: { ...fixture.input.queue, namespace: 'another-' + randomUUID() } })
    try { await expect(worker.start()).rejects.toThrow('does not match') }
    finally { await worker.close(); await fixture.close() }
  })

  it('terminates on an invalid work protocol response instead of retrying forever', async () => {
    // 验证非法领取响应触发永久协议故障而非无休止重试。
    let claims = 0
    const fixture = await hostCreateFixture(method => {
      // 返回未知领取状态并记录次数，供终止行为断言。
      if (method === 'claim') { claims++; return { data: { status: 'unexpected' } } }
      return { data: { released: true } }
    })
    const runner = vi.fn()
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start(); await fixture.publish()
      await expect(worker.finished()).resolves.toMatchObject({ name: 'HostProtocolError' })
      expect(claims).toBe(1)
      expect(runner).not.toHaveBeenCalled()
    } finally { await worker.close(); await fixture.close() }
  })

  it('aborts a disconnected delivery and drains DSH before reconnecting and accepting redelivery', async () => {
    // 验证 broker 断流取消当前工作，等清理与释放后才重连处理重投。
    vi.spyOn(console, 'error').mockImplementation(() => {
      // 抑制断线测试预期产生的控制台错误。
    })
    const events: string[] = []
    let finishCleanup!: () => void
    const cleanup = new Promise<void>(resolve => {
      // 保存断线后 DSH 清理的可控完成回调。
       finishCleanup = resolve })
    const fixture = await hostCreateFixture((method, params) => {
      // 记录工作 API 调用并为每次领取返回匹配持有者的授权。
      events.push(method)
      return { data: method === 'claim' ? { status: 'claimed', grant: fixture.grant(params.holderId) } : { released: true } }
    }, true)
    let executions = 0
    const runner = vi.fn(async (input: DshWorkInput) => {
      // 首次执行等待断线取消和清理，后续执行记录替代运行成功。
      if (++executions > 1) {
        events.push('runner.replacement')
        return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
      }
      await new Promise<void>(resolve => /* 把首次执行的取消信号转为可等待同步点。 */  input.signal!.addEventListener('abort', () => /* 断流引发取消后解除执行等待。 */  resolve(), { once: true }))
      events.push('runner.aborted')
      await cleanup
      events.push('runner.exited')
      throw input.signal!.reason
    })
    const worker = hostCreateWorker(fixture.input, runner)
    try {
      await worker.start()
      await fixture.publish()
      await vi.waitFor(() => /* 等待原工作执行开始，再切断代理连接。 */  expect(runner).toHaveBeenCalledTimes(1))
      fixture.disconnect()
      await vi.waitFor(() => /* 等待断线取消确实传递到执行器。 */  expect(events).toContain('runner.aborted'))
      await delay(300)
      expect(events.filter(event => /* 统计断线清理期间的领取次数，确认没有提前接管。 */  event === 'claim')).toHaveLength(1)
      expect(events).not.toContain('release')
      finishCleanup()
      await vi.waitFor(() => /* 等待替代执行开始，供断线恢复顺序断言。 */  expect(events).toContain('runner.replacement'), { timeout: 5000 })
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('runner.exited'))
      expect(events.indexOf('runner.replacement')).toBeGreaterThan(events.indexOf('release'))
      expect(events).not.toContain('fail')
    } finally { finishCleanup(); await worker.close(); await fixture.close() }
  })
})
