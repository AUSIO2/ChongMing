import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as sdk from '@deepseek-ai/dsh-sdk-client'
import type { DshRuntimeAPI } from '../../../contracts/dsh'
import type { GraphDataRead } from '../../../contracts/graph'
import * as dshRuntime from '../../../backend/execution/dsh/runtime'
import { dshCreateRuntime, dshReadEvent } from '../../../backend/execution/dsh/runtime'
import { dshHttpCreateServer } from '../../../backend/adapters/http/dsh-diagnostic-server'
import { dshRunWork, type DshWorkInput } from '../../../backend/execution/dsh/work-executor'
import { verificationConfiguration, verificationSlots } from '../fixtures/verification'

vi.mock('@deepseek-ai/dsh-sdk-client', { spy: true })

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
})

function workInput(): DshWorkInput {
  return {
    grant: {
      workId: 'operation:route', mapId: 'map', runId: 'run', operationId: 'operation',
      actor: { role: 'router' }, routeRevision: 0, hostId: 'host', holderId: 'holder',
      fence: 1, expiresAt: '2099-01-01T00:00:00.000Z', leaseMs: 30000,
    },
    dataApiUrl: 'http://127.0.0.1:12345', token: 'test-only-token',
    dshHome: path.join(tmpdir(), 'unused-work-access-test'),
  }
}

describe('DSH work access failures', () => {
  it('marks network, 5xx, 429 and lost-lease responses as access errors without retrying', async () => {
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockRejectedValueOnce(new TypeError('connection reset'))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    for (const [status, code] of [[503, 'DATABASE_UNAVAILABLE'], [429, 'RATE_LIMITED'], [409, 'LEASE_LOST']] as const) {
      request.mockResolvedValueOnce(Response.json({ ok: false, error: { code, message: 'temporarily unavailable' } }, { status }))
      await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    }
    request.mockResolvedValueOnce(new Response('proxy unavailable', { status: 502 }))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    expect(request).toHaveBeenCalledTimes(5)
  })

  it('also classifies input-read failures after a valid ready-work confirmation', async () => {
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockResolvedValueOnce(Response.json({ ok: true, data: { workId: 'operation:route', status: 'ready' } }))
    request.mockResolvedValueOnce(Response.json({ ok: false, error: { code: 'DATABASE_UNAVAILABLE', message: 'retry later' } }, { status: 503 }))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'WorkAccessError' })
    expect(request).toHaveBeenCalledTimes(2)
    expect((request.mock.calls[1][0] as Request).url).toContain('/internal/v1/data/read')
  })

  it('preserves explicit cancellation and does not classify permanent configuration errors as retryable access', async () => {
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockResolvedValueOnce(Response.json({ ok: false, error: { code: 'UNAUTHORIZED', message: 'invalid credentials' } }, { status: 401 }))
    await expect(dshRunWork(workInput())).rejects.toMatchObject({ name: 'Error', message: 'UNAUTHORIZED: invalid credentials' })
    const stop = new AbortController()
    const reason = new Error('Host is shutting down')
    request.mockImplementationOnce(async () => { stop.abort(reason); throw reason })
    await expect(dshRunWork({ ...workInput(), signal: stop.signal })).rejects.toBe(reason)
    expect(request).toHaveBeenCalledTimes(2)
  })
})

describe('DSH operation profiles', () => {
  it.each([
    { kind: 'parse', actor: { role: 'parse' } },
    { kind: 'split', actor: { role: 'router' } },
    { kind: 'split', actor: { role: 'worker', slotId: 'angle-1' } },
    { kind: 'split', actor: { role: 'merge' } },
  ] as const)('binds $kind/$actor.role to its frozen profile and exact proposal identity', async ({ kind, actor }) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-dsh-profile-'))
    temporaryDirectories.push(directory)
    const configuration = verificationConfiguration()
    configuration.parse = { ...configuration.router, id: 'custom-parser', provider: 'parse-provider', model: 'parse-model', content: 'Parse={{rawContent}}', promptVars: ['rawContent'] }
    configuration.split = {
      router: { ...configuration.router, id: 'split-router', provider: 'split-router-provider', model: 'route-model', content: 'Route={{content}}', promptVars: ['content'] },
      merger: { ...configuration.merger, id: 'split-merger', provider: 'split-merge-provider', model: 'merge-model', content: 'Merge={{subResults}}', promptVars: ['subResults'] },
      agents: configuration.agents.map(profile => ({ ...profile, id: 'split-' + profile.id, provider: 'split-worker-provider', model: 'worker-model',
        content: 'Split={{content}};{{hint}}', promptVars: ['content', 'hint'] })),
    }
    const slots = verificationSlots(2).map(slot => ({ ...slot, agentId: 'split-' + slot.agentId }))
    const input = workInput()
    input.dshHome = directory
    input.grant = { ...input.grant, actor, routeRevision: actor.role === 'parse' || actor.role === 'router' ? 0 : 2 }
    const data: GraphDataRead = {
      mapId: input.grant.mapId, runId: input.grant.runId, operationId: input.grant.operationId, operationKind: kind,
      target: { id: 'target', revision: 0, createdAt: '', updatedAt: '', data: kind === 'parse'
        ? { kind: 'source', locator: { kind: 'asset', assetId: 'asset', mediaType: 'text/plain' }, label: null }
        : { kind: 'news', content: 'Frozen news', context: {} } },
      ...(kind === 'parse' ? { rawContent: 'Shared source' } : {}),
      configuration, context: [], route: input.grant.routeRevision ? { revision: 2, reason: 'Angles', slots, approved: true } : null,
      reports: [], splitReports: [], contentDraft: null, draft: null, review: null,
      phase: actor.role === 'parse' ? 'parse' : actor.role === 'router' ? 'route' : actor.role === 'worker' ? 'workers' : 'merge',
      proposalId: 'exact-proposal-from-api', work: { id: input.grant.workId, actor, routeRevision: input.grant.routeRevision, status: 'ready' },
    }
    const request = vi.spyOn(globalThis, 'fetch')
    request.mockResolvedValueOnce(Response.json({ ok: true, data: { workId: input.grant.workId, status: 'ready' } }))
    request.mockResolvedValueOnce(Response.json({ ok: true, data }))
    request.mockResolvedValueOnce(Response.json({ ok: true, data: { workId: input.grant.workId, status: 'accepted' } }))
    let patch: Array<{ id: string; config: Record<string, any> }> = []
    const close = vi.fn(async () => {})
    const run = vi.fn<DshRuntimeAPI['run']>(async ({ sessionId }) => ({ sessionId: sessionId!, finalResponse: 'accepted', events: [] }))
    const create = vi.spyOn(dshRuntime, 'dshCreateRuntime').mockImplementation(config => ({
      start: async () => { patch = JSON.parse(await readFile(config.patches!.at(-1)!, 'utf8')) }, run, close,
    }))
    const result = await dshRunWork(input)
    const profile = kind === 'parse' ? configuration.parse : actor.role === 'router' ? configuration.split.router
      : actor.role === 'merge' ? configuration.split.merger : configuration.split.agents[0]
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ provider: profile.provider, model: profile.model }))
    expect(patch[0].config).toMatchObject({ operationKind: kind, proposalId: data.proposalId, grant: input.grant, rootSessionId: result.sessionId, configuration })
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ sessionId: result.sessionId, prompt: expect.stringContaining(kind === 'parse' ? 'Shared source' : actor.role === 'merge' ? 'Merge=[]' : 'Frozen news') }), undefined)
    expect(close).toHaveBeenCalledOnce()
  })
})

