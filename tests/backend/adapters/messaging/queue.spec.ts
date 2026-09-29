// 文件职责：验证真实 RabbitMQ 的命名空间、发布确认、重投、广播与网络黑洞收尾。
import { randomUUID } from 'node:crypto'
import { connect as connectTcp, createServer, type Socket } from 'node:net'
import { connect } from 'amqplib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queueOpen } from '../../../../backend/adapters/messaging/rabbitmq'
import { type QueueLink } from '../../../../backend/ports/messaging'
import type { QueueWork } from '../../../../contracts/events'
import { rabbitCreateFixture } from '../../fixtures/rabbitmq'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  // 逆序执行用例注册的连接、代理与 broker 清理。
   for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  // 建立隔离 broker 命名空间及原生控制通道，并跟踪业务连接以统一关闭。
  const broker = await rabbitCreateFixture()
  cleanups.push(broker.close)
  const links: QueueLink[] = []
  const raw = await connect(broker.queue.url)
  raw.on('error', () => {
    // 吸收测试原生连接的预期错误事件，操作失败由对应 Promise 断言。
  })
  const channel = await raw.createChannel()
  channel.on('error', () => {
    // 吸收检查不存在资源时通道发出的预期错误事件。
  })
  cleanups.push(async () => {
    // 关闭全部业务连接与原生通道，再删除本夹具命名空间。
    for (const link of links) await link.close()
    await raw.close().catch(() => {
      // 原生连接可能已被 broker 关闭，清理时继续删除命名空间。
    })
    await broker.deleteNamespace(broker.queue.namespace)
  })
  const open = async () => {
    // 打开一个业务队列连接并登记后续关闭。
     const link = await queueOpen(broker.queue); links.push(link); return link }
  return { config: broker.queue, channel, open, deleteNamespace: broker.deleteNamespace }
}
function notice(): QueueWork {
  // 构造具有独立部署、图与工作身份的合法通知。
   return { version: 1, deploymentId: randomUUID(), mapId: randomUUID(), workId: randomUUID() + ':verify' } }

