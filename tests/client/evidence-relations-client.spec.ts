// 先行验证公共客户端的新关系查询：完整身份、有限邻域、实际边和历史缺失标记。
import { describe, expect, it, vi } from 'vitest'

import type { EvidenceRelationNode, EvidenceRelationsView } from '../../contracts/evidence-library'
import { clientCreateApi } from '../../client/graph-client'

const workspaceId = '11111111-1111-4111-8111-111111111111'
const mapId = '22222222-2222-4222-8222-222222222222'
const entryId = '33333333-3333-4333-8333-333333333333'
const claimId = '44444444-4444-4444-8444-444444444444'
const opinionId = '55555555-5555-4555-8555-555555555555'
const edgeId = '66666666-6666-4666-8666-666666666666'
const capturedAt = '2026-10-07T00:00:00.000Z'
const digest = 'a'.repeat(64)

function relationNode(
  /* 关系中的精确节点身份。 */ id: string,
  /* 节点在收录邻域中的实际角色。 */ role: EvidenceRelationNode['role'],
): EvidenceRelationNode {
  // 构造固定 Claim 或 score0.5 的核查意见，JSON payload 不冒充库判断。
  return { key: `${mapId}:${id}:0`, ref: { mapId, nodeId: id, revision: 0 }, role, definitionDigest: digest,
    nodeSnapshot: { id, revision: 0, typeId: role === 'claim' ? 'factcheck.claim' : 'factcheck.opinion', typeVersion: 1,
      payload: role === 'claim' ? { content: '固定陈述原文。', category: null }
        : { score: 0.5, reason: '仅为原 Opinion 内容。', evidenceIds: [] }, createdAt: capturedAt, updatedAt: capturedAt } }
}

function relationView(): EvidenceRelationsView {
  // 构造有真实边身份的固定邻域形状，供公共边界的破坏性输入逐项验证。
  const root = relationNode(claimId, 'claim'), opinion = relationNode(opinionId, 'downstream')
  return { workspaceId, entryId, contentDigest: digest, snapshot: { version: 1, capturedAt,
    rootKey: root.key, nodes: [root, opinion], truncated: false,
    edges: [{ key: edgeId, kind: 'graph', from: root.key, to: opinion.key, mapId,
      edge: { id: edgeId, revision: 0, kind: 'successor', from: claimId, to: opinionId,
        label: '核查', createdAt: capturedAt, updatedAt: capturedAt } }] } }
}

function clientFor(
  /* 正常响应或测试故意损坏的任意关系结果。 */ data: unknown,
) {
  // 替换网络响应 seam，真实公共客户端仍负责新方法和响应完整性。
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true, requestId: 'query', replayed: false, data }))
  return clientCreateApi({ baseUrl: 'http://127.0.0.1:4320', token: 'test-token', fetch: fetcher })
}

describe('public evidence relations response', () => {
  // 关系属于独立收录身份，不把邻域节点类型、分数或未知历史当成普通库条目。
  it.each(['array', 'null'] as const)('does not normalize %s query params into a valid identity object', async (
    /* 即使服务端返回合法关系，也不符合公开参数形状的调用输入。 */ kind,
  ) => {
    // 冻结请求身份必须保留输入种类，数组上的命名属性不能冒充对象参数。
    const params = kind === 'array' ? Object.assign([], { workspaceId, entryId }) : null
    const client = clientFor(relationView())
    try {
      await expect(client.read('evidence.relations', params as never)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally { client.close() }
  })

  it('accepts fixed graph relations and preserves a downstream Opinion score of 0.5', async () => {
    const view = relationView(), client = clientFor(view)
    try {
      expect(await client.read('evidence.relations', { workspaceId, entryId })).toEqual(view)
    } finally { client.close() }
  })

  it('accepts an explicit missing historical relation snapshot', async () => {
    const view = { ...relationView(), snapshot: null }, client = clientFor(view)
    try { expect(await client.read('evidence.relations', { workspaceId, entryId })).toEqual(view) }
    finally { client.close() }
  })

  it.each(['workspaceId', 'entryId'] as const)('rejects a response for another %s', async (
    /* 当前查询中必须绑定的请求身份字段。 */ field,
  ) => {
    const view = relationView()
    view[field] = '77777777-7777-4777-8777-777777777777'
    const client = clientFor(view)
    try { await expect(client.read('evidence.relations', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('rejects a node snapshot which contradicts its exact reference', async () => {
    const view = relationView()
    if (!view.snapshot) throw new Error('Fixture requires a snapshot')
    view.snapshot.nodes[0].ref.revision = 1
    const client = clientFor(view)
    try { await expect(client.read('evidence.relations', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('rejects duplicate display keys instead of merging distinct versions', async () => {
    const view = relationView()
    if (!view.snapshot) throw new Error('Fixture requires a snapshot')
    view.snapshot.nodes[1].key = view.snapshot.nodes[0].key
    const client = clientFor(view)
    try { await expect(client.read('evidence.relations', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('rejects a dangling relation endpoint', async () => {
    const view = relationView()
    if (!view.snapshot) throw new Error('Fixture requires a snapshot')
    view.snapshot.edges[0].to = 'not-captured'
    const client = clientFor(view)
    try { await expect(client.read('evidence.relations', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('rejects a physical edge whose original endpoint is a different node', async () => {
    const view = relationView()
    if (!view.snapshot || view.snapshot.edges[0].kind !== 'graph') throw new Error('Fixture requires a graph edge')
    view.snapshot.edges[0].edge.to = claimId
    const client = clientFor(view)
    try { await expect(client.read('evidence.relations', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('rejects a missing snapshot field rather than treating it as unknown history', async () => {
    const view = relationView()
    const client = clientFor({ workspaceId: view.workspaceId, entryId: view.entryId, contentDigest: view.contentDigest })
    try { await expect(client.read('evidence.relations', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })

  it('rejects a malformed boundary marker', async () => {
    const view = relationView()
    if (!view.snapshot) throw new Error('Fixture requires a snapshot')
    const client = clientFor({ ...view, snapshot: { ...view.snapshot, truncated: 'false' } })
    try { await expect(client.read('evidence.relations', { workspaceId, entryId })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' }) }
    finally { client.close() }
  })
})
