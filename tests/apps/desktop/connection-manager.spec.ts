// 验证桌面本地与远程模式切换、重启恢复和远程凭据保留。
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientCreateDesktop } from '../../../apps/desktop/connection-manager'
import type { ClientService } from '../../../apps/desktop/local-service-process'
import type { ClientConnectionStore } from '../../../client/graph-client'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  // 按创建顺序的逆序释放网关、HTTP 服务和临时目录。
   for (const close of cleanup.splice(0).reverse()) await close() })
async function desktopCreateServer(/* 模拟 API 返回的用户身份标签，用来区分本地和远程服务。 */ name: string) {
  // 创建具有指定身份的模拟 API，并登记服务清理。
  const server: Server = createServer((/* 模拟 API 收到的请求，本用例不按路径区分响应。 */ _req, /* 由模拟服务器拥有的 HTTP 响应，写入对应身份的引导数据。 */ res) => {
    // 返回带指定用户身份的应用引导响应，用于区分本地和远程目标。
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, requestId: 'fixture', replayed: false, data: { identity: { userId: name, displayName: name, hostAdmin: false },
      settings: { revision: 0, llm: {}, tools: [], limits: {} }, metadata: {} } }))
  })
  await new Promise<void>(/* 模拟 API 成功监听后的完成回调。 */ resolve => /* 等待模拟 API 绑定本机随机端口。 */  server.listen(0, '127.0.0.1', resolve))
  cleanup.push(async () => {
    // 断开所有模拟连接并等待 HTTP 服务关闭。
     server.closeAllConnections(); await new Promise<void>(/* 模拟 API 完全关闭后的清理完成回调。 */ resolve => /* 把服务关闭回调转换为清理等待。 */  server.close(() => /* 确认模拟 HTTP 服务已关闭。 */  resolve())) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server port')
  return 'http://127.0.0.1:' + address.port
}
describe('desktop local/remote selection', () => {
  // 组织桌面模式切换与持久化恢复的场景。
  it('preserves remote credentials when using local and restores local automatically next launch', async () => {
    // 验证切换本地不改远程凭据，重启恢复本地，并能再次切换远程及清除凭据。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-desktop-'))
    cleanup.push(() => /* 移除保存模式选择的临时目录。 */  rm(directory, { recursive: true, force: true }))
    const localUrl = await desktopCreateServer('local'), remoteUrl = await desktopCreateServer('remote')
    const service = { start: vi.fn(async () => /* 模拟本地服务启动后返回仅在内存使用的连接凭据。 */  ({ baseUrl: localUrl, token: 'local-token' })), close: vi.fn(async () => {
      // 模拟无需实际资源清理的本地服务关闭，并记录调用。
      }), state: () => /* 模拟本地服务处于运行状态。 */  ({ status: 'running' }) } as unknown as ClientService
    const saved = { baseUrl: remoteUrl, token: 'remote-token', remembered: true }
    const store: ClientConnectionStore = { canRemember: () => /* 模拟存储支持安全记住远程令牌。 */  true, load: async () => /* 恢复夹具预置的远程地址与令牌。 */  saved, save: vi.fn(async () => /* 模拟成功保存远程凭据并记录调用。 */  true), clear: vi.fn(async () => {
      // 记录清除远程凭据的调用，供断开断言使用。
      }) }
    const one = clientCreateDesktop({ directory, remoteStore: store, service })
    cleanup.push(() => /* 清理首次创建的桌面连接管理器。 */  one.close())
    expect((await one.gateway.getConnection()).mode).toBe('remote')
    expect(service.start).not.toHaveBeenCalled()
    expect((await one.gateway.connectLocal!()).identity.userId).toBe('local')
    expect(store.save).not.toHaveBeenCalled()
    expect(store.clear).not.toHaveBeenCalled()
    await one.close()
    const two = clientCreateDesktop({ directory, remoteStore: store, service })
    cleanup.push(() => /* 清理模拟重启后的桌面连接管理器。 */  two.close())
    expect(await two.gateway.getConnection()).toMatchObject({ mode: 'local', configured: true })
    expect((await two.gateway.read('app.bootstrap', {})).identity.userId).toBe('local')
    await two.gateway.connect({ baseUrl: remoteUrl, token: 'remote-token', remember: true })
    expect((await two.gateway.getConnection()).mode).toBe('remote')
    expect((await two.gateway.read('app.bootstrap', {})).identity.userId).toBe('remote')
    await two.gateway.disconnect()
    expect(store.clear).toHaveBeenCalled()
  })
})
