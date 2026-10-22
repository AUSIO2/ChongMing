// 仅供授权可靠性用例使用：逐帧扣住真实 SSE 字节，HTTP 原样透传，浏览器只回报读取进度。
import { createServer, request as requestHttp, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Page } from '@playwright/test'

export interface GrantSnapshotFrame {
  readonly connection: number
  readonly sequence: number
  readonly revision: number
  readonly ownershipRevision: number
}
interface BufferedFrame { sequence: number; bytes: Buffer; snapshot: GrantSnapshotFrame | null }
interface Channel { response: ServerResponse; upstream: IncomingMessage; frames: BufferedFrame[]; pending: Buffer; released: number; active: boolean }
interface FrameWaiter { predicate: (frame: GrantSnapshotFrame) => boolean; resolve: (frame: GrantSnapshotFrame) => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> }
interface BrowserWaiter { connection: number; sequence: number; resolve: () => void; reject: (cause: Error) => void; timer: ReturnType<typeof setTimeout> }

enum GrantRelayError {
  ADDRESS_MISSING = '授权测试转发器没有提供回环监听地址。',
  INVALID_FRAME = '授权测试收到不合法的真实 SSE 快照帧。',
  FRAME_TIMEOUT = '授权测试没有在期限内收到指定真实快照。',
  READ_TIMEOUT = '授权测试没有在期限内确认浏览器已处理指定原帧。',
  CLOSED = '授权测试转发器已经结束。',
  CHANNEL_CLOSED = '授权测试的原始 SSE 连接已结束，不能换用新连接冒充旧帧交付。',
  FRAME_MISSING = '授权测试没有找到指定原始帧。',
  STREAM_FAILED = '授权测试的真实上游 SSE 连接意外失败。',
}

/** 只从完整原帧读取定位元数据；保留并交付的始终是原 Buffer。 */
function grantReadSnapshotFrame(
  /* 真实后端已产生的完整 SSE 原始字节。 */ bytes: Buffer,
  /* 当前真实响应连接的编号。 */ connection: number,
  /* 当前连接内的原始帧序号，包含活动/心跳帧。 */ sequence: number,
  /* 本用例唯一允许扣住的数据图身份。 */ mapId: string,
): GrantSnapshotFrame | null {
  const text = bytes.toString('utf8')
  if (!text.startsWith('event: snapshot\n')) return null
  const data = text.split('\n').filter((/* 真实 SSE 的一行文本。 */ line) => line.startsWith('data: '))
    .map((/* 不改写该行，只提取已产生帧的 JSON 元数据。 */ line) => line.slice(6)).join('\n')
  const value: unknown = JSON.parse(data)
  const event = value as { type?: unknown; snapshot?: { mapId?: unknown; revision?: unknown; ownershipRevision?: unknown } }
  if (event.type !== 'snapshot' || event.snapshot?.mapId !== mapId || !Number.isSafeInteger(event.snapshot.revision)
    || !Number.isSafeInteger(event.snapshot.ownershipRevision)) throw new Error(GrantRelayError.INVALID_FRAME)
  return { connection, sequence, revision: event.snapshot.revision as number, ownershipRevision: event.snapshot.ownershipRevision as number }
}

