import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { clientCreateApi, clientCreateGateway } from '../../client/graph-client'
import type { GraphSnapshot } from '../../contracts/graph'
import type { GraphStreamEvent } from '../../contracts/events'

const mapId = randomUUID(), workspaceId = randomUUID()
const snapshot = (revision = 1): GraphSnapshot => ({ mapId, workspaceId, revision, name: '实时图', nodes: [], edges: [], run: null, updatedAt: '' })
const encode = (text: string) => new TextEncoder().encode(text)
function stream(parts: Uint8Array[], end = true) {
  return new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const part of parts) controller.enqueue(part); if (end) controller.close() } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
function frame(event: GraphStreamEvent) { return 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n' }

describe('authenticated SSE client', () => {
  it('parses split UTF-8 and CRLF frames with a complete baseline, heartbeats and invalidations', async () => {
    const body = ': heartbeat\r\n\r\n' + frame({ type: 'snapshot', snapshot: snapshot() }).replaceAll('\n', '\r\n')
      + frame({ type: 'activity', items: [] }) + frame({ type: 'refresh', scope: 'workspace' }) + frame({ type: 'snapshot', snapshot: snapshot(2) })
    const bytes = encode(body), fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream([...bytes].map(byte => new Uint8Array([byte]))))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'stream-token', fetch: fetcher })
    const events: GraphStreamEvent[] = []
    await expect(client.watch(mapId, event => events.push(event))).rejects.toMatchObject({ code: 'STREAM_ENDED', retryable: true })
    expect(events).toEqual([{ type: 'snapshot', snapshot: snapshot() }, { type: 'activity', items: [] }, { type: 'refresh', scope: 'workspace' }, { type: 'snapshot', snapshot: snapshot(2) }])
    expect(String(fetcher.mock.calls[0][0])).toBe('http://localhost:4320/api/v1/maps/' + mapId + '/events')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer stream-token', accept: 'text/event-stream' } })
    client.close()
  })

  it('rejects wrong maps, missing baselines, unknown events and invalid UTF-8', async () => {
    const values = [
      frame({ type: 'snapshot', snapshot: { ...snapshot(), mapId: randomUUID() } }),
      frame({ type: 'refresh', scope: 'settings' }),
      frame({ type: 'activity', items: [] }),
      frame({ type: 'snapshot', snapshot: snapshot() }) + 'event: activity\ndata: {"type":"activity","items":[{"sessionId":"secret"}]}\n\n',
      'event: unknown\ndata: {"type":"unknown"}\n\n',
      'event: snapshot\ndata: {"type":"snapshot","snapshot":{}}\n\n',
    ]
    for (const body of values) {
      const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: vi.fn().mockResolvedValue(stream([encode(body)])) })
      await expect(client.watch(mapId, () => {})).rejects.toMatchObject({ retryable: false }); client.close()
    }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: vi.fn().mockResolvedValue(stream([new Uint8Array([0xff])])) })
    await expect(client.watch(mapId, () => {})).rejects.toMatchObject({ code: 'INVALID_STREAM' }); client.close()
  })

  it('requires a baseline by the initial deadline and bounds idle time and frame size', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream([encode(': heartbeat\n\n')], false))
      .mockResolvedValueOnce(stream([encode(frame({ type: 'snapshot', snapshot: snapshot() }))], false))
      .mockResolvedValueOnce(stream([encode('data: ' + 'x'.repeat(16 * 1024 * 1024 + 1))]))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher, timeoutMs: 30, streamIdleMs: 30 })
    await expect(client.watch(mapId, () => {})).rejects.toMatchObject({ code: 'STREAM_TIMEOUT', retryable: true })
    await expect(client.watch(mapId, () => {})).rejects.toMatchObject({ code: 'STREAM_TIMEOUT', retryable: true })
    await expect(client.watch(mapId, () => {})).rejects.toMatchObject({ code: 'STREAM_TOO_LARGE', retryable: false })
    client.close()
  })

  it('retains structured authorization errors before and during a stream', async () => {
    const error = { code: 'UNAUTHORIZED', message: 'Token expired', status: 401, retryable: false, errorId: randomUUID() }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false, error }, { status: 401 }))
      .mockResolvedValueOnce(stream([encode(frame({ type: 'snapshot', snapshot: snapshot() }) + frame({ type: 'error', error }))]))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(client.watch(mapId, () => {})).rejects.toMatchObject(error)
    const events: GraphStreamEvent[] = []
    await expect(client.watch(mapId, event => events.push(event))).rejects.toMatchObject(error)
    expect(events[1]).toEqual({ type: 'error', error }); client.close()
  })

  it('cancels a live reader and does not serialize disconnect behind the watch lifetime', async () => {
    const bootstrap = { identity: { userId: randomUUID(), displayName: 'Owner', hostAdmin: false }, settings: { revision: 0, llm: {}, tools: [], limits: {} }, metadata: {} }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, requestId: randomUUID(), replayed: false, data: bootstrap }))
      .mockResolvedValueOnce(stream([encode(frame({ type: 'snapshot', snapshot: snapshot() }))], false))
    const gateway = clientCreateGateway({ baseUrl: 'http://localhost:4320', fetch: fetcher })
    await gateway.connect({ baseUrl: 'http://localhost:4320', token: 'token', remember: false })
    const events: GraphStreamEvent[] = [], pending = gateway.watch(mapId, event => events.push(event))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await vi.waitFor(() => expect(events).toHaveLength(1))
    await gateway.disconnect(); await rejected; gateway.close()
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: vi.fn().mockResolvedValue(stream([], false)) })
    const controller = new AbortController(), watch = client.watch(mapId, () => {}, controller.signal)
    const stopped = expect(watch).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    controller.abort(); await stopped; client.close()
  })
})
