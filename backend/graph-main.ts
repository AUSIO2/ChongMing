import { apiCreateServer } from './api'
import { graphCreateService } from './graph'
import { storeCreateConnection, storeCreateGraphStore, storeDeleteConnection } from './store'

const uri = process.env.CHONGMING_MONGO_URI ?? 'mongodb://127.0.0.1:27017/chongming_graph'
const port = Number(process.env.CHONGMING_GRAPH_PORT ?? '4320')

if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error('CHONGMING_GRAPH_PORT must be an integer from 1 to 65535')
}

async function main(): Promise<void> {
  const connection = await storeCreateConnection(uri)
  const server = apiCreateServer(graphCreateService(storeCreateGraphStore(connection)))
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
    await storeDeleteConnection(connection)
  }
  process.once('SIGINT', () => void close().then(() => process.exit(0)))
  process.once('SIGTERM', () => void close().then(() => process.exit(0)))
}

void main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