/** 为一张真实 Map 建立固定原帧队列，不伪造成功、快照、事件或新的业务顺序。 */
export async function grantCreateFrameRelay(
  /* 当前测试独占的真实 Vite origin，所有普通 HTTP 都原样转发至此。 */ upstream: string,
  /* 本用例唯一允许扣帧的数据图。 */ mapId: string,
) {
  const eventsPath = `/api/v1/maps/${mapId}/events`, requests = new Set<ClientRequest>()
  const channels = new Map<number, Channel>(), waiters = new Set<FrameWaiter>()
  let connections = 0, closed = false, closing: Promise<void> | undefined, streamFailed = false
  /** 将已经真实到达的快照元数据交给等待者，取消其期限计时器。 */
  function notifyFrame(/* 当前真实连接中已经完整接收的原始帧。 */ frame: GrantSnapshotFrame): void {
    for (const waiter of [...waiters]) if (waiter.predicate(frame)) {
      waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(frame)
    }
  }
  const server = createServer((
    /* 浏览器发出的真实 HTTP 请求。 */ incoming,
    /* 对应浏览器响应，普通 HTTP 原样流转。 */ outgoing,
  ) => {
    // 只在指定 SSE 端点截住字节；其余认证、查询、写入和静态资源不设测试屏障。
    const target = new URL(incoming.url ?? '/', upstream), isEvents = incoming.method === 'GET' && target.pathname === eventsPath
    const request = requestHttp(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } }, (
      /* 真正上游返回的响应头、状态和字节流。 */ response,
    ) => {
      if (outgoing.destroyed || response.statusCode === undefined) { response.destroy(); outgoing.destroy(); return }
      outgoing.writeHead(response.statusCode, response.headers)
      if (!isEvents || response.statusCode !== 200) {
        response.on('error', () => { /* 上游失败只结束运输，不制造业务结果。 */ outgoing.destroy() })
        response.pipe(outgoing)
        return
      }
      outgoing.flushHeaders()
      const connection = ++connections
      const channel: Channel = { response: outgoing, upstream: response, frames: [], pending: Buffer.alloc(0), released: 0, active: true }
      channels.set(connection, channel)
      response.on('data', (/* 上游实际送达的一块 SSE 字节。 */ chunk: Buffer) => {
        // 完整帧按照原连接顺序保存；读取元数据不会改变任何待交付字节。
        channel.pending = Buffer.concat([channel.pending, chunk])
        let boundary = channel.pending.indexOf('\n\n')
        while (boundary !== -1) {
          const bytes = channel.pending.subarray(0, boundary + 2)
          channel.pending = channel.pending.subarray(boundary + 2)
          const sequence = channel.frames.length + 1
          try {
            const snapshot = grantReadSnapshotFrame(bytes, connection, sequence, mapId)
            channel.frames.push({ sequence, bytes, snapshot })
            if (snapshot) notifyFrame(snapshot)
          } catch {
            streamFailed = true; response.destroy(); outgoing.destroy()
          }
          boundary = channel.pending.indexOf('\n\n')
        }
      })
      response.on('error', () => { /* 只记录固定故障标记，不输出上游错误正文。 */ if (!closed && !outgoing.destroyed) streamFailed = true; outgoing.destroy() })
      response.once('end', () => { /* 原连接结束后不能让等待改指向重连的替代流。 */ channel.active = false; outgoing.end() })
      outgoing.once('close', () => { /* 页面结束或取消后结束该原始订阅。 */ channel.active = false; response.destroy() })
    })
    requests.add(request)
    request.once('close', () => { /* 不保留已结束的本轮请求。 */ requests.delete(request) })
    request.on('error', () => { /* 将真实运输失败传给页面，不构造替代业务 JSON。 */ outgoing.destroy() })
    incoming.once('aborted', () => { /* 浏览器取消时释放本次上游运输。 */ request.destroy(); outgoing.destroy() })
    incoming.on('error', () => { /* 请求流失败时结束两端。 */ request.destroy(); outgoing.destroy() })
    outgoing.on('error', () => { /* 浏览器已结束时不保留上游调用。 */ request.destroy() })
    outgoing.once('close', () => { /* 普通 HTTP 与 SSE 都有明确的自有请求生命周期。 */ request.destroy() })
    incoming.pipe(request)
  })
  try {
    await new Promise<void>((/* 实际随机端口绑定完成。 */ resolve, /* 真实绑定错误不降级成假服务。 */ reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() })
    })
  } catch (cause) { server.closeAllConnections(); server.close(); throw cause }
  const address = server.address()
  if (!address || typeof address === 'string') { server.closeAllConnections(); server.close(); throw new Error(GrantRelayError.ADDRESS_MISSING) }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    eventsPath,
    /** 只返回已经收到的真实帧，不创建对应的业务数据。 */
    async waitForSnapshot(
      /* 对真实帧元数据的限定条件，不读取或输出正文。 */ predicate: (frame: GrantSnapshotFrame) => boolean,
    ): Promise<GrantSnapshotFrame> {
      if (closed) throw new Error(GrantRelayError.CLOSED)
      if (streamFailed) throw new Error(GrantRelayError.STREAM_FAILED)
      for (const channel of channels.values()) for (const frame of channel.frames) if (frame.snapshot && predicate(frame.snapshot)) return frame.snapshot
      return new Promise<GrantSnapshotFrame>((/* 匹配真实帧后完成等待。 */ resolve, /* 超时或结束明确失败。 */ reject) => {
        const waiter: FrameWaiter = { predicate, resolve, reject, timer: setTimeout(() => {
          // 缺失真实上游事件不能以空快照或其他连接补齐。
          waiters.delete(waiter); reject(new Error(GrantRelayError.FRAME_TIMEOUT))
        }, 10_000) }
        waiters.add(waiter)
      })
    },
    /** 严格按该连接原顺序放行到指定帧，其他后续帧仍扣住。 */
    async releaseThrough(/* 必须是该 relay 已接收的原始帧定位。 */ target: GrantSnapshotFrame): Promise<void> {
      if (closed) throw new Error(GrantRelayError.CLOSED)
      const channel = channels.get(target.connection)
      if (!channel || !channel.active) throw new Error(GrantRelayError.CHANNEL_CLOSED)
      if (!channel.frames.some((/* 当前连接内的真实原帧。 */ frame) => frame.sequence === target.sequence)) throw new Error(GrantRelayError.FRAME_MISSING)
      for (const frame of channel.frames) if (frame.sequence > channel.released && frame.sequence <= target.sequence) {
        await new Promise<void>((/* 原字节已经交给真实响应运输。 */ resolve, /* 写入失败不能当作浏览器已收到。 */ reject) => {
          channel.response.write(frame.bytes, (/* Node 对原始字节写入的真实结果。 */ error) => { if (error) reject(new Error(GrantRelayError.CHANNEL_CLOSED)); else resolve() })
        })
        channel.released = frame.sequence
      }
    },
    /** 实际结束本轮请求、原始流、等待者和监听端口，不触碰原服务。 */
    close(): Promise<void> {
      return closing ??= (async () => {
        closed = true
        for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(GrantRelayError.CLOSED)) }
        waiters.clear()
        for (const channel of channels.values()) { channel.active = false; channel.response.destroy(); channel.upstream.destroy() }
        for (const request of requests) request.destroy()
        server.closeAllConnections()
        if (server.listening) await new Promise<void>((/* 真实端口不再监听后完成关闭。 */ resolve, /* 原监听关闭失败继续使测试失败。 */ reject) => {
          server.close((/* Node 的实际关闭错误。 */ error) => { if (error) reject(error); else resolve() })
        })
      })()
    },
  }
}

