// 092先行验证使用追溯公共响应的身份、原消费者版本和有限摘要页。
import { describe, expect, it, vi } from 'vitest'

import type { EvidenceUse, EvidenceUsesPage } from '../../contracts/evidence-library'
import { clientCreateApi } from '../../client/graph-client'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const entryId = '22222222-2222-4222-8222-222222222222'
const usageId = '33333333-3333-4333-8333-333333333333'
const mapId = '44444444-4444-4444-8444-444444444444'
const nodeId = '55555555-5555-4555-8555-555555555555'
const time = '2026-10-07T00:00:00.000Z'

function use(): EvidenceUse {
  // 构造一份真实协议形状，消费者正文与库正文拥有不同身份。
  return { id: usageId, workspaceId, ref: { entryId, contentDigest: 'a'.repeat(64) },
    consumer: { mapId, nodeId, revision: 2 }, reason: '用于核查目标陈述。', kind: 'manual',
    runId: null, operationId: null, workId: null, reusedFromOperationId: null, startedAt: time, endedAt: null,
    consumerSnapshot: { id: nodeId, revision: 2, typeId: 'test.opinion', typeVersion: 1,
      payload: { score: 0.5, reason: '原消费者意见。' }, createdAt: time, updatedAt: time } }
}

function page(): EvidenceUsesPage {
  // 摘要页没有消费者全文，不把有界追溯变成全图加载。
  const { consumerSnapshot: _snapshot, ...summary } = use()
  return { workspaceId, entryId, items: [summary], nextCursor: null, usageRevision: 1 }
}

function apiFor(
  /* 服务端成功信封中的正常或故意损坏数据。 */ data: unknown,
) {
  // 只替换网络返回，仍运行实际公共客户端白名单和响应验证。
  return clientCreateApi({ baseUrl: 'http://127.0.0.1:4320', token: 'test-token',
    fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, requestId: 'query', replayed: false, data })) })
}

describe('evidence usage public response', () => {
  it.each([{ kind: ['manual'] }, { kind: ['work'] }])('rejects coerced use kind $kind', async (
    /* 不能作为使用分类字符串的服务端数组。 */ { kind },
  ) => {
    // 数组不能借字符串化绕过分类和对应工作上下文的约束。
    const api = apiFor({ ...use(), kind })
    try { await expect(api.read('evidence.use.get', { workspaceId, entryId, usageId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { api.close() }
  })

  it('accepts a bounded summary and preserves a frozen historical consumer detail', async () => {
    const list = apiFor(page()), historical = { ...use(), endedAt: time }, detail = apiFor(historical)
    try {
      expect(await list.read('evidence.uses', { workspaceId, entryId })).toEqual(page())
      expect(await detail.read('evidence.use.get', { workspaceId, entryId, usageId })).toEqual(historical)
    } finally { list.close(); detail.close() }
  })

  it.each(['workspaceId', 'entryId'] as const)('rejects another %s page', async (
    /* 当前追溯查询必须匹配的身份。 */ field,
  ) => {
    const data = page()
    data[field] = '77777777-7777-4777-8777-777777777777'
    const api = apiFor(data)
    try { await expect(api.read('evidence.uses', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { api.close() }
  })

  it('rejects a summary whose material reference belongs to another entry', async () => {
    const data = page()
    data.items[0].ref.entryId = '77777777-7777-4777-8777-777777777777'
    const api = apiFor(data)
    try { await expect(api.read('evidence.uses', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { api.close() }
  })

  it.each(['usage', 'entry'] as const)('rejects another %s identity even if its detail is structurally valid', async (
    /* 详情必须与本次请求匹配的使用身份或库引用身份。 */ identity,
  ) => {
    // 公开客户端负责拒绝错配DTO，窗口状态只处理已经验证的回复及迟到响应。
    const data = use()
    if (identity === 'usage') data.id = '77777777-7777-4777-8777-777777777777'
    else data.ref.entryId = '77777777-7777-4777-8777-777777777777'
    const api = apiFor(data)
    try { await expect(api.read('evidence.use.get', { workspaceId, entryId, usageId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { api.close() }
  })

  it('rejects a consumer snapshot which disagrees with its exact version reference', async () => {
    const data = use()
    data.consumerSnapshot.revision = 3
    const api = apiFor(data)
    try { await expect(api.read('evidence.use.get', { workspaceId, entryId, usageId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { api.close() }
  })

  it('rejects an invalid end timestamp instead of treating an ended use as current', async () => {
    const api = apiFor({ ...use(), endedAt: 'invalid date' })
    try { await expect(api.read('evidence.use.get', { workspaceId, entryId, usageId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { api.close() }
  })

  it('rejects manual use with invented work context', async () => {
    const api = apiFor({ ...use(), runId: 'fake-run' })
    try { await expect(api.read('evidence.use.get', { workspaceId, entryId, usageId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { api.close() }
  })
})
