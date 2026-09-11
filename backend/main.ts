import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshCreateRuntime } from './dsh'
import { dshHttpCreateServer } from './dsh-http'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dshHome = path.resolve(process.env.CHONGMING_DSH_HOME ?? path.join(projectRoot, '.dsh-runtime'))
const port = Number(process.env.CHONGMING_DSH_PORT ?? '4318')

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('CHONGMING_DSH_PORT must be an integer from 1 to 65535')
}

async function main(): Promise<void> {
  await mkdir(dshHome, { recursive: true })
  const runtime = dshCreateRuntime({
    dshBin: path.join(projectRoot, 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
    dshHome,
    cwd: projectRoot,
    processCwd: dshHome,
    profile: process.env.CHONGMING_DSH_PROFILE ?? 'sdk',
    provider: process.env.CHONGMING_DSH_PROVIDER ?? 'deepseek-official',
    model: process.env.CHONGMING_DSH_MODEL ?? 'deepseek-v4-flash',
  })
  await runtime.start()
  const server = dshHttpCreateServer(runtime)
  server.listen(port, '127.0.0.1', () => {
    console.log(`DSH runtime listening at http://127.0.0.1:${port}`)
  })

  let closing = false
  async function close(): Promise<void> {
    if (closing) return
    closing = true
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    await runtime.close()
  }

  process.once('SIGINT', () => void close().then(() => process.exit(0)))
  process.once('SIGTERM', () => void close().then(() => process.exit(0)))
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
