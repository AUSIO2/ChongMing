// 文件职责：验证公共 HTTP 错误脱敏、诊断关联及受控停机时的写入拒绝。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { DiagnosticEvent, DiagnosticReporter } from '../../../../contracts/diagnostics'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { createGraphApi, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
const events: Array<DiagnosticEvent & { errorId: string }> = []
const reporter: DiagnosticReporter = {
  /**
   * 保存诊断事件与错误编号，供断言公共响应和内部记录一致。
   *
   * @param event API 错误边界产生的内部诊断事件，保留原异常并补充关联错误编号。
   */
  report(event) {
     const errorId = event.errorId ?? crypto.randomUUID(); events.push({ ...event, errorId }); return errorId },
  async close() {
    // 测试报告器无外部资源，关闭时无需执行清理。
  },
}
beforeAll(async () => {
  // 启动带内存诊断报告器的真实图 API 测试夹具。
   api = await createGraphApi(60_000, undefined, reporter) }, 90_000)
afterAll(async () => {
  // 关闭测试 API 及其依赖，避免资源泄漏到后续用例。
   await api?.close() }, 30_000)

describe('public request error boundary', () => {
  // 覆盖未知异常的公共响应及关闭阶段的服务就绪状态。
  it('requires an explicitly assembled Host token instead of inheriting the process environment', async () => {
    // 没有装配内部令牌的服务不能悄悄接纳同进程环境中的另一份Host凭据。
    vi.stubEnv('CHONGMING_DATA_TOKEN', 'ambient-host-token')
    const server = apiCreateServer(api.application)
    try {
      await new Promise<void>((/* 临时服务监听完成后开始发请求。 */ resolve) => /* 仅监听本机随机端口。 */ server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Host token test server did not bind')
      const response = await fetch(`http://127.0.0.1:${address.port}/internal/v1/messaging`, {
        headers: { authorization: 'Bearer ambient-host-token' },
      })
      expect(response.status).toBe(401)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'UNAUTHORIZED' } })
    } finally {
      vi.unstubAllEnvs()
      await new Promise<void>((/* 服务关闭完成入口。 */ resolve, /* 服务关闭故障入口。 */ reject) => {
        // 无论断言成功与否都释放本例创建的HTTP服务。
        server.close((/* 原生HTTP关闭错误。 */ error) => /* 向测试传播关闭结果。 */ error ? reject(error) : resolve())
      })
    }
  })

  it('returns a safe error id while retaining the original failure only inside the reporter', async () => {
    // 注入携带私有细节的异常，验证响应仅含安全错误信息且服务仍可继续查询。
    const secret = 'secret-request-body-and-local-path'
    vi.spyOn(api.application, 'read').mockRejectedValueOnce(new Error(secret))
    const result = await api.post('/api/v1/query', { method: 'workspace.list', params: {} })
    expect(result).toMatchObject({ status: 500, body: { ok: false, error: {
      code: 'INTERNAL_ERROR', message: 'Internal server error', retryable: true, errorId: expect.any(String),
    } } })
    expect(JSON.stringify(result.body)).not.toContain(secret)
    expect(events[events.length - 1]).toMatchObject({ name: 'request.failed', severity: 'error', errorId: result.body.error.errorId,
      context: { route: '/api/v1/query' }, error: expect.objectContaining({ message: secret }) })
    expect(await api.post('/api/v1/query', { method: 'workspace.list', params: {} })).toMatchObject({ status: 200 })
  })

  it('marks readiness false and rejects new public writes once controlled shutdown begins', async () => {
    // 开始受控关闭后验证健康检查不可就绪，并拒绝新业务写入。
    api.server.beginShutdown()
    const health = await fetch(api.url + '/health')
    expect(health.status).toBe(503)
    expect(await health.json()).toEqual({ ok: true, ready: false })
    const stopped = await api.post('/api/v1/command', {})
    expect(stopped).toMatchObject({ status: 503, body: { error: { code: 'SERVICE_STOPPING', errorId: expect.any(String) } } })
  })
})
