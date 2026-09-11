import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { applicationCreateService } from './application'
import { GraphError } from './graph-error'
import { inputReadId, inputReadObject, inputReadString } from './input'
import { localReadConfiguration, localReadUri, localUpdateSecret, localUpdateSettings } from './local-settings'
import { storeCreateConnection, storeDeleteConnection } from './store'
import endpointPrompt from './prompts/admin/endpoint.json'

async function adminReadInput(file?: string): Promise<unknown> {
  if (file) return JSON.parse(await readFile(file, 'utf8'))
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk)
    if (size > 1_048_576) throw new Error('Admin input exceeds 1 MiB')
    chunks.push(Buffer.from(chunk))
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

async function adminRunCommand(): Promise<unknown> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { input: { type: 'string' } } })
  const command = positionals[0]
  const supported = ['init', 'user.create', 'token.create', 'token.revoke', 'user.disable', 'user.enable', 'agents.seed', 'assets.cleanup', 'settings.read', 'secret.set', 'database.test', 'database.stage', 'endpoint.test']
  if (positionals.length !== 1 || !supported.includes(command)) throw new Error(`Usage: npm run admin -- <${supported.join('|')}> [--input JSON_FILE]; otherwise read JSON from stdin`)
  const input = await adminReadInput(values.input)
  const local = await localReadConfiguration()
  if (command === 'settings.read') {
    inputReadObject(input, [], 'input')
    return { mongoUri: localReadUri(process.env.CHONGMING_MONGO_URI ?? local.settings.mongoUri ?? 'mongodb://127.0.0.1:27017/chongming_graph'),
      dataApiUrl: process.env.CHONGMING_DATA_API ?? local.settings.dataApiUrl ?? 'http://127.0.0.1:4320',
      dshHome: process.env.CHONGMING_DSH_HOME ?? local.settings.dshHome ?? null,
      secrets: Object.fromEntries(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'CHONGMING_DATA_TOKEN']
        .map(name => [name, Boolean(process.env[name] ?? local.secrets[name])])),
    }
  }
  if (command === 'secret.set') {
    const data = inputReadObject(input, ['name', 'value'], 'input')
    if (data.value !== null && typeof data.value !== 'string') throw new Error('value must be string or null')
    return localUpdateSecret(inputReadString(data.name, 'name'), data.value)
  }
  if (command === 'database.test' || command === 'database.stage') {
    const data = inputReadObject(input, ['uri'], 'input')
    const uri = inputReadString(data.uri, 'uri')
    let connection
    try {
      connection = await storeCreateConnection(uri)
      const hello = await connection.db!.admin().command({ hello: 1 })
      if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error('Replica set required')
      if (command === 'database.stage') await localUpdateSettings({ ...local.settings, mongoUri: uri })
      return { ok: true, replicaSet: true, databaseName: connection.name, staged: command === 'database.stage' }
    } catch { return { ok: false, error: 'Database is unavailable or does not support transactions' } }
    finally { if (connection) await storeDeleteConnection(connection) }
  }
  if (command === 'endpoint.test') {
    const data = inputReadObject(input, ['url', 'kind', 'model', 'secretName'], 'input')
    const url = new URL(inputReadString(data.url, 'url'))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Endpoint must be an HTTP(S) URL without credentials')
    if (data.kind !== 'network' && data.kind !== 'llm') throw new Error('kind must be network or llm')
    const started = performance.now()
    try {
      let response: Response
      if (data.kind === 'network') response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      else {
        const name = inputReadString(data.secretName, 'secretName')
        if (!['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].includes(name)) throw new Error('Unsupported model secret')
        const secret = process.env[name] ?? local.secrets[name]
        if (!secret) throw new Error('Model secret is not configured')
        response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(15_000),
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify({ model: inputReadString(data.model, 'model'), messages: [{ role: 'user', content: endpointPrompt.content }], max_tokens: 8 }),
        })
        const result = await response.json() as { choices?: unknown[] }
        return { ok: response.ok && Array.isArray(result.choices) && result.choices.length > 0,
          status: response.status, latencyMs: Math.round(performance.now() - started),
        }
      }
      await response.body?.cancel()
      return { ok: response.ok, status: response.status, latencyMs: Math.round(performance.now() - started) }
    } catch { return { ok: false, error: 'Endpoint request failed', latencyMs: Math.round(performance.now() - started) } }
  }
  const connection = await storeCreateConnection(process.env.CHONGMING_MONGO_URI ?? local.settings.mongoUri ?? 'mongodb://127.0.0.1:27017/chongming_graph')
  try {
    const app = applicationCreateService(connection)
    await app.initialize()
    if (command === 'init' || command === 'user.create') {
      const data = inputReadObject(input, command === 'init' ? ['id', 'displayName'] : ['id', 'displayName', 'hostAdmin'], 'input')
      if (command === 'user.create' && typeof data.hostAdmin !== 'boolean') throw new Error('hostAdmin must be boolean')
      if (command === 'init') {
        await app.control.seed()
        if (!process.env.CHONGMING_DATA_TOKEN && !local.secrets.CHONGMING_DATA_TOKEN) {
          await localUpdateSecret('CHONGMING_DATA_TOKEN', randomBytes(32).toString('base64url'))
        }
      }
      const user = await app.auth.createUser({ id: data.id === undefined ? randomUUID() : inputReadId(data.id, 'id'),
        displayName: inputReadString(data.displayName, 'displayName'), hostAdmin: command === 'init' || data.hostAdmin === true,
      })
      return command === 'init' ? { user, ...await app.auth.createToken(user.userId) } : user
    }
    if (command === 'agents.seed') {
      inputReadObject(input, [], 'input')
      await app.control.seed()
      return { initialized: true }
    }
    if (command === 'assets.cleanup') {
      inputReadObject(input, [], 'input')
      return { deletedBlobs: await app.assets.cleanupDeleted() }
    }
    const data = inputReadObject(input, [command === 'token.revoke' ? 'tokenId' : 'userId'], 'input')
    if (command === 'token.create') return await app.auth.createToken(inputReadId(data.userId, 'userId'))
    if (command === 'token.revoke') await app.auth.revokeToken(inputReadId(data.tokenId, 'tokenId'))
    else if (command === 'user.enable') await app.auth.enableUser(inputReadId(data.userId, 'userId'))
    else await app.auth.disableUser(inputReadId(data.userId, 'userId'))
    return { ok: true }
  } finally { await storeDeleteConnection(connection) }
}

adminRunCommand().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {
  console.error(error instanceof GraphError ? `${error.code}: ${error.message}` : 'Admin command failed; check its input and local configuration')
  process.exitCode = 1
})
