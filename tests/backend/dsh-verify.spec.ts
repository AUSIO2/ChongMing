import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import type { GraphDataRead, GraphWorkGrant } from '../../contracts/graph'
import { createGraphApi, expectRejected, type TestGraphApi } from './fixtures/graph-api'
import { verificationConfiguration, verificationSlots } from './fixtures/verification'

interface WireCall { id: string; function: { name: string; arguments: string } }
interface WireMessage { role: string; content?: string; tool_call_id?: string; tool_calls?: WireCall[] }
interface ProviderRequest { messages: WireMessage[]; tools?: Array<{ function: { name: string } }> }
interface Trace { role?: string; sessionId?: string; tools?: string[]; error?: string; last?: unknown }

function toolResults(messages: WireMessage[]) {
  const calls = new Map(messages.flatMap(message => message.tool_calls ?? []).map(call => [call.id, call]))
  return messages.flatMap(message => {
    if (message.role !== 'tool') return []
    const call = calls.get(message.tool_call_id ?? '')
    if (!call) throw new Error('Native tool result has no call')
    return [{ name: call.function.name, data: JSON.parse(message.content ?? '') as Record<string, any> }]
  })
}

function stream(response: ServerResponse, name: string, args: unknown) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
    id: `tool-${Date.now()}-${Math.random()}`, type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

async function listen(server: Server) {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Provider did not bind')
  return `http://127.0.0.1:${address.port}`
}

interface HostProcess {
  child: ChildProcess
  ready: Promise<void>
  exited: Promise<{ code: number | null; signal: string | null }>
  output(): string
  crashed?: boolean
}

function startHost(hostId: string, api: TestGraphApi, directory: string, patchPath: string, mapId: string, toolDelayMs = 150): HostProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve('backend/host-main.ts'),
    '--data-api', api.url, '--host-id', hostId, '--map-id', mapId,
    '--dsh-home', path.join(directory, hostId), '--poll-ms', '40', '--request-timeout-ms', '1000',
    '--patch', patchPath, '--cwd', directory, '--process-cwd', directory, '--max-tokens', '2000', '--max-rounds', '3',
  ], { cwd: path.resolve('.'), stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...process.env, CHONGMING_DATA_TOKEN: api.token, DEEPSEEK_API_KEY: 'local-fixture-key',
    DSH_TELEMETRY_DISABLED: '1', CHONGMING_E2E_TOOL_LOG: path.join(directory, 'tool-calls.jsonl'),
    CHONGMING_E2E_RUNTIME_LOG: path.join(directory, 'runtime-processes.jsonl'), CHONGMING_E2E_OVERLAP: '1',
    CHONGMING_E2E_TOOL_DELAY_MS: String(toolDelayMs),
  } })
  let stdout = '', stderr = '', readyResolved = false
  let readyResolve!: () => void, readyReject!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  child.stdout!.on('data', chunk => {
    stdout += chunk.toString()
    if (!readyResolved && stdout.includes('"host.started"')) { readyResolved = true; readyResolve() }
  })
  child.stderr!.on('data', chunk => { stderr += chunk.toString() })
  child.once('error', readyReject)
  const exited = new Promise<{ code: number | null; signal: string | null }>(resolve => child.once('exit', (code, signal) => {
    if (!readyResolved) readyReject(new Error(`Host failed before ready: ${stderr}`))
    resolve({ code, signal })
  }))
  return { child, ready, exited, output: () => stdout + stderr }
}

async function stopHost(host: HostProcess) {
  if (host.child.exitCode === null && host.child.signalCode === null) host.child.kill('SIGTERM')
  const result = await Promise.race([host.exited, delay(5000, undefined, { ref: false }).then(() => null)])
  if (!result) { host.child.kill('SIGKILL'); await host.exited; throw new Error(`Host did not drain: ${host.output()}`) }
  expect(result).toEqual({ code: 0, signal: null })
  expect(host.output()).toContain('"host.stopped"')
}

