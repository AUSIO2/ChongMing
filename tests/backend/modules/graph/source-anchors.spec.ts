// 验证脚注硬换行、原文版本和经真实本机 HTTP 写入后的持久化与原子拒绝。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { applicationCreateLocalService } from '../../../../apps/local-server/application'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { graphReadSourceAnchors, graphValidateSourceAnchors } from '../../../../backend/modules/shared/source-anchors'
import { clientCreateApi } from '../../../../client/graph-client'
import type { GraphChanges, GraphNode, GraphSourceAnchor } from '../../../../contracts/graph'
import { sourceTextReadLines, sourceTextReadQuote } from '../../../../contracts/source-text'
import { verificationConfiguration } from '../../fixtures/verification'

describe('source text anchors', () => {
  it('counts hard newlines and empty lines while retaining exact internal line endings', () => {
    const text = '一\r\n\r\n三\n四\r五\n'
    expect(sourceTextReadLines(text).map(line => line.text)).toEqual(['一', '', '三', '四', '五', ''])
    expect(sourceTextReadQuote(text, 1, 3)).toBe('一\r\n\r\n三')
    expect(sourceTextReadQuote(text, 2, 2)).toBe('')
    expect(sourceTextReadQuote(text, 6, 6)).toBe('')
    for (const range of [[0, 1], [2, 1], [1, 7], [1.5, 2]]) expect(sourceTextReadQuote(text, ...range as [number, number])).toBeUndefined()
  })

  it('resolves escaped JSON Pointer fields and array positions without reading inherited values', () => {
    const source: GraphNode = { id: randomUUID(), revision: 4, typeId: 'fixture.source', typeVersion: 1,
      payload: { 'body/text': [{ '~value': 'original' }] }, createdAt: '', updatedAt: '' }
    const anchor = { path: '/body~1text/0/~0value', sourceRevision: 4, startLine: 1, endLine: 1, quote: 'original' }
    expect(() => graphValidateSourceAnchors({ kind: 'successor', sourceAnchors: [anchor] }, source)).not.toThrow()
    expect(() => graphValidateSourceAnchors({ kind: 'successor', sourceAnchors: [{ ...anchor, path: '/toString' }] }, source)).toThrow()
    expect(() => graphReadSourceAnchors([{ ...anchor, path: '/broken~2pointer' }])).toThrow()
  })
})

let directory: string, database: ReturnType<typeof sqliteCreatePersistence>
let app: ReturnType<typeof applicationCreateLocalService>, server: ReturnType<typeof apiCreateServer>
let client: ReturnType<typeof clientCreateApi>, workspaceId: string
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'source-anchors-'))
  database = sqliteCreatePersistence(directory)
  app = applicationCreateLocalService(database)
  await app.initialize(); await app.control.seed(verificationConfiguration()); await app.startMessaging()
  const user = await app.auth.createUser({ id: randomUUID(), displayName: 'Source annotator', hostAdmin: true })
  const credential = await app.auth.createToken(user.userId)
  server = apiCreateServer(app, { internalToken: randomUUID() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Source anchor test server did not bind')
  client = clientCreateApi({ baseUrl: 'http://127.0.0.1:' + address.port, token: credential.token })
  workspaceId = (await client.dispatch(randomUUID(), 'workspace.create', {
    id: randomUUID(), name: 'Footnotes', description: '', agentSource: 'library',
  })).data.id
})
afterAll(async () => {
  client?.close(); server?.closeAllConnections()
  if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  await app?.closeMessaging(); await database?.close()
  if (directory) await rm(directory, { recursive: true, force: true })
})

async function anchorMap() {
  const workspace = await client.read('workspace.get', { workspaceId })
  const mapId = randomUUID(), newsId = randomUUID(), claimId = randomUUID(), edgeId = randomUUID()
  const text = '第一行\r\n\r\n第三行\n第四行'
  const sourceAnchors: GraphSourceAnchor[] = [1, 3].map(line => ({ path: '/content', sourceRevision: 0,
    startLine: line, endLine: line, quote: sourceTextReadQuote(text, line, line)! }))
  await client.dispatch(randomUUID(), 'map.create', { id: mapId, workspaceId, expectedRevision: workspace.revision, name: 'News and fact' })
  await client.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [newsId], expectedVersion: null }, changes: {
    nodes: { put: [
      { id: newsId, typeId: 'factcheck.news', typeVersion: 1, payload: { content: text, context: {} } },
      { id: claimId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '第一及第三行的事实', category: null } },
    ] }, edges: { put: [{ id: edgeId, kind: 'successor', from: newsId, to: claimId, sourceAnchors }] },
  } })
  return { mapId, newsId, claimId, edgeId, sourceAnchors }
}
async function edit(mapId: string, rootId: string, changes: GraphChanges) {
  const branch = await client.read('branch.get', { mapId, rootIds: [rootId] })
  return client.dispatch(randomUUID(), 'graph.apply', { mapId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, changes })
}

