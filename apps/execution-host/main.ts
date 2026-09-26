import { RuntimeMessage } from '../../contracts/messages'
import { queueCreateTransport } from '../../backend/adapters/messaging/rabbitmq'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { hostCreateWorker } from '../../backend/execution/host-worker'
import { localReadConfiguration } from '../config/local-settings'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRunEntry } from '../../platform/node/process-boundary'

const reporter = diagnosticCreateReporter({ component: 'dsh-host' })

// 用途：启动进程流程，并返回执行结果。
async function hostStartProcess(): Promise<() => Promise<void>> {
  const local = await localReadConfiguration()
  const { values } = parseArgs({
    options: {
      'data-api': { type: 'string' }, 'host-id': { type: 'string' },
      'queue-url': { type: 'string' }, 'queue-namespace': { type: 'string' },
      'dsh-home': { type: 'string' }, 'dsh-bin': { type: 'string' },
      cwd: { type: 'string' }, 'process-cwd': { type: 'string' },
      'request-timeout-ms': { type: 'string' },
      patch: { type: 'string', multiple: true },
      'max-tokens': { type: 'string' }, 'max-rounds': { type: 'string' },
    },
  })
  const hostId = values['host-id'] ?? process.env.CHONGMING_HOST_ID ?? randomUUID()
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(hostId)) throw new Error(RuntimeMessage.HOST_ID_MUST_CONTAIN_ONLY_LETTERS_NUMBERS_UNDERSCORES_OR_HYPHENS)
  const dataApiUrl = values['data-api'] ?? process.env.CHONGMING_DATA_API ?? local.settings.dataApiUrl ?? 'http://127.0.0.1:4320'
  const dshHome = path.resolve(values['dsh-home'] ?? process.env.CHONGMING_DSH_HOME ?? local.settings.dshHome ?? path.join('.dsh-runtime', 'hosts', hostId))
  const maxTokens = values['max-tokens'] ?? process.env.CHONGMING_DSH_MAX_TOKENS
  const maxRounds = values['max-rounds'] ?? process.env.CHONGMING_DSH_MAX_ROUNDS
  const queueUrl = values['queue-url'] ?? process.env.CHONGMING_AMQP_URL ?? local.secrets.CHONGMING_AMQP_URL
  if (!queueUrl) throw new Error(RuntimeMessage.CHONGMING_AMQP_URL_OR_QUEUE_URL_MUST_BE_CONFIGURED)
  const worker = hostCreateWorker({
    hostId, dataApiUrl, dshHome, token: process.env.CHONGMING_DATA_TOKEN ?? local.secrets.CHONGMING_DATA_TOKEN ?? '',
    env: Object.fromEntries(Object.entries(local.secrets).filter(([name]) => process.env[name] === undefined)),
    queue: queueCreateTransport({ url: queueUrl, namespace: values['queue-namespace'] ?? process.env.CHONGMING_QUEUE_NAMESPACE ?? 'chongming' }),
    requestTimeoutMs: Number(values['request-timeout-ms'] ?? process.env.CHONGMING_HOST_REQUEST_TIMEOUT_MS ?? 5000),
    dshBin: values['dsh-bin'] ?? process.env.CHONGMING_DSH_BIN,
    cwd: values.cwd ? path.resolve(values.cwd) : undefined,
    processCwd: path.resolve(values['process-cwd'] ?? dshHome),
    patches: values.patch?.map(patch => path.resolve(patch)),
    maxTokens: maxTokens === undefined ? undefined : Number(maxTokens),
    maxRounds: maxRounds === undefined ? undefined : Number(maxRounds),
    reporter,
  })
  await worker.start()
  console.log(JSON.stringify({ event: 'host.started', hostId, dataApiUrl, dshHome }))
  void worker.finished().then(error => {
    if (error !== undefined) {
      reporter.report({ name: 'host.loop.failed', severity: 'fatal', context: { phase: 'consume' }, error })
      process.exitCode = 1
    }
  }).catch(error => reporter.report({ name: 'host.monitor.failed', severity: 'fatal', error }))
  return async () => { await worker.close(); console.log(JSON.stringify({ event: 'host.stopped', hostId })) }
}
processRunEntry({ component: 'dsh-host', reporter, start: hostStartProcess })
