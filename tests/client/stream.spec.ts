// SSE 传输测试：覆盖分块解码、快照基线、帧限制、认证失败与订阅取消。
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { clientCreateApi, clientCreateGateway } from '../../client/graph-client'
import type { GraphSnapshot } from '../../contracts/graph'
import type { GraphStreamEvent } from '../../contracts/events'

const mapId = randomUUID(), workspaceId = randomUUID()
const snapshot = (/* 测试快照的版本号，默认 1，用于观察后续实时更新。 */ revision = 1): GraphSnapshot =>
  /* 构造属于固定图与工作区、可指定版本的实时基线快照。 */
  ({ mapId, workspaceId, revision, name: '实时图', nodes: [], edges: [], run: null, updatedAt: '' })
const encode = (/* 待编码的 SSE 测试文本，包含刻意构造的换行边界。 */ text: string) => /* 将测试帧文本编码为 UTF-8 字节。 */ new TextEncoder().encode(text)
function stream(/* 按顺序交付的字节块数组，可逐字节拆分 UTF-8 与 CRLF。 */ parts: Uint8Array[], /* 交付全部字节后是否关闭流，默认 true；false 用于空闲和取消测试。 */ end = true) {
  // 按给定字节块构造 SSE 响应，可选择保持流不结束。
  return new Response(new ReadableStream<Uint8Array>({ start(/* 可读流生产端，由夹具依次入队字节并按标记关闭。 */ controller) {
    // 依次交付测试字节块，并按用例要求关闭流。
    for (const part of parts) controller.enqueue(part); if (end) controller.close()
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
function frame(/* 要编码的测试业务事件，类型写入 SSE event 字段。 */ event: GraphStreamEvent) {
  // 把业务事件编码为带事件名和 JSON 数据的完整 SSE 帧。
  return 'event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n'
}

describe('authenticated SSE client', () => {
  // 覆盖带认证的 SSE 客户端解析、基线约束、资源上限和取消行为。
  it('parses split UTF-8 and CRLF frames with a complete baseline, heartbeats and invalidations', async () => {
    // 验证逐字节 UTF-8 与 CRLF 分块仍能解析基线、活动和刷新事件。
    const body = ': heartbeat\r\n\r\n' + frame({ type: 'snapshot', snapshot: snapshot() }).replaceAll('\n', '\r\n')
      + frame({ type: 'activity', items: [] }) + frame({ type: 'refresh', scope: 'workspace' }) + frame({ type: 'snapshot', snapshot: snapshot(2) })
    const bytes = encode(body), fetcher = vi.fn<typeof fetch>().mockResolvedValue(stream([...bytes].map(/* 原始编码结果中的单个字节，用于构造最小分块。 */ byte =>
      /* 把每个字节单独分块，模拟任意 UTF-8 和换行边界。 */
      new Uint8Array([byte]))))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'stream-token', fetch: fetcher })
    const events: GraphStreamEvent[] = []
    await expect(client.watch(mapId, /* 客户端已解码并校验的事件，按接纳顺序记录。 */ event =>
      /* 记录客户端解码后的事件顺序。 */
      events.push(event))).rejects.toMatchObject({ code: 'STREAM_ENDED', retryable: true })
    expect(events).toEqual([{ type: 'snapshot', snapshot: snapshot() }, { type: 'activity', items: [] }, { type: 'refresh', scope: 'workspace' }, { type: 'snapshot', snapshot: snapshot(2) }])
    expect(String(fetcher.mock.calls[0][0])).toBe('http://localhost:4320/api/v1/maps/' + mapId + '/events')
    expect(fetcher.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', credentials: 'omit', headers: { authorization: 'Bearer stream-token', accept: 'text/event-stream' } })
    client.close()
  })

  it('rejects wrong maps, missing baselines, unknown events and invalid UTF-8', async () => {
    // 验证错图、无基线事件、未知类型和无效 UTF-8 均被拒绝。
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
      await expect(client.watch(mapId, () => {
        // 忽略事件内容，仅检验协议错误导致的订阅拒绝。
      })).rejects.toMatchObject({ retryable: false }); client.close()
    }
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: vi.fn().mockResolvedValue(stream([new Uint8Array([0xff])])) })
    await expect(client.watch(mapId, () => {
      // 忽略事件内容，仅检验无效 UTF-8 的拒绝原因。
    })).rejects.toMatchObject({ code: 'INVALID_STREAM' }); client.close()
  })

  it('requires a baseline by the initial deadline and bounds idle time and frame size', async () => {
    // 验证首个基线有建立期限，后续空闲和超大帧也会终止订阅。
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(stream([encode(': heartbeat\n\n')], false))
      .mockResolvedValueOnce(stream([encode(frame({ type: 'snapshot', snapshot: snapshot() }))], false))
      .mockResolvedValueOnce(stream([encode('data: ' + 'x'.repeat(16 * 1024 * 1024 + 1))]))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher, timeoutMs: 30, streamIdleMs: 30 })
    await expect(client.watch(mapId, () => {
      // 不接纳业务事件，仅观察只有心跳时的基线超时。
    })).rejects.toMatchObject({ code: 'STREAM_TIMEOUT', retryable: true })
    await expect(client.watch(mapId, () => {
      // 忽略已收到的基线，检验后续空闲超时。
    })).rejects.toMatchObject({ code: 'STREAM_TIMEOUT', retryable: true })
    await expect(client.watch(mapId, () => {
      // 忽略业务事件，仅检验超大帧被拒绝。
    })).rejects.toMatchObject({ code: 'STREAM_TOO_LARGE', retryable: false })
    client.close()
  })

  it('retains structured authorization errors before and during a stream', async () => {
    // 验证建立订阅前及流中的认证错误均保留结构化信息。
    const error = { code: 'UNAUTHORIZED', message: 'Token expired', status: 401, retryable: false, errorId: randomUUID() }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: false, error }, { status: 401 }))
      .mockResolvedValueOnce(stream([encode(frame({ type: 'snapshot', snapshot: snapshot() }) + frame({ type: 'error', error }))]))
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: fetcher })
    await expect(client.watch(mapId, () => {
      // 不记录事件，仅检查 HTTP 阶段的认证失败。
    })).rejects.toMatchObject(error)
    const events: GraphStreamEvent[] = []
    await expect(client.watch(mapId, /* 客户端收到的基线或错误事件，用于核对结构化认证错误。 */ event => /* 记录基线和流内错误事件，供顺序及错误内容断言。 */ events.push(event))).rejects.toMatchObject(error)
    expect(events[1]).toEqual({ type: 'error', error }); client.close()
  })

  it('cancels a live reader and does not serialize disconnect behind the watch lifetime', async () => {
    // 验证退出不会排在长订阅后等待，取消会终止活跃读取器。
    const bootstrap = { identity: { userId: randomUUID(), displayName: 'Owner', hostAdmin: false }, settings: { revision: 0, llm: {}, tools: [], limits: {} }, metadata: {} }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({ ok: true, requestId: randomUUID(), replayed: false, data: bootstrap }))
      .mockResolvedValueOnce(stream([encode(frame({ type: 'snapshot', snapshot: snapshot() }))], false))
    const gateway = clientCreateGateway({ baseUrl: 'http://localhost:4320', fetch: fetcher })
    await gateway.connect({ baseUrl: 'http://localhost:4320', token: 'token', remember: false })
    const events: GraphStreamEvent[] = [], pending = gateway.watch(mapId, /* 活跃订阅接纳的事件，用于确认首个快照已到达。 */ event => /* 记录实时基线以确认订阅已开始读取。 */ events.push(event))
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    await vi.waitFor(() => /* 等待首个快照事件到达后再退出网关。 */ expect(events).toHaveLength(1))
    await gateway.disconnect(); await rejected; gateway.close()
    const client = clientCreateApi({ baseUrl: 'http://localhost:4320', token: 'token', fetch: vi.fn().mockResolvedValue(stream([], false)) })
    const controller = new AbortController(), watch = client.watch(mapId, () => {
      // 忽略事件内容，仅验证调用者主动取消的错误类型。
    }, controller.signal)
    const stopped = expect(watch).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    controller.abort(); await stopped; client.close()
  })
})
