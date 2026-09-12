import { apiCreateServer } from './api'
import { applicationCreateService } from './application'
import { storeCreateConnection } from './store'
import { localReadConfiguration } from './local-settings'

const port = Number(process.env.CHONGMING_GRAPH_PORT ?? '4320')
const leaseMs = Number(process.env.CHONGMING_LEASE_MS ?? '15000')

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('CHONGMING_GRAPH_PORT must be an integer from 1 to 65535')
}

async function main(): Promise<void> {
  const local = await localReadConfiguration()
  const uri = process.env.CHONGMING_MONGO_URI ?? local.settings.mongoUri ?? 'mongodb://127.0.0.1:27017/chongming_graph'
  const connection = await storeCreateConnection(uri)
  const application = applicationCreateService(connection, { leaseMs })
  try { await application.initialize() }
  catch (error) { await connection.close(); throw error }
  const server = apiCreateServer(application, { internalToken: process.env.CHONGMING_DATA_TOKEN ?? local.secrets.CHONGMING_DATA_TOKEN })
  server.listen(port, '127.0.0.1', () => {
    console.log(`Graph API listening at http://127.0.0.1:${port}`)
  })

  let closing = false
  async function close(): Promise<void> {
    if (closing) return
    closing = true
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
    await connection.close()
  }
  process.once('SIGINT', () => void close().then(() => process.exit(0)))
  process.once('SIGTERM', () => void close().then(() => process.exit(0)))
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
