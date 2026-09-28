// 独立本地服务命令入口：解析参数、启动 SQLite/API/Host 并输出连接文件位置。
import path from 'node:path'
import { parseArgs } from 'node:util'
import { localCreateRuntime } from './runtime'
import { localReadConfiguration } from '../config/local-settings'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRunEntry } from '../../platform/node/process-boundary'

const reporter = diagnosticCreateReporter({ component: 'local-service' })

async function localStartProcess(): Promise<() => Promise<void>> {
  // 解析本地运行参数并启动服务，监控队列异常并返回保留数据的关闭操作。
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, directory: { type: 'string' }, port: { type: 'string' },
    'dsh-home': { type: 'string' }, patch: { type: 'string', multiple: true },
  } })
  if (values.help) {
    console.log('Usage: npm run local:serve -- [--directory .chongming-local] [--port 4320] [--dsh-home PATH] [--patch FILE]\nRequires Node.js 24+. Runs one local SQLite/API/DSH Host; no MongoDB or RabbitMQ. Models/tools may access the network.')
    return async () => {
      // 帮助模式没有创建运行资源，退出时无需清理。
      }
  }
  const local = await localReadConfiguration()
  const runtime = await localCreateRuntime({ directory: values.directory ?? '.chongming-local', port: values.port === undefined ? undefined : Number(values.port),
    dshHome: values['dsh-home'], patches: values.patch?.map(/* 命令行给出的补丁文件路径，转换为绝对路径后传给运行时。 */ file => /* 将补丁文件转换为绝对路径。 */  path.resolve(file)), reporter,
    env: Object.fromEntries(Object.entries(local.secrets).filter((/* 本机密钥条目，仅取名称以保留显式进程环境的优先级。 */ [name]) => /* 仅把环境中缺少的密钥补充给本地运行时。 */  process.env[name] === undefined)) })
  console.log(JSON.stringify({ event: 'local.ready', baseUrl: runtime.baseUrl, connectionPath: runtime.connectionPath, tokenPath: runtime.tokenPath }))
  let closing = false
  runtime.application.localQueue.closed.then(() => {
    // 未主动关闭时队列结束视为运行故障，记录诊断并标记失败退出码。
    if (!closing) {
      reporter.report({ name: 'local.channel.closed', severity: 'fatal', context: { phase: 'runtime' } })
      process.exitCode = 1
    }
  }).catch(/* 观察本地队列关闭过程时抛出的异常，用于致命诊断。 */ error => /* 记录本地队列结束监听的异常。 */  reporter.report({ name: 'local.channel.failed', severity: 'fatal', error }))
  return async () => {
    // 标记主动关闭并等待运行时收尾，说明本地数据仍然保留。
     closing = true; await runtime.close(); console.log('Local services stopped; data retained') }
}
processRunEntry({ component: 'local-service', reporter, start: localStartProcess })
