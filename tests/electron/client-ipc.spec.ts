import { EventEmitter } from 'node:events'
import type { IpcMain, IpcMainInvokeEvent, WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { clientAssertSender, clientRegisterIpc } from '../../electron/client-ipc'
import { CLIENT_CHANNELS } from '../../electron/client-channels'
import { ClientError, type ClientBridge, type ClientGateway } from '../../contracts/client'
import { apiCreateGateway } from '../../src/api'

const callId = '11111111-1111-4111-8111-111111111111'
function fixture() {
  const handlers = new Map<string, (...args: any[]) => any>()
  const ipc = Object.assign(new EventEmitter(), {
    handle: (channel: string, handler: (...args: any[]) => any) => { handlers.set(channel, handler) },
    removeHandler: (channel: string) => { handlers.delete(channel) },
  })
  const frame = { routingId: 12, processId: 34, url: 'http://localhost:5173/' }
  const contents = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false }) as unknown as WebContents
  const event = { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent
  const read = vi.fn(async () => ({ id: 'response' }))
  const gateway = { getConnection: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), read, dispatch: vi.fn() } as unknown as ClientGateway
  const dispose = clientRegisterIpc({ ipc: ipc as unknown as IpcMain, gateway, rendererUrl: frame.url, contents: () => contents })
  return { ipc, handlers, frame, contents, event, read, gateway, dispose }
}

describe('desktop client IPC authority', () => {
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