describe('source anchor HTTP persistence', () => {
  it('keeps disjoint source lines on the successor and preserves history after source editing', async () => {
    const { mapId, newsId, edgeId, sourceAnchors } = await anchorMap()
    expect((await client.read('map.get', { mapId })).edges[0].sourceAnchors).toEqual(sourceAnchors)
    const edited = await edit(mapId, newsId, { nodes: { put: [{ id: newsId, typeId: 'factcheck.news', typeVersion: 1,
      payload: { content: 'Updated news body', context: {} } }] } })
    expect(edited.data.snapshot.nodes.find(node => node.id === newsId)?.revision).toBe(1)
    expect(edited.data.snapshot.edges[0].sourceAnchors).toEqual(sourceAnchors)
    const edge = edited.data.snapshot.edges.find(edge => edge.id === edgeId)!
    const relabelled = await edit(mapId, newsId, { edges: { put: [{ id: edge.id, kind: edge.kind,
      from: edge.from, to: edge.to, sourceAnchors, label: 'Unchanged historical attribution' }] } })
    expect(relabelled.data.snapshot.edges[0].sourceAnchors).toEqual(sourceAnchors)
    const mixedAnchors = [...sourceAnchors, { path: '/content', sourceRevision: 1, startLine: 1, endLine: 1, quote: 'Updated news body' }]
    const mixed = await edit(mapId, newsId, { edges: { put: [{ id: edge.id, kind: edge.kind,
      from: edge.from, to: edge.to, sourceAnchors: mixedAnchors }] } })
    expect(mixed.data.snapshot.edges[0].sourceAnchors).toEqual(mixedAnchors)
    await expect(edit(mapId, newsId, { edges: { put: [{ id: edge.id, kind: edge.kind, from: edge.from, to: edge.to,
      sourceAnchors: [{ ...sourceAnchors[0], quote: 'edited historical quote' }] }] } }))
      .rejects.toMatchObject({ code: 'SOURCE_VERSION_CONFLICT' })
    expect((await client.read('map.get', { mapId })).edges[0].sourceAnchors).toEqual(mixedAnchors)
  })

  it('rejects invented quotes, stale revisions, invalid fields and ranges without partially changing the graph', async () => {
    const { mapId, newsId, claimId, edgeId, sourceAnchors } = await anchorMap()
    const before = await client.read('map.get', { mapId })
    const invalid: Partial<GraphSourceAnchor>[] = [
      { quote: 'invented excerpt' }, { sourceRevision: 1 }, { path: '/context' }, { path: '/missing' },
      { startLine: 0 }, { startLine: 3, endLine: 1 }, { endLine: 5 }, { path: '/broken~pointer' },
    ]
    for (const changes of invalid) {
      await expect(edit(mapId, newsId, { edges: { put: [{ id: edgeId, kind: 'successor', from: newsId, to: claimId,
        sourceAnchors: [{ ...sourceAnchors[0], ...changes }] }] } })).rejects.toHaveProperty('code')
      expect(await client.read('map.get', { mapId })).toEqual(before)
    }
    await expect(edit(mapId, newsId, { edges: { put: [{ id: edgeId, kind: 'reference', from: newsId,
      to: claimId, sourceAnchors }] } })).rejects.toMatchObject({ code: 'INVALID_SOURCE_ANCHOR' })
    expect(await client.read('map.get', { mapId })).toEqual(before)
    const changed = await edit(mapId, newsId, { edges: { put: [{ id: edgeId, kind: 'successor', from: newsId, to: claimId,
      sourceAnchors: [{ path: '/content', sourceRevision: 0, startLine: 1, endLine: 3, quote: '第一行\r\n\r\n第三行' }] }] } })
    expect(changed.data.snapshot.edges[0].revision).toBe(1)
    expect(changed.data.snapshot.edges[0].sourceAnchors?.[0].quote).toBe('第一行\r\n\r\n第三行')
  })
})
