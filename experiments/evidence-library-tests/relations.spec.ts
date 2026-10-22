// 先定义证据库关系验收，再用真实 Mongo/HTTP 验证冻结、身份隔离和边界；不替换原 114 条业务用例。
import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EvidenceCollectParams, EvidenceLibraryEntry } from '../../contracts/evidence-library'
import type { GraphChanges, GraphNodeInput } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'

import { storeCreateInputHash } from '../../backend/modules/graph/graph-record'
import {
  evidenceCreateRelationFixture, relationClaimRef, relationCollectParams, relationReadRecord, relationRequireSnapshot,
  type RelationTestSnapshot,
} from './relations-fixture'

enum RelationTestMessage {
  SOURCE_NODE_MISSING = 'Relation test cannot find its real source node.',
  ROOT_MISSING = 'Relation test cannot find its saved root.',
}

let fixture: Awaited<ReturnType<typeof evidenceCreateRelationFixture>>
let workspaceId: string

beforeAll(async () => {
  // 全套只拥有一个临时 Mongo 进程；每条用例仍创建独立工作区与条目。
  fixture = await evidenceCreateRelationFixture()
})
beforeEach(async () => {
  // 不共用库条目或游标，native seam 的损坏只影响当前用例。
  workspaceId = await fixture.createWorkspace()
})
afterAll(async () => {
  // 无论断言或准备失败都关闭本套拥有的服务资源。
  await fixture?.close()
})

async function createIsolated(
  /* 原始 Claim 文本，可为大正文或跨 Map 同名场景指定。 */ content = '原陈述完全不成立。',
  /* 同名跨 Map 用例明确指定的节点身份。 */ nodeId = randomUUID(),
  /* 当前用例明确指定的来源工作区。 */ targetWorkspaceId = workspaceId,
): Promise<{ graph: GraphSnapshot; claim: GraphNodeInput }> {
  // 只有实际 Claim 节点，没有隐式来源和核查下游。
  const claim = await fixture.nodeInput(targetWorkspaceId, 'factcheck.claim', { content, category: null }, nodeId)
  const graph = await fixture.createGraph(targetWorkspaceId, [claim])
  return { graph, claim }
}

async function createChain() {
  // 保存实际 Source→News→Claim→Opinion→Verification，Opinion 保持原 0.5，锚点绑定 News 的精确初始版本。
  const source = await fixture.nodeInput(workspaceId, 'factcheck.source', {
    locator: { kind: 'url', url: 'https://example.test/original' }, label: '原始公开材料',
  })
  const news = await fixture.nodeInput(workspaceId, 'factcheck.news', {
    content: '第一行原文\r\n\r\n第三行原文', context: {},
  })
  const claim = await fixture.nodeInput(workspaceId, 'factcheck.claim', { content: '原报道中的错误陈述。', category: null })
  const opinion = await fixture.opinionInput(workspaceId)
  const verification = await fixture.nodeInput(workspaceId, 'factcheck.verification', {
    score: 0.5, reason: '汇总时仍存在不确定性。', opinionIds: [opinion.id],
  })
  const edgeInputs: NonNullable<NonNullable<GraphChanges['edges']>['put']> = [
    { id: randomUUID(), kind: 'successor', from: source.id, to: news.id },
    { id: randomUUID(), kind: 'successor', from: news.id, to: claim.id, label: '原文出处', sourceAnchors: [
      { path: '/content', sourceRevision: 0, startLine: 1, endLine: 3, quote: '第一行原文\r\n\r\n第三行原文' },
    ] },
    { id: randomUUID(), kind: 'successor', from: claim.id, to: opinion.id },
    { id: randomUUID(), kind: 'successor', from: opinion.id, to: verification.id },
  ]
  const graph = await fixture.createGraph(workspaceId, [source, news, claim, opinion, verification], edgeInputs)
  return { graph, source, news, claim, opinion, verification }
}

