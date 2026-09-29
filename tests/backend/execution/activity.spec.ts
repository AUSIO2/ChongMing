// 文件职责：验证执行活动只暴露固定摘要，发送并发与关闭均受控。
import { describe, expect, it, vi } from 'vitest'
import { activityReadStatus, activityCreateReporter } from '../../../backend/execution/dsh/activity-reporter'
import { activityIsRecord } from '../../../contracts/activity'
import type { GraphWorkGrant } from '../../../contracts/graph'

describe('DSH display-only activity', () => {
  // 覆盖活动阶段白名单、通知阻塞和协议字段验证。
  it('whitelists SDK transitions and discards session identity, model content and tool payloads', () => {
    // 验证仅已知 SDK 阶段生成活动，原始消息及内容字段不会进入摘要。
    for (const [type, status] of [['turn/start', 'preparing'], ['step/start', 'model'], ['tool/call', 'tool'], ['tool/result', 'result']]) {
      expect(activityReadStatus({ method: 'session.event', params: { sessionId: 'secret', event: { type, data: { arguments: 'secret', text: 'secret' } } } })).toBe(status)
    }
    for (const type of ['assistant/message', 'assistant/attempt', 'user/message', 'system/message']) {
      expect(activityReadStatus({ method: 'session.event', params: { event: { type, data: { content: 'secret' } } } })).toBeNull()
    }
    expect(activityReadStatus({ method: 'session.status', params: { status: 'idle' } })).toBeNull()
  })

  it('bounds concurrent reporting and teardown when the activity endpoint stalls', async () => {
    // 模拟活动端点停滞，验证高频更新仍只有一个请求且关闭能够取消等待。
    const controller = new AbortController()
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn((/* 被替换 fetch 收到的目标地址，此停滞模拟不按 URL 路由。 */ _url, /* 活动报告器发出的请求选项，用于记录载荷和监听取消信号。 */ init: RequestInit) => {
      // 记录显示请求并让其一直等待取消，模拟无响应端点。
      calls.push(init)
      return new Promise((/* 挂起请求的成功回调，本用例刻意永不成功因此不使用。 */ _resolve, /* 请求被取消时的拒绝回调，以原取消原因结束挂起调用。 */ reject) => /* 将测试请求的取消信号连接到拒绝回调。 */  init.signal!.addEventListener('abort', () => /* 按取消原因结束挂起的显示请求。 */  reject(init.signal!.reason), { once: true }))
    }))
    const grant = { workId: 'work', holderId: 'holder', fence: 1, mapId: 'map' } as GraphWorkGrant
    const reporter = activityCreateReporter({ dataApiUrl: 'http://localhost', token: 'private', grant, signal: controller.signal })
    try {
      reporter.update()
      for (let i = 0; i < 30; i++) reporter.update('tool')
      expect(calls).toHaveLength(1)
      await reporter.close()
      expect(calls).toHaveLength(1)
      expect(JSON.parse(String(calls[0].body))).toEqual({ mapId: 'map', status: 'preparing', sequence: 1 })
      reporter.update()
      expect(calls).toHaveLength(1)
    } finally { vi.unstubAllGlobals() }
  })

  it('rejects activity records containing raw execution fields or invalid stage identities', () => {
    // 验证活动记录拒绝原始会话字段、空阶段身份和非法阶段状态。
    const item = { mapId: 'map', runId: 'run', operationId: 'op', nodeId: 'node', workId: 'work',
      stageId: 'route', slotId: 'route', agentName: 'Router', status: 'model', fence: 1, sequence: 1, updatedAt: new Date().toISOString() }
    expect(activityIsRecord(item)).toBe(true)
    expect(activityIsRecord({ ...item, sessionId: 'secret' })).toBe(false)
    expect(activityIsRecord({ ...item, stageId: '' })).toBe(false)
    expect(activityIsRecord({ ...item, status: '__proto__' })).toBe(false)
  })
})