describe('RabbitMQ work transport', () => {
  // 覆盖工作确认、广播隔离、坏消息和传输故障恢复。
  it('deletes only its fixture namespace while keeping another fixture available', async () => {
    // 删除一个夹具的队列与交换机，验证邻居命名空间不受影响且禁止越界清理。
    const owned = await fixture(), neighbor = await fixture()
    const first = await owned.open(), second = await neighbor.open()
    await first.close()
    await owned.deleteNamespace(owned.config.namespace)
    await expect(owned.channel.checkQueue(owned.config.namespace + '.work')).rejects.toMatchObject({ code: 404 })
    await expect(owned.deleteNamespace(neighbor.config.namespace)).rejects.toThrow('another fixture')
    await second.publishWork(notice())
    expect((await neighbor.channel.checkQueue(neighbor.config.namespace + '.work')).messageCount).toBe(1)
    const connection = await connect(owned.config.url)
    connection.on('error', () => {
      // 吸收检查已删除交换机时原生连接的错误事件。
    })
    try {
      for (const suffix of ['.work-exchange', '.events']) {
        const channel = await connection.createChannel()
        channel.on('error', () => {
          // 吸收预期的交换机不存在错误，让拒绝断言读取结果。
        })
        await expect(channel.checkExchange(owned.config.namespace + suffix)).rejects.toMatchObject({ code: 404 })
      }
    } finally { await connection.close() }
  })

  it('retains work until ACK and broadcasts changes independently to API subscribers', async () => {
    // 验证工作直到确认才移出队列，变更广播可独立抵达多个订阅者。
    const f = await fixture(), producer = await f.open(), worker = await f.open(), peer = await f.open()
    const a: string[] = [], b: string[] = []
    const stopA = await worker.subscribeChanges(/* 第一个 API 订阅者收到的合法图变更，记录其 mapId。 */ event => /* 记录第一个订阅者收到的图身份。 */  a.push(event.mapId!))
    const stopB = await peer.subscribeChanges(/* 第二个独立订阅者收到的合法变更，记录其图身份用于比较广播结果。 */ event => /* 记录第二个订阅者收到的图身份。 */  b.push(event.mapId!))
    const item = notice()
    await producer.publishWork(item)
    const before = await f.channel.checkQueue(f.config.namespace + '.work')
    expect(before.messageCount).toBe(1)
    await producer.publishChange({ version: 1, deploymentId: item.deploymentId, kind: 'graph', mapId: item.mapId })
    await vi.waitFor(() => {
      // 等待两个订阅者均收到同一图广播。
       expect(a).toEqual([item.mapId]); expect(b).toEqual(a) })
    const stop = new AbortController(), seen: QueueWork[] = []
    const running = worker.consumeWork(async /* 真实 broker 投递并经协议解析的工作通知，记录后返回 ack。 */ work => {
      // 记录消费到的工作并确认投递。
       seen.push(work); return 'ack' }, stop.signal)
    await vi.waitFor(() => /* 等待消费者收到唯一的目标工作。 */  expect(seen).toEqual([item]))
    await vi.waitFor(async () => /* 检查 broker 队列直到已确认消息被移除。 */  expect((await f.channel.checkQueue(f.config.namespace + '.work')).messageCount).toBe(0))
    stop.abort(); await running; await stopA(); await stopB()
  })

  it('drops malformed change hints but aborts the transport when application handler code throws', async () => {
    // 验证畸形显示提示被丢弃，而应用处理器异常会终止传输。
    const f = await fixture(), producer = await f.open(), malformed = await f.open(), broken = await f.open()
    let seen = 0
    const stopMalformed = await malformed.subscribeChanges(() => {
      // 统计真正进入业务处理器的变更提示。
       seen++ })
    f.channel.publish(f.config.namespace + '.events', '', Buffer.from('{"invalid":true}'))
    await new Promise(/* 短暂投递观察窗口结束时的回调，允许畸形消息先被消费。 */ resolve => /* 等待短暂投递窗口，验证畸形提示没有被转交。 */  setTimeout(resolve, 50))
    expect(seen).toBe(0)
    expect(malformed.signal.aborted).toBe(false)
    const stopBroken = await broken.subscribeChanges(() => {
      // 模拟订阅业务代码抛错，测试处理器故障边界。
       throw new Error('handler bug') })
    const item = notice()
    await producer.publishChange({ version: 1, deploymentId: item.deploymentId, kind: 'graph', mapId: item.mapId })
    await expect.poll(() => /* 轮询错误处理器对应连接是否已被取消。 */  broken.signal.aborted).toBe(true)
    expect(broken.signal.reason).toMatchObject({ code: 'QUEUE_HANDLER' })
    await stopMalformed(); await stopBroken()
  })

  it('rejects a mandatory work publish that has no bound destination', async () => {
    // 解除工作队列绑定，验证 mandatory 发布报告无法路由。
    const f = await fixture(), producer = await f.open()
    await f.channel.unbindQueue(f.config.namespace + '.work', f.config.namespace + '.work-exchange', 'work')
    await expect(producer.publishWork(notice())).rejects.toMatchObject({ code: 'QUEUE_UNROUTABLE' })
  })

  it('redelivers a retry and aborts then drains the active handler before close returns', async () => {
    // 验证 retry 重新投递，取消时等待处理器排空，未确认工作可由新连接恢复。
    const f = await fixture(), producer = await f.open(), worker = await f.open(), item = notice()
    await producer.publishWork(item)
    const stop = new AbortController(), order: string[] = []
    const running = worker.consumeWork(async (/* 当前收到的工作通知，应与最初发布对象完全相同。 */ work, /* 本次投递的取消信号，用来验证关闭会等待处理器收尾。 */ signal) => {
      // 首次返回重试，第二次等待取消并模拟异步清理。
      expect(work).toEqual(item)
      if (!order.length) { order.push('retry'); return 'retry' }
      order.push('started')
      await new Promise<void>(/* 收到投递取消后兑现处理器等待的回调。 */ resolve => /* 等待当前投递的取消信号。 */  signal.addEventListener('abort', () => /* 取消发生后解除处理器等待。 */  resolve(), { once: true }))
      await new Promise(/* 模拟执行器清理延迟结束后的兑现函数。 */ resolve => /* 模拟执行器需要短暂时间释放资源。 */  setTimeout(resolve, 20))
      order.push('drained'); return 'ack'
    }, stop.signal)
    await vi.waitFor(() => /* 等待第一次重试完成且第二次投递已开始处理。 */  expect(order).toEqual(['retry', 'started']))
    stop.abort(); await running
    expect(order).toEqual(['retry', 'started', 'drained'])
    const replacement = await f.open(), finish = new AbortController(), delivered: QueueWork[] = []
    const recovery = replacement.consumeWork(async /* 替代消费者收到的未确认原工作，记录后正常确认。 */ work => {
      // 记录新消费者恢复的未确认工作并发送确认。
       delivered.push(work); return 'ack' }, finish.signal)
    await vi.waitFor(() => /* 等待新消费者收到原来的工作消息。 */  expect(delivered).toEqual([item]))
    finish.abort(); await recovery
  })

  it('prefetches up to the configured capacity, confirms each result independently and drains all active handlers', async () => {
    // 以容量 2 乱序完成三项工作，停止时只让尚未确认的一项重投，并等待它完成清理。
    const f = await fixture(), producer = await f.open(), worker = await f.open()
    const items = [notice(), notice(), notice()]
    for (const item of items) await producer.publishWork(item)
    const stop = new AbortController(), started: QueueWork[] = [], releases = new Map<string, () => void>()
    let active = 0, maximum = 0
    const running = worker.consumeWork(async (/* broker 在容量内投递的一份工作，按 workId 等待测试释放。 */ work) => {
      // 记录活动处理器数并允许后启动项先确认，供独立 ACK 与关闭排空断言使用。
      started.push(work); active++; maximum = Math.max(maximum, active)
      await new Promise<void>(/* 当前消息处理的完成开关，由用例按乱序释放。 */ resolve => {
        // 保存当前 workId 对应的释放函数。
        releases.set(work.workId, resolve)
      })
      active--
      return 'ack'
    }, stop.signal, { concurrency: 2 })
    await vi.waitFor(() => /* 等待预取容量中的两项都进入处理器。 */ expect(started).toHaveLength(2))
    expect(maximum).toBe(2)
    const held = started[0], completedFirst = started[1]
    releases.get(completedFirst.workId)!()
    await vi.waitFor(() => /* 等待第二项确认后第三项取得空闲容量。 */ expect(started).toHaveLength(3))
    const completedSecond = started[2]
    releases.get(completedSecond.workId)!()
    await vi.waitFor(() => /* 等待第三项处理器真正归还活动计数。 */ expect(active).toBe(1))
    stop.abort()
    let drained = false
    void running.then(() => {
      // 标记消费者完成全部在途清理，用于确认最早任务仍能阻止关闭完成。
      drained = true
    })
    await new Promise<void>(/* 让出一个事件循环轮次观察排空状态。 */ resolve => /* 下一轮检查消费者仍未完成。 */ setImmediate(resolve))
    expect(drained).toBe(false)
    releases.get(held.workId)!()
    await running
    expect(active).toBe(0)
    const replacement = await f.open(), finish = new AbortController(), recovered: QueueWork[] = []
    const recovery = replacement.consumeWork(async /* 新连接收到的未确认投递，应只有停止时仍活动的第一项。 */ work => {
      // 保存恢复项并确认，已独立确认的另外两项不得再次出现。
      recovered.push(work); return 'ack'
    }, finish.signal, { concurrency: 2 })
    await vi.waitFor(() => /* 等待未确认的最早工作被新连接恢复。 */ expect(recovered).toEqual([held]))
    finish.abort(); await recovery
  })

  it('settles an unconfirmed publish and closes its transport after a TCP blackhole', async () => {
    // 模拟 TCP 黑洞，验证发布确认超时后连接及 Promise 都在有界时间内结束。
    const f = await fixture(), broker = new URL(f.config.url), sockets = new Set<Socket>()
    let blackhole = false, producer: QueueLink | undefined
    const proxy = createServer(/* 发布连接连入黑洞代理的客户端套接字，与 broker 上游成对管理。 */ client => {
      // 建立可切换黑洞的双向 TCP 代理，跟踪所有套接字以验证释放。
      const upstream = connectTcp(Number(broker.port || 5672), broker.hostname)
      sockets.add(client); sockets.add(upstream)
      client.on('data', /* 客户端发往 broker 的字节块，黑洞开启后故意不转发。 */ data => {
        // 黑洞关闭前转发客户端发往 broker 的字节。
         if (!blackhole) upstream.write(data) })
      upstream.on('data', /* broker 发往客户端的字节块，黑洞开启后故意丢弃以阻断确认。 */ data => {
        // 黑洞关闭前转发 broker 发往客户端的字节。
         if (!blackhole) client.write(data) })
      for (const socket of [client, upstream]) {
        socket.on('error', () => {
          // 吸收故障代理的预期套接字错误，生命周期由关闭事件负责。
        })
        socket.on('close', () => {
          // 从集合移除关闭套接字并销毁对应双向连接。
           sockets.delete(socket); client.destroy(); upstream.destroy() })
      }
    })
    await new Promise<void>(/* 黑洞代理绑定本地端口后的启动完成回调。 */ resolve => /* 等待黑洞代理绑定本地临时端口。 */  proxy.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      // 销毁代理连接并关闭监听，确保失败回归也不会卡在未完成连接上。
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((/* 代理正常停止监听后兑现清理等待的回调。 */ resolve, /* 代理关闭失败时拒绝清理等待的回调。 */ reject) => /* 把代理关闭回调转换为可等待清理。 */  proxy.close(/* TCP 代理关闭返回的可选错误，传给清理 Promise。 */ error => /* 传递代理关闭的错误或成功状态。 */  error ? reject(error) : resolve()))
      // The regression itself is an unresolved close promise; destroyed sockets bound failure cleanup.
      void producer?.close()
    })
    const address = proxy.address()
    if (!address || typeof address === 'string') throw new Error('Queue test proxy did not bind')
    const proxyUrl = new URL(f.config.url)
    proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = String(address.port)
    producer = await queueOpen({ ...f.config, url: proxyUrl.toString() })
    blackhole = true
    let settled = false, failure: unknown, abortedAt = 0, settledAt = 0
    producer.signal.addEventListener('abort', () => {
      // 记录连接被取消的单调时间，用于衡量发布收尾时限。
       abortedAt = performance.now() }, { once: true })
    void producer.publishWork(notice()).catch(/* 发布在确认期限后产生的错误，保留用于核对超时错误码。 */ error => {
      // 保存未获确认发布的实际错误。
       failure = error }).finally(() => {
      // 记录发布 Promise 结束状态和时间。
      settled = true; settledAt = performance.now()
    })
    await expect.poll(() => /* 轮询发布是否已在期限内完成或失败。 */  settled, { timeout: 18_000, interval: 50 }).toBe(true)
    expect(failure).toMatchObject({ code: 'QUEUE_CONFIRM_TIMEOUT' })
    expect(abortedAt).toBeGreaterThan(0)
    expect(settledAt - abortedAt).toBeLessThan(2000)
    await expect.poll(() => /* 轮询代理套接字是否全部释放。 */  sockets.size, { timeout: 1000 }).toBe(0)
    await producer.close()
    const recovered = await f.open()
    await recovered.publishWork(notice())
    expect((await f.channel.checkQueue(f.config.namespace + '.work')).messageCount).toBe(1)
  }, 25_000)
})