async function collect(
  /* 实际保存的来源图。 */ graph: GraphSnapshot,
  /* 图中实际 Claim 身份。 */ nodeId: string,
  /* 用户显式选择的固定判断。 */ confidence: 0 | 1 = 0,
  /* 可覆盖显式依据，不覆盖实际来源身份。 */ overrides: Partial<EvidenceCollectParams> = {},
  /* 可指定重放同一收录请求身份。 */ requestId = randomUUID(),
): Promise<{ entry: EvidenceLibraryEntry; params: EvidenceCollectParams; requestId: string }> {
  // 所有收录经过真实生产客户端、HTTP 和授权事务；夹具不计算去重结果。
  const params = { ...relationCollectParams(graph.workspaceId, relationClaimRef(graph, nodeId), confidence), ...overrides }
  const entry = (await fixture.client.dispatch(requestId, 'evidence.collect', params)).data.entry
  return { entry, params, requestId }
}

function assertClosedEndpoints(
  /* 实际固定关系快照。 */ snapshot: RelationTestSnapshot,
): void {
  // 每个端点都必须有固定节点，且 key 不将跨 Map 或不同版本合并。
  const keys = snapshot.nodes.map((/* 已保存关系节点。 */ node) => /* 比较真实展示身份。 */ node.key)
  expect(new Set(keys).size).toBe(keys.length)
  expect(new Set(snapshot.edges.map((/* 已保存关系。 */ edge) => /* 比较完整关系身份。 */ edge.key)).size).toBe(snapshot.edges.length)
  for (const node of snapshot.nodes) {
    expect(node.ref.nodeId).toBe(node.nodeSnapshot.id)
    expect(node.ref.revision).toBe(node.nodeSnapshot.revision)
    expect(node.definitionDigest).toMatch(/^[a-f0-9]{64}$/)
  }
  const root = snapshot.nodes.find((/* 已保存节点。 */ node) => /* 找回快照声明的固定 root。 */ node.key === snapshot.rootKey)
  if (!root) throw new Error(RelationTestMessage.ROOT_MISSING)
  expect(root.role).toBe('claim')
  for (const edge of snapshot.edges) {
    expect(keys).toContain(edge.from)
    expect(keys).toContain(edge.to)
    if (edge.kind === 'graph') {
      expect(snapshot.nodes.find((/* 固定节点。 */ node) => /* 找回实际边起点。 */ node.key === edge.from)?.ref)
        .toMatchObject({ mapId: edge.mapId, nodeId: edge.edge.from })
      expect(snapshot.nodes.find((/* 固定节点。 */ node) => /* 找回实际边终点。 */ node.key === edge.to)?.ref)
        .toMatchObject({ mapId: edge.mapId, nodeId: edge.edge.to })
    }
  }
}

