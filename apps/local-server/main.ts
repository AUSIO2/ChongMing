import path from 'node:path'
import { parseArgs } from 'node:util'
import { localCreateRuntime } from './runtime'
import { localReadConfiguration } from '../config/local-settings'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRunEntry } from '../../platform/node/process-boundary'

const reporter = diagnosticCreateReporter({ component: 'local-service' })

// 用途：启动进程流程，并返回执行结果。
async function localStartProcess(): Promise<() => Promise<void>> {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, directory: { type: 'string' }, port: { type: 'string' },
    'dsh-home': { type: 'string' }, patch: { type: 'string', multiple: true },
  } })
  if (values.help) {
    console.log('Usage: npm run local:serve -- [--directory .chongming-local] [--port 4320] [--dsh-home PATH] [--patch FILE]\nRequires Node.js 24+. Runs one local SQLite/API/DSH Host; no MongoDB or RabbitMQ. Models/tools may access the network.')
    return async () => {}
  }
  const local = await localReadConfiguration()
  const runtime = await localCreateRuntime({ directory: values.directory ?? '.chongming-local', port: values.port === undefined ? undefined : Number(values.port),
    dshHome: values['dsh-home'], patches: values.patch?.map(file => path.resolve(file)), reporter,
    env: Object.fromEntries(Object.entries(local.secrets).filter(([name]) => process.env[name] === undefined)) })
  console.log(JSON.stringify({ event: 'local.ready', baseUrl: runtime.baseUrl, connectionPath: runtime.connectionPath, tokenPath: runtime.tokenPath }))
  let closing = false
  runtime.application.localQueue.closed.then(() => {
    if (!closing) {
      reporter.report({ name: 'local.channel.closed', severity: 'fatal', context: { phase: 'runtime' } })
      process.exitCode = 1
    }
  }).catch(error => reporter.report({ name: 'local.channel.failed', severity: 'fatal', error }))
  return async () => { closing = true; await runtime.close(); console.log('Local services stopped; data retained') }
}
processRunEntry({ component: 'local-service', reporter, start: localStartProcess })