/** 只观察公开 fetch reader 的读取次序，不改响应、正文、业务状态或 SSE 字节。 */
export async function grantObserveBrowserFrames(
  /* 当前用例的正常浏览器页面，在第一次导航前安装观测。 */ page: Page,
  /* 只计数本轮唯一图的 SSE 连接。 */ eventsPath: string,
) {
  const observed = new Map<number, number>(), waiters = new Set<BrowserWaiter>()
  const bindingName = '__m00GrantFrameConsumed'
  await page.exposeBinding(bindingName, (
    /* 绑定来源仅由 Playwright 持有，不输出其页面或上下文对象。 */ _source,
    /* 浏览器只允许回传连接和完整帧计数两个整数。 */ input: unknown,
  ) => {
    const value = input as { connection?: unknown; frames?: unknown }
    if (!value || typeof value.connection !== 'number' || !Number.isSafeInteger(value.connection) || value.connection < 1
      || typeof value.frames !== 'number' || !Number.isSafeInteger(value.frames) || value.frames < 1) return
    observed.set(value.connection, Math.max(observed.get(value.connection) ?? 0, value.frames))
    for (const waiter of [...waiters]) if (waiter.connection === value.connection && value.frames >= waiter.sequence) {
      clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve()
    }
  })
  await page.addInitScript((/* 当前唯一流路径及固定只读观测绑定名。 */ options: { eventsPath: string; bindingName: string }) => {
    // 应用在处理完本次 read 返回块之后才会再次调用 read；此处仅观察这一公开消费边界。
    const originalFetch = window.fetch.bind(window)
    let connections = 0
    window.fetch = async (
      /* 原始正常 fetch 输入，不改变请求地址或凭据。 */ input: RequestInfo | URL,
      /* 原始请求选项，不添加或删除任何字段。 */ init?: RequestInit,
    ): Promise<Response> => {
      const response = await originalFetch(input, init)
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, window.location.href)
      if (url.pathname !== options.eventsPath || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) return response
      const connection = ++connections, body = response.body, getReader = body.getReader.bind(body)
      Object.defineProperty(body, 'getReader', { configurable: true, value: (/* 其他 reader 模式仍原样交给浏览器。 */ readerOptions?: ReadableStreamGetReaderOptions) => {
        if (readerOptions !== undefined) return Reflect.apply(getReader, body, [readerOptions])
        const reader = getReader(), read = reader.read.bind(reader)
        let frames = 0, acknowledged = 0, previousLf = false
        Object.defineProperty(reader, 'read', { configurable: true, value: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
          // 下一次 read 是前一块已由真实消费循环处理的证据，而非 pull 预取或运输 write 回调。
          if (frames > acknowledged) {
            acknowledged = frames
            const notify = Reflect.get(window, options.bindingName) as unknown
            if (typeof notify === 'function') void (notify as (value: { connection: number; frames: number }) => Promise<void>)({ connection, frames }).catch(() => {})
          }
          const result = await read()
          if (!result.done) for (const byte of result.value) { if (byte === 10 && previousLf) frames++; previousLf = byte === 10 }
          return result
        } })
        return reader
      } })
      return response
    }
  }, { eventsPath, bindingName })
  return {
    /** 等待浏览器实际处理到本连接的原始帧，不依赖是否触发了 branch.get。 */
    async waitForProcessed(/* relay 中真实收到并放行的目标帧。 */ frame: GrantSnapshotFrame): Promise<void> {
      if ((observed.get(frame.connection) ?? 0) >= frame.sequence) return
      await new Promise<void>((/* 原帧已被消费循环处理时完成。 */ resolve, /* 没有明确处理证据就失败。 */ reject) => {
        const waiter: BrowserWaiter = { connection: frame.connection, sequence: frame.sequence, resolve, reject,
          timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(GrantRelayError.READ_TIMEOUT)) }, 10_000) }
        waiters.add(waiter)
      })
    },
    /** 只结束本轮尚未完成的读取观测与计时器。 */
    dispose(): void {
      for (const waiter of waiters) { clearTimeout(waiter.timer); waiter.reject(new Error(GrantRelayError.CLOSED)) }
      waiters.clear()
    },
  }
}
