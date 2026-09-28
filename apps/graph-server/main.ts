// 图 API 服务入口：协调 Mongo、消息服务与 HTTP 的启动、故障退出和资源回收。
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

async function apiStartProcess(): Promise<() => Promise<void>> {
  // 读取部署配置并依次启动持久化应用、消息服务与 HTTP，返回共享关闭操作。
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
    await new Promise<void>((/* 本机 HTTP 端口监听成功后完成启动等待的函数。 */ resolve, /* HTTP 端口监听错误到达时拒绝启动的函数。 */ reject) => {
      // 等待 HTTP 绑定本机端口，监听失败时拒绝启动。
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        // 绑定成功后移除启动错误监听并完成启动等待。
         server.removeListener('error', reject); resolve() })
    })
  } catch (error) {
    server.closeAllConnections()
    await processRunClose({ reporter, component: 'graph-api', timeoutMs: 5000, close: async () => {
      // 启动失败时并行尝试关闭消息服务和数据库，收集双方的结束结果。
      await Promise.allSettled([application.closeMessaging(), connection.close()])
    } })
    throw error
  }
  console.log(`Graph API listening at http://127.0.0.1:${port}`)
  let closing: Promise<void> | undefined
  const closeProcess = () => /* 重复关闭请求共享同一个服务收尾过程。 */  closing ??= (async () => {
    // 停止接收业务并关闭连接，待 HTTP 与消息服务收尾后关闭数据库，再传播清理错误。
    server.beginShutdown()
    server.closeAllConnections()
    const results = await Promise.allSettled([
      new Promise<void>((/* HTTP 关闭完成后完成该项资源等待的函数。 */ resolve, /* HTTP 关闭出错时记录该项拒绝的函数。 */ reject) => /* 将 HTTP 服务关闭回调转为可等待的 Promise。 */  server.close(/* 服务器关闭回调的可选故障，存在时向清理协调器传播。 */ error => /* HTTP 关闭失败时拒绝等待，否则确认关闭完成。 */  error ? reject(error) : resolve())),
      application.closeMessaging(),
    ])
    await connection.close()
    const failure = results.find(/* HTTP 或消息关闭的 settled 结果，用于找出首个失败。 */ result => /* 查找并传播 HTTP 或消息关闭中出现的首个拒绝。 */  result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  })()
  void application.messagingFinished().then(/* 消息生命周期记录的失败，undefined 或正在主动关闭时无需重复退出。 */ error => {
    // 消息服务异常终止时报告致命故障并关闭 API，防止继续接受无法派发的工作。
    if (error === undefined || closing) return
    reporter.report({ name: 'messaging.terminated', severity: 'fatal', error })
    void closeProcess().finally(() => /* 消息终止触发的清理结束后以失败码退出。 */  process.exit(1))
  }).catch(/* 监控消息生命周期本身产生的异常，属于致命故障。 */ error => {
    // 监控处理本身异常时记录致命故障并退出。
     reporter.report({ name: 'messaging.monitor.failed', severity: 'fatal', error }); process.exit(1) })
  return closeProcess
}
processRunEntry({ component: 'graph-api', reporter, start: apiStartProcess })
