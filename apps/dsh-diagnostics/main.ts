// 启动仅监听本机的 DSH 诊断 HTTP 服务，并统一关闭 HTTP 与 DSH 运行时。
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

async function dshStartProcess(): Promise<() => Promise<void>> {
  // 创建 DSH 工作目录并启动运行时和诊断端口，返回可重复调用的关闭操作。
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
  await new Promise<void>((/* HTTP 成功绑定端口后完成启动等待的函数。 */ resolve, /* HTTP 监听失败时拒绝启动等待的函数。 */ reject) => {
    // 把 HTTP 监听成功或失败转换为启动 Promise。
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      // 监听成功后移除启动期错误监听，并完成启动等待。
       server.removeListener('error', reject); resolve() })
  })
  console.log(`DSH runtime listening at http://127.0.0.1:${port}`)
  let closing: Promise<void> | undefined
  return () => /* 复用同一次诊断服务关闭，避免重复释放资源。 */  closing ??= (async () => {
    // 先断开 HTTP 客户端并停止监听，再等待 DSH 运行时退出。
    server.closeAllConnections()
    await new Promise<void>((/* HTTP 关闭回调确认完成后结束等待的函数。 */ resolve, /* HTTP 关闭回调报告错误时拒绝等待的函数。 */ reject) => {
      // 等待 HTTP 服务的关闭回调。
      server.close(/* HTTP 关闭回调的可选错误，无错误时确认关闭成功。 */ error => /* 根据 HTTP 关闭结果完成或拒绝关闭等待。 */  error ? reject(error) : resolve())
    })
    await runtime.close()
  })()
}
processRunEntry({ component: 'dsh-diagnostic', reporter, start: dshStartProcess })
