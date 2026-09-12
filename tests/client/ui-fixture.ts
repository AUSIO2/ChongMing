import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { apiCreateServer } from '../../backend/api'
import { applicationCreateService } from '../../backend/application'
import { hostCreateWorker, type HostWorker } from '../../backend/host'
import { storeCreateConnection } from '../../backend/store'
import type { GraphAgentProfile, GraphDataRead, GraphRunConfiguration } from '../../contracts/graph'

import routerPrompt from './fixtures/router.json'
import workerPrompt from './fixtures/worker.json'
import mergePrompt from './fixtures/merge.json'

interface WireMessage {
  role: string; content?: string; tool_call_id?: string
  tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>
}

export interface FixtureModelCall { role: string; tool: string; sessionId: string }

function fixtureReadConfiguration(): GraphRunConfiguration {
  const prompts = { router: routerPrompt, worker: workerPrompt, merge: mergePrompt }
  const profile = (id: string, name: string, role: 'router' | 'worker' | 'merge'): GraphAgentProfile => ({
    id, name, description: `${name}，使用本机确定性验收数据。`,
    content: prompts[role].content,
    provider: 'deepseek-official', model: 'deepseek-v4-flash', tools: role === 'worker' ? ['archive_lookup'] : [],
    promptVars: role === 'router' ? ['claimContent', 'availableAgents'] : role === 'worker' ? ['hint', 'claimContent'] : ['claimContent', 'opinions'],
  })
  return {
    router: profile('ui-router', '核查路由', 'router'), merger: profile('ui-merger', '综合判断', 'merge'),
    agents: [profile('ui-source', '来源核验', 'worker'), profile('ui-data', '数据核验', 'worker'), profile('ui-logic', '逻辑核验', 'worker')],
    tools: [{ name: 'archive_lookup', description: '读取本机验收证据，不连接外部数据源。' }], maxSlots: 5,
  }
}

