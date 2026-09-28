// 文件职责：通过真实 RabbitMQ 与可控工作 API 验证 Host 领取、续租、重试和排空。
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GraphWorkGrant } from '../../../contracts/graph'
import type { DshWorkInput } from '../../../backend/execution/dsh/work-executor'
import { hostCreateWorker } from '../../../backend/execution/host-worker'
import { queueOpen, queueCreateTransport } from '../../../backend/adapters/messaging/rabbitmq'
import { rabbitCreateFixture } from '../fixtures/rabbitmq'

afterEach(() => /* 每个用例结束后恢复日志及执行器替身。 */  vi.restoreAllMocks())

async function hostCreateFixture(/* 用例提供的工作 API 行为，按方法和载荷返回授权、状态或错误。 */ handler: (/* Host 发起的工作命令名，例如 claim、renew 或 release。 */ method: string, /* 工作请求中已由夹具解码的参数，包含待回显的 holderId。 */ params: Record<string, string>) => { status?: number; data?: unknown; error?: unknown }, /* 是否启用可断开的 TCP 代理，默认 false 直接连接真实 broker。 */ proxy = false) {
  // 建立真实消息队列、可控工作 API 和可选断线代理，返回授予工作与清理工具。
  const broker = await rabbitCreateFixture()
  const deploymentId = randomUUID(), mapId = randomUUID(), runId = randomUUID(), hostId = randomUUID()
  const queue = broker.queue
  const link = await queueOpen({ ...queue, namespace: queue.namespace + '.' + deploymentId })
  const sockets = new Set<Socket>()
  const address = new URL(queue.url)
  const brokerPort = Number(address.port || 5672), brokerHost = address.hostname
  const tunnel = proxy ? createTcpServer(/* Host 连接到代理的客户端套接字，与新建上游成对管理。 */ socket => {
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
    await new Promise<void>(/* 代理成功监听临时端口后兑现启动等待的回调。 */ resolve => /* 等待 AMQP 测试代理监听本地临时端口。 */  tunnel.listen(0, '127.0.0.1', resolve))
    const binding = tunnel.address()
    if (!binding || typeof binding === 'string') throw new Error('AMQP test tunnel did not bind')
    address.hostname = '127.0.0.1'; address.port = String(binding.port)
  }
  const workId = 'route'
  const server = createServer(async (/* Host 发来的原始 HTTP 请求，夹具读取命令或返回消息配置。 */ request, /* 向 Host 返回模拟工作结果的响应流。 */ response) => {
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
  await new Promise<void>(/* 工作 API 服务监听成功后的启动完成回调。 */ resolve => /* 等待工作 API 测试服务器绑定临时端口。 */  server.listen(0, '127.0.0.1', resolve))
  const binding = server.address()
  if (!binding || typeof binding === 'string') throw new Error('Test server did not bind')
  return {
    input: { hostId, dataApiUrl: `http://127.0.0.1:${binding.port}`, token: 'host-test-token', dshHome: '/unused-host-test', queue: queueCreateTransport({ ...queue, url: address.toString() }) },
    disconnect: () => {
      // 强制销毁全部代理连接以模拟 broker 断流。
       for (const socket of sockets) socket.destroy() },
    grant(/* 本次 claim 请求的持有者身份，夹具授权必须原样回显。 */ holderId: string, /* 测试租约时长，单位毫秒，默认 30000；失租用例可缩短。 */ leaseMs = 30_000): GraphWorkGrant {
      // 构造绑定本夹具部署和图的工作授权，可调整租约时长。
      return { workId, mapId, runId, operationId: `${runId}:verify:claim`, actor: { role: 'router' }, routeRevision: 0,
        hostId, holderId, fence: 1, leaseMs, expiresAt: new Date(Date.now() + leaseMs).toISOString() }
    },
    publish: () => /* 向本夹具命名空间发布固定工作的领取通知。 */  link.publishWork({ version: 1, deploymentId, mapId, workId }),
    async close() {
      // 关闭发布连接、代理和 HTTP 服务，再清理队列命名空间与 broker 夹具。
      await link.close()
      for (const socket of sockets) socket.destroy()
      if (tunnel) await new Promise<void>((/* AMQP 代理正常关闭后兑现清理等待的回调。 */ resolve, /* AMQP 代理关闭失败时拒绝清理等待的回调。 */ reject) => /* 等待 AMQP 代理停止监听。 */  tunnel.close(/* 代理关闭操作返回的可选异常，传给清理 Promise。 */ error => /* 传递 AMQP 代理关闭的成功或失败结果。 */  error ? reject(error) : resolve()))
      server.closeAllConnections()
      await new Promise<void>((/* 工作 API 正常停止监听后的完成回调。 */ resolve, /* 工作 API 关闭失败时的拒绝回调。 */ reject) => /* 等待工作 API HTTP 服务器关闭。 */  server.close(/* HTTP 服务器关闭时返回的可选错误。 */ error => /* 传递工作 API 服务器关闭的成功或失败结果。 */  error ? reject(error) : resolve()))
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
    const fixture = await hostCreateFixture((/* 暂时访问失败用例中 Host 调用的方法，用于记录领取与释放顺序。 */ method, /* 该次工作命令的参数，领取时用于生成匹配的 holder 授权。 */ params) => {
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
    const cleanup = new Promise<void>(/* 模拟 DSH 清理的完成回调，由用例在断言等待状态后显式释放。 */ resolve => {
      // 保存允许模拟 DSH 完成清理的释放回调。
       finishCleanup = resolve })
    const fixture = await hostCreateFixture((/* 失租用例中 Host 请求的方法，续租时刻意返回 LEASE_LOST。 */ method, /* 失租用例的命令参数，领取阶段从中取得实际 holderId。 */ params) => {
      // 授予短租约并在续租时返回失租，驱动执行取消路径。
      events.push(method)
      if (method === 'claim') return { data: { status: 'claimed', grant: fixture.grant(params.holderId, 900) } }
      if (method === 'renew') return { status: 409, error: { code: 'LEASE_LOST', message: 'Lease was taken over' } }
      return { data: { released: true } }
    })
    const worker = hostCreateWorker({ ...fixture.input, requestTimeoutMs: 1000 }, async /* Host 交给执行器的授权、环境与取消信号，用于验证绑定和清理顺序。 */ input => {
      // 检查传给执行器的身份，等待失租取消后延迟完成清理。
      expect(input.grant.hostId).toBe(fixture.input.hostId)
      expect(input.grant.holderId).toMatch(/^[0-9a-f-]{36}$/)
      expect(input.env?.CHONGMING_HOST_ID).toBe(fixture.input.hostId)
      await new Promise<void>(/* 执行取消到达后解除等待的回调，已取消时立即调用。 */ resolve => {
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
      await new Promise<void>(/* 下一个事件循环轮次的完成回调，用于观察关闭是否提前结束。 */ resolve => /* 让出一个事件循环轮次，检查清理未完成时关闭仍在等待。 */  setImmediate(resolve))
      expect(closed).toBe(false)
      expect(events).not.toContain('release')
      finishCleanup()
      await observedClose
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('runner.exited'))
      expect(events.filter(/* 记录的 Host 生命周期方法或运行器标记，筛出 claim 统计次数。 */ event => /* 统计领取事件，确认清理期间未开始下一份执行。 */  event === 'claim')).toHaveLength(1)
      expect(events).not.toContain('fail')
    } finally { finishCleanup(); await worker.close(); await fixture.close() }
  })

  it('retains a busy delivery until its lease expires and ignores already accepted duplicates', async () => {
    // 验证 busy 投递等待服务器期限后重试，已接纳重复消息不会再次执行。
    const claims: number[] = []
    let accepted = false
    const fixture = await hostCreateFixture((/* 占用重试用例的工作方法，首次 claim 返回 busy。 */ method, /* 工作命令中的领取身份，成功时原样写入模拟授权。 */ params) => {
      // 首次领取返回 busy，后续根据是否已接纳返回授权或过时状态。
      if (method !== 'claim') return { data: { released: true } }
      claims.push(performance.now())
      if (claims.length === 1) return { data: { status: 'busy', retryAfterMs: 200 } }
      return { data: accepted ? { status: 'obsolete' } : { status: 'claimed', grant: fixture.grant(params.holderId) } }
    })
    const runner = vi.fn(async (/* Host 传入的工作配置，模拟成功结果沿用其 grant。 */ input: DshWorkInput) => {
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
    const fixture = await hostCreateFixture(/* 协议故障用例收到的方法，claim 返回刻意非法的状态。 */ method => {
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
    const cleanup = new Promise<void>(/* 断线后执行器清理的可控释放函数，测试决定何时允许结束。 */ resolve => {
      // 保存断线后 DSH 清理的可控完成回调。
       finishCleanup = resolve })
    const fixture = await hostCreateFixture((/* 断线恢复用例观察到的工作方法，用于记录释放与接管顺序。 */ method, /* Host 发来的领取参数，用 holderId 建立本次独立授权。 */ params) => {
      // 记录工作 API 调用并为每次领取返回匹配持有者的授权。
      events.push(method)
      return { data: method === 'claim' ? { status: 'claimed', grant: fixture.grant(params.holderId) } : { released: true } }
    }, true)
    let executions = 0
    const runner = vi.fn(async (/* 本次执行的工作配置，首次等待取消，重投时返回已接纳结果。 */ input: DshWorkInput) => {
      // 首次执行等待断线取消和清理，后续执行记录替代运行成功。
      if (++executions > 1) {
        events.push('runner.replacement')
        return { ...input.grant, status: 'accepted' as const, sessionId: null, finalResponse: '' }
      }
      await new Promise<void>(/* 首次执行收到断流取消后兑现同步点的函数。 */ resolve => /* 把首次执行的取消信号转为可等待同步点。 */  input.signal!.addEventListener('abort', () => /* 断流引发取消后解除执行等待。 */  resolve(), { once: true }))
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
      expect(events.filter(/* 断线恢复日志中的方法或运行器标记，筛选领取次数。 */ event => /* 统计断线清理期间的领取次数，确认没有提前接管。 */  event === 'claim')).toHaveLength(1)
      expect(events).not.toContain('release')
      finishCleanup()
      await vi.waitFor(() => /* 等待替代执行开始，供断线恢复顺序断言。 */  expect(events).toContain('runner.replacement'), { timeout: 5000 })
      expect(events.indexOf('release')).toBeGreaterThan(events.indexOf('runner.exited'))
      expect(events.indexOf('runner.replacement')).toBeGreaterThan(events.indexOf('release'))
      expect(events).not.toContain('fail')
    } finally { finishCleanup(); await worker.close(); await fixture.close() }
  })
})
