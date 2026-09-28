// 为测试创建或复用隔离 RabbitMQ，并限定本机引擎和测试命名空间的清理范围。
import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { connect } from 'amqplib'
import type { QueueConfig } from '../../../contracts/events'

const rabbitExecute = promisify(execFile)
const image = 'rabbitmq:4.3.5-management'

export interface TestBroker {
  file: string
  url: string
  // 结束该调用拥有的代理资源；借用外部代理时保持其存活。
  close(): Promise<void>
}

async function rabbitReadEngine(): Promise<void> {
  // 验证使用本机 Docker 引擎，必要时在 macOS 启动 Docker，并在有限时间内等待可用。
  const endpoint = process.env.DOCKER_HOST || (await rabbitExecute('docker', ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'])).stdout.trim()
  if (!endpoint.startsWith('unix://') && !endpoint.startsWith('npipe://')) throw new Error('RabbitMQ tests require a local Docker engine')
  try { await rabbitExecute('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 }); return }
  catch {
    if (process.platform !== 'darwin') throw new Error('Start the local Docker engine to run RabbitMQ integration tests')
    await rabbitExecute('open', ['-gja', 'Docker'])
  }
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try { await rabbitExecute('docker', ['info', '--format', '{{.ServerVersion}}'], { timeout: 3000 }); return }
    catch { await delay(1000) }
  }
  throw new Error('Docker Desktop did not become ready for RabbitMQ tests')
}

async function rabbitReadReady(/* 包含测试代理凭据、需要等待可建立连接的 AMQP 地址。 */ url: string): Promise<void> {
  // 在一分钟期限内反复建立并关闭 AMQP 连接，确认测试代理已可接受连接。
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const connection = await connect(url, { timeout: 2000 })
      connection.on('error', () => {
        // 探测连接的错误交给当前连接尝试和重试流程，不让事件成为未处理异常。
        })
      await connection.close()
      return
    } catch { await delay(500) }
  }
  throw new Error('The isolated RabbitMQ broker did not become ready')
}

// 套件包装器拥有共享代理；未经过包装器直接创建夹具时，夹具拥有自己的临时代理。
export async function rabbitCreateBroker(): Promise<TestBroker> {
  // 复用外部测试代理或创建只绑定回环地址的临时容器，返回配置文件及所属资源清理函数。
  const supplied = process.env.CHONGMING_TEST_BROKER_FILE
  if (supplied) {
    const metadata = JSON.parse(await readFile(supplied, 'utf8')) as { amqpUrl?: unknown }
    if (typeof metadata.amqpUrl !== 'string' || !['amqp:', 'amqps:'].includes(new URL(metadata.amqpUrl).protocol)) throw new Error('Test broker file has no valid amqpUrl')
    await rabbitReadReady(metadata.amqpUrl)
    return { file: supplied, url: metadata.amqpUrl, close: async () => {
      // 外部提供的代理由套件拥有，此夹具关闭时不删除共享容器。
      } }
  }
  await rabbitReadEngine()
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-test-broker-'))
  const name = 'chongming-test-' + randomUUID()
  let containerId: string | undefined
  let closing: Promise<void> | undefined
  const close = () => /* 合并重复关闭请求，返回同一次容器及临时目录清理过程。 */ closing ??= (async () => {
    // 删除本次创建的容器，并在删除失败时仍清理临时凭据目录。
    try { if (containerId) await rabbitExecute('docker', ['rm', '-f', '-v', containerId], { timeout: 30_000 }) }
    finally { await rm(directory, { recursive: true, force: true }) }
  })()
  try {
    const username = 'cm_test_' + randomBytes(6).toString('hex'), password = randomBytes(24).toString('base64url')
    const result = await rabbitExecute('docker', ['run', '-d', '--rm', '--name', name, '--label', 'com.chongming.test=061',
      '-p', '127.0.0.1::5672', '-e', 'RABBITMQ_DEFAULT_USER', '-e', 'RABBITMQ_DEFAULT_PASS', image], {
      env: { ...process.env, RABBITMQ_DEFAULT_USER: username, RABBITMQ_DEFAULT_PASS: password }, timeout: 180_000,
    })
    containerId = result.stdout.trim()
    const binding = (await rabbitExecute('docker', ['port', containerId, '5672/tcp'])).stdout.trim()
    if (!/^127\.0\.0\.1:\d+$/.test(binding)) throw new Error('Test RabbitMQ must bind exclusively to loopback')
    const url = `amqp://${username}:${password}@${binding}/`
    const file = path.join(directory, 'broker.json')
    await writeFile(file, JSON.stringify({ amqpUrl: url, containerId, containerName: name, image }), { mode: 0o600 })
    await rabbitReadReady(url)
    return { file, url, close }
  } catch (error) { await close(); throw error }
}

export async function rabbitCreateFixture(): Promise<{
  queue: QueueConfig;
  // 删除本夹具拥有的测试命名空间，不允许影响其他测试的队列和交换器。
  deleteNamespace(/* 调用方准备删除的测试队列命名空间。 */ namespace: string): Promise<void>;
  // 结束底层代理的所属资源；外部传入的共享代理保持存活。
  close(): Promise<void>
}> {
  // 为测试分配随机队列命名空间，同时保留底层代理的生命周期入口。
  const broker = await rabbitCreateBroker()
  const queue = { url: broker.url, namespace: 'test-' + randomUUID() }
  return {
    queue,
    async deleteNamespace(/* 实现方法收到、必须属于本夹具前缀的命名空间。 */ namespace) {
      // 只删除本夹具命名空间内的队列和交换器，最后关闭管理连接。
      if (namespace !== queue.namespace && !namespace.startsWith(queue.namespace + '.')) throw new Error('Cannot delete another fixture namespace')
      const connection = await connect(queue.url)
      connection.on('error', () => {
        // 清理连接上的错误由清理调用结果处理，避免未监听错误事件终止进程。
        })
      try {
        const channel = await connection.createChannel()
        channel.on('error', () => {
          // 清理通道上的错误由删除操作报告，不再额外抛出未处理事件。
          })
        await channel.deleteQueue(namespace + '.work')
        await channel.deleteExchange(namespace + '.work-exchange')
        await channel.deleteExchange(namespace + '.events')
      } finally { await connection.close() }
    },
    close: broker.close,
  }
}
