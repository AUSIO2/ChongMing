import { RuntimeMessage } from '../../contracts/messages'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { applicationCreateService } from './application'
import { storeCreateConnection } from '../../backend/adapters/storage/mongo/connection'
import { localReadConfiguration } from '../config/local-settings'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRunClose, processRunEntry } from '../../platform/node/process-boundary'

const port = Number(process.env.CHONGMING_GRAPH_PORT ?? '4320')
const leaseMs = Number(process.env.CHONGMING_LEASE_MS ?? '15000')

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(RuntimeMessage.CHONGMING_GRAPH_PORT_MUST_BE_AN_INTEGER_FROM_1_TO_65535)
}

const reporter = diagnosticCreateReporter({ component: 'graph-api' })

// 用途：启动进程流程，并返回执行结果。
async function apiStartProcess(): Promise<() => Promise<void>> {
  const local = await localReadConfiguration()
  const uri = process.env.CHONGMING_MONGO_URI ?? local.settings.mongoUri ?? 'mongodb://127.0.0.1:27017/chongming_graph'
  const amqpUrl = process.env.CHONGMING_AMQP_URL ?? local.secrets.CHONGMING_AMQP_URL
  if (!amqpUrl) throw new Error(RuntimeMessage.CONFIGURE_CHONGMING_AMQP_URL_BEFORE_STARTING_THE_GRAPH_API)
  const connection = await storeCreateConnection(uri)
  let application: ReturnType<typeof applicationCreateService>
  try {
    application = applicationCreateService(connection, { leaseMs,
      messaging: { url: amqpUrl, namespace: process.env.CHONGMING_QUEUE_NAMESPACE ?? 'chongming' }, reporter,
    })
    await application.initialize()
  } catch (error) { await connection.close(); throw error }
  const server = apiCreateServer(application, { internalToken: process.env.CHONGMING_DATA_TOKEN ?? local.secrets.CHONGMING_DATA_TOKEN, reporter })
  try {
    await application.startMessaging()
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
    })
  } catch (error) {
    server.closeAllConnections()
    await processRunClose({ reporter, component: 'graph-api', timeoutMs: 5000, close: async () => {
      await Promise.allSettled([application.closeMessaging(), connection.close()])
    } })
    throw error
  }
  console.log(`Graph API listening at http://127.0.0.1:${port}`)
  let closing: Promise<void> | undefined
  const closeProcess = () => closing ??= (async () => {
    server.beginShutdown()
    server.closeAllConnections()
    const results = await Promise.allSettled([
      new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
      application.closeMessaging(),
    ])
    await connection.close()
    const failure = results.find(result => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  })()
  void application.messagingFinished().then(error => {
    if (error === undefined || closing) return
    reporter.report({ name: 'messaging.terminated', severity: 'fatal', error })
    void closeProcess().finally(() => process.exit(1))
  }).catch(error => { reporter.report({ name: 'messaging.monitor.failed', severity: 'fatal', error }); process.exit(1) })
  return closeProcess
}
processRunEntry({ component: 'graph-api', reporter, start: apiStartProcess })
