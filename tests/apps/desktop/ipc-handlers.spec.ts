// 验证桌面 IPC 的框架权限、调用取消、文件配额、错误脱敏和渲染器订阅隔离。
import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { clientAssertSender, clientRegisterIpc } from '../../../apps/desktop/ipc-handlers'
import { CLIENT_CHANNELS } from '../../../apps/desktop/ipc-channels'
import { ClientError, type ClientBridge, type ClientBridgeResult, type ClientGateway } from '../../../contracts/client'
import { apiCreateGateway } from '../../../apps/ui/transport/client-gateway'
import type { GraphStreamEvent } from '../../../contracts/events'
import type { DiagnosticReporter } from '../../../contracts/diagnostics'

const callId = '11111111-1111-4111-8111-111111111111'
function fixture() {
  // 建立内存 IPC、可信主框架和网关替身，暴露处理器及调用记录供权限测试。
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = Object.assign(new EventEmitter(), {
    /**
     * 将 IPC 请求处理器记录到映射，供测试直接调用。
     *
     * @param channel 需要注册的 IPC 通道名，作为内存处理器映射键。
     * @param handler 被测主进程注册的通道回调，保存在夹具中供测试直接调用。
     */
    handle: (channel: string, handler: (...args: any[]) => any) => {
       handlers.set(channel, handler) },
    /**
     * 删除指定通道处理器以验证卸载行为。
     *
     * @param channel 需要卸载的通道名，用于验证 dispose 移除注册。
     */
    removeHandler: (channel: string) => {
       handlers.delete(channel) },
  })
  const frame = { routingId: 12, processId: 34, url: 'http://localhost:5173/' }
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => /* 模拟窗口尚未被销毁。 */  false, send: vi.fn() }) as unknown as WebContents
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const read = vi.fn(async () => /* 返回固定查询结果并记录网关调用。 */  ({ id: 'response' }))
  const gateway = { connectLocal: vi.fn(async () => /* 模拟本地连接成功后返回本机用户身份。 */  ({ identity: { userId: 'local' } })), getConnection: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), watch: vi.fn(), read, dispatch: vi.fn(), upload: vi.fn(), download: vi.fn() } as unknown as ClientGateway
  const report = vi.fn(() => /* 返回固定诊断编号以核对渲染器错误关联。 */  callId)
  const diagnostics = { report, close: async () => {
    // 模拟没有输出资源需要清理的诊断器关闭。
    } } as DiagnosticReporter
  const dispose = clientRegisterIpc({ ipc: ipc as unknown as IpcMain, gateway, diagnostics, rendererUrl: frame.url, contents: () => /* 提供夹具的当前可信窗口内容。 */  contents })
  return { ipc, handlers, frame, contents, event, read, gateway, report, dispose }
}