async function stopOwnedRuntime(pid: number) {
  if (pid === process.pid) throw new Error('Refusing to treat the test runner as an owned DSH process')
  const alive = () => {
    try { process.kill(pid, 0); return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error }
  }
  if (!alive()) return
  try { process.kill(pid, 'SIGTERM') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await delay(20)
  if (!alive()) return
  try { process.kill(pid, 'SIGKILL') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw error }
  for (let attempt = 0; attempt < 100 && alive(); attempt++) await delay(20)
  expect(alive(), `Owned DSH PID ${pid} did not exit`).toBe(false)
}

describe('Multiple real Host processes and official DSH', () => {
  it.each([
    { mode: 'auto' as const, crash: false },
    { mode: 'human-in-loop' as const, crash: false },
    { mode: 'auto' as const, crash: true },
  ])('automatically executes shared slots ($mode, crash=$crash)', async ({ mode, crash }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-multi-host-'))
    const trace: Trace[] = []
    const hosts: HostProcess[] = []
    const orphanPids = new Set<number>()
    let crashedGrant: GraphWorkGrant | undefined, crashedHostId: string | undefined, crashAt: number | undefined
    let api: TestGraphApi | undefined, provider: Server | undefined
    const slots = verificationSlots(3).map(slot => ({ ...slot, tools: ['archive_lookup'] }))
    try {
      // Only model responses are scripted. Production Host loops, DSH processes, tools and Mongo are real.
      provider = createServer(async (request, response) => {
        try {
          if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer local-fixture-key') throw new Error('Unexpected external/provider request')
          const chunks: Buffer[] = []
          for await (const chunk of request) chunks.push(Buffer.from(chunk))
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderRequest
          const persona = body.messages.filter(message => message.role === 'system' || message.role === 'user').map(message => message.content).join('\n')
          const role = persona.match(/E2E_ROLE=(router|worker|merge)/)?.[1]
          if (!role) throw new Error('Frozen role persona was not installed')
          const results = toolResults(body.messages)
          const last = results[results.length - 1]
          trace.push({ role, sessionId: String(request.headers['x-deepseek-harness-session-id']),
            tools: body.tools?.map(tool => tool.function.name), last })
          if (!last) return stream(response, 'data_read', {})
          if (last.name === 'archive_lookup') return stream(response, 'data_propose', { proposal: {
            kind: 'report', score: last.data.score, reason: `${last.data.marker}: ${last.data.source}`,
          } })
          if (last.name !== 'data_read') throw new Error('Accepted work should conclude its native turn')
          const data = last.data as unknown as GraphDataRead
          if (role === 'router') return stream(response, 'data_propose', { proposal: {
            kind: 'route', reason: 'Three evidence angles selected by the router', slots,
          } })
          if (role === 'worker') {
            if (data.work.actor.role !== 'worker') throw new Error('Worker lacks its DB-derived slot identity')
            const slotId = data.work.actor.slotId
            return stream(response, 'archive_lookup', { query: data.route!.slots.find(slot => slot.id === slotId)!.angle })
          }
          return stream(response, 'data_propose', { proposal: { kind: 'merge', score: 0.5,
            reason: 'Merged three independent Host reports.', reportIds: data.reports.map(report => report.id) } })
        } catch (error) {
          trace.push({ error: String(error) })
          response.writeHead(500, { 'content-type': 'application/json' })
          response.end(JSON.stringify({ error: { message: String(error) } }))
        }
      })
      const providerUrl = await listen(provider)
      const patchPath = path.join(directory, 'fixture.patch.yml')
      await writeFile(patchPath, ['- id: llm-deepseek', '  config:', '    apiKeyEnv: DEEPSEEK_API_KEY',
        `    baseURL: ${providerUrl}/v1`, '    thinking: disabled', '    streamIdleTimeoutMs: 10000',
        '- insert:', '    - id: verification-evidence-fixture',
        `      name: ${JSON.stringify(path.resolve('tests/backend/fixtures/evidence-tool.mjs'))}`, '',
      ].join('\n'))
      api = await createGraphApi(crash ? 1800 : 3000)
      const configuration = verificationConfiguration(5)
      configuration.tools = [{ name: 'archive_lookup', description: 'Read local fixture evidence' }]
      configuration.router.content = 'E2E_ROLE=router'
      configuration.merger.content = 'E2E_ROLE=merge'
      for (const profile of [configuration.router, configuration.merger, ...configuration.agents]) {
        profile.provider = 'deepseek-official'; profile.model = 'deepseek-v4-flash'
      }
      for (const profile of configuration.agents) { profile.content = 'E2E_ROLE=worker'; profile.tools = ['archive_lookup'] }
      const context = await api.createRun(mode, configuration)
      hosts.push(startHost('host-a', api, directory, patchPath, context.mapId, crash ? 2200 : 150),
        startHost('host-b', api, directory, patchPath, context.mapId, crash ? 2200 : 150))
      await Promise.all(hosts.map(host => host.ready))
      expect(hosts[0].child.pid).not.toBe(hosts[1].child.pid)
      async function waitFor(predicate: (snapshot: Record<string, any>) => boolean) {
        const deadline = Date.now() + 25000
        while (Date.now() < deadline) {
          const current = await api!.snapshot(context.mapId)
          if (current.run.status === 'failed') throw new Error(`Host failed: ${JSON.stringify(current.run.error)}`)
          if (predicate(current)) return current
          await delay(40)
        }
        throw new Error('Hosts did not reach the expected business boundary')
      }
      if (crash) {
        const deadline = Date.now() + 15000
        let starts: Array<{ hostId: string; pid: number }> = []
        while (Date.now() < deadline) {
          const text = await readFile(path.join(directory, 'tool-calls.jsonl'), 'utf8').catch(error => {
            if (error.code === 'ENOENT') return ''
            throw error
          })
          starts = text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(record => record.event === 'start')
          if (new Set(starts.map(record => record.hostId)).size === 2) break
          await delay(20)
        }
        expect(new Set(starts.map(record => record.hostId)).size).toBe(2)
        crashedHostId = starts[0].hostId
        const document = (await api.store.read(context.mapId))!
        crashedGrant = Object.values(document.leases).find(grant => grant.hostId === crashedHostId && grant.actor.role === 'worker')!
        expect(crashedGrant).toBeDefined()
        expect(document.run!.operation.reports).toHaveLength(0)
        const victim = hosts.find(host => host.output().includes(`"hostId":"${crashedHostId}"`))!
        victim.crashed = true
        crashAt = Date.now()
        expect(victim.child.kill('SIGKILL')).toBe(true)
        expect(await victim.exited).toEqual({ code: null, signal: 'SIGKILL' })
        // These PIDs came only from this test's real SDK tool log, never from a system process search.
        for (const record of starts.filter(record => record.hostId === crashedHostId)) {
          orphanPids.add(record.pid)
          await stopOwnedRuntime(record.pid)
          orphanPids.delete(record.pid)
        }
      }
      if (mode === 'human-in-loop') {
        const routed = await waitFor(snapshot => snapshot.run.status === 'waiting' && snapshot.run.operation.review.kind === 'route')
        expect(routed.run.operation.reports).toEqual([])
        await delay(200)
        await expect(readFile(path.join(directory, 'tool-calls.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await api.answer(context.mapId)
        const merged = await waitFor(snapshot => snapshot.run.status === 'waiting' && snapshot.run.operation.review.kind === 'result')
        expect(merged.nodes).toHaveLength(1)
        expect(merged.run.operation.reports).toHaveLength(3)
        await api.answer(context.mapId)
      }
      const completed = await waitFor(snapshot => snapshot.run.status === 'completed')
      expect(completed.run.operation.route.slots).toHaveLength(3)
      const verification = completed.nodes.find((node: { data: { kind: string } }) => node.data.kind === 'verification')
      expect(verification.data).toMatchObject({ score: 0.5, reason: 'Merged three independent Host reports.' })
      expect(verification.data.opinions).toHaveLength(3)
      for (const slot of slots) expect(verification.data.opinions).toContainEqual(expect.objectContaining({
        slotId: slot.id, agentId: slot.agentId, tools: ['archive_lookup'], reason: `custom-tool-executed: archive:${slot.angle}`,
      }))
      await Promise.all(hosts.filter(host => !host.crashed).map(stopHost))
      const toolCalls = (await readFile(path.join(directory, 'tool-calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const starts = toolCalls.filter(call => call.event === 'start')
      const ends = toolCalls.filter(call => call.event === 'end')
      if (crash) {
        expect(starts.length).toBeGreaterThanOrEqual(4)
        expect(ends.length).toBeGreaterThanOrEqual(3)
      } else {
        expect(starts).toHaveLength(3)
        expect(ends).toHaveLength(3)
      }
      expect(new Set(starts.map(call => call.hostId))).toEqual(new Set(['host-a', 'host-b']))
      expect(new Set(starts.map(call => call.sessionId)).size).toBe(starts.length)
      const endedAt = (start: typeof starts[number]) => ends.find(end => end.sessionId === start.sessionId)?.at
        ?? (start.hostId === crashedHostId ? crashAt : undefined)
      expect(starts.some(a => starts.some(b => a.hostId !== b.hostId
        && Math.max(a.at, b.at) < Math.min(endedAt(a), endedAt(b))))).toBe(true)
      const runtimes = (await readFile(path.join(directory, 'runtime-processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      if (crash) expect(new Set(runtimes.map(runtime => runtime.pid)).size).toBeGreaterThanOrEqual(6)
      else expect(new Set(runtimes.map(runtime => runtime.pid)).size).toBe(5)
      expect(new Set(runtimes.map(runtime => runtime.hostId))).toEqual(new Set(['host-a', 'host-b']))
      for (const entry of trace) expect([...(entry.tools ?? [])].sort()).toEqual(entry.role === 'worker'
        ? ['archive_lookup', 'data_propose', 'data_read'] : ['data_propose', 'data_read'])
      expect(new Set(trace.map(entry => entry.role))).toEqual(new Set(['router', 'worker', 'merge']))
      if (crashedGrant) {
        const replacement = (await api.store.read(context.mapId))!.leases[crashedGrant.workId]
        expect(replacement.fence).toBeGreaterThan(crashedGrant.fence)
        expect(replacement.hostId).not.toBe(crashedGrant.hostId)
        expectRejected(await api.propose(crashedGrant, { mapId: context.mapId, operationId: context.operationId,
          id: crashedGrant.workId, kind: 'report', routeRevision: crashedGrant.routeRevision,
          slotId: crashedGrant.actor.role === 'worker' ? crashedGrant.actor.slotId : '', score: 0, reason: 'Late orphan proposal',
        }))
        expect(await api.snapshot(context.mapId)).toEqual(completed)
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.stack : String(error)}\nHosts:\n${hosts.map(host => host.output()).join('\n')}\nProvider trace:\n${JSON.stringify(trace, null, 2)}`)
    } finally {
      await Promise.all(hosts.map(async host => {
        if (host.child.exitCode === null && host.child.signalCode === null) await stopHost(host)
      }))
      for (const pid of orphanPids) {
        await stopOwnedRuntime(pid)
      }
      if (provider) { provider.closeAllConnections(); await new Promise<void>(resolve => provider!.close(() => resolve())) }
      await api?.close()
      await rm(directory, { recursive: true, force: true })
    }
  }, 45_000)
})
