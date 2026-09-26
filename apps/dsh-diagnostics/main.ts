import { RuntimeMessage } from '../../contracts/messages'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { dshCreateRuntime } from '../../backend/execution/dsh/runtime'
import { dshHttpCreateServer } from '../../backend/adapters/http/dsh-diagnostic-server'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRunEntry } from '../../platform/node/process-boundary'

const projectRoot = process.cwd()
const dshHome = path.resolve(process.env.CHONGMING_DSH_HOME ?? path.join(projectRoot, '.dsh-runtime'))
const port = Number(process.env.CHONGMING_DSH_PORT ?? '4318')

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(RuntimeMessage.CHONGMING_DSH_PORT_MUST_BE_AN_INTEGER_FROM_1_TO_65535)
}

const reporter = diagnosticCreateReporter({ component: 'dsh-diagnostic' })

// 用途：启动进程流程，并返回执行结果。
async function dshStartProcess(): Promise<() => Promise<void>> {
  await mkdir(dshHome, { recursive: true })
  const runtime = dshCreateRuntime({
    dshHome,
    cwd: projectRoot,
    processCwd: dshHome,
    profile: process.env.CHONGMING_DSH_PROFILE ?? 'sdk',
    provider: process.env.CHONGMING_DSH_PROVIDER ?? 'deepseek-official',
    model: process.env.CHONGMING_DSH_MODEL ?? 'deepseek-v4-flash',
  })
  await runtime.start()
  const server = dshHttpCreateServer(runtime)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  console.log(`DSH runtime listening at http://127.0.0.1:${port}`)
  let closing: Promise<void> | undefined
  return () => closing ??= (async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    await runtime.close()
  })()
}
processRunEntry({ component: 'dsh-diagnostic', reporter, start: dshStartProcess })