async function fixtureStartServer(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function fixtureCloseServer(server: Server | undefined) {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function fixtureWriteReply(response: ServerResponse, name: string, args: unknown) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
    id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 12, total_tokens: 24 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

/** A real, disposable backend and native DSH Host. Only the local model HTTP responses are scripted. */
export async function fixtureCreateEnvironment() {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-ui-'))
  const modelCalls: FixtureModelCall[] = []
  const errors: string[] = []
  let mongo: MongoMemoryReplSet | undefined, connection: Connection | undefined
  let server: Server | undefined, provider: Server | undefined, host: HostWorker | undefined
  let closing: Promise<void> | undefined
  const close = () => closing ??= (async () => {
    await host?.close()
    await fixtureCloseServer(server)
    await fixtureCloseServer(provider)
    if (connection) await connection.close()
    if (mongo) await mongo.stop()
    await rm(directory, { recursive: true, force: true })
  })()
  try {
    provider = createServer(async (request, response) => {
      try {
        if (request.method !== 'POST' || request.url !== '/v1/chat/completions'
          || request.headers.authorization !== 'Bearer ui-fixture-key') throw new Error('Unexpected model request')
        const chunks: Buffer[] = []
        for await (const chunk of request) chunks.push(Buffer.from(chunk))
        const { messages } = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: WireMessage[] }
        const persona = messages.filter(message => message.role === 'user' || message.role === 'system').map(message => message.content).join('\n')
        const role = persona.match(/UI_FIXTURE_ROLE=(router|worker|merge)/)?.[1]
        if (!role) throw new Error('Fixture role persona is absent')
        const calls = new Map(messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]))
        const results = messages.filter(message => message.role === 'tool').map(message => ({
          name: calls.get(message.tool_call_id ?? '')?.function.name,
          data: JSON.parse(message.content ?? '') as Record<string, any>,
        }))
        const last = results[results.length - 1]
        const send = (name: string, args: unknown = {}) => {
          modelCalls.push({ role, tool: name, sessionId: String(request.headers['x-deepseek-harness-session-id']) })
          fixtureWriteReply(response, name, args)
        }
        if (!last) return send('data_read')
        if (last.name === 'archive_lookup') return send('data_propose', { proposal: {
          kind: 'report', score: 1, reason: `已查阅本机验收证据：${last.data.source}。该角度支持待核查内容。`,
        } })
        if (last.name !== 'data_read') throw new Error('The accepted native work should have ended its turn')
        const data = last.data as unknown as GraphDataRead
        if (data.work.actor.role !== role) throw new Error('Model persona differs from its granted work')
        if (role === 'router') return send('data_propose', { proposal: {
          kind: 'route', reason: '从来源、数据与逻辑三个独立角度核查，保留每项依据。',
          slots: data.configuration.agents.slice(0, 3).map((agent, index) => ({
            id: `check-${index + 1}`, agentId: agent.id, angle: agent.name,
            priority: (['high', 'medium', 'low'] as const)[index], hint: `请完成${agent.name}，写明证据和限制。`, tools: [...agent.tools],
          })),
        } })
        if (role === 'worker' && data.work.actor.role === 'worker') {
          const slotId = data.work.actor.slotId
          return send('archive_lookup', { query: data.route!.slots.find(slot => slot.id === slotId)!.angle })
        }
        return send('data_propose', { proposal: { kind: 'merge', reportIds: data.reports.map(report => report.id),
          score: 0.5, reason: `已完成 ${data.reports.length} 个独立核查角度。现有证据支持主要内容，但细节仍需更多来源确认。`,
        } })
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
        response.writeHead(500, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: errors[errors.length - 1] } }))
      }
    })
    const providerUrl = await fixtureStartServer(provider)
    const patchPath = path.join(directory, 'provider.patch.yml')
    await writeFile(patchPath, ['- id: llm-deepseek', '  config:', '    apiKeyEnv: DEEPSEEK_API_KEY',
      `    baseURL: ${providerUrl}/v1`, '    thinking: disabled', '    streamIdleTimeoutMs: 10000',
      '- insert:', '    - id: verification-evidence-fixture',
      `      name: ${JSON.stringify(path.resolve('tests/backend/fixtures/evidence-tool.mjs'))}`, '',
    ].join('\n'), { mode: 0o600 })
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
    connection = await storeCreateConnection(mongo.getUri('chongming_ui_fixture'))
    const application = applicationCreateService(connection, { leaseMs: 5000 })
    await application.initialize()
    await application.control.seed(fixtureReadConfiguration())
    const identity = await application.auth.createUser({ id: randomUUID(), displayName: '界面验收用户', hostAdmin: false })
    const { token, tokenId } = await application.auth.createToken(identity.userId)
    const workspace = await application.auth.transact(token, ctx => application.control.createWorkspace(ctx, {
      id: randomUUID(), name: '重明 · 核查验收', description: '独立本机验收环境，模型输出为确定性测试数据。', agentSource: 'library',
    }))
    const internalToken = randomUUID()
    server = apiCreateServer(application, { internalToken })
    const baseUrl = await fixtureStartServer(server)
    host = hostCreateWorker({ hostId: 'ui-fixture-host', dataApiUrl: baseUrl, token: internalToken,
      dshHome: path.join(directory, 'dsh-home'), cwd: directory, processCwd: directory,
      dshBin: path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), patches: [patchPath], pollMs: 50,
      env: { DEEPSEEK_API_KEY: 'ui-fixture-key', DSH_TELEMETRY_DISABLED: '1',
        CHONGMING_CONFIG_DIR: path.join(directory, 'local-config'),
        CHONGMING_E2E_TOOL_LOG: path.join(directory, 'tool-calls.jsonl'),
        CHONGMING_E2E_RUNTIME_LOG: path.join(directory, 'runtime.jsonl'), CHONGMING_E2E_TOOL_DELAY_MS: '100', CHONGMING_E2E_OVERLAP: '0' },
    })
    await host.start()
    const credentialsPath = path.join(directory, 'credentials.json')
    await writeFile(credentialsPath, JSON.stringify({ baseUrl, token, workspaceId: workspace.id, displayName: identity.displayName }, null, 2), { mode: 0o600 })
    return { baseUrl, token, tokenId, identity, workspaceId: workspace.id, directory, credentialsPath,
      application, modelCalls, errors, close }
  } catch (error) { await close(); throw error }
}

export type UiFixture = Awaited<ReturnType<typeof fixtureCreateEnvironment>>

async function fixtureRunMain() {
  const fixture = await fixtureCreateEnvironment()
  console.log(JSON.stringify({ event: 'ui.fixture.ready', pid: process.pid, baseUrl: fixture.baseUrl, workspaceId: fixture.workspaceId,
    credentialsPath: fixture.credentialsPath, proxyEnvironment: { CHONGMING_GRAPH_API: fixture.baseUrl } }))
  const stop = () => { void fixture.close().then(() => console.log(JSON.stringify({ event: 'ui.fixture.stopped' }))) }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void fixtureRunMain().catch(error => { console.error(error); process.exitCode = 1 })
}
