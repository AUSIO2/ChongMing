// 文件职责：检验真实恢复设施的重复关闭、重启/收尾竞态与原存储归属，不替代用户正文恢复旅程。
import { stat } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'

import { clientCreateGateway } from '../../client/graph-client'
import { recoveryTest, type WorkspaceRecoveryEnvironment } from './workspace-recovery-fixture'
import { expect } from './workspace-fixture'

enum RecoveryLifecycleMessage {
  PROBE_TIMEOUT = '恢复设施端口核验超过期限。',
  PROBE_FAILED = '恢复设施端口核验没有得到明确结果。',
}

async function directoryExists(
  /* 当前测试拥有的恢复环境目录，只核验其存在状态而不扩大清理范围。 */
  directory: string,
): Promise<boolean> {
  // 目录只有确实返回 ENOENT 才算已删除，其他文件系统故障继续传播。
  try {
    await stat(directory)
    return true
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function portIsListening(
  /* 夹具公开的随机回环 origin，不使用开发者的固定服务端口。 */
  origin: string,
): Promise<boolean> {
  // 用真实 TCP 建连区分已关闭和仍监听；超时不是端口已关闭的证据。
  const target = new URL(origin)
  return new Promise<boolean>((
    /* 真实连接成功或明确拒绝连接后给出监听状态。 */ resolve,
    /* 超时或其他网络错误不能误报为资源已经释放。 */ reject,
  ) => {
    // 每次探测只持有自己的短连接，所有结果都会销毁该连接。
    const socket = createConnection({ host: target.hostname, port: Number(target.port) })
    socket.setTimeout(1000)
    socket.once('connect', () => {
      // 连接成功证明该 origin 仍有监听，随后释放探测连接。
      socket.destroy()
      resolve(true)
    })
    socket.once('error', (
      /* TCP 层结果；只将明确的连接拒绝认定为端口关闭。 */
      error: NodeJS.ErrnoException,
    ) => {
      // 不输出底层错误原文；未知错误应使资格检查失败。
      socket.destroy()
      if (error.code === 'ECONNREFUSED') resolve(false)
      else reject(new Error(RecoveryLifecycleMessage.PROBE_FAILED))
    })
    socket.once('timeout', () => {
      // 避免将挂起的服务当作已经关闭，也保证探测本身有界。
      socket.destroy()
      reject(new Error(RecoveryLifecycleMessage.PROBE_TIMEOUT))
    })
  })
}

async function assertFinallyClosed(
  /* 同一个最终 close 已完成的恢复夹具；字段仅作为自有资源核验坐标。 */
  environment: WorkspaceRecoveryEnvironment,
): Promise<void> {
  // 最终目录消失及两个真实端口停止监听必须同时成立，不能只检查 close Promise。
  expect(await directoryExists(environment.directory)).toBe(false)
  expect(await portIsListening(environment.baseUrl)).toBe(false)
  expect(await portIsListening(environment.webUrl)).toBe(false)
}

recoveryTest('M00-Q03 重复与并发 close 收敛到同一最终资源状态', async (
  /* 本测试独占的真实 SQLite/Mongo 恢复环境，未使用旧 ui-fixture 创建第二套服务。 */
  { recovery },
) => {
  // 先证明端口与目录确实存在，再检验多次关闭后的实际资源状态。
  expect(await directoryExists(recovery.directory)).toBe(true)
  expect(await portIsListening(recovery.baseUrl)).toBe(true)
  expect(await portIsListening(recovery.webUrl)).toBe(true)
  const firstClose = recovery.close()
  const secondClose = recovery.close()
  expect(secondClose).toBe(firstClose)
  await Promise.all([firstClose, secondClose])
  await recovery.close()
  await assertFinallyClosed(recovery)
})

for (const mode of ['graceful', 'crash'] as const) {
  recoveryTest(`M00-Q04 ${mode} 重启与最终 close 同时发生后不遗留重开的服务`, async (
    /* 同一环境的应用重开与最终销毁必须由夹具协调，不能删库后再启动 child。 */
    { recovery },
  ) => {
    // 不等待重启完成就发起最终关闭，确定覆盖其第一个异步让出点后的收尾交错。
    const restarting = recovery.restart(mode)
    const closing = recovery.close()
    const results = await Promise.allSettled([restarting, closing])
    expect(results.every((
      /* 两个设施动作都应在既定协议下正常收敛，不把清理拒绝忽略成成功。 */
      result,
    ) => /* 只断言结果类别，不把原始错误或私有字段序列化。 */ result.status === 'fulfilled')).toBe(true)
    await assertFinallyClosed(recovery)
  })
}

recoveryTest('M00-Q06 原目录与原账号在两轮应用重开后保持归属', async (
  /* 两种存储均重新认证原身份，SQLite 另核验真实文件身份。 */
  { recovery },
) => {
  // 仅检查设施保留原文件与身份，不重复用户界面保存正文、资产和审核的业务验收。
  const directoryBefore = await stat(recovery.directory)
  const filename = path.join(recovery.directory, 'sqlite', 'chongming.sqlite')
  const databaseBefore = recovery.storage === 'sqlite' ? await stat(filename) : undefined
  const originalUserId = recovery.credential.userId
  const originalTokenId = recovery.credential.tokenId
  const originalToken = recovery.credential.token
  for (let round = 0; round < 2; round += 1) {
    await recovery.restart('graceful')
    const directoryAfter = await stat(recovery.directory)
    expect(directoryAfter.dev === directoryBefore.dev && directoryAfter.ino === directoryBefore.ino).toBe(true)
    if (databaseBefore) {
      const databaseAfter = await stat(filename)
      expect(databaseAfter.dev === databaseBefore.dev && databaseAfter.ino === databaseBefore.ino).toBe(true)
    }
    expect(recovery.credential.tokenId === originalTokenId && recovery.credential.token === originalToken).toBe(true)
    const gateway = clientCreateGateway({ baseUrl: recovery.baseUrl, timeoutMs: 3000 })
    try {
      const bootstrap = await gateway.connect({ baseUrl: recovery.baseUrl, token: originalToken, remember: false })
      expect(bootstrap.identity.userId === originalUserId).toBe(true)
    } finally {
      await gateway.disconnect()
    }
  }
})
