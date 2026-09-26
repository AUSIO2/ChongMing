import { describe, expect, it, vi } from 'vitest'
import { activityReadStatus, activityCreateReporter } from '../../../backend/execution/dsh/activity-reporter'
import { activityIsRecord } from '../../../contracts/activity'
import type { GraphWorkGrant } from '../../../contracts/graph'

describe('DSH display-only activity', () => {
  it('whitelists SDK transitions and discards session identity, model content and tool payloads', () => {
    for (const [type, status] of [['turn/start', 'preparing'], ['step/start', 'model'], ['tool/call', 'tool'], ['tool/result', 'result']]) {
      expect(activityReadStatus({ method: 'session.event', params: { sessionId: 'secret', event: { type, data: { arguments: 'secret', text: 'secret' } } } })).toBe(status)
    }
    for (const type of ['assistant/message', 'assistant/attempt', 'user/message', 'system/message']) {
      expect(activityReadStatus({ method: 'session.event', params: { event: { type, data: { content: 'secret' } } } })).toBeNull()
    }
    expect(activityReadStatus({ method: 'session.status', params: { status: 'idle' } })).toBeNull()
  })

  it('bounds concurrent reporting and teardown when the activity endpoint stalls', async () => {
    const controller = new AbortController()
    const calls: RequestInit[] = []
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => {
      calls.push(init)
      return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }))
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

  it('rejects activity records containing raw execution fields or invalid actors', () => {
    const item = { mapId: 'map', runId: 'run', operationId: 'op', nodeId: 'node', workId: 'work',
      actor: { role: 'router' }, agentName: 'Router', status: 'model', fence: 1, sequence: 1, updatedAt: new Date().toISOString() }
    expect(activityIsRecord(item)).toBe(true)
    expect(activityIsRecord({ ...item, sessionId: 'secret' })).toBe(false)
    expect(activityIsRecord({ ...item, actor: { role: 'worker' } })).toBe(false)
    expect(activityIsRecord({ ...item, status: '__proto__' })).toBe(false)
  })
})
