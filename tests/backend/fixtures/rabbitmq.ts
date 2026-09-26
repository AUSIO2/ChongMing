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
  close(): Promise<void>
}

async function rabbitReadEngine(): Promise<void> {
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

async function rabbitReadReady(url: string): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const connection = await connect(url, { timeout: 2000 })
      connection.on('error', () => {})
      await connection.close()
      return
    } catch { await delay(500) }
  }
  throw new Error('The isolated RabbitMQ broker did not become ready')
}

/** The suite wrapper owns one broker; a direct fixture invocation owns its temporary broker. */
export async function rabbitCreateBroker(): Promise<TestBroker> {
  const supplied = process.env.CHONGMING_TEST_BROKER_FILE
  if (supplied) {
    const metadata = JSON.parse(await readFile(supplied, 'utf8')) as { amqpUrl?: unknown }
    if (typeof metadata.amqpUrl !== 'string' || !['amqp:', 'amqps:'].includes(new URL(metadata.amqpUrl).protocol)) throw new Error('Test broker file has no valid amqpUrl')
    await rabbitReadReady(metadata.amqpUrl)
    return { file: supplied, url: metadata.amqpUrl, close: async () => {} }
  }
  await rabbitReadEngine()
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-test-broker-'))
  const name = 'chongming-test-' + randomUUID()
  let containerId: string | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
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

export async function rabbitCreateFixture(): Promise<{ queue: QueueConfig; deleteNamespace(namespace: string): Promise<void>; close(): Promise<void> }> {
  const broker = await rabbitCreateBroker()
  const queue = { url: broker.url, namespace: 'test-' + randomUUID() }
  return {
    queue,
    async deleteNamespace(namespace) {
      if (namespace !== queue.namespace && !namespace.startsWith(queue.namespace + '.')) throw new Error('Cannot delete another fixture namespace')
      const connection = await connect(queue.url)
      connection.on('error', () => {})
      try {
        const channel = await connection.createChannel()
        channel.on('error', () => {})
        await channel.deleteQueue(namespace + '.work')
        await channel.deleteExchange(namespace + '.work-exchange')
        await channel.deleteExchange(namespace + '.events')
      } finally { await connection.close() }
    },
    close: broker.close,
  }
}
