import { randomUUID } from 'node:crypto'
import { connect as connectTcp, createServer, type Socket } from 'node:net'
import { connect } from 'amqplib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { queueOpen } from '../../../../backend/adapters/messaging/rabbitmq'
import { type QueueLink } from '../../../../backend/ports/messaging'
import type { QueueWork } from '../../../../contracts/events'
import { rabbitCreateFixture } from '../../fixtures/rabbitmq'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close() })
async function fixture() {
  const broker = await rabbitCreateFixture()
  cleanups.push(broker.close)
  const links: QueueLink[] = []
  const raw = await connect(broker.queue.url)
  raw.on('error', () => {})
  const channel = await raw.createChannel()
  channel.on('error', () => {})
  cleanups.push(async () => {
    for (const link of links) await link.close()
    await raw.close().catch(() => {})
    await broker.deleteNamespace(broker.queue.namespace)
  })
  const open = async () => { const link = await queueOpen(broker.queue); links.push(link); return link }
  return { config: broker.queue, channel, open, deleteNamespace: broker.deleteNamespace }
}
function notice(): QueueWork { return { version: 1, deploymentId: randomUUID(), mapId: randomUUID(), workId: randomUUID() + ':verify' } }

describe('RabbitMQ work transport', () => {
  it('deletes only its fixture namespace while keeping another fixture available', async () => {
    const owned = await fixture(), neighbor = await fixture()
    const first = await owned.open(), second = await neighbor.open()
    await first.close()
    await owned.deleteNamespace(owned.config.namespace)
    await expect(owned.channel.checkQueue(owned.config.namespace + '.work')).rejects.toMatchObject({ code: 404 })
    await expect(owned.deleteNamespace(neighbor.config.namespace)).rejects.toThrow('another fixture')
    await second.publishWork(notice())
    expect((await neighbor.channel.checkQueue(neighbor.config.namespace + '.work')).messageCount).toBe(1)
    const connection = await connect(owned.config.url)
    connection.on('error', () => {})
    try {
      for (const suffix of ['.work-exchange', '.events']) {
        const channel = await connection.createChannel()
        channel.on('error', () => {})
        await expect(channel.checkExchange(owned.config.namespace + suffix)).rejects.toMatchObject({ code: 404 })
      }
    } finally { await connection.close() }
  })

  it('retains work until ACK and broadcasts changes independently to API subscribers', async () => {
    const f = await fixture(), producer = await f.open(), worker = await f.open(), peer = await f.open()
    const a: string[] = [], b: string[] = []
    const stopA = await worker.subscribeChanges(event => a.push(event.mapId!))
    const stopB = await peer.subscribeChanges(event => b.push(event.mapId!))
    const item = notice()
    await producer.publishWork(item)
    const before = await f.channel.checkQueue(f.config.namespace + '.work')
    expect(before.messageCount).toBe(1)
    await producer.publishChange({ version: 1, deploymentId: item.deploymentId, kind: 'graph', mapId: item.mapId })
    await vi.waitFor(() => { expect(a).toEqual([item.mapId]); expect(b).toEqual(a) })
    const stop = new AbortController(), seen: QueueWork[] = []
    const running = worker.consumeWork(async work => { seen.push(work); return 'ack' }, stop.signal)
    await vi.waitFor(() => expect(seen).toEqual([item]))
    await vi.waitFor(async () => expect((await f.channel.checkQueue(f.config.namespace + '.work')).messageCount).toBe(0))
    stop.abort(); await running; await stopA(); await stopB()
  })

  it('drops malformed change hints but aborts the transport when application handler code throws', async () => {
    const f = await fixture(), producer = await f.open(), malformed = await f.open(), broken = await f.open()
    let seen = 0
    const stopMalformed = await malformed.subscribeChanges(() => { seen++ })
    f.channel.publish(f.config.namespace + '.events', '', Buffer.from('{"invalid":true}'))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(seen).toBe(0)
    expect(malformed.signal.aborted).toBe(false)
    const stopBroken = await broken.subscribeChanges(() => { throw new Error('handler bug') })
    const item = notice()
    await producer.publishChange({ version: 1, deploymentId: item.deploymentId, kind: 'graph', mapId: item.mapId })
    await expect.poll(() => broken.signal.aborted).toBe(true)
    expect(broken.signal.reason).toMatchObject({ code: 'QUEUE_HANDLER' })
    await stopMalformed(); await stopBroken()
  })

  it('rejects a mandatory work publish that has no bound destination', async () => {
    const f = await fixture(), producer = await f.open()
    await f.channel.unbindQueue(f.config.namespace + '.work', f.config.namespace + '.work-exchange', 'work')
    await expect(producer.publishWork(notice())).rejects.toMatchObject({ code: 'QUEUE_UNROUTABLE' })
  })

  it('redelivers a retry and aborts then drains the active handler before close returns', async () => {
    const f = await fixture(), producer = await f.open(), worker = await f.open(), item = notice()
    await producer.publishWork(item)
    const stop = new AbortController(), order: string[] = []
    const running = worker.consumeWork(async (work, signal) => {
      expect(work).toEqual(item)
      if (!order.length) { order.push('retry'); return 'retry' }
      order.push('started')
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push('drained'); return 'ack'
    }, stop.signal)
    await vi.waitFor(() => expect(order).toEqual(['retry', 'started']))
    stop.abort(); await running
    expect(order).toEqual(['retry', 'started', 'drained'])
    const replacement = await f.open(), finish = new AbortController(), delivered: QueueWork[] = []
    const recovery = replacement.consumeWork(async work => { delivered.push(work); return 'ack' }, finish.signal)
    await vi.waitFor(() => expect(delivered).toEqual([item]))
    finish.abort(); await recovery
  })

  it('settles an unconfirmed publish and closes its transport after a TCP blackhole', async () => {
    const f = await fixture(), broker = new URL(f.config.url), sockets = new Set<Socket>()
    let blackhole = false, producer: QueueLink | undefined
    const proxy = createServer(client => {
      const upstream = connectTcp(Number(broker.port || 5672), broker.hostname)
      sockets.add(client); sockets.add(upstream)
      client.on('data', data => { if (!blackhole) upstream.write(data) })
      upstream.on('data', data => { if (!blackhole) client.write(data) })
      for (const socket of [client, upstream]) {
        socket.on('error', () => {})
        socket.on('close', () => { sockets.delete(socket); client.destroy(); upstream.destroy() })
      }
    })
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve))
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
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
    producer.signal.addEventListener('abort', () => { abortedAt = performance.now() }, { once: true })
    void producer.publishWork(notice()).catch(error => { failure = error }).finally(() => {
      settled = true; settledAt = performance.now()
    })
    await expect.poll(() => settled, { timeout: 18_000, interval: 50 }).toBe(true)
    expect(failure).toMatchObject({ code: 'QUEUE_CONFIRM_TIMEOUT' })
    expect(abortedAt).toBeGreaterThan(0)
    expect(settledAt - abortedAt).toBeLessThan(2000)
    await expect.poll(() => sockets.size, { timeout: 1000 }).toBe(0)
    await producer.close()
    const recovered = await f.open()
    await recovered.publishWork(notice())
    expect((await f.channel.checkQueue(f.config.namespace + '.work')).messageCount).toBe(1)
  }, 25_000)
})