describe('DSH runtime facade', () => {
  it('keeps broker credentials and test configuration paths out of the DSH subprocess environment', async () => {
    vi.stubEnv('CHONGMING_AMQP_URL', 'amqp://brokerSecret@localhost')
    vi.stubEnv('CHONGMING_TEST_BROKER_FILE', '/private/brokerSecret.json')
    const create = vi.mocked(sdk.DeepSeekHarness)
    create.mockClear()
    const runtime = dshCreateRuntime({
      dshBin: path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'), dshHome: '/unused-dsh-env-test',
      cwd: '/tmp', processCwd: '/tmp', provider: 'deepseek-official', model: 'deepseek-v4-flash',
      env: { CHONGMING_AMQP_URL: 'amqp://overrideBrokerSecret@localhost',
      CHONGMING_TEST_BROKER_FILE: '/private/overrideBrokerSecret.json', CHONGMING_HOST_ID: 'test-host' } })
    const options = create.mock.calls[0][0]!
    expect(options.env).not.toHaveProperty('CHONGMING_AMQP_URL')
    expect(options.env).not.toHaveProperty('CHONGMING_TEST_BROKER_FILE')
    expect(JSON.stringify(options)).not.toMatch(/brokerSecret/i)
    expect(options.env).toHaveProperty('CHONGMING_HOST_ID', 'test-host')
    expect(process.env.CHONGMING_AMQP_URL).toContain('brokerSecret')
    await runtime.close()
  })

  it('starts and closes the official SDK profile', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-dsh-'))
    temporaryDirectories.push(directory)
    const runtime = dshCreateRuntime({
      dshBin: path.resolve('node_modules/@deepseek-ai/dsh/lib/bin.js'),
      dshHome: path.join(directory, 'home'),
      cwd: directory,
      processCwd: directory,
      profile: 'sdk',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    await expect(runtime.start()).resolves.toBeUndefined()
    const firstClose = runtime.close()
    const secondClose = runtime.close()
    expect(secondClose).toBe(firstClose)
    await expect(firstClose).resolves.toBeUndefined()
    await expect(secondClose).resolves.toBeUndefined()
    await expect(runtime.close()).resolves.toBeUndefined()
    await expect(runtime.start()).rejects.toThrow('closed')
  }, 20_000)

  it('copies SDK notifications into JSON-safe events', () => {
    const params = { sessionId: 'session-1', status: 'idle', nested: { items: [1, true, null] }, ignored: undefined }
    const event = dshReadEvent({
      method: 'session.status',
      params,
    })
    expect(event).toEqual({
      method: 'session.status',
      params: { sessionId: 'session-1', status: 'idle', nested: { items: [1, true, null] } },
    })
    params.nested.items.push(2)
    expect(event.params.nested).toEqual({ items: [1, true, null] })
    expect(() => dshReadEvent({ method: 'invalid', params: { value: BigInt(1) } })).toThrow(TypeError)
  })

  it('streams events and a final result over NDJSON', async () => {
    const runtime: DshRuntimeAPI = {
      start: async () => {},
      async run(input, onEvent) {
        onEvent?.({ method: 'session.status', params: { status: 'running' } })
        return { sessionId: input.sessionId ?? 'new-session', finalResponse: 'done', events: [] }
      },
      close: async () => {},
    }
    const server = dshHttpCreateServer(runtime)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Server did not bind')
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/runtime/dsh/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: 'session-1', prompt: 'hello' }),
      })
      expect(response.status).toBe(200)
      expect(await response.text()).toBe([
        JSON.stringify({ type: 'event', event: { method: 'session.status', params: { status: 'running' } } }),
        JSON.stringify({ type: 'result', result: { sessionId: 'session-1', finalResponse: 'done', events: [] } }),
        '',
      ].join('\n'))
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
