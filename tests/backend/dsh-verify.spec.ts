import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MongoMemoryServer } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { describe, expect, it } from 'vitest'
import { apiCreateServer } from '../../backend/api'
import { dshRunVerification } from '../../backend/dsh-verify'
import { graphCreateService } from '../../backend/graph'
import { storeCreateConnection, storeCreateGraphStore, storeDeleteConnection } from '../../backend/store'
import { DEVELOPMENT_WORKSPACE_ID, type GraphDataRead } from '../../contracts/graph'
import { verificationConfiguration, verificationSlots } from './fixtures/verification'

interface WireCall { id: string; type: 'function'; function: { name: string; arguments: string } }
interface WireMessage { role: string; content?: string; tool_call_id?: string; tool_calls?: WireCall[] }
interface ProviderRequest { messages: WireMessage[]; tools?: Array<{ function: { name: string } }> }
interface ToolResult { name: string; args: Record<string, any>; data: Record<string, any> }

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function close(server: Server | undefined) {
  if (!server) return
  server.closeAllConnections()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}

function toolResults(messages: WireMessage[]): ToolResult[] {
  const calls = new Map(messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]))
  return messages.flatMap(message => {
    if (message.role !== 'tool') return []
    const call = calls.get(message.tool_call_id ?? '')
    if (!call) throw new Error('Provider received a tool result without its native tool call')
    return [{ name: call.function.name, args: JSON.parse(call.function.arguments), data: JSON.parse(message.content ?? '') }]
  })
}

function stream(response: ServerResponse, calls: Array<{ name: string; args: unknown }> | string) {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  const toolCalls = typeof calls === 'string' ? undefined : calls.map((call, index) => ({
    index, id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) },
  }))
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0,
    delta: typeof calls === 'string' ? { content: calls } : { tool_calls: toolCalls },
    finish_reason: typeof calls === 'string' ? 'stop' : 'tool_calls',
  }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

