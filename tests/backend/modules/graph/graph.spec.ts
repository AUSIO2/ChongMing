// 验证通用数据图的 HTTP 边界、CAS、幂等和持久化。
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { DefinitionPackage } from '../../../../contracts/data-definition'
import { graphCreateService } from '../../../../backend/modules/graph/graph-service'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { createGraphApi, FACT_TYPES, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi, workspaceId: string
beforeAll(async () => { api = await createGraphApi(); workspaceId = (await api.createWorkspace()).id }, 30_000)
afterAll(async () => { await api?.close() })

describe('Generic graph HTTP API', () => {
  it('creates, relabels, redirects, changes kind and removes both relation kinds without changing nodes', async () => {
    // 两种真实关系使用同一公开补丁往返，删边只影响关系，不级联删除数据。
    const mapId = randomUUID(), newsId = randomUUID(), firstId = randomUUID(), secondId = randomUUID()
    const roots = [newsId, firstId, secondId]
    expect((await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Manual relations' })).status).toBe(201)
    expect((await api.apply(mapId, roots, { nodes: { put: [
      { id: newsId, typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version, payload: { content: 'News', context: {} } },
      { id: firstId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'First fact', category: null } },
      { id: secondId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Second fact', category: null } },
    ] } }, true)).status).toBe(200)
    const before = await api.snapshot(mapId)
    for (const kind of ['successor', 'reference'] as const) {
      const edge = { id: randomUUID(), kind, from: newsId, to: firstId, label: 'Initial label' }
      expect((await api.apply(mapId, roots, { edges: { put: [edge] } })).status).toBe(200)
      expect((await api.snapshot(mapId)).edges).toEqual([expect.objectContaining({ ...edge, revision: 0 })])
      const relabelled = { ...edge, label: 'Changed label' }
      expect((await api.apply(mapId, roots, { edges: { put: [relabelled] } })).status).toBe(200)
      expect((await api.snapshot(mapId)).edges).toEqual([expect.objectContaining({ ...relabelled, revision: 1 })])
      const redirected = { ...relabelled, to: secondId }
      expect((await api.apply(mapId, roots, { edges: { put: [redirected] } })).status).toBe(200)
      expect((await api.snapshot(mapId)).edges).toEqual([expect.objectContaining({ ...redirected, revision: 2 })])
      const changed = { ...redirected, kind: kind === 'successor' ? 'reference' : 'successor' } as const
      expect((await api.apply(mapId, roots, { edges: { put: [changed] } })).status).toBe(200)
      expect((await api.snapshot(mapId)).edges).toEqual([expect.objectContaining({ ...changed, revision: 3 })])
      expect((await api.apply(mapId, roots, { edges: { remove: [edge.id] } })).status).toBe(200)
      expect(await api.snapshot(mapId)).toMatchObject({ edges: [], nodes: before.nodes })
    }
  })

  it('rejects invalid relation patches atomically while permitting an ordinary reference cycle', async () => {
    // 自后继类型让结构环测试真正触达无环校验，而不是先被类型许可拒绝。
    const workspace = await api.createWorkspace(), mapId = randomUUID(), otherMapId = randomUUID()
    const firstId = randomUUID(), secondId = randomUUID(), newsId = randomUUID(), claimId = randomUUID(), externalId = randomUUID()
    const type = { id: 'fixture.relation-node', version: 1 }
    const packageItem: DefinitionPackage = { id: 'fixture.relation-types', version: 1, title: 'Relation checks',
      schemaDialect: 'http://json-schema.org/draft-07/schema#', dependencies: { packages: [], agents: [] }, transitions: [], dataTypes: [{
        ...type, title: 'Relation node', schema: { type: 'object', properties: { content: { type: 'string' } },
          required: ['content'], additionalProperties: false }, successorTypes: [type], references: [],
        agentProjection: { include: ['/content'], mapEntryFilters: [] },
      }] }
    expect((await api.command('definition.publish', { workspaceId: workspace.id, expectedRevision: workspace.revision, package: packageItem })).status).toBe(200)
    for (const id of [mapId, otherMapId]) expect((await api.command('map.create', { workspaceId: workspace.id,
      expectedRevision: workspace.revision + 1, id, name: 'Relation validation' })).status).toBe(201)
    const roots = [firstId, secondId, newsId, claimId], initialEdge = { id: randomUUID(), kind: 'successor' as const, from: firstId, to: secondId }
    expect((await api.apply(mapId, roots, { nodes: { put: [
      { id: firstId, typeId: type.id, typeVersion: type.version, payload: { content: 'First' } },
      { id: secondId, typeId: type.id, typeVersion: type.version, payload: { content: 'Second' } },
      { id: newsId, typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version, payload: { content: 'News', context: {} } },
      { id: claimId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Fact', category: null } },
    ] }, edges: { put: [initialEdge] } }, true)).status).toBe(200)
    expect((await api.apply(otherMapId, [externalId], { nodes: { put: [{ id: externalId,
      typeId: type.id, typeVersion: type.version, payload: { content: 'Another map' } }] } }, true)).status).toBe(200)
    const before = await api.snapshot(mapId)
    for (const invalid of [
      { kind: 'successor', from: claimId, to: newsId, code: 'TRANSITION_NOT_ALLOWED' },
      { kind: 'reference', from: firstId, to: firstId, code: 'INVALID_RELATION' },
      { kind: 'successor', from: secondId, to: firstId, code: 'INVALID_RELATION' },
      { kind: 'reference', from: firstId, to: externalId, code: 'INVALID_RELATION' },
    ] as const) {
      const { code, ...edge } = invalid
      expect(await api.apply(mapId, roots, { edges: { put: [{ id: randomUUID(), ...edge }] } }))
        .toMatchObject({ status: 422, body: { error: { code } } })
      expect(await api.snapshot(mapId)).toMatchObject({ revision: before.revision, nodes: before.nodes, edges: before.edges })
    }
    const references = [{ id: randomUUID(), kind: 'reference' as const, from: firstId, to: secondId },
      { id: randomUUID(), kind: 'reference' as const, from: secondId, to: firstId }]
    expect((await api.apply(mapId, roots, { edges: { put: references } })).status).toBe(200)
    expect((await api.snapshot(mapId)).edges).toEqual([expect.objectContaining(initialEdge),
      expect.objectContaining(references[0]), expect.objectContaining(references[1])])
    expect((await api.branch(mapId, [secondId])).scope.nodeIds).toEqual([secondId])
  })

  it('renames empty and populated maps without acquiring a branch', async () => {
    // 用真实 HTTP 验证统一元数据命令，不伪造新根或放宽既有分支规则。
    for (const populated of [false, true]) {
      const mapId = randomUUID(), nodeId = randomUUID()
      await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Before rename' })
      if (populated) await api.apply(mapId, [nodeId], { nodes: { put: [{ id: nodeId,
        typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'Keep this fact', category: null } }] } }, true)
      const before = await api.snapshot(mapId), requestId = randomUUID()
      const params = { mapId, expectedRevision: before.revision, name: '  改名后的图  ' }
      const renamed = await api.command('map.rename', params, requestId)
      expect(renamed).toMatchObject({ status: 200, body: { replayed: false, data: { snapshot: {
        mapId, name: '改名后的图', revision: before.revision + 1, nodes: before.nodes, edges: before.edges,
      }, createdNodeIds: [], createdEdgeIds: [] } } })
      expect(await api.command('map.rename', params, requestId)).toMatchObject({ status: 200, body: { replayed: true } })
      expect(await api.command('map.rename', { ...params, name: 'Different input' }, requestId))
        .toMatchObject({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } })
      expect(await api.command('map.rename', { ...params, name: 'Stale' }))
        .toMatchObject({ status: 409, body: { error: { code: 'REVISION_CONFLICT' } } })
      expect((await api.snapshot(mapId)).name).toBe('改名后的图')
    }
  })

  it('confirms only the authorized original delete request after a map is tombstoned', async () => {
    // 首次删除成功后原请求应可确认，其他访问和新删除请求仍按已删除处理。
    const workspace = await api.createWorkspace(), mapId = randomUUID(), requestId = randomUUID()
    await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Delete once' })
    const params = { mapId, expectedRevision: 0 }
    expect(await api.command('map.delete', params, requestId))
      .toMatchObject({ status: 200, body: { replayed: false, data: { mapId, deleted: true } } })
    expect(await api.command('map.delete', params, requestId))
      .toMatchObject({ status: 200, body: { replayed: true, data: { mapId, deleted: true } } })
    expect(await api.command('map.delete', { ...params, expectedRevision: 1 }, requestId))
      .toMatchObject({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } })
    expect(await api.command('map.delete', params)).toMatchObject({ status: 404 })
    expect(await api.post('/api/v1/query', { method: 'map.get', params: { mapId } })).toMatchObject({ status: 404 })
    expect(await api.command('map.rename', { mapId, expectedRevision: 1, name: 'Cannot revive' })).toMatchObject({ status: 404 })
    const other = await api.auth.createUser({ id: randomUUID(), displayName: 'Other member', hostAdmin: false })
    const token = (await api.auth.createToken(other.userId)).token
    expect(await api.post('/api/v1/command', { requestId, method: 'map.delete', params }, { authorization: `Bearer ${token}` }))
      .toMatchObject({ status: 404 })
    await api.command('member.set', { workspaceId: workspace.id, expectedRevision: workspace.revision, userId: other.userId, role: 'editor' })
    expect(await api.post('/api/v1/command', { requestId, method: 'map.delete', params }, { authorization: `Bearer ${token}` }))
      .toMatchObject({ status: 404 })
  })

  it('validates rename inputs and keeps viewer access and user receipts separate', async () => {
    // 名称、版本和字段边界由真实协议验证；猜中其他成员请求编号也不取得重放权。
    const workspace = await api.createWorkspace(), mapId = randomUUID(), requestId = randomUUID()
    await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Scoped actions' })
    for (const name of ['', '   ', '字'.repeat(121), null, 123]) {
      expect(await api.command('map.rename', { mapId, expectedRevision: 0, name })).toMatchObject({ status: 400 })
    }
    expect(await api.command('map.rename', { mapId, expectedRevision: -1, name: 'Valid name' })).toMatchObject({ status: 400 })
    expect(await api.command('map.rename', { mapId, expectedRevision: 0, name: 'Valid name', extra: true })).toMatchObject({ status: 400 })
    const editor = await api.auth.createUser({ id: randomUUID(), displayName: 'Second editor', hostAdmin: false })
    const token = (await api.auth.createToken(editor.userId)).token
    await api.command('member.set', { workspaceId: workspace.id, expectedRevision: workspace.revision, userId: editor.userId, role: 'editor' })
    const params = { mapId, expectedRevision: 0, name: '字'.repeat(120) }
    expect(await api.command('map.rename', params, requestId)).toMatchObject({ status: 200 })
    expect(await api.post('/api/v1/command', { requestId, method: 'map.rename', params }, { authorization: `Bearer ${token}` }))
      .toMatchObject({ status: 409, body: { error: { code: 'REVISION_CONFLICT' } } })
    await api.command('member.set', { workspaceId: workspace.id, expectedRevision: workspace.revision + 1, userId: editor.userId, role: 'viewer' })
    for (const method of ['map.rename', 'map.delete']) {
      const guarded = { mapId, expectedRevision: 1, ...(method === 'map.rename' ? { name: 'Viewer write' } : {}) }
      expect(await api.post('/api/v1/command', { requestId: randomUUID(), method, params: guarded }, { authorization: `Bearer ${token}` }))
        .toMatchObject({ status: 403, body: { error: { code: 'FORBIDDEN' } } })
    }
    expect((await api.snapshot(mapId)).name).toBe(params.name)
  })

  it('rejects malformed envelopes and payloads outside the registered type schema', async () => {
    const mapId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Boundary' })
    const before = await api.snapshot(mapId)
    for (const node of [
      { id: randomUUID(), payload: { content: 'missing type' } },
      { id: randomUUID(), typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version, payload: { content: 'missing context' } },
      { id: randomUUID(), typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'claim', category: null, extra: true } },
      { id: randomUUID(), typeId: 'unknown.type', typeVersion: 1, payload: {} },
    ]) {
      const result = await api.command('graph.apply', { mapId, branch: { rootIds: [node.id], expectedVersion: null }, changes: { nodes: { put: [node] } } })
      expect(result.status).toBeGreaterThanOrEqual(400)
      expect(await api.snapshot(mapId)).toEqual(before)
    }
  })

  it('rejects creating the retired Evidence type in a default workspace', async () => {
    // 新工作区只发布当前五种数据类型，写入历史 Evidence 身份必须失败且不改变图。
    const mapId = randomUUID(), evidenceId = randomUUID()
    expect((await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Retired Evidence' })).status).toBe(201)
    const before = await api.snapshot(mapId)
    const result = await api.command('graph.apply', { mapId, branch: { rootIds: [evidenceId], expectedVersion: null }, changes: {
      nodes: { put: [{ id: evidenceId, typeId: 'factcheck.evidence', typeVersion: 1,
        payload: { content: 'Historical evidence', locator: { kind: 'url', url: 'https://example.com/evidence' },
          capturedAt: '2026-09-28T00:00:00.000Z' } }] },
    } })
    expect(result).toMatchObject({ status: 404, body: { error: { code: 'DEFINITION_NOT_FOUND' } } })
    expect(await api.snapshot(mapId)).toEqual(before)
  })

  it('preserves an explicitly empty payload object member through storage and later writes', async () => {
    const mapId = randomUUID(), newsId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Empty context' })
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: [newsId], expectedVersion: null }, changes: { nodes: { put: [{ id: newsId,
      typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version, payload: { content: 'News', context: {} } }] } } })).status).toBe(200)
    expect((await api.snapshot(mapId)).nodes[0].payload).toHaveProperty('context', {})
    await api.apply(mapId, [newsId], { name: 'Renamed' })
    expect((await api.snapshot(mapId)).nodes[0].payload).toHaveProperty('context', {})
  })

  it('confirms an accepted asset-backed source edit after the source and asset are deleted', async () => {
    const content = Buffer.from('source evidence'), sha256 = createHash('sha256').update(content).digest('hex')
    const asset = await api.application.assets.upload(api.userToken,
      { workspaceId, requestId: randomUUID(), filename: 'source.txt', mediaType: 'text/plain', size: content.length, sha256 }, Readable.from([content]))
    const mapId = randomUUID(), nodeId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'Asset replay' })
    const saved = { requestId: randomUUID(), method: 'graph.apply', params: { mapId, branch: { rootIds: [nodeId], expectedVersion: null }, changes: { nodes: { put: [{
      id: nodeId, typeId: FACT_TYPES.source.id, typeVersion: FACT_TYPES.source.version,
      payload: { label: null, locator: { kind: 'asset', assetId: asset.data.id, mediaType: 'text/plain' } },
    }] } } } }
    expect((await api.post('/api/v1/command', saved)).status).toBe(200)
    await api.apply(mapId, [nodeId], { nodes: { remove: [nodeId] } })
    await api.command('asset.delete', { assetId: asset.data.id, expectedSha256: sha256 })
    expect(await api.post('/api/v1/command', saved)).toMatchObject({ status: 200, body: { replayed: true, data: { snapshot: { nodes: [] } } } })
    const changed = structuredClone(saved); changed.params.changes.nodes.put[0].payload.locator.assetId = randomUUID()
    expect(await api.post('/api/v1/command', changed)).toMatchObject({ status: 409, body: { error: { code: 'IDEMPOTENCY_CONFLICT' } } })
  })

  it('rejects an oversized generic document before publishing it', async () => {
    const id = randomUUID(), now = new Date().toISOString()
    await expect(api.store.create({ id, workspaceId, revision: 0, name: 'Too large', nodes: [{ id: randomUUID(), revision: 0,
      typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version, payload: { content: 'x'.repeat(8 * 1024 * 1024), context: {} }, createdAt: now, updatedAt: now }],
    edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now })).rejects.toMatchObject({ status: 413, code: 'GRAPH_LIMIT' })
    expect(await api.store.read(id)).toBeNull()
  })

  it('uses branch versions for CAS, replays identical requests and summarizes registered type ids', async () => {
    const mapId = randomUUID(), newsId = randomUUID(), claimId = randomUUID(), edgeId = randomUUID()
    await api.command('map.create', { workspaceId, expectedRevision: 0, id: mapId, name: 'CAS graph' })
    const requestId = randomUUID(), changes = { nodes: { put: [
      { id: newsId, typeId: FACT_TYPES.news.id, typeVersion: FACT_TYPES.news.version, payload: { content: 'A', context: {} } },
      { id: claimId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'B', category: 'data' } },
    ] }, edges: { put: [{ id: edgeId, kind: 'successor', from: newsId, to: claimId }] } }
    const create = { mapId, branch: { rootIds: [newsId], expectedVersion: null }, changes }
    expect((await api.command('graph.apply', create, requestId)).status).toBe(200)
    expect(await api.command('graph.apply', create, requestId)).toMatchObject({ status: 200, body: { replayed: true } })
    const old = await api.branch(mapId, [newsId])
    expect((await api.command('graph.apply', { mapId, branch: { rootIds: old.scope.rootIds, expectedVersion: old.version },
      changes: { nodes: { put: [{ id: claimId, typeId: FACT_TYPES.claim.id, typeVersion: FACT_TYPES.claim.version, payload: { content: 'changed', category: 'data' } }] } } })).status).toBe(200)
    const stale = await api.command('graph.apply', { mapId, branch: { rootIds: old.scope.rootIds, expectedVersion: old.version }, changes: { name: 'stale' } })
    expect(stale).toMatchObject({ status: 409, body: { error: { code: 'BRANCH_VERSION_CONFLICT' } } })
    expect(await api.post('/api/v1/query', { method: 'map.list', params: { workspaceId } })).toMatchObject({ status: 200,
      body: { data: expect.arrayContaining([expect.objectContaining({ id: mapId, nodeCount: 2,
        typeCounts: { 'factcheck.news': 1, 'factcheck.claim': 1 } })]) } })
    const reopened = await storeCreateConnection(api.uri)
    try { expect(await graphCreateService(storeCreateGraphStore(reopened)).read({ method: 'map.get', params: { mapId } })).toMatchObject({ nodes: [{ id: newsId }, { id: claimId }] }) }
    finally { await reopened.close() }
  })
})