describe('desktop client IPC authority', () => {
  // 组织主进程 IPC 的权限、流转发、取消与资源限制场景。
  it('only starts the local service for the trusted main frame and exposes no credentials', async () => {
    // 验证只有可信主框架能启动本地服务，状态响应不包含连接凭据。
    const f = fixture()
    expect(await f.handlers.get(CLIENT_CHANNELS.connectLocal)!(f.event)).toMatchObject({ ok: true, value: { identity: { userId: 'local' } } })
    expect(await f.handlers.get(CLIENT_CHANNELS.localState)!(f.event)).toEqual({ ok: true, value: { status: 'stopped' } })
    f.frame.url = 'https://untrusted.example'
    expect(await f.handlers.get(CLIENT_CHANNELS.connectLocal)!(f.event)).toMatchObject({ ok: false, error: { code: 'IPC_FORBIDDEN' } })
    expect(f.gateway.connectLocal).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('accepts only fixed, credential-free renderer diagnostics from the trusted frame', () => {
    // 验证诊断仅接受可信框架的固定字段，拒绝附加消息和外部页面。
    const f = fixture()
    f.ipc.emit(CLIENT_CHANNELS.diagnostic, f.event, { errorId: callId, source: 'vue' })
    expect(f.report).toHaveBeenCalledWith(expect.objectContaining({ name: 'renderer.failed', errorId: callId, context: { reason: 'vue' } }))
    f.ipc.emit(CLIENT_CHANNELS.diagnostic, f.event, { errorId: callId, source: 'vue', message: 'secret' })
    f.frame.url = 'https://untrusted.example'
    f.ipc.emit(CLIENT_CHANNELS.diagnostic, f.event, { errorId: callId, source: 'promise' })
    expect(f.report).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('forwards ordered stream events only while the authorized watch remains active', async () => {
    // 验证合法订阅按序转发事件，非法取消无效且已取消订阅不再发消息。
    const f = fixture()
    /**
     * @param event 测试手动发出的图事件，交给被保存的网关订阅回调。
     */
    let emit!: (event: GraphStreamEvent) => void, signal!: AbortSignal, finish!: () => void
    vi.mocked(f.gateway.watch).mockImplementation((_mapId, onEvent, stop) => {
      // 保存订阅回调和信号，并延迟结束以便手动模拟流事件。
      emit = onEvent; signal = stop!
      return new Promise<void>(resolve => {
        // 把订阅完成函数交给测试，控制何时结束主进程处理。
         finish = resolve })
    })
    expect(await f.handlers.get(CLIENT_CHANNELS.watch)!(f.event, callId, 'http://private.example/map')).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(f.gateway.watch).not.toHaveBeenCalled()
    const watching = f.handlers.get(CLIENT_CHANNELS.watch)!(f.event, callId, callId)
    const event: GraphStreamEvent = { type: 'refresh', scope: 'workspace' }
    emit(event); emit({ type: 'refresh', scope: 'settings' })
    expect(f.contents.send).toHaveBeenNthCalledWith(1, CLIENT_CHANNELS.stream, { watchId: callId, sequence: 1, event })
    expect(f.contents.send).toHaveBeenNthCalledWith(2, CLIENT_CHANNELS.stream, { watchId: callId, sequence: 2, event: { type: 'refresh', scope: 'settings' } })
    f.ipc.emit(CLIENT_CHANNELS.cancel, { ...f.event, senderFrame: { ...f.frame, routingId: 99 } }, callId)
    expect(signal.aborted).toBe(false)
    f.ipc.emit(CLIENT_CHANNELS.cancel, f.event, callId)
    expect(signal.aborted).toBe(true)
    emit(event)
    expect(f.contents.send).toHaveBeenCalledTimes(2)
    finish()
    expect(await watching).toEqual({ ok: true, value: null })
    f.dispose()
  })

  it('aborts a window stream together with files and preserves the two-file limit', async () => {
    // 验证窗口销毁会同时取消订阅与文件传输，订阅不占用两个文件配额。
    const f = fixture()
    /**
     * @param signal 可选类型的操作取消信号，本用例始终传入并借此结束挂起操作。
     */
    const wait = (signal?: AbortSignal) => /* 创建只有收到取消信号才失败的操作，模拟持续流或未完成下载。 */  new Promise<never>((_resolve, reject) => /* 注册取消监听，让挂起操作保持未完成直到窗口关闭。 */  signal!.addEventListener('abort', () => /* 取消时以结构化客户端错误拒绝挂起操作。 */  reject(new ClientError({ status: 0, code: 'REQUEST_ABORTED', message: 'Closed', retryable: false })), { once: true }))
    vi.mocked(f.gateway.watch).mockImplementation((_mapId, _emit, signal) => /* 使模拟订阅等待同一个取消信号。 */  wait(signal))
    vi.mocked(f.gateway.download).mockImplementation((_input, signal) => /* 使模拟下载等待同一个取消信号。 */  wait(signal))
    const watching = f.handlers.get(CLIENT_CHANNELS.watch)!(f.event, callId, callId)
    const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
    const files = ids.slice(0, 2).map(id => /* 为两个不同调用编号发起资产下载，填满文件配额。 */  f.handlers.get(CLIENT_CHANNELS.download)!(f.event, id, { kind: 'asset', id: callId }))
    expect(await f.handlers.get(CLIENT_CHANNELS.download)!(f.event, ids[2], { kind: 'asset', id: callId })).toMatchObject({ ok: false, error: { code: 'TOO_MANY_REQUESTS' } })
    f.contents.emit('destroyed')
    for (const result of await Promise.all([watching, ...files])) expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    expect(f.contents.send).not.toHaveBeenCalled()
    f.dispose()
    expect(f.handlers.has(CLIENT_CHANNELS.watch)).toBe(false)
  })

  it('rejects foreign watch frames and handles cancellation before subscription', async () => {
    // 验证外部框架不能订阅，且提前到达的取消会阻止网关调用。
    const f = fixture()
    expect(await f.handlers.get(CLIENT_CHANNELS.watch)!({ ...f.event, senderFrame: { ...f.frame, routingId: 99 } }, callId, callId)).toMatchObject({ ok: false, error: { code: 'IPC_FORBIDDEN' } })
    f.ipc.emit(CLIENT_CHANNELS.cancel, f.event, callId)
    expect(await f.handlers.get(CLIENT_CHANNELS.watch)!(f.event, callId, callId)).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    expect(f.gateway.watch).not.toHaveBeenCalled()
    f.dispose()
  })

  it('keeps file transfers on fixed resource and byte contracts behind the main-frame check', async () => {
    // 验证文件传输仅接受固定资源结构、合法文件名与可信框架。
    const f = fixture(), input = { workspaceId: callId, filename: 'source.txt', mediaType: 'text/plain', bytes: new Uint8Array([1, 2, 3]) }
    expect(await f.handlers.get(CLIENT_CHANNELS.upload)!(f.event, callId, callId, input)).toMatchObject({ ok: true })
    expect(f.gateway.upload).toHaveBeenCalledWith(callId, input, expect.any(AbortSignal))
    expect(await f.handlers.get(CLIENT_CHANNELS.download)!(f.event, callId, { kind: 'asset', id: callId })).toMatchObject({ ok: true })
    expect(f.gateway.download).toHaveBeenCalledWith({ kind: 'asset', id: callId }, expect.any(AbortSignal))
    expect(await f.handlers.get(CLIENT_CHANNELS.download)!(f.event, callId, { kind: 'asset', id: callId, url: 'http://127.0.0.1/private' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(await f.handlers.get(CLIENT_CHANNELS.upload)!({ ...f.event, senderFrame: { ...f.frame, routingId: 99 } }, callId, callId, input)).toMatchObject({ ok: false, error: { code: 'IPC_FORBIDDEN' } })
    expect(await f.handlers.get(CLIENT_CHANNELS.upload)!(f.event, callId, callId, { ...input, filename: '/tmp/secret' })).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } })
    expect(f.gateway.upload).toHaveBeenCalledTimes(1); expect(f.gateway.download).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('bounds file concurrency and aborts pending transfers when the window closes', async () => {
    // 验证第三项文件传输被拒绝，窗口关闭后两项挂起传输均被取消。
    const f = fixture()
    vi.mocked(f.gateway.download).mockImplementation(async (_input, signal) => /* 模拟在取消前始终挂起的下载。 */  new Promise((_resolve, reject) => {
      // 监听下载的取消信号，以便检查窗口销毁是否向下传递。
      signal!.addEventListener('abort', () => /* 收到取消时拒绝下载 Promise。 */  reject(new ClientError({ code: 'REQUEST_ABORTED', message: 'Closed', status: 0, retryable: false })), { once: true })
    }))
    const ids = [callId, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
    const pending = ids.slice(0, 2).map(id => /* 并行发起两项图导出下载，占满文件传输配额。 */  f.handlers.get(CLIENT_CHANNELS.download)!(f.event, id, { kind: 'map', id: callId }))
    expect(await f.handlers.get(CLIENT_CHANNELS.download)!(f.event, ids[2], { kind: 'map', id: callId })).toMatchObject({ ok: false, error: { code: 'TOO_MANY_REQUESTS' } })
    f.contents.emit('destroyed')
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    f.dispose(); expect(f.handlers.size).toBe(0)
  })
  it('dispatches persistent pause and resume through the public command channel', async () => {
    // 验证暂停和恢复通过公开写命令通道传给网关。
    const f = fixture()
    const params = { mapId: 'map', runId: 'run', control: { leaseId: callId,
      holderId: '22222222-2222-4222-8222-222222222222', fence: 1 } }
    for (const method of ['run.pause', 'run.resume']) {
      const result = await f.handlers.get(CLIENT_CHANNELS.dispatch)!(f.event, callId, callId, method, params)
      expect(result.ok).toBe(true)
      expect(f.gateway.dispatch).toHaveBeenLastCalledWith(callId, method, params, expect.any(AbortSignal))
    }
    f.dispose()
  })

  it('accepts only the known window main frame and its application URL', () => {
    // 验证窗口、进程、框架及应用来源必须同时匹配，文件来源允许页面片段。
    const f = fixture()
    expect(() => /* 校验夹具中的可信主框架，预期允许访问。 */  clientAssertSender(f.event, f.contents, f.frame.url)).not.toThrow()
    for (const senderFrame of [
      { ...f.frame, routingId: 99 }, { ...f.frame, processId: 999 }, { ...f.frame, url: 'https://untrusted.example/' },
      { ...f.frame, url: 'blob:http://localhost:5173/untrusted' },
    ]) {
      expect(() => /* 校验替换后的框架或来源，预期拒绝访问。 */  clientAssertSender({ ...f.event, senderFrame } as unknown as IpcMainInvokeEvent, f.contents, f.frame.url)).toThrow('frame')
    }
    expect(() => /* 校验来自其他窗口对象的调用，预期拒绝访问。 */  clientAssertSender({ ...f.event, sender: {} } as IpcMainInvokeEvent, f.contents, f.frame.url)).toThrow()
    const local = { ...f.frame, url: 'file:///app/dist/index.html#/workspace' }
    expect(() => /* 校验同一应用文件带路由片段的 URL，预期允许访问。 */  clientAssertSender({ ...f.event, senderFrame: local } as unknown as IpcMainInvokeEvent, f.contents, 'file:///app/dist/index.html')).not.toThrow()
    expect(() => /* 校验其他本机 HTML 文件，预期拒绝访问。 */  clientAssertSender({ ...f.event, senderFrame: { ...local, url: 'file:///private/other.html' } } as unknown as IpcMainInvokeEvent, f.contents, 'file:///app/dist/index.html')).toThrow()
    f.dispose()
  })

  it('rejects unknown old-backend methods before invoking the network gateway', async () => {
    // 验证旧后端方法和外部框架在网络网关调用前就被拒绝。
    const f = fixture()
    const result = await f.handlers.get(CLIENT_CHANNELS.read)!(f.event, callId, 'db.getSettings', {})
    expect(result).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } })
    expect(f.read).not.toHaveBeenCalled()
    const foreign = { ...f.event, senderFrame: { ...f.frame, routingId: 99 } }
    expect(await f.handlers.get(CLIENT_CHANNELS.read)!(foreign, callId, 'map.get', { mapId: 'map' })).toMatchObject({ ok: false, error: { code: 'IPC_FORBIDDEN' } })
    expect(f.read).not.toHaveBeenCalled()
    f.dispose()
  })

  it('does not expose unexpected Main errors or local paths to the Renderer', async () => {
    // 验证主进程未知异常只返回通用错误及诊断编号，不暴露令牌或本机路径。
    const f = fixture()
    f.read.mockRejectedValueOnce(new Error('private-token at /Users/private/source.ts'))
    const result = await f.handlers.get(CLIENT_CHANNELS.read)!(f.event, callId, 'map.get', { mapId: callId })
    expect(result).toMatchObject({ ok: false, error: { code: 'CLIENT_ERROR', message: '客户端内部错误', errorId: expect.any(String) } })
    expect(JSON.stringify(result)).not.toMatch(/private-token|\/Users\/private/)
    f.dispose()
  })

  it('cancels only the owning frame call and handles cancellation before invoke', async () => {
    // 验证只有所属可信框架可以取消，且 invoke 之前到达的取消不会漏掉。
    const f = fixture()
    f.read.mockImplementation((...args: unknown[]) => /* 让查询保持挂起，直到收到所属调用的取消信号。 */  new Promise((_resolve, reject) => {
      // 提取查询的取消信号并监听其变化。
      const signal = args[2] as AbortSignal
      signal.addEventListener('abort', () => /* 收到取消时将挂起查询转换为结构化取消错误。 */  reject(new ClientError({ code: 'REQUEST_ABORTED', message: 'Stopped', status: 0, retryable: false })), { once: true })
    }))
    const pending = f.handlers.get(CLIENT_CHANNELS.read)!(f.event, callId, 'map.get', { mapId: 'map' })
    f.ipc.emit(CLIENT_CHANNELS.cancel, { ...f.event, senderFrame: { ...f.frame, routingId: 99 } }, callId)
    const signal = (f.read.mock.calls[0] as unknown[])[2] as AbortSignal
    expect(signal.aborted).toBe(false)
    f.ipc.emit(CLIENT_CHANNELS.cancel, f.event, callId)
    expect(await pending).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    const early = '22222222-2222-4222-8222-222222222222'
    f.ipc.emit(CLIENT_CHANNELS.cancel, f.event, early)
    expect(await f.handlers.get(CLIENT_CHANNELS.read)!(f.event, early, 'map.get', { mapId: 'map' })).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    expect(f.read).toHaveBeenCalledTimes(1)
    f.dispose()
    expect(f.handlers.size).toBe(0)
  })

  it('serializes conflict details through IPC instead of losing them in Error.message', async () => {
    // 验证版本冲突的状态码与当前版本通过 IPC 保留，而非仅剩错误消息。
    const f = fixture()
    f.read.mockRejectedValueOnce(new ClientError({ code: 'REVISION_CONFLICT', message: 'Changed', status: 409, retryable: false, currentRevision: 12 }))
    expect(await f.handlers.get(CLIENT_CHANNELS.read)!(f.event, callId, 'map.get', { mapId: 'map' })).toMatchObject({
      ok: false, error: { code: 'REVISION_CONFLICT', status: 409, retryable: false, currentRevision: 12 },
    })
    f.dispose()
  })

  it('registers one destroy listener per window and aborts all its pending calls', async () => {
    // 验证同一窗口只注册一个销毁监听，销毁会取消其全部挂起调用。
    const f = fixture()
    f.read.mockImplementation((...args: unknown[]) => /* 模拟未完成查询，供窗口整体取消测试使用。 */  new Promise((_resolve, reject) => {
      // 监听查询取消，以验证窗口销毁会终止全部请求。
      const signal = args[2] as AbortSignal
      signal.addEventListener('abort', () => /* 窗口关闭时拒绝当前查询并标记取消原因。 */  reject(new ClientError({ code: 'REQUEST_ABORTED', message: 'Window closed', status: 0, retryable: false })), { once: true })
    }))
    const secondId = '22222222-2222-4222-8222-222222222222'
    const requests = [callId, secondId].map(id => /* 为同一窗口的两个调用编号分别发起查询。 */  f.handlers.get(CLIENT_CHANNELS.read)!(f.event, id, 'map.get', { mapId: 'map' }))
    expect(f.contents.listenerCount('destroyed')).toBe(1)
    f.contents.emit('destroyed')
    for (const result of await Promise.all(requests)) expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    expect(f.contents.listenerCount('destroyed')).toBe(0)
    f.dispose()
  })
})

describe('Renderer bridge adapter', () => {
  // 组织渲染器桥接的先监听后调用、序号检查及本地取消场景。
  it('listens before invoking and isolates ordered first frames by watch ID', async () => {
    // 验证订阅调用前已经监听消息，并按订阅编号隔离首次及后续事件。
    type Message = Parameters<Parameters<ClientBridge['onStream']>[0]>[0]
    const listeners = new Set<(message: Message) => void>()
    const finish: Array<() => void> = [], ids: string[] = []
    const onStream = vi.fn((listener: (message: Message) => void) => {
      // 登记模拟流监听器并返回对应解除函数。
       listeners.add(listener); return () => /* 从监听集合中删除本次订阅回调。 */  listeners.delete(listener) })
    const watch = vi.fn((watchId: string, mapId: string) => {
      // 在 watch 调用期间立即发布首帧，验证适配器不会漏掉同步到达的消息。
      expect(listeners.size).toBeGreaterThan(0)
      ids.push(watchId)
      const event: GraphStreamEvent = { type: 'snapshot', snapshot: { mapId, workspaceId: 'workspace', revision: 1, name: mapId, nodes: [], edges: [], runs: [], ownershipRevision: 0, ownerships: [], runControls: [], updatedAt: '' } }
      for (const listener of listeners) listener({ watchId, sequence: 1, event })
      return new Promise<ClientBridgeResult<null>>(resolve => /* 保存手动完成订阅的函数，使测试能分别结束两条流。 */  finish.push(() => /* 将该条模拟订阅标记为正常完成。 */  resolve({ ok: true, value: null })))
    })
    const cancel = vi.fn(), gateway = apiCreateGateway({ bridge: { onStream, watch, cancel } as unknown as ClientBridge })
    const first = vi.fn(), second = vi.fn()
    const a = gateway.watch('map-a', first), b = gateway.watch('map-b', second)
    await Promise.resolve()
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot', snapshot: expect.objectContaining({ mapId: 'map-a' }) }))
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot', snapshot: expect.objectContaining({ mapId: 'map-b' }) }))
    expect(watch.mock.calls.every(call => /* 检查桥接订阅只传递订阅编号和图编号。 */  call.length === 2)).toBe(true)
    finish[0](); await a
    for (const listener of listeners) {
      listener({ watchId: ids[0], sequence: 2, event: { type: 'refresh', scope: 'settings' } })
      listener({ watchId: ids[1], sequence: 2, event: { type: 'refresh', scope: 'settings' } })
    }
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledTimes(2)
    finish[1](); await b
    expect(listeners.size).toBe(0)
    expect(cancel).not.toHaveBeenCalled()
  })

  it('cancels broken stream sequences and removes listeners on caller abort', async () => {
    // 验证序号跳跃触发取消，调用者中止会卸载监听并丢弃迟到事件。
    type Message = Parameters<Parameters<ClientBridge['onStream']>[0]>[0]
    /**
     * @param message 用于序号异常测试的流消息负载。
     */
    let listener!: (message: Message) => void, id = ''
    const dispose = vi.fn(), cancel = vi.fn()
    const bridge = { onStream: vi.fn((next: typeof listener) => {
      // 保存当前流监听器，并提供可观察的卸载函数。
       listener = next; return dispose }), watch: vi.fn((watchId: string) => {
      // 记录订阅编号并保持调用挂起，供异常序号与取消测试使用。
       id = watchId; return new Promise<never>(() => {
      // 故意不结束模拟订阅，使适配器必须主动处理取消。
      }) }), cancel } as unknown as ClientBridge
    const gateway = apiCreateGateway({ bridge })
    const seen = vi.fn(), broken = gateway.watch('map', seen)
    await Promise.resolve()
    listener({ watchId: id, sequence: 2, event: { type: 'refresh', scope: 'workspace' } })
    await expect(broken).rejects.toMatchObject({ code: 'STREAM_SEQUENCE', retryable: true })
    expect(cancel).toHaveBeenCalledWith(id)
    expect(dispose).toHaveBeenCalledOnce()
    expect(seen).not.toHaveBeenCalled()
    const controller = new AbortController(), pending = gateway.watch('map', seen, controller.signal)
    await Promise.resolve()
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(dispose).toHaveBeenCalledTimes(2)
    listener({ watchId: id, sequence: 1, event: { type: 'refresh', scope: 'workspace' } })
    expect(seen).not.toHaveBeenCalled()
  })

  it('keeps AbortSignal local and cancels by an opaque call ID', async () => {
    // 验证 AbortSignal 保留在渲染器中，只通过不透明调用编号向主进程取消。
    const read = vi.fn(() => /* 模拟一直未完成的桥接查询以观察本地取消行为。 */  new Promise<never>(() => {
      // 保持模拟查询未完成，迫使适配器通过取消竞态结束请求。
      }))
    const cancel = vi.fn()
    const bridge = { read, cancel } as unknown as ClientBridge
    const gateway = apiCreateGateway({ bridge })
    const stop = new AbortController()
    const pending = gateway.read('map.get', { mapId: 'map' }, stop.signal)
    await Promise.resolve()
    expect(read).toHaveBeenCalledTimes(1)
    const [id, method, params] = read.mock.calls[0] as unknown[]
    expect(typeof id).toBe('string')
    expect(method).toBe('map.get')
    expect(params).toEqual({ mapId: 'map' })
    expect(read.mock.calls[0]).toHaveLength(3)
    stop.abort()
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_ABORTED' })
    expect(cancel).toHaveBeenCalledWith(id)
  })
})