describe('Real DSH verification integration', () => {
  it.each(['auto', 'human-in-loop'] as const)('runs three native workers and a custom tool in %s mode', async (mode) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-dsh-verify-'))
    const toolLog = path.join(directory, 'tool-calls.jsonl')
    const runtimeLog = path.join(directory, 'runtime-processes.jsonl')
    const providerTrace: Array<Record<string, unknown>> = []
    let mongo: MongoMemoryServer | undefined
    let connection: Connection | undefined
    let api: Server | undefined
    let provider: Server | undefined
    const slots = verificationSlots(3).map(slot => ({ ...slot, tools: ['archive_lookup'] }))
    try {
      // Only the LLM endpoint is scripted. Native DSH, its Agent loop, tool dispatch and Mongo are real.
      provider = createServer(async (request, response) => {
        try {
          if (request.url !== '/v1/chat/completions' || request.method !== 'POST') throw new Error('Unexpected provider route')
          if (request.headers.authorization !== 'Bearer local-fixture-key') throw new Error('Provider did not use the local fixture credential')
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest
          const tools = body.tools?.map(tool => tool.function.name) ?? []
          const role = tools.includes('data_delegate') ? 'router' : tools.includes('archive_lookup') ? 'worker' : 'merge'
          const results = toolResults(body.messages)
          const last = results[results.length - 1]
          providerTrace.push({ sessionId: request.headers['x-deepseek-harness-session-id'], role, tools,
            last: last ? { name: last.name, args: last.args, data: last.data } : null })
          const call = (name: string, args: unknown = {}) => stream(response, [{ name, args }])
          if (!last) return call('data_read')
          if (role === 'router') {
            if (last.name === 'data_delegate') {
              if (last.args.kind === 'merge') return stream(response, `Merger reached ${last.data.state}.`)
              return call('data_read')
            }
            const data = last.data as unknown as GraphDataRead
            if (data.phase === 'route') return call('data_propose', {
              proposal: { kind: 'route', reason: 'Three independent evidence angles fit this claim', slots },
            })
            if (data.phase === 'workers') return stream(response, data.route!.slots
              .filter(slot => !data.reports.some(report => report.slotId === slot.id))
              .map(slot => ({ name: 'data_delegate', args: { kind: 'worker', slotId: slot.id } })))
            if (data.phase === 'merge') return call('data_delegate', { kind: 'merge' })
            return stream(response, `Operation ${data.phase}.`)
          }
          if (role === 'worker') {
            if (last.name === 'data_read') {
              const data = last.data as unknown as GraphDataRead
              const slotId = data.proposalId.split(':').pop()
              const slot = data.route!.slots.find(slot => slot.id === slotId)
              if (!slot) throw new Error('Worker was not bound to an approved slot')
              return call('archive_lookup', { query: slot.angle })
            }
            if (last.name === 'archive_lookup') return call('data_propose', {
              proposal: { kind: 'report', score: last.data.score, reason: `${last.data.marker}: ${last.data.source}` },
            })
            return stream(response, 'My evidence report was submitted.')
          }
          if (last.name === 'data_read') return call('data_propose', {
            proposal: { kind: 'merge', reportIds: last.data.reports.map((report: { id: string }) => report.id),
              score: 0.5, reason: 'Merged three independently sourced fixture reports.' },
          })
          return stream(response, 'The final conclusion was submitted.')
        } catch (error) {
          providerTrace.push({ error: error instanceof Error ? error.message : String(error) })
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: String(error) } }))
        }
      })
      const providerUrl = await listen(provider)
      const patchPath = path.join(directory, 'fixture.patch.yml')
      await writeFile(patchPath, [
        '- id: llm-deepseek', '  config:', '    apiKeyEnv: DEEPSEEK_API_KEY',
        `    baseURL: ${providerUrl}/v1`, '    thinking: disabled', '    streamIdleTimeoutMs: 10000',
        '- insert:', '    - id: verification-evidence-fixture',
        `      name: ${JSON.stringify(path.resolve('tests/backend/fixtures/evidence-tool.mjs'))}`,
        '',
      ].join('\n'))
      mongo = await MongoMemoryServer.create()
      connection = await storeCreateConnection(mongo.getUri('chongming_dsh_verify_test'))
      api = apiCreateServer(graphCreateService(storeCreateGraphStore(connection)), { internalToken: 'e2e-internal-token' })
      const apiUrl = await listen(api)
      const post = async (suffix: 'command' | 'query', body: unknown) => {
        const response = await fetch(`${apiUrl}/api/v1/${suffix}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        })
        const result = await response.json() as Record<string, any>
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
        return result.data
      }
      const mapId = randomUUID()
      const claimId = randomUUID()
      const runId = randomUUID()
      await post('command', { requestId: randomUUID(), method: 'map.create',
        params: { workspaceId: DEVELOPMENT_WORKSPACE_ID, expectedRevision: 0, id: mapId, name: 'Native verification' } })
      await post('command', { requestId: randomUUID(), method: 'graph.apply', params: { mapId, expectedRevision: 0,
        changes: { nodes: { put: [{ id: claimId, data: { kind: 'claim', content: 'Fixture claim', category: null } }] } } } })
      const configuration = verificationConfiguration(5)
      configuration.tools = [{ name: 'archive_lookup', description: 'Read local fixture evidence' }]
      for (const profile of [configuration.router, configuration.merger, ...configuration.agents]) {
        profile.provider = 'deepseek-official'
        profile.model = 'deepseek-v4-flash'
      }
      for (const agent of configuration.agents) agent.tools = ['archive_lookup']
      const started = await post('command', { requestId: randomUUID(), method: 'run.start', params: {
        mapId, expectedRevision: 1, id: runId, targetId: claimId, mode, configuration,
      } })
      const runtimeInput = {
        mapId, operationId: started.snapshot.run.operation.id, dataApiUrl: apiUrl, token: 'e2e-internal-token',
        dshBin: path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
        dshHome: path.join(directory, 'dsh-home'), cwd: directory, processCwd: directory,
        patches: [patchPath], maxTokens: 2000, maxRounds: 8,
        env: { ...process.env, DEEPSEEK_API_KEY: 'local-fixture-key', DEEPSEEK_BASE_URL: `${providerUrl}/v1`,
          DSH_TELEMETRY_DISABLED: '1', CHONGMING_E2E_TOOL_LOG: toolLog, CHONGMING_E2E_RUNTIME_LOG: runtimeLog },
      }
      const result = await dshRunVerification(runtimeInput)
      expect(result).toMatchObject({ mapId, runId, phase: mode === 'auto' ? 'done' : 'waiting' })
      if (mode === 'human-in-loop') {
        const routeWaiting = await post('query', { method: 'map.get', params: { mapId } })
        expect(routeWaiting.run).toMatchObject({ status: 'waiting', operation: {
          reports: [], route: { approved: false }, review: { kind: 'route', state: 'pending' },
        } })
        expect(providerTrace.every(entry => entry.role === 'router')).toBe(true)
        await expect(readFile(toolLog, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        const approve = async (current: typeof routeWaiting) => post('command', {
          requestId: randomUUID(), method: 'review.answer', params: {
            mapId, expectedRevision: current.revision, runId,
            reviewId: current.run.operation.review.id,
            expectedReviewRevision: current.run.operation.review.revision, decision: 'approve',
          },
        })
        await approve(routeWaiting)
        // The first SDK process has closed; a fresh root resumes from the shared approved route.
        const resumed = await dshRunVerification(runtimeInput)
        expect(resumed).toMatchObject({ mapId, runId, phase: 'waiting', sessionId: expect.any(String) })
        expect(resumed.sessionId).not.toBe(result.sessionId)
        const resultWaiting = await post('query', { method: 'map.get', params: { mapId } })
        expect(resultWaiting.run).toMatchObject({ status: 'waiting', operation: { review: { kind: 'result', state: 'pending' } } })
        expect(resultWaiting.run.operation.reports).toHaveLength(3)
        expect(resultWaiting.nodes).toHaveLength(1)
        await approve(resultWaiting)
        const providerCalls = providerTrace.length
        expect(await dshRunVerification(runtimeInput)).toMatchObject({ phase: 'done', sessionId: null })
        expect(providerTrace).toHaveLength(providerCalls)
      }
      const graph = await post('query', { method: 'map.get', params: { mapId } })
      expect(graph.run.status).toBe('completed')
      expect(graph.run.operation.route.slots).toHaveLength(3)
      expect(graph.run.operation.reports).toHaveLength(3)
      const verification = graph.nodes.find((node: { data: { kind: string } }) => node.data.kind === 'verification')
      expect(verification.data).toMatchObject({ score: 0.5, reason: 'Merged three independently sourced fixture reports.' })
      expect(verification.data.opinions).toHaveLength(3)
      for (const slot of slots) expect(verification.data.opinions).toContainEqual(expect.objectContaining({
        slotId: slot.id, agentId: slot.agentId, angle: slot.angle, tools: ['archive_lookup'],
        reason: `custom-tool-executed: archive:${slot.angle}`,
      }))
      const calls = (await readFile(toolLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      expect(calls).toHaveLength(3)
      expect(new Set(calls.map(call => call.sessionId)).size).toBe(3)
      expect(calls.map(call => call.query).sort()).toEqual(slots.map(slot => slot.angle).sort())
      const runtimeProcesses = (await readFile(runtimeLog, 'utf8')).trim().split('\n').map(line => JSON.parse(line).pid)
      expect(runtimeProcesses).toHaveLength(mode === 'auto' ? 1 : 2)
      expect(new Set(runtimeProcesses).size).toBe(runtimeProcesses.length)
      expect(runtimeProcesses).not.toContain(process.pid)
      expect(new Set(providerTrace.map(entry => entry.role))).toEqual(new Set(['router', 'worker', 'merge']))
      for (const entry of providerTrace) {
        const expected = entry.role === 'router' ? ['data_delegate', 'data_propose', 'data_read']
          : entry.role === 'worker' ? ['archive_lookup', 'data_propose', 'data_read'] : ['data_propose', 'data_read']
        expect([...(entry.tools as string[])].sort()).toEqual(expected)
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.stack : String(error)}\nProvider trace:\n${JSON.stringify(providerTrace, null, 2)}`)
    } finally {
      await close(api)
      await close(provider)
      if (connection) await storeDeleteConnection(connection)
      if (mongo) await mongo.stop()
      await rm(directory, { recursive: true, force: true })
    }
  }, 60_000)
})
