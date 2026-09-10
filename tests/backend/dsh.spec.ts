import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DshRuntimeAPI } from '../../contracts/dsh'
import { dshCreateRuntime, dshReadEvent } from '../../backend/dsh'
import { dshHttpCreateServer } from '../../backend/dsh-http'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory =>
    rm(directory, { recursive: true, force: true }),
  ))
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
      patches: [path.resolve('backend/dsh-business.patch.yml')],
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
    })
    await expect(runtime.start()).resolves.toBeUndefined()
    await expect(runtime.close()).resolves.toBeUndefined()
    await expect(runtime.close()).resolves.toBeUndefined()
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
