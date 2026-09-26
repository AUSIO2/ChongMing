import { RuntimeMessage } from '../../contracts/messages'
import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { clientCreateGateway, type ClientConnectionStore } from '../../client/graph-client'
import type { ClientGateway, ClientConnectInput } from '../../contracts/client'
import type { ClientService } from './local-service-process'

// 用途：创建客户端请求，供后续流程使用。
export function clientCreateDesktop(input: { directory: string; remoteStore: ClientConnectionStore; service: ClientService }) {
  const remote = clientCreateGateway({ baseUrl: 'http://127.0.0.1:4320', store: input.remoteStore })
  const local = clientCreateGateway({ baseUrl: 'http://127.0.0.1:4320' })
  const modeFile = path.join(input.directory, 'client-mode.json')
  let mode: 'local' | 'remote' | null = null, closed = false, tail = Promise.resolve()
  const initialized = (async () => {
    try {
      const value = JSON.parse(await readFile(modeFile, 'utf8'))
      if (value.mode !== 'local' && value.mode !== 'remote') throw new Error(RuntimeMessage.INVALID_DESKTOP_MODE)
      mode = value.mode
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  })()
  void initialized.catch(() => {})
  // 用途：读取网关，并把结构化结果交给调用方。
  function clientReadGateway() { return mode === 'local' ? local : remote }
  // 用途：执行连接流程，并返回执行结果。
  function clientRunConnection<T>(operation: () => Promise<T>): Promise<T> {
    const task = tail.then(async () => { await initialized; if (closed) throw new Error(RuntimeMessage.DESKTOP_IS_CLOSING); return operation() })
    tail = task.then(() => {}, () => {})
    return task
  }
  // 用途：处理客户端请求相关工作，并把结果交给调用方。
  async function clientWriteMode(next: 'local' | 'remote' | null) {
    mode = next
    if (!next) { await rm(modeFile, { force: true }); return }
    await mkdir(input.directory, { recursive: true })
    const temporary = modeFile + '.' + randomUUID() + '.tmp'
    try { await writeFile(temporary, JSON.stringify({ mode: next }), { mode: 0o600 }); await rename(temporary, modeFile) }
    finally { await rm(temporary, { force: true }) }
  }
  // 用途：处理客户端请求相关工作，并把结果交给调用方。
  async function clientConnectLocal() {
    const info = await input.service.start()
    const result = await local.connect({ ...info, remember: false })
    await clientWriteMode('local')
    return result
  }
  const gateway: ClientGateway = {
    getConnection: () => clientRunConnection(async () => {
      if (mode === 'local' && !(await local.getConnection()).configured) await clientConnectLocal()
      return { ...await clientReadGateway().getConnection(), mode: mode ?? 'remote' }
    }),
    connect: (value: ClientConnectInput) => clientRunConnection(async () => {
      const result = await remote.connect(value)
      if (mode === 'local') await local.disconnect()
      await clientWriteMode('remote')
      return result
    }),
    connectLocal: () => clientRunConnection(clientConnectLocal),
    disconnect: () => clientRunConnection(async () => { await clientReadGateway().disconnect(); await clientWriteMode(null) }),
    read: async (method, params, signal) => { await initialized; await tail; return clientReadGateway().read(method, params, signal) },
    dispatch: async (requestId, method, params, signal) => { await initialized; await tail; return clientReadGateway().dispatch(requestId, method, params, signal) },
    upload: async (requestId, value, signal) => { await initialized; await tail; return clientReadGateway().upload(requestId, value, signal) },
    download: async (value, signal) => { await initialized; await tail; return clientReadGateway().download(value, signal) },
    watch: async (mapId, onEvent, signal) => { await initialized; await tail; return clientReadGateway().watch(mapId, onEvent, signal) },
  }
  return { gateway, // 用途：关闭当前模块并释放占用的资源。
    // 用途：关闭当前模块并释放占用的资源。
    async close() { closed = true; remote.close(); local.close(); await input.service.close(); await tail } }
}
