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
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = Object.assign(new EventEmitter(), {
    handle: (channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler) },
    removeHandler: (channel: string) => { handlers.delete(channel) },
  })
  const frame = { routingId: 12, processId: 34, url: 'http://localhost:5173/' }
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false, send: vi.fn() }) as unknown as WebContents
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const read = vi.fn(async () => ({ id: 'response' }))
  const gateway = { connectLocal: vi.fn(async () => ({ identity: { userId: 'local' } })), getConnection: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), watch: vi.fn(), read, dispatch: vi.fn(), upload: vi.fn(), download: vi.fn() } as unknown as ClientGateway
  const report = vi.fn(() => callId)
  const diagnostics = { report, close: async () => {} } as DiagnosticReporter
  const dispose = clientRegisterIpc({ ipc: ipc as unknown as IpcMain, gateway, diagnostics, rendererUrl: frame.url, contents: () => contents })
  return { ipc, handlers, frame, contents, event, read, gateway, report, dispose }
}

describe('desktop client IPC authority', () => {
  it('only starts the local service for the trusted main frame and exposes no credentials', async () => {
    const f = fixture()
    expect(await f.handlers.get(CLIENT_CHANNELS.connectLocal)!(f.event)).toMatchObject({ ok: true, value: { identity: { userId: 'local' } } })
    expect(await f.handlers.get(CLIENT_CHANNELS.localState)!(f.event)).toEqual({ ok: true, value: { status: 'stopped' } })
    f.frame.url = 'https://untrusted.example'
    expect(await f.handlers.get(CLIENT_CHANNELS.connectLocal)!(f.event)).toMatchObject({ ok: false, error: { code: 'IPC_FORBIDDEN' } })
    expect(f.gateway.connectLocal).toHaveBeenCalledTimes(1)
    f.dispose()
  })

  it('accepts only fixed, credential-free renderer diagnostics from the trusted frame', () => {
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
    const f = fixture()
    let emit!: (event: GraphStreamEvent) => void, signal!: AbortSignal, finish!: () => void
    vi.mocked(f.gateway.watch).mockImplementation((_mapId, onEvent, stop) => {
      emit = onEvent; signal = stop!
      return new Promise<void>(resolve => { finish = resolve })
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
    const f = fixture()
    const wait = (signal?: AbortSignal) => new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(new ClientError({ status: 0, code: 'REQUEST_ABORTED', message: 'Closed', retryable: false })), { once: true }))
    vi.mocked(f.gateway.watch).mockImplementation((_mapId, _emit, signal) => wait(signal))
    vi.mocked(f.gateway.download).mockImplementation((_input, signal) => wait(signal))
    const watching = f.handlers.get(CLIENT_CHANNELS.watch)!(f.event, callId, callId)
    const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
    const files = ids.slice(0, 2).map(id => f.handlers.get(CLIENT_CHANNELS.download)!(f.event, id, { kind: 'asset', id: callId }))
    expect(await f.handlers.get(CLIENT_CHANNELS.download)!(f.event, ids[2], { kind: 'asset', id: callId })).toMatchObject({ ok: false, error: { code: 'TOO_MANY_REQUESTS' } })
    f.contents.emit('destroyed')
    for (const result of await Promise.all([watching, ...files])) expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    expect(f.contents.send).not.toHaveBeenCalled()
    f.dispose()
    expect(f.handlers.has(CLIENT_CHANNELS.watch)).toBe(false)
  })

  it('rejects foreign watch frames and handles cancellation before subscription', async () => {
    const f = fixture()
    expect(await f.handlers.get(CLIENT_CHANNELS.watch)!({ ...f.event, senderFrame: { ...f.frame, routingId: 99 } }, callId, callId)).toMatchObject({ ok: false, error: { code: 'IPC_FORBIDDEN' } })
    f.ipc.emit(CLIENT_CHANNELS.cancel, f.event, callId)
    expect(await f.handlers.get(CLIENT_CHANNELS.watch)!(f.event, callId, callId)).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    expect(f.gateway.watch).not.toHaveBeenCalled()
    f.dispose()
  })

  it('keeps file transfers on fixed resource and byte contracts behind the main-frame check', async () => {
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
    const f = fixture()
    vi.mocked(f.gateway.download).mockImplementation(async (_input, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new ClientError({ code: 'REQUEST_ABORTED', message: 'Closed', status: 0, retryable: false })), { once: true })
    }))
    const ids = [callId, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']
    const pending = ids.slice(0, 2).map(id => f.handlers.get(CLIENT_CHANNELS.download)!(f.event, id, { kind: 'map', id: callId }))
    expect(await f.handlers.get(CLIENT_CHANNELS.download)!(f.event, ids[2], { kind: 'map', id: callId })).toMatchObject({ ok: false, error: { code: 'TOO_MANY_REQUESTS' } })
    f.contents.emit('destroyed')
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    f.dispose(); expect(f.handlers.size).toBe(0)
  })
  it('dispatches persistent pause and resume through the public command channel', async () => {
    const f = fixture()
    const params = { mapId: 'map', expectedRevision: 2, runId: 'run' }
    for (const method of ['run.pause', 'run.resume']) {
      const result = await f.handlers.get(CLIENT_CHANNELS.dispatch)!(f.event, callId, callId, method, params)
      expect(result.ok).toBe(true)
      expect(f.gateway.dispatch).toHaveBeenLastCalledWith(callId, method, params, expect.any(AbortSignal))
    }
    f.dispose()
  })

  it('accepts only the known window main frame and its application URL', () => {
    const f = fixture()
    expect(() => clientAssertSender(f.event, f.contents, f.frame.url)).not.toThrow()
    for (const senderFrame of [
      { ...f.frame, routingId: 99 }, { ...f.frame, processId: 999 }, { ...f.frame, url: 'https://untrusted.example/' },
      { ...f.frame, url: 'blob:http://localhost:5173/untrusted' },
    ]) {
      expect(() => clientAssertSender({ ...f.event, senderFrame } as unknown as IpcMainInvokeEvent, f.contents, f.frame.url)).toThrow('frame')
    }
    expect(() => clientAssertSender({ ...f.event, sender: {} } as IpcMainInvokeEvent, f.contents, f.frame.url)).toThrow()
    const local = { ...f.frame, url: 'file:///app/dist/index.html#/workspace' }
    expect(() => clientAssertSender({ ...f.event, senderFrame: local } as unknown as IpcMainInvokeEvent, f.contents, 'file:///app/dist/index.html')).not.toThrow()
    expect(() => clientAssertSender({ ...f.event, senderFrame: { ...local, url: 'file:///private/other.html' } } as unknown as IpcMainInvokeEvent, f.contents, 'file:///app/dist/index.html')).toThrow()
    f.dispose()
  })

  it('rejects unknown old-backend methods before invoking the network gateway', async () => {
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
    const f = fixture()
    f.read.mockRejectedValueOnce(new Error('private-token at /Users/private/source.ts'))
    const result = await f.handlers.get(CLIENT_CHANNELS.read)!(f.event, callId, 'map.get', { mapId: callId })
    expect(result).toMatchObject({ ok: false, error: { code: 'CLIENT_ERROR', message: '客户端内部错误', errorId: expect.any(String) } })
    expect(JSON.stringify(result)).not.toMatch(/private-token|\/Users\/private/)
    f.dispose()
  })

  it('cancels only the owning frame call and handles cancellation before invoke', async () => {
    const f = fixture()
    f.read.mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = args[2] as AbortSignal
      signal.addEventListener('abort', () => reject(new ClientError({ code: 'REQUEST_ABORTED', message: 'Stopped', status: 0, retryable: false })), { once: true })
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
    const f = fixture()
    f.read.mockRejectedValueOnce(new ClientError({ code: 'REVISION_CONFLICT', message: 'Changed', status: 409, retryable: false, currentRevision: 12 }))
    expect(await f.handlers.get(CLIENT_CHANNELS.read)!(f.event, callId, 'map.get', { mapId: 'map' })).toMatchObject({
      ok: false, error: { code: 'REVISION_CONFLICT', status: 409, retryable: false, currentRevision: 12 },
    })
    f.dispose()
  })

  it('registers one destroy listener per window and aborts all its pending calls', async () => {
    const f = fixture()
    f.read.mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = args[2] as AbortSignal
      signal.addEventListener('abort', () => reject(new ClientError({ code: 'REQUEST_ABORTED', message: 'Window closed', status: 0, retryable: false })), { once: true })
    }))
    const secondId = '22222222-2222-4222-8222-222222222222'
    const requests = [callId, secondId].map(id => f.handlers.get(CLIENT_CHANNELS.read)!(f.event, id, 'map.get', { mapId: 'map' }))
    expect(f.contents.listenerCount('destroyed')).toBe(1)
    f.contents.emit('destroyed')
    for (const result of await Promise.all(requests)) expect(result).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } })
    expect(f.contents.listenerCount('destroyed')).toBe(0)
    f.dispose()
  })
})

