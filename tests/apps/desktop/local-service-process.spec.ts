// 使用真实子进程验证桌面本地服务启动合并、就绪校验、重试和有界退出。
import { mkdtemp, mkdir, writeFile, rm, cp, link } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { clientCreateService } from '../../../apps/desktop/local-service-process'
import type { LocalServiceState } from '../../../contracts/desktop'

const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  // 逆序关闭测试服务，再移除其运行目录。
   for (const close of cleanup.splice(0).reverse()) await close() })
/**
 * 建立随包目录结构并写入指定子进程源码，收集状态用于生命周期断言。
 *
 * @param source 写入模拟随包服务入口的源码字符串，由各用例控制就绪和退出行为。
 * @param startupMs 等待子进程就绪的毫秒上限，缺省 2000，超时测试会缩短它。
 */
async function serviceCreateFixture(source: string, startupMs = 2000) {
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-service-'))
  cleanup.push(() => /* 删除当前用例的临时服务目录。 */  rm(directory, { recursive: true, force: true }))
  await mkdir(path.join(directory, 'bin')); await mkdir(path.join(directory, 'service'))
  const executable = path.join(directory, 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  try { await link(process.execPath, executable) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error; await cp(process.execPath, executable) }
  await writeFile(path.join(directory, 'service/main.mjs'), source)
  const states: LocalServiceState[] = []
  const input = { runtimeDirectory: directory, dataDirectory: path.join(directory, 'data'), configDirectory: path.join(directory, 'config'),
    startupMs, shutdownMs: 100,
                                /**
                                 * @param state 被测服务控制器发布的无凭据状态，保存以核对状态转换和脱敏。
                                 */
                                onState: (state: LocalServiceState) => /* 记录服务状态变化，以检查凭据未进入对外状态。 */  states.push(state) }
  const service = clientCreateService(input)
  cleanup.push(() => /* 确保用例结束后等待服务子进程关闭。 */  service.close())
  return { directory, states, service, input }
}
describe('owned desktop service process', () => {
  // 组织桌面独占子进程的启动、失败及退出场景。
  it('coalesces starts, keeps tokens out of state and gracefully drains its child on close', async () => {
    // 验证并发启动共享结果，状态不泄漏令牌，关闭后禁止重启。
    const f = await serviceCreateFixture(`process.send({type:'ready',baseUrl:'http://127.0.0.1:4567',token:'x'.repeat(43)});process.on('message',m=>{if(m.type==='stop')process.disconnect()})`)
    const one = f.service.start(), two = f.service.start()
    expect(one).toBe(two)
    expect(await one).toEqual(await two)
    expect(f.service.state()).toEqual({ status: 'running' })
    expect(JSON.stringify(f.states)).not.toContain('x'.repeat(43))
    await f.service.close()
    expect(f.service.state()).toEqual({ status: 'stopped' })
    await expect(f.service.start()).rejects.toMatchObject({ code: 'LOCAL_SERVICE_FAILED' })
  })
  it('cleans up a startup timeout and allows an explicit retry', async () => {
    // 验证启动超时会回收子进程，修复入口后允许显式重试。
    const f = await serviceCreateFixture("process.on('message',m=>{if(m.type==='stop')process.disconnect()})", 500)
    await expect(f.service.start()).rejects.toMatchObject({ code: 'LOCAL_SERVICE_FAILED' })
    expect(f.service.state().status).toBe('failed')
    f.input.startupMs = 3000
    await writeFile(path.join(f.directory, 'service/main.mjs'), `process.send({type:'ready',baseUrl:'http://127.0.0.1:4568',token:'y'.repeat(43)});process.on('message',()=>process.disconnect())`)
    expect((await f.service.start()).baseUrl).toContain('4568')
  })
  it('rejects non-loopback readiness and notices an unexpected exit after becoming ready', async () => {
    // 验证拒绝非本机就绪地址，并在服务就绪后意外退出时发布失败状态。
    const invalid = await serviceCreateFixture(`process.send({type:'ready',baseUrl:'https://example.com',token:'x'.repeat(43)});process.on('message',()=>process.disconnect())`)
    await expect(invalid.service.start()).rejects.toMatchObject({ code: 'LOCAL_SERVICE_FAILED' })
    const exited = await serviceCreateFixture(`process.send({type:'ready',baseUrl:'http://127.0.0.1:4567',token:'x'.repeat(43)});setTimeout(()=>process.exit(7),100)`)
    await exited.service.start()
    await expect.poll(() => /* 读取服务状态，等待意外退出被识别为失败。 */  exited.service.state().status).toBe('failed')
  })
  it('terminates a child that ignores graceful stop without waiting forever', async () => {
    // 验证忽略正常停止和终止信号的子进程仍被强制回收，关闭不会无限等待。
    const f = await serviceCreateFixture(`process.send({type:'ready',baseUrl:'http://127.0.0.1:4567',token:'x'.repeat(43)});process.on('message',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`)
    await f.service.start()
    await f.service.close()
    expect(f.service.state().status).toBe('stopped')
  }, 5000)
})
