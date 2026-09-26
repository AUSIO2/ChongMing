import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Asset, Page, WorkspaceView } from '../../../../contracts/control'
import { createGraphApi, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => { api = await createGraphApi() }, 30_000)
afterAll(async () => { await api?.close() })

async function workspace(): Promise<WorkspaceView> {
  const result = await api.command('workspace.create', { id: randomUUID(), name: 'Asset list', description: '', agentSource: 'empty' })
  expect(result).toMatchObject({ status: 201, body: { ok: true } })
  return result.body.data
}

async function upload(workspaceId: string, filename: string): Promise<Asset> {
  const bytes = Buffer.from(filename)
  const result = await api.application.assets.upload(api.userToken, { workspaceId, filename, mediaType: 'text/plain',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(),
  }, Readable.from([bytes]))
  return result.data
}

function query(params: unknown, token = api.userToken) {
  return api.rawPost('/api/v1/query', { method: 'asset.list', params }, { authorization: `Bearer ${token}` })
}

async function page(params: { workspaceId: string; cursor?: string; limit?: number }, token = api.userToken): Promise<Page<Asset>> {
  const result = await query(params, token)
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data
}

describe('Workspace asset listing', () => {
  it('paginates tied creation times without duplicates and survives deletion of the cursor asset', async () => {
    const ws = await workspace(), other = await workspace()
    const assets: Asset[] = []
    const metadata = api.connection.collection<{ _id: string; createdAt: string }>('control_assets')
    for (let index = 0; index < 6; index++) {
      const asset = await upload(ws.id, `asset-${index}.txt`)
      asset.createdAt = index < 4 ? '2020-02-02T00:00:00.000Z' : '2020-01-01T00:00:00.000Z'
      await metadata.updateOne({ _id: asset.id }, { $set: { createdAt: asset.createdAt } })
      assets.push(asset)
    }
    await upload(other.id, 'another-workspace.txt')
    assets.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    const first = await page({ workspaceId: ws.id, limit: 2 })
    expect(first.items).toEqual(assets.slice(0, 2))
    expect(Object.keys(first.items[0]).sort()).toEqual(['id', 'workspaceId', 'filename', 'mediaType', 'size', 'sha256', 'createdAt'].sort())
    expect(JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())).toEqual({
      workspaceId: ws.id, createdAt: first.items[1].createdAt, id: first.items[1].id,
    })
    const cursorAsset = first.items[1]
    expect(await api.command('asset.delete', { assetId: cursorAsset.id, expectedSha256: cursorAsset.sha256 })).toMatchObject({ status: 200 })
    const newest = await upload(ws.id, 'arrived-after-first-page.txt')
    const second = await page({ workspaceId: ws.id, limit: 2, cursor: first.nextCursor! })
    const third = await page({ workspaceId: ws.id, limit: 2, cursor: second.nextCursor! })
    expect([...first.items, ...second.items, ...third.items].map(item => item.id)).toEqual(assets.map(item => item.id))
    expect(third.nextCursor).toBeNull()
    const current = await page({ workspaceId: ws.id, limit: 200 })
    expect(current.items.map(item => item.id)).toEqual([newest.id, ...assets.filter(item => item.id !== cursorAsset.id).map(item => item.id)])
  })

  it('defaults to 50 items and enforces the public limit bounds', async () => {
    const ws = await workspace()
    for (let index = 0; index < 51; index++) await upload(ws.id, `limit-${index}.txt`)
    const first = await page({ workspaceId: ws.id })
    expect(first.items).toHaveLength(50)
    const second = await page({ workspaceId: ws.id, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(item => item.id)).size).toBe(51)
    expect((await page({ workspaceId: ws.id, limit: 200 })).items).toHaveLength(51)
    for (const limit of [0, -1, 201, 1.5, '2']) {
      expect(await query({ workspaceId: ws.id, limit })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ARGUMENT' } } })
    }
  }, 15_000)

  it('rejects malformed and cross-workspace cursors without exposing another workspace', async () => {
    const ws = await workspace(), other = await workspace()
    await upload(ws.id, 'first.txt'); await upload(ws.id, 'second.txt')
    const first = await page({ workspaceId: ws.id, limit: 1 })
    expect(await query({ workspaceId: other.id, cursor: first.nextCursor })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_CURSOR' } } })
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())
    for (const invalid of ['not-json', '%%%invalid', first.nextCursor + '=', encode({}), encode({ ...cursor, createdAt: 'not-a-date' }),
      encode({ ...cursor, id: { $gt: '' } }), encode({ ...cursor, extra: true })]) {
      expect(await query({ workspaceId: ws.id, cursor: invalid })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_CURSOR' } } })
    }
    expect(await query({ workspaceId: ws.id, cursor: '', limit: 2 })).toMatchObject({ status: 400 })
    expect(await query({ workspaceId: ws.id, state: 'deleted' })).toMatchObject({ status: 400 })
  })

  it('allows Viewer reads but rechecks membership and token validity on every page', async () => {
    const ws = await workspace()
    await upload(ws.id, 'visible-a.txt'); await upload(ws.id, 'visible-b.txt')
    const viewer = await api.auth.createUser({ id: randomUUID(), displayName: 'Asset Viewer', hostAdmin: false })
    const credentials = await api.auth.createToken(viewer.userId)
    expect(await api.command('member.set', { workspaceId: ws.id, expectedRevision: ws.revision, userId: viewer.userId, role: 'viewer' }))
      .toMatchObject({ status: 200 })
    const first = await page({ workspaceId: ws.id, limit: 1 }, credentials.token)
    expect(first.items).toHaveLength(1)
    expect(await api.command('member.set', { workspaceId: ws.id, expectedRevision: ws.revision + 1, userId: viewer.userId, role: null }))
      .toMatchObject({ status: 200 })
    expect(await query({ workspaceId: ws.id, cursor: first.nextCursor }, credentials.token)).toMatchObject({ status: 404, body: { error: { code: 'WORKSPACE_NOT_FOUND' } } })
    // Membership is checked before decoding a cursor or reading the asset collection.
    expect(await query({ workspaceId: ws.id, cursor: '%%%invalid' }, credentials.token)).toMatchObject({ status: 404 })
    expect(await query({ workspaceId: randomUUID() }, credentials.token)).toMatchObject({ status: 404 })
    await api.auth.revokeToken(credentials.tokenId)
    expect(await query({ workspaceId: ws.id }, credentials.token)).toMatchObject({ status: 401 })
  })

  it('never lists an in-flight GridFS upload or logically deleted asset', async () => {
    const ws = await workspace()
    const bytes = Buffer.alloc(300_000, 'a')
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve })
    const resumed = new Promise<void>(resolve => { release = resolve })
    async function* chunks() {
      yield bytes.subarray(0, 280_000)
      enter(); await resumed
      yield bytes.subarray(280_000)
    }
    const pending = api.application.assets.upload(api.userToken, { workspaceId: ws.id, filename: 'uploading.txt', mediaType: 'text/plain',
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(),
    }, Readable.from(chunks()))
    try {
      await entered
      expect(await page({ workspaceId: ws.id })).toEqual({ items: [], nextCursor: null })
    } finally { release(); await pending }
    const asset = (await pending).data
    expect((await page({ workspaceId: ws.id })).items).toEqual([asset])
    expect(await api.command('asset.delete', { assetId: asset.id, expectedSha256: asset.sha256 })).toMatchObject({ status: 200 })
    expect(await page({ workspaceId: ws.id })).toEqual({ items: [], nextCursor: null })
  })
})