describe('Renderer bridge adapter', () => {
  it('listens before invoking and isolates ordered first frames by watch ID', async () => {
    type Message = Parameters<Parameters<ClientBridge['onStream']>[0]>[0]
    const listeners = new Set<(message: Message) => void>()
    const finish: Array<() => void> = [], ids: string[] = []
    const onStream = vi.fn((listener: (message: Message) => void) => { listeners.add(listener); return () => listeners.delete(listener) })
    const watch = vi.fn((watchId: string, mapId: string) => {
      expect(listeners.size).toBeGreaterThan(0)
      ids.push(watchId)
      const event: GraphStreamEvent = { type: 'snapshot', snapshot: { mapId, workspaceId: 'workspace', revision: 1, name: mapId, nodes: [], edges: [], run: null, updatedAt: '' } }
      for (const listener of listeners) listener({ watchId, sequence: 1, event })
      return new Promise<ClientBridgeResult<null>>(resolve => finish.push(() => resolve({ ok: true, value: null })))
    })
    const cancel = vi.fn(), gateway = apiCreateGateway({ bridge: { onStream, watch, cancel } as unknown as ClientBridge })
    const first = vi.fn(), second = vi.fn()
    const a = gateway.watch('map-a', first), b = gateway.watch('map-b', second)
    await Promise.resolve()
    expect(first).toHaveBeenCalledOnce(); expect(second).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot', snapshot: expect.objectContaining({ mapId: 'map-a' }) }))
    expect(second).toHaveBeenCalledWith(expect.objectContaining({ type: 'snapshot', snapshot: expect.objectContaining({ mapId: 'map-b' }) }))
    expect(watch.mock.calls.every(call => call.length === 2)).toBe(true)
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
    type Message = Parameters<Parameters<ClientBridge['onStream']>[0]>[0]
    let listener!: (message: Message) => void, id = ''
    const dispose = vi.fn(), cancel = vi.fn()
    const bridge = { onStream: vi.fn((next: typeof listener) => { listener = next; return dispose }), watch: vi.fn((watchId: string) => { id = watchId; return new Promise<never>(() => {}) }), cancel } as unknown as ClientBridge
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
    const read = vi.fn(() => new Promise<never>(() => {}))
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
