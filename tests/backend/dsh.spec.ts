import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DshRuntimeAPI } from '../../contracts/dsh'
import { dshCreateRuntime, dshReadEvent } from '../../backend/dsh'
import { dshHttpCreateServer } from '../../backend/dsh-http'
import { dshRunWork, type DshWorkInput } from '../../backend/dsh-verify'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
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

describe('DSH runtime facade', () => {
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
    expect(dshReadEvent({
      method: 'session.status',
      params: { sessionId: 'session-1', status: 'idle', ignored: undefined },
    })).toEqual({
      method: 'session.status',
      params: { sessionId: 'session-1', status: 'idle' },
    })
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