describe('evidence frozen origin and relation HTTP contract', () => {
  // 新库条目能公开读取冻结关系，历史不从当前图推断，查询只有读授权。
  it('keeps an isolated Claim as a sole root without inventing a manual-basis source edge', async () => {
    // 人工依据即使存在也不产生虚构来源节点或边。
    const { graph, claim } = await createIsolated()
    const { entry } = await collect(graph, claim.id)
    const view = await fixture.relations(workspaceId, entry.id)
    const snapshot = relationRequireSnapshot(view)
    expect(view).toMatchObject({ workspaceId, entryId: entry.id, contentDigest: entry.contentDigest })
    expect(snapshot).toMatchObject({ version: 1, capturedAt: entry.collectedAt, truncated: false, edges: [] })
    expect(snapshot.nodes).toHaveLength(1)
    expect(snapshot.nodes[0]).toMatchObject({ key: snapshot.rootKey, ref: entry.claim.origin,
      role: 'claim', nodeSnapshot: entry.claim.nodeSnapshot, definitionDigest: entry.claim.definitionDigest })
    assertClosedEndpoints(snapshot)
  })

  it('freezes the actual upstream and verification chain with complete edges, anchors and a distinct payload reference', async () => {
    // Verification 的声明引用与 Opinion→Verification 的 successor 是两种真实关系。
    const chain = await createChain()
    const { entry } = await collect(chain.graph, chain.claim.id)
    const snapshot = relationRequireSnapshot(await fixture.relations(workspaceId, entry.id))
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.nodes).toHaveLength(5)
    const roles = new Map(snapshot.nodes.map((/* 固定节点。 */ node) => /* 用实际身份断言角色。 */ [node.ref.nodeId, node.role]))
    expect(roles).toEqual(new Map([[chain.source.id, 'upstream'], [chain.news.id, 'upstream'],
      [chain.claim.id, 'claim'], [chain.opinion.id, 'downstream'], [chain.verification.id, 'downstream']]))
    for (const sourceNode of chain.graph.nodes) {
      expect(snapshot.nodes.find((/* 固定节点。 */ node) => /* 与实际原节点逐一对照。 */ node.ref.nodeId === sourceNode.id)?.nodeSnapshot)
        .toEqual(sourceNode)
    }
    const graphEdges = snapshot.edges.filter((/* 固定关系。 */ edge) => /* 只对照真实 GraphEdge。 */ edge.kind === 'graph')
    expect(graphEdges).toHaveLength(4)
    expect(graphEdges.map((/* 已缩窄为实际图边的关系。 */ edge) => /* 对照完整保存边含锚点。 */ edge.edge))
      .toEqual(expect.arrayContaining(chain.graph.edges))
    const verificationKey = snapshot.nodes.find((/* 固定节点。 */ node) => /* 定位汇总引用起点。 */ node.ref.nodeId === chain.verification.id)?.key
    const opinionKey = snapshot.nodes.find((/* 固定节点。 */ node) => /* 定位原意见引用终点。 */ node.ref.nodeId === chain.opinion.id)?.key
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ kind: 'payload', mapId: chain.graph.mapId,
      from: verificationKey, to: opinionKey, path: '/opinionIds/0' }))
    assertClosedEndpoints(snapshot)
  })

  it.each([0, 1] as const)('retains Opinion score 0.5 while the library judgment remains %s', async (
    /* 用户固定的数字真假判断。 */ confidence,
  ) => {
    // 关系只提供出处与核查原值，不能重新计算已固定的库判断。
    const chain = await createChain()
    const { entry } = await collect(chain.graph, chain.claim.id, confidence)
    const snapshot = relationRequireSnapshot(await fixture.relations(workspaceId, entry.id))
    expect(snapshot.nodes.find((/* 固定节点。 */ node) => /* 找回实际核查意见。 */ node.ref.nodeId === chain.opinion.id)?.nodeSnapshot.payload.score).toBe(0.5)
    expect((await fixture.client.read('evidence.get', { workspaceId, entryId: entry.id })).confidence).toBe(confidence)
  })

  it('retains frozen bodies, exact revisions and anchors after the actual source and Opinion are edited', async () => {
    // 编辑真实原图后只当前 Map 正文改变，库关系仍等于收录时的快照。
    const chain = await createChain()
    const { entry } = await collect(chain.graph, chain.claim.id)
    const before = await fixture.relations(workspaceId, entry.id)
    await fixture.editGraph(chain.graph.mapId, [chain.source.id], { nodes: { put: [
      { ...chain.news, payload: { content: '原报道现已修改。', context: {} } },
      { ...chain.opinion, payload: { ...chain.opinion.payload, reason: '新核查意见', score: 1 } },
    ] } })
    expect(await fixture.relations(workspaceId, entry.id)).toEqual(before)
  })

  it('returns the same frozen relation history after the source Map is deleted', async () => {
    // 删除来源只能影响当前图定位，历史关系读取不访问已删除 Map。
    const chain = await createChain()
    const { entry } = await collect(chain.graph, chain.claim.id)
    const before = await fixture.relations(workspaceId, entry.id)
    await fixture.client.dispatch(randomUUID(), 'map.delete', { mapId: chain.graph.mapId, expectedRevision: chain.graph.revision })
    expect(await fixture.relations(workspaceId, entry.id)).toEqual(before)
  })

  it('keeps relation history and digest readable after withdrawal', async () => {
    // 撤回改变可复用状态，不删除固定历史或改写摘要。
    const chain = await createChain()
    const { entry } = await collect(chain.graph, chain.claim.id)
    const before = await fixture.relations(workspaceId, entry.id)
    await fixture.client.dispatch(randomUUID(), 'evidence.withdraw', {
      workspaceId, entryId: entry.id, expectedRevision: entry.revision, reason: '该材料当前停止复用。',
    })
    expect(await fixture.relations(workspaceId, entry.id)).toEqual(before)
  })

  it('returns the first captured relations for an exact duplicate after downstream content changes', async () => {
    // Claim 版本和显式依据不变，图中的新增核查事实不能隐式刷新原库条目。
    const chain = await createChain()
    const { entry, params } = await collect(chain.graph, chain.claim.id)
    const before = await fixture.relations(workspaceId, entry.id)
    await fixture.editGraph(chain.graph.mapId, [chain.source.id], { nodes: { put: [
      { ...chain.opinion, payload: { ...chain.opinion.payload, reason: '收录后的新核查事实。' } },
    ] } })
    const duplicate = await fixture.client.dispatch(randomUUID(), 'evidence.collect', params)
    expect(duplicate.data).toMatchObject({ existing: true, replayed: false, entry: { id: entry.id, contentDigest: entry.contentDigest } })
    expect(await fixture.relations(workspaceId, entry.id)).toEqual(before)
  })

  it('accepts a legal receipt replay after deletion without recapturing relation history', async () => {
    // 已接受收据优先于来源当前状态，重放保持第一次固定内容。
    const chain = await createChain()
    const { entry, params, requestId } = await collect(chain.graph, chain.claim.id)
    const before = await fixture.relations(workspaceId, entry.id)
    await fixture.client.dispatch(randomUUID(), 'map.delete', { mapId: chain.graph.mapId, expectedRevision: chain.graph.revision })
    expect(await fixture.client.dispatch(requestId, 'evidence.collect', params)).toMatchObject({ replayed: true,
      data: { replayed: true, entry: { id: entry.id, contentDigest: entry.contentDigest } } })
    expect(await fixture.relations(workspaceId, entry.id)).toEqual(before)
  })

  it('allows the actual viewer to read the frozen relations', async () => {
    // 使用真实 viewer 令牌，查询不能要求 editor 或取得分支写权限。
    const { graph, claim } = await createIsolated()
    const { entry } = await collect(graph, claim.id)
    expect(await fixture.relations(workspaceId, entry.id, fixture.viewerToken))
      .toEqual(await fixture.relations(workspaceId, entry.id))
  })

  it('hides a known entry and its original body from a real nonmember', async () => {
    // 已知 UUID 也不透露工作区中条目是否存在。
    const { graph, claim } = await createIsolated('非成员不应读取的库原文。')
    const { entry } = await collect(graph, claim.id)
    const response = await fixture.relationResponse({ workspaceId, entryId: entry.id }, fixture.outsiderToken)
    expect(response).toMatchObject({ status: 404, body: { ok: false, error: { code: 'WORKSPACE_NOT_FOUND' } } })
    expect(JSON.stringify(response.body)).not.toContain('非成员不应读取的库原文。')
    expect(response.body).not.toHaveProperty('data')
  })

  it('rejects an entry queried through another authorized workspace', async () => {
    // owner 同时有两个工作区权限仍须逐条绑定实际归属。
    const { graph, claim } = await createIsolated()
    const { entry } = await collect(graph, claim.id)
    const otherWorkspaceId = await fixture.createWorkspace()
    const response = await fixture.relationResponse({ workspaceId: otherWorkspaceId, entryId: entry.id })
    expect(response).toMatchObject({ status: 422, body: { ok: false, error: { code: 'EVIDENCE_WORKSPACE_MISMATCH' } } })
    expect(response.body).not.toHaveProperty('data')
  })

  it('keeps a registered non-Claim other-Map basis with the same nodeId separate from the Claim root', async () => {
    // 收录主体仍是Claim，依据可为注册News；跨Map同nodeId保留独立身份及原依据序号。
    const nodeId = randomUUID()
    const root = await createIsolated('根陈述原文。', nodeId)
    const basis = await fixture.nodeInput(workspaceId, 'factcheck.news', { content: '另一个 Map 的依据原文。', context: {} }, nodeId)
    const basisGraph = await fixture.createGraph(workspaceId, [basis])
    const { entry } = await collect(root.graph, nodeId, 0, { basisRefs: [
      { kind: 'manual', text: '第一项人工理由。' },
      { kind: 'node', ref: relationClaimRef(basisGraph, nodeId) },
    ] })
    const snapshot = relationRequireSnapshot(await fixture.relations(workspaceId, entry.id))
    expect(snapshot.nodes).toHaveLength(2)
    expect(new Set(snapshot.nodes.map((/* 固定节点。 */ node) => /* 检查 Map 身份未被合并。 */ node.ref.mapId)))
      .toEqual(new Set([root.graph.mapId, basisGraph.mapId]))
    const basisNode = snapshot.nodes.find((/* 固定节点。 */ node) => /* 找回外 Map 显式依据。 */ node.ref.mapId === basisGraph.mapId)
    expect(basisNode).toMatchObject({ role: 'basis', nodeSnapshot: { typeId: 'factcheck.news', payload: { content: '另一个 Map 的依据原文。' } } })
    expect(snapshot.edges).toContainEqual(expect.objectContaining({ kind: 'basis', basisIndex: 1,
      from: basisNode?.key, to: snapshot.rootKey }))
    assertClosedEndpoints(snapshot)
  })

  it.each([
    { kind: 'changed node', code: 'EVIDENCE_SOURCE_VERSION_CONFLICT' },
    { kind: 'asset hash', code: 'EVIDENCE_BASIS_INVALID' },
    { kind: 'library digest', code: 'EVIDENCE_DIGEST_MISMATCH' },
    { kind: 'inactive library', code: 'EVIDENCE_INACTIVE' },
  ] as const)('rejects a $kind basis without changing its Claim or publishing partial collection state', async (
    /* 已选择依据在提交时实际违反的版本、摘要或活动状态。 */ { kind, code },
  ) => {
    // 只构造真实来源和真实库条目，再经过同一个公开收录接口验收最终事务边界。
    const root = await createIsolated(), params = relationCollectParams(workspaceId, relationClaimRef(root.graph, root.claim.id))
    if (kind === 'changed node') {
      const news = await fixture.nodeInput(workspaceId, 'factcheck.news', { content: '选择时的依据正文。', context: {} })
      const graph = await fixture.createGraph(workspaceId, [news])
      params.basisRefs = [{ kind: 'node', ref: relationClaimRef(graph, news.id) }]
      await fixture.editGraph(graph.mapId, [news.id], { nodes: { put: [{ ...news, payload: { content: '提交前已更新的依据正文。', context: {} } }] } })
    } else if (kind === 'asset hash') {
      const asset = (await fixture.client.upload(randomUUID(), { workspaceId, filename: 'basis.txt', mediaType: 'text/plain',
        bytes: new TextEncoder().encode('真实资产依据字节。') })).data
      params.basisRefs = [{ kind: 'asset', assetId: asset.id, sha256: 'f'.repeat(64) }]
    } else {
      const basis = await createIsolated('已经收录的库内依据。')
      const { entry } = await collect(basis.graph, basis.claim.id)
      if (kind === 'inactive library') await fixture.client.dispatch(randomUUID(), 'evidence.withdraw', {
        workspaceId, entryId: entry.id, expectedRevision: entry.revision, reason: '选择后不再允许新增引用。',
      })
      params.basisRefs = [{ kind: 'library', ref: { entryId: entry.id,
        contentDigest: kind === 'library digest' ? 'f'.repeat(64) : entry.contentDigest } }]
    }
    const beforeGraph = await fixture.client.read('map.get', { mapId: root.graph.mapId })
    const beforeEntries = await fixture.connection.collection('evidence_entries').countDocuments({ workspaceId })
    const beforeReceipts = await fixture.connection.collection('evidence_receipts').countDocuments({ workspaceId })
    const beforeAssets = await fixture.connection.collection('evidence_asset_refs').countDocuments({ workspaceId })
    const catalogs = fixture.connection.collection<{ _id: string; revision: number }>('evidence_catalogs')
    const beforeCatalog = await catalogs.findOne({ _id: workspaceId })
    await expect(fixture.client.dispatch(randomUUID(), 'evidence.collect', params)).rejects.toMatchObject({ code })
    expect(await fixture.client.read('map.get', { mapId: root.graph.mapId })).toEqual(beforeGraph)
    expect(await fixture.connection.collection('evidence_entries').countDocuments({ workspaceId })).toBe(beforeEntries)
    expect(await fixture.connection.collection('evidence_receipts').countDocuments({ workspaceId })).toBe(beforeReceipts)
    expect(await fixture.connection.collection('evidence_asset_refs').countDocuments({ workspaceId })).toBe(beforeAssets)
    expect(await catalogs.findOne({ _id: workspaceId })).toEqual(beforeCatalog)
  })

  it('rejects a selected node basis from another workspace without publishing the library entry or receipt', async () => {
    // 拥有两边权限仍不能把跨工作区来源内容写入当前固定关系。
    const root = await createIsolated()
    const otherWorkspaceId = await fixture.createWorkspace()
    const basis = await createIsolated('另一工作区材料。', randomUUID(), otherWorkspaceId)
    const params = relationCollectParams(workspaceId, relationClaimRef(root.graph, root.claim.id))
    params.basisRefs = [{ kind: 'node', ref: relationClaimRef(basis.graph, basis.claim.id) }]
    await expect(fixture.client.dispatch(randomUUID(), 'evidence.collect', params))
      .rejects.toMatchObject({ code: 'EVIDENCE_WORKSPACE_MISMATCH' })
    expect(await fixture.connection.collection('evidence_entries').countDocuments({ workspaceId })).toBe(0)
    expect(await fixture.connection.collection('evidence_receipts').countDocuments({ workspaceId })).toBe(0)
  })

  it('traverses actual reference cycles once without inventing successor relations or marking a finite graph truncated', async () => {
    // reference 可成环，visited 必须终止，不能借此扩大结构上下游角色。
    const left = await fixture.nodeInput(workspaceId, 'factcheck.claim', { content: '循环根陈述。', category: null })
    const right = await fixture.nodeInput(workspaceId, 'factcheck.claim', { content: '引用依赖。', category: null })
    const graph = await fixture.createGraph(workspaceId, [left, right], [
      { id: randomUUID(), kind: 'reference', from: left.id, to: right.id },
      { id: randomUUID(), kind: 'reference', from: right.id, to: left.id },
    ])
    const { entry } = await collect(graph, left.id)
    const snapshot = relationRequireSnapshot(await fixture.relations(workspaceId, entry.id))
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.edges).toHaveLength(2)
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.nodes.find((/* 固定节点。 */ node) => /* 引用目标只能成为依赖。 */ node.ref.nodeId === right.id)?.role).toBe('dependency')
    for (const edge of snapshot.edges) expect(edge).toMatchObject({ kind: 'graph', edge: { kind: 'reference' } })
    assertClosedEndpoints(snapshot)
  })

  it('protects an upstream Source asset after source deletion and library withdrawal', async () => {
    // 库冻结的非 Claim 节点资产也属于历史材料，图删除后仍不能删除其字节。
    const asset = (await fixture.client.upload(randomUUID(), {
      workspaceId, filename: 'original.txt', mediaType: 'text/plain', bytes: new TextEncoder().encode('冻结来源字节。'),
    })).data
    const source = await fixture.nodeInput(workspaceId, 'factcheck.source', {
      locator: { kind: 'asset', assetId: asset.id, mediaType: asset.mediaType }, label: '资产来源',
    })
    const news = await fixture.nodeInput(workspaceId, 'factcheck.news', { content: '资产派生正文。', context: {} })
    const claim = await fixture.nodeInput(workspaceId, 'factcheck.claim', { content: '已收录陈述。', category: null })
    const graph = await fixture.createGraph(workspaceId, [source, news, claim], [
      { id: randomUUID(), kind: 'successor', from: source.id, to: news.id },
      { id: randomUUID(), kind: 'successor', from: news.id, to: claim.id },
    ])
    const { entry } = await collect(graph, claim.id)
    await fixture.client.dispatch(randomUUID(), 'map.delete', { mapId: graph.mapId, expectedRevision: graph.revision })
    await fixture.client.dispatch(randomUUID(), 'evidence.withdraw', { workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '停止复用但保留历史。' })
    await expect(fixture.client.dispatch(randomUUID(), 'asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 }))
      .rejects.toMatchObject({ code: 'ASSET_REFERENCED' })
    expect((await fixture.client.download({ kind: 'asset', id: asset.id })).bytes).toEqual(new TextEncoder().encode('冻结来源字节。'))
  })

  it('marks a reference neighborhood exceeding 128 nodes truncated and keeps every saved endpoint closed', async () => {
    // 实际图有 130 节点；捕获边界必须明示，不能返回缺端点的关系。
    const nodes: GraphNodeInput[] = []
    for (let index = 0; index < 130; index++) nodes.push(await fixture.nodeInput(workspaceId, 'factcheck.claim',
      { content: `节点容量 ${index}`, category: null }))
    const root = nodes[0]
    if (!root) throw new Error(RelationTestMessage.SOURCE_NODE_MISSING)
    const edges = nodes.slice(1).map((/* 实际依赖节点。 */ node) => /* 生成真实 reference 出边。 */
      ({ id: randomUUID(), kind: 'reference' as const, from: root.id, to: node.id }))
    const graph = await fixture.createGraph(workspaceId, nodes, edges)
    const { entry } = await collect(graph, root.id)
    const snapshot = relationRequireSnapshot(await fixture.relations(workspaceId, entry.id))
    expect(snapshot.nodes.length).toBeLessThanOrEqual(128)
    expect(snapshot.edges.length).toBeLessThanOrEqual(256)
    expect(snapshot.truncated).toBe(true)
    assertClosedEndpoints(snapshot)
  })

  it('marks more than 256 actual edges truncated while retaining their saved endpoints', async () => {
    // 图允许不同 edgeId 的多个真实引用，边容量与节点容量须分别约束。
    const left = await fixture.nodeInput(workspaceId, 'factcheck.claim', { content: '关系容量根。', category: null })
    const right = await fixture.nodeInput(workspaceId, 'factcheck.claim', { content: '关系容量依赖。', category: null })
    const edges = Array.from({ length: 257 }, (/* 构造器要求的位置参数，不作为关系身份。 */ _value,
      /* 每条实际关系标签的固定位置。 */ index) => {
      // 用真实独立边身份和标签确认不会假冒完整 257 条链路。
      return { id: randomUUID(), kind: 'reference' as const, from: left.id, to: right.id, label: `引用 ${index}` }
    })
    const graph = await fixture.createGraph(workspaceId, [left, right], edges)
    const { entry } = await collect(graph, left.id)
    const snapshot = relationRequireSnapshot(await fixture.relations(workspaceId, entry.id))
    expect(snapshot.nodes).toHaveLength(2)
    expect(snapshot.edges.length).toBeLessThanOrEqual(256)
    expect(snapshot.truncated).toBe(true)
    assertClosedEndpoints(snapshot)
  })

  it('stops a real reference path at depth eight and declares the omitted tail', async () => {
    // 10 跳依赖链不能绕过深度边界，仍应保留 root 与前 8 跳。
    const nodes: GraphNodeInput[] = []
    for (let index = 0; index < 11; index++) nodes.push(await fixture.nodeInput(workspaceId, 'factcheck.claim',
      { content: `深度 ${index}`, category: null }))
    const root = nodes[0]
    if (!root) throw new Error(RelationTestMessage.SOURCE_NODE_MISSING)
    const edges: NonNullable<NonNullable<GraphChanges['edges']>['put']> = []
    for (let index = 0; index < nodes.length - 1; index++) {
      const from = nodes[index], to = nodes[index + 1]
      if (!from || !to) throw new Error(RelationTestMessage.SOURCE_NODE_MISSING)
      edges.push({ id: randomUUID(), kind: 'reference', from: from.id, to: to.id })
    }
    const graph = await fixture.createGraph(workspaceId, nodes, edges)
    const { entry } = await collect(graph, root.id)
    const snapshot = relationRequireSnapshot(await fixture.relations(workspaceId, entry.id))
    expect(snapshot.nodes.length).toBeLessThanOrEqual(9)
    expect(snapshot.truncated).toBe(true)
    assertClosedEndpoints(snapshot)
  })

  it('rejects fixed content plus relations over 1 MiB and rolls back the entry, asset refs and receipt', async () => {
    // 图用多个小于 HTTP 1MiB 的真实编辑形成大材料，收录不能静默裁掉正文以求成功。
    const nodes: GraphNodeInput[] = []
    for (let index = 0; index < 9; index++) nodes.push(await fixture.nodeInput(workspaceId, 'factcheck.claim',
      { content: `大材料 ${index}`, category: null }))
    const root = nodes[0]
    if (!root) throw new Error(RelationTestMessage.SOURCE_NODE_MISSING)
    const graph = await fixture.createGraph(workspaceId, nodes, nodes.slice(1).map((/* 实际大正文依赖。 */ node) =>
      /* 先保存有界 HTTP 输入中的关系。 */ ({ id: randomUUID(), kind: 'reference' as const, from: root.id, to: node.id })))
    const rootIds = nodes.map((/* 实际独立结构根。 */ node) => /* reference 不替代结构根。 */ node.id)
    for (const batch of [nodes.slice(1, 5), nodes.slice(5)]) {
      await fixture.editGraph(graph.mapId, rootIds, { nodes: { put: batch.map((/* 本次实际正文节点。 */ node) =>
        /* 每个正文140KB，两次命令均小于HTTP限制。 */ ({ ...node, payload: { content: 'x'.repeat(140_000), category: null } })) } })
    }
    await expect(collect(graph, root.id)).rejects.toMatchObject({ status: 413, code: 'EVIDENCE_INPUT_LIMIT' })
    expect(await fixture.connection.collection('evidence_entries').countDocuments({ workspaceId })).toBe(0)
    expect(await fixture.connection.collection('evidence_receipts').countDocuments({ workspaceId })).toBe(0)
    expect(await fixture.connection.collection('evidence_asset_refs').countDocuments({ workspaceId })).toBe(0)
  })

  it('returns snapshot null for a real old-format record without rebuilding history from the current Map', async () => {
    // 只在临时 Mongo seam 转成 089 已接受旧格式，旧摘要算法与固定字段保持原约定。
    const chain = await createChain()
    const { entry } = await collect(chain.graph, chain.claim.id)
    const collection = fixture.connection.collection<{ _id: string }>('evidence_entries')
    const document = relationReadRecord(await collection.findOne({ _id: entry.id }))
    const oldDigest = storeCreateInputHash({ claim: document.claim, confidence: document.confidence,
      applicability: document.applicability, decision: document.decision, basisSnapshots: document.basisSnapshots })
    expect((await collection.updateOne({ _id: entry.id }, {
      $unset: { relationSnapshot: '' }, $set: { contentDigest: oldDigest },
    })).modifiedCount).toBe(1)
    const before = await collection.findOne({ _id: entry.id })
    const view = await fixture.relations(workspaceId, entry.id)
    expect(view).toEqual({ workspaceId, entryId: entry.id, contentDigest: oldDigest, snapshot: null })
    expect(await collection.findOne({ _id: entry.id })).toEqual(before)
  })

  it.each([
    { name: 'missing edge endpoint', path: 'relationSnapshot.edges.0.to', value: 'missing-endpoint' },
    { name: 'changed metadata retaining the original digest', path: 'relationSnapshot.truncated', value: true },
  ])('blocks a corrupted $name record before exposing historical content', async (
    /* 本条用例只在真实存储 seam 改坏的关系字段。 */ corruption,
  ) => {
    // 不绕过服务验证返回损坏 DTO，也不允许改坏关系后继续读取原条目。
    const chain = await createChain()
    const { entry } = await collect(chain.graph, chain.claim.id)
    const collection = fixture.connection.collection<{ _id: string }>('evidence_entries')
    expect((await collection.updateOne({ _id: entry.id }, { $set: { [corruption.path]: corruption.value } })).modifiedCount).toBe(1)
    const response = await fixture.relationResponse({ workspaceId, entryId: entry.id })
    expect(response).toMatchObject({ status: 500, body: { ok: false, error: { code: 'EVIDENCE_RECORD_INVALID', retryable: true } } })
    expect(response.body).not.toHaveProperty('data')
    expect(JSON.stringify(response.body)).not.toContain('原报道中的错误陈述。')
    await expect(fixture.client.read('evidence.get', { workspaceId, entryId: entry.id }))
      .rejects.toMatchObject({ code: 'EVIDENCE_RECORD_INVALID' })
  })
})
