// 从真实 HTTP 字节入口验证非法 UTF-8 不进入业务，而合法 Unicode 保持原文。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import type { Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'

import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { dshHttpCreateServer } from '../../../../backend/adapters/http/dsh-diagnostic-server'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'

async function listen(/* 本例拥有的真实 HTTP 服务。 */ server: Server): Promise<string> {
  // 仅监听本机随机端口，由调用者在 finally 关闭。
  await new Promise<void>((/* 监听完成入口。 */ resolve) => /* 绑定隔离的回环端口。 */ server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected isolated HTTP port')
  return `http://127.0.0.1:${address.port}`
}
async function close(/* 本例拥有的 HTTP 服务。 */ server: Server): Promise<void> {
  // 断开测试连接后等待监听资源释放。
  server.closeAllConnections()
  await new Promise<void>((/* 正常关闭入口。 */ resolve, /* 关闭错误入口。 */ reject) => {
    server.close((/* 实际原生关闭错误。 */ error) => /* 传播真实关闭结果。 */ error ? reject(error) : resolve())
  })
}

it('rejects malformed command bytes before dispatch and preserves a valid Unicode command', async () => {
  // 应用装配保持真实，只观察其已有 dispatch seam；本例不初始化或读写业务数据库。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-request-bytes-'))
  const database = sqliteCreatePersistence(directory)
  const application = applicationCreateLocalService(database)
  const dispatch = vi.spyOn(application, 'dispatch').mockResolvedValue({ data: {}, replayed: false })
  const server = apiCreateServer(application)
  const origin = await listen(server)
  const requestId = randomUUID(), id = randomUUID()
  const raw = Buffer.from(JSON.stringify({ requestId, method: 'workspace.create', params: { id, name: 'MARKER', description: '', agentSource: 'empty' } }))
  const marker = raw.indexOf('MARKER')
  const bad = Buffer.concat([raw.subarray(0, marker), Buffer.from([0xff]), raw.subarray(marker + 6)])
  try {
    const rejected = await fetch(origin + '/api/v1/command', { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: bad })
    expect(rejected.status).toBe(400)
    expect(await rejected.json()).toMatchObject({ ok: false, error: { code: 'INVALID_JSON' } })
    expect(dispatch).not.toHaveBeenCalled()
    const bom = await fetch(origin + '/api/v1/command', { method: 'POST', headers: { authorization: 'Bearer fixture' }, body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), raw]) })
    expect(bom.status).toBe(400)
    expect(await bom.json()).toMatchObject({ error: { code: 'INVALID_JSON' } })
    expect(dispatch).not.toHaveBeenCalled()
    const name = '沙箱 café'
    const accepted = await fetch(origin + '/api/v1/command', { method: 'POST', headers: { authorization: 'Bearer fixture' },
      body: JSON.stringify({ requestId, method: 'workspace.create', params: { id, name, description: '', agentSource: 'empty' } }) })
    expect(accepted.status).toBe(201)
    expect(dispatch).toHaveBeenCalledWith('fixture', expect.objectContaining({ params: expect.objectContaining({ name }) }))
  } finally {
    dispatch.mockRestore()
    await close(server)
    await database.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('rejects malformed diagnostic prompt bytes before starting the runtime', async () => {
  // 诊断流尚未开始时按原输入失败响应拒绝，合法提示词仍启动一次运行。
  const run = vi.fn(async (/* 已通过诊断 HTTP 解析的执行输入。 */ input) => {
    return { sessionId: 'session', finalResponse: input.prompt, events: [] }
  })
  const server = dshHttpCreateServer({ start: async () => { /* 没有真实执行进程。 */ }, run,
    close: async () => { /* 没有外部运行时资源。 */ } })
  const origin = await listen(server)
  try {
    const invalid = await fetch(origin + '/runtime/dsh/run', { method: 'POST', body: Buffer.concat([Buffer.from('{"prompt":"'), Buffer.from([0xff]), Buffer.from('"}')]) })
    expect(invalid.status).toBe(400)
    expect(run).not.toHaveBeenCalled()
    const valid = await fetch(origin + '/runtime/dsh/run', { method: 'POST', body: JSON.stringify({ prompt: '原文 café' }) })
    expect(valid.status).toBe(200)
    expect(await valid.text()).toContain('原文 café')
    expect(run).toHaveBeenCalledWith({ prompt: '原文 café', sessionId: undefined }, expect.any(Function))
  } finally { await close(server) }
})
