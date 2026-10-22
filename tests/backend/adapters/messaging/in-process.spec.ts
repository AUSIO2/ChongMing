// 文件职责：验证进程内工作队列的有界并发、去重、重试、独占消费与关闭排空。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { QueueWork } from '../../../../contracts/events'
import { localCreateMessaging } from '../../../../backend/adapters/messaging/in-process'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'

const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  // 逆序关闭本机消息、SQLite 和临时目录，确保挂起消费者不会进入下一用例。
  for (const close of cleanups.splice(0).reverse()) await close()
})

async function localCreateFixture() {
  // 建立带真实 SQLite 端口的进程内消息服务，返回工作通道和统一清理资源。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-in-process-'))
  const database = sqliteCreatePersistence(directory)
  const messaging = localCreateMessaging(database)
  await messaging.initialize()
  cleanups.push(() => /* 删除当前夹具使用的临时数据库目录。 */ rm(directory, { recursive: true, force: true }))
  cleanups.push(() => /* 关闭夹具持有的 SQLite 连接。 */ database.close())
  cleanups.push(() => /* 关闭本机消息并等待全部在途工作排空。 */ messaging.closeMessaging())
  return messaging.queue
}

/**
 * 构造符合队列协议的本机工作通知。
 *
 * @param workId 用例指定的稳定工作后缀，用于产生同图内不同工作。
 * @param mapId 可选图身份；省略时创建独立 UUID。
 */
function localNotice(workId: string, mapId = randomUUID()): QueueWork {
  return { version: 1, deploymentId: randomUUID(), mapId, workId }
}

describe('in-process work transport', () => {
  // 覆盖本机单消费者内部的容量、通知合并、重试和资源排空。
  it('bounds concurrency, coalesces duplicate pending/in-flight work and drains every handler on close', async () => {
    // 以容量 2 启动三份工作，先完成后一项，并验证关闭仍等待最早任务完成。
    const queue = await localCreateFixture(), mapId = randomUUID()
    const notices = ['one', 'two', 'three'].map(id => /* 建立当前编号的合法工作通知。 */ localNotice(id, mapId))
    await queue.publishWork(notices[0]); await queue.publishWork(notices[0])
    await queue.publishWork(notices[1]); await queue.publishWork(notices[2])
    const releases = new Map<string, () => void>(), started: string[] = []
    let active = 0, maximum = 0
    const running = queue.consumeWork(async work => {
      // 记录并发数并挂起当前工作，返回确认前归还活动计数。
      started.push(work.workId); active++; maximum = Math.max(maximum, active)
      await new Promise<void>(resolve => {
        // 按工作编号登记释放函数。
        releases.set(work.workId, resolve)
      })
      active--
      return 'ack'
    }, undefined, { concurrency: 2 })
    await vi.waitFor(() => /* 等待两个容量槽都被占用。 */ expect(started).toHaveLength(2))
    expect(maximum).toBe(2)
    await queue.publishWork(notices[0])
    releases.get('two')!()
    await vi.waitFor(() => /* 等待第二项结束后第三项取得刚归还的容量。 */ expect(started).toContain('three'))
    expect(started.filter(id => /* 统计第一项实际启动次数。 */ id === 'one')).toHaveLength(1)
    releases.get('three')!()
    const closing = queue.close()
    let closed = false
    void closing.then(() => {
      // 标记通道完成全部排空，供关闭不得提前结束的断言使用。
      closed = true
    })
    await new Promise<void>(resolve => /* 在下一轮检查仍挂起的第一项。 */ setImmediate(resolve))
    expect(closed).toBe(false)
    releases.get('one')!()
    await closing; await running
    expect(active).toBe(0)
  })

  it('retries only the requested work and still rejects a second simultaneous consumer', async () => {
    // 验证 retry 会重新运行同一项，且已有消费者等待时第二个消费者立即失败。
    const queue = await localCreateFixture(), item = localNotice('retry')
    await queue.publishWork(item)
    const stop = new AbortController()
    let attempts = 0, finish!: () => void
    const completed = new Promise<void>(resolve => {
      // 保存测试完成通知函数。
      finish = resolve
    })
    const running = queue.consumeWork(async work => {
      // 首次要求重投，第二次确认并通知用例结束。
      expect(work).toEqual(item)
      attempts++
      if (attempts === 1) return 'retry'
      finish(); return 'ack'
    }, stop.signal)
    await expect(queue.consumeWork(async () => {
      // 第二消费者不应获得任何通知。
      return 'ack'
    })).rejects.toThrow('one Host')
    await completed
    expect(attempts).toBe(2)
    stop.abort(); await running
  })
})
