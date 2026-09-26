import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCreateDesktop } from '../../../apps/desktop/connection-manager'
import type { ClientService } from '../../../apps/desktop/local-service-process'
import type { ClientConnectionStore } from '../../../client/graph-client'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
async function desktopCreateServer(name: string) {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, requestId: 'fixture', replayed: false, data: { identity: { userId: name, displayName: name, hostAdmin: false },
      settings: { revision: 0, llm: {}, tools: [], limits: {} }, metadata: {} } }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  return 'http://127.0.0.1:' + address.port
}
describe('desktop local/remote selection', () => {
  it('preserves remote credentials when using local and restores local automatically next launch', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-desktop-'))
    cleanup.push(() => rm(directory, { recursive: true, force: true }))
    const localUrl = await desktopCreateServer('local'), remoteUrl = await desktopCreateServer('remote')
    const service = { start: vi.fn(async () => ({ baseUrl: localUrl, token: 'local-token' })), close: vi.fn(async () => {}), state: () => ({ status: 'running' }) } as unknown as ClientService
    const saved = { baseUrl: remoteUrl, token: 'remote-token', remembered: true }
    const store: ClientConnectionStore = { canRemember: () => true, load: async () => saved, save: vi.fn(async () => true), clear: vi.fn(async () => {}) }
    const one = clientCreateDesktop({ directory, remoteStore: store, service })
    cleanup.push(() => one.close())
    expect((await one.gateway.getConnection()).mode).toBe('remote')
    expect(service.start).not.toHaveBeenCalled()
    expect((await one.gateway.connectLocal!()).identity.userId).toBe('local')
    expect(store.save).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
    await one.close()
    const two = clientCreateDesktop({ directory, remoteStore: store, service })
    cleanup.push(() => two.close())
    expect(await two.gateway.getConnection()).toMatchObject({ mode: 'local', configured: true })
    expect((await two.gateway.read('app.bootstrap', {})).identity.userId).toBe('local')
    await two.gateway.connect({ baseUrl: remoteUrl, token: 'remote-token', remember: true })
    expect((await two.gateway.getConnection()).mode).toBe('remote')
    expect((await two.gateway.read('app.bootstrap', {})).identity.userId).toBe('remote')
    await two.gateway.disconnect()
    expect(store.clear).toHaveBeenCalled()
  })
})
