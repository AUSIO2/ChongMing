import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { hostCreateWorker } from './host'
import { localReadConfiguration } from './local-settings'

async function hostRunMain(): Promise<void> {
  const local = await localReadConfiguration()
  const { values } = parseArgs({
    options: {
      'data-api': { type: 'string' }, 'host-id': { type: 'string' }, 'map-id': { type: 'string' },
      'dsh-home': { type: 'string' }, 'dsh-bin': { type: 'string' },
      cwd: { type: 'string' }, 'process-cwd': { type: 'string' },
      'poll-ms': { type: 'string' }, 'request-timeout-ms': { type: 'string' },
      patch: { type: 'string', multiple: true },
      'max-tokens': { type: 'string' }, 'max-rounds': { type: 'string' },
    },
  })
  const hostId = values['host-id'] ?? process.env.CHONGMING_HOST_ID ?? randomUUID()
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(hostId)) throw new Error('host-id must contain only letters, numbers, underscores or hyphens')
  const dataApiUrl = values['data-api'] ?? process.env.CHONGMING_DATA_API ?? local.settings.dataApiUrl ?? 'http://127.0.0.1:4320'
  const dshHome = path.resolve(values['dsh-home'] ?? process.env.CHONGMING_DSH_HOME ?? local.settings.dshHome ?? path.join('.dsh-runtime', 'hosts', hostId))
  const maxTokens = values['max-tokens'] ?? process.env.CHONGMING_DSH_MAX_TOKENS
  const maxRounds = values['max-rounds'] ?? process.env.CHONGMING_DSH_MAX_ROUNDS
  const worker = hostCreateWorker({
    hostId, dataApiUrl, dshHome, token: process.env.CHONGMING_DATA_TOKEN ?? local.secrets.CHONGMING_DATA_TOKEN ?? '',
    env: Object.fromEntries(Object.entries(local.secrets).filter(([name]) => process.env[name] === undefined)),
    mapId: values['map-id'] ?? process.env.CHONGMING_MAP_ID,
    pollMs: Number(values['poll-ms'] ?? process.env.CHONGMING_HOST_POLL_MS ?? 1000),
    requestTimeoutMs: Number(values['request-timeout-ms'] ?? process.env.CHONGMING_HOST_REQUEST_TIMEOUT_MS ?? 5000),
    dshBin: values['dsh-bin'] ?? process.env.CHONGMING_DSH_BIN,
    cwd: values.cwd ? path.resolve(values.cwd) : undefined,
    processCwd: path.resolve(values['process-cwd'] ?? dshHome),
    patches: values.patch?.map(patch => path.resolve(patch)),
    maxTokens: maxTokens === undefined ? undefined : Number(maxTokens),
    maxRounds: maxRounds === undefined ? undefined : Number(maxRounds),
  })
  let shutdown: Promise<void> | undefined
  function hostCloseProcess(): void {
    shutdown ??= worker.close().then(() => {
      console.log(JSON.stringify({ event: 'host.stopped', hostId }))
    }).catch(error => {
      console.error(error)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', hostCloseProcess)
  process.once('SIGTERM', hostCloseProcess)
  await worker.start()
  console.log(JSON.stringify({ event: 'host.started', hostId, dataApiUrl, dshHome }))
}

hostRunMain().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
