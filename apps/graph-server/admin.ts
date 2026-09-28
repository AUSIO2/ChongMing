// 管理命令入口：维护身份、配置与数据，并提供数据库及模型端点诊断。
import { RuntimeMessage, messageFormat } from '../../contracts/messages'
import { randomBytes, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { applicationCreateService } from './application'
import { GraphError } from '../../backend/modules/shared/domain-error'
import { inputReadId, inputReadObject, inputReadString } from '../../backend/modules/shared/input-validation'
import { localReadConfiguration, localUpdateSecret, localUpdateSettings } from '../config/local-settings'
import { localReadUri } from '../../backend/adapters/storage/mongo/connection'
import { storeCreateConnection } from '../../backend/adapters/storage/mongo/connection'
import endpointPrompt from './resources/endpoint.json'
import { repairMigrateNodeRuns, repairUpdateNewsContext } from '../../backend/adapters/storage/mongo/maintenance'
import { diagnosticCreateReporter } from '../../platform/node/diagnostics'
import { processRegisterBoundary } from '../../platform/node/process-boundary'

const reporter = diagnosticCreateReporter({ component: 'admin-cli' })
processRegisterBoundary({ component: 'admin-cli', reporter })

async function adminReadInput(/* 可选 JSON 文件路径；未提供时从标准输入读取，空输入视为空对象。 */ file?: string): Promise<unknown> {
  // 从指定文件或标准输入解析 JSON；标准输入累计超过 1 MiB 时拒绝读取。
  if (file) return JSON.parse(await readFile(file, 'utf8'))
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of process.stdin) {
    size += Buffer.byteLength(chunk)
    if (size > 1_048_576) throw new Error(RuntimeMessage.ADMIN_INPUT_EXCEEDS_1_MIB)
    chunks.push(Buffer.from(chunk))
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
}

async function adminRunCommand(): Promise<unknown> {
  // 校验管理子命令并执行配置、连通性检查或数据管理，数据库操作结束后关闭连接。
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { input: { type: 'string' } } })
  const command = positionals[0]
  const supported = ['init', 'user.create', 'token.create', 'token.revoke', 'user.disable', 'user.enable', 'agents.seed', 'assets.cleanup', 'data.repair-news-context', 'data.migrate-node-runs', 'settings.read', 'secret.set', 'database.test', 'database.stage', 'endpoint.test']
  if (positionals.length !== 1 || !supported.includes(command)) throw new Error(messageFormat(RuntimeMessage.USAGE_NPM_RUN_ADMIN_VALUE_INPUT_JSON_FILE_OTHERWISE_READ_JSON_FROM, supported.join('|')))
  const input = await adminReadInput(values.input)
  const local = await localReadConfiguration()
  if (command === 'settings.read') {
    inputReadObject(input, [], 'input')
    return { mongoUri: localReadUri(process.env.CHONGMING_MONGO_URI ?? local.settings.mongoUri ?? 'mongodb://127.0.0.1:27017/chongming_graph'),
      dataApiUrl: process.env.CHONGMING_DATA_API ?? local.settings.dataApiUrl ?? 'http://127.0.0.1:4320',
      dshHome: process.env.CHONGMING_DSH_HOME ?? local.settings.dshHome ?? null,
      secrets: Object.fromEntries(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'TAVILY_API_KEY', 'CHONGMING_DATA_TOKEN', 'CHONGMING_AMQP_URL']
        .map(/* 允许检查的密钥名称，只输出对应值是否已配置。 */ name => /* 只暴露密钥是否存在，不在设置查询中返回密钥原文。 */  [name, Boolean(process.env[name] ?? local.secrets[name])])),
    }
  }
  if (command === 'secret.set') {
    const data = inputReadObject(input, ['name', 'value'], 'input')
    if (data.value !== null && typeof data.value !== 'string') throw new Error(RuntimeMessage.VALUE_MUST_BE_STRING_OR_NULL)
    return localUpdateSecret(inputReadString(data.name, 'name'), data.value)
  }
  if (command === 'database.test' || command === 'database.stage') {
    const data = inputReadObject(input, ['uri'], 'input')
    const uri = inputReadString(data.uri, 'uri')
    let connection
    try {
      connection = await storeCreateConnection(uri)
      const hello = await connection.db!.admin().command({ hello: 1 })
      if (!hello.setName && hello.msg !== 'isdbgrid') throw new Error(RuntimeMessage.REPLICA_SET_REQUIRED)
      if (command === 'database.stage') await localUpdateSettings({ ...local.settings, mongoUri: uri })
      return { ok: true, replicaSet: true, databaseName: connection.name, staged: command === 'database.stage' }
    } catch { return { ok: false, error: RuntimeMessage.DATABASE_IS_UNAVAILABLE_OR_DOES_NOT_SUPPORT_TRANSACTIONS } }
    finally { if (connection) await connection.close() }
  }
  if (command === 'endpoint.test') {
    const data = inputReadObject(input, ['url', 'kind', 'model', 'secretName'], 'input')
    const url = new URL(inputReadString(data.url, 'url'))
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error(RuntimeMessage.ENDPOINT_MUST_BE_AN_HTTP_S_URL_WITHOUT_CREDENTIALS)
    if (data.kind !== 'network' && data.kind !== 'llm') throw new Error(RuntimeMessage.KIND_MUST_BE_NETWORK_OR_LLM)
    const started = performance.now()
    try {
      let response: Response
      if (data.kind === 'network') response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
      else {
        const name = inputReadString(data.secretName, 'secretName')
        if (!['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'].includes(name)) throw new Error(RuntimeMessage.UNSUPPORTED_MODEL_SECRET)
        const secret = process.env[name] ?? local.secrets[name]
        if (!secret) throw new Error(RuntimeMessage.MODEL_SECRET_IS_NOT_CONFIGURED)
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
    } catch { return { ok: false, error: RuntimeMessage.ENDPOINT_REQUEST_FAILED, latencyMs: Math.round(performance.now() - started) } }
  }
  const connection = await storeCreateConnection(process.env.CHONGMING_MONGO_URI ?? local.settings.mongoUri ?? 'mongodb://127.0.0.1:27017/chongming_graph')
  try {
    if (command === 'data.migrate-node-runs') {
      const data = inputReadObject(input, ['apply'], 'input')
      if (data.apply !== undefined && typeof data.apply !== 'boolean') throw new Error(RuntimeMessage.APPLY_MUST_BE_BOOLEAN)
      return await repairMigrateNodeRuns(connection, data.apply === true)
    }
    const app = applicationCreateService(connection)
    await app.initialize()
    if (command === 'data.repair-news-context') {
      const data = inputReadObject(input, ['apply'], 'input')
      if (data.apply !== undefined && typeof data.apply !== 'boolean') throw new Error(RuntimeMessage.APPLY_MUST_BE_BOOLEAN)
      return await repairUpdateNewsContext(connection, data.apply === true)
    }
    if (command === 'init' || command === 'user.create') {
      const data = inputReadObject(input, command === 'init' ? ['id', 'displayName'] : ['id', 'displayName', 'hostAdmin'], 'input')
      if (command === 'user.create' && typeof data.hostAdmin !== 'boolean') throw new Error(RuntimeMessage.HOSTADMIN_MUST_BE_BOOLEAN)
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
  } finally { await connection.close() }
}

adminRunCommand().then(/* 已完成管理命令的返回值，以 JSON 写入标准输出。 */ result => /* 将管理命令的结果格式化为 JSON 输出。 */  console.log(JSON.stringify(result, null, 2))).catch(/* 管理命令拒绝原因；领域错误可公开说明，其他错误只输出诊断编号。 */ error => {
  // 记录管理错误并输出关联诊断编号，同时设置失败退出码。
  const errorId = reporter.report({ name: 'admin.failed', severity: error instanceof GraphError ? 'warn' : 'error', error })
  console.error(error instanceof GraphError ? `${error.code}: ${error.message} (${errorId})` : `Admin command failed; check its input and local configuration (${errorId})`)
  process.exitCode = 1
})
