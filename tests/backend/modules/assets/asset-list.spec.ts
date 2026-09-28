// 验证资产分页的顺序、游标边界、权限复查以及上传/删除状态隔离。
import { createHash, randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Asset, Page, WorkspaceView } from '../../../../contracts/control'
import { createGraphApi, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
beforeAll(async () => {
  // 启动真实图服务夹具，为资产列表测试提供独立数据库和队列。
  api = await createGraphApi() }, 30_000)
afterAll(async () => {
  // 关闭本文件创建的服务、数据库及消息资源。
  await api?.close() })

async function workspace(): Promise<WorkspaceView> {
  // 创建不含 Agent 的独立工作区，隔离每个分页用例的数据。
  const result = await api.command('workspace.create', { id: randomUUID(), name: 'Asset list', description: '', agentSource: 'empty' })
  expect(result).toMatchObject({ status: 201, body: { ok: true } })
  return result.body.data
}

async function upload(/* 测试资产应归属的工作区身份。 */ workspaceId: string, /* 同时作为确定性文件内容和显示名称的测试文件名。 */ filename: string): Promise<Asset> {
  // 以文件名作为确定性内容上传资产，返回用于排序与删除的公开元数据。
  const bytes = Buffer.from(filename)
  const result = await api.application.assets.upload(api.userToken, { workspaceId, filename, mediaType: 'text/plain',
    size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), requestId: randomUUID(),
  }, Readable.from([bytes]))
  return result.data
}

function query(/* 直接发送给 asset.list 查询边界的测试参数。 */ params: unknown, /* 查询使用的用户令牌；省略时使用夹具所有者。 */ token = api.userToken) {
  // 使用指定用户身份发起资产列表查询，保留错误响应以测试边界。
  return api.rawPost('/api/v1/query', { method: 'asset.list', params }, { authorization: `Bearer ${token}` })
}

async function page(/* 已经按列表协议构造的工作区、游标和页大小。 */ params: { workspaceId: string; cursor?: string; limit?: number }, /* 分页读取使用的用户令牌；省略时使用夹具所有者。 */ token = api.userToken): Promise<Page<Asset>> {
  // 读取一页资产并断言成功，供用例组合多页结果。
  const result = await query(params, token)
  expect(result).toMatchObject({ status: 200, body: { ok: true } })
  return result.body.data
}

describe('Workspace asset listing', () => {
  // 组织资产分页、游标权限和未发布内容隔离的回归场景。
  it('paginates tied creation times without duplicates and survives deletion of the cursor asset', async () => {
    // 验证同时间资产无重复漏项，删除游标资产后旧游标仍有效，新上传资产只出现在重新查询中。
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
    assets.sort((/* 预期排序比较中位于左侧的资产元数据。 */ a, /* 预期排序比较中位于右侧的资产元数据。 */ b) => /* 按协议的创建时间和身份顺序构造预期资产列表。 */ b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
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
    expect([...first.items, ...second.items, ...third.items].map(/* 跨页结果中当前提取身份的资产。 */ item => /* 提取跨页结果身份，以检查完整覆盖及排序。 */ item.id)).toEqual(assets.map(/* 完整预期列表中当前提取身份的资产。 */ item => /* 提取原始预期资产身份，与跨页结果逐项比较。 */ item.id))
    expect(third.nextCursor).toBeNull()
    const current = await page({ workspaceId: ws.id, limit: 200 })
    expect(current.items.map(/* 重新查询结果中当前提取身份的资产。 */ item => /* 提取新一轮查询身份，以检查新上传项和删除项的可见性。 */ item.id)).toEqual([newest.id, ...assets.filter(/* 当前判断是否为已删除游标资产的预期项。 */ item => /* 从预期结果排除已逻辑删除的游标资产。 */ item.id !== cursorAsset.id).map(/* 删除项过滤后当前提取身份的预期资产。 */ item => /* 把剩余预期资产转换为身份列表。 */ item.id)])
  })

  it('defaults to 50 items and enforces the public limit bounds', async () => {
    // 验证默认每页 50 项、后续页不重复，并拒绝超限、非整数或非数字分页大小。
    const ws = await workspace()
    for (let index = 0; index < 51; index++) await upload(ws.id, `limit-${index}.txt`)
    const first = await page({ workspaceId: ws.id })
    expect(first.items).toHaveLength(50)
    const second = await page({ workspaceId: ws.id, cursor: first.nextCursor! })
    expect(second.items).toHaveLength(1)
    expect(second.nextCursor).toBeNull()
    expect(new Set([...first.items, ...second.items].map(/* 两页结果中当前提取身份、用于检查去重的资产。 */ item => /* 汇总两页身份，检查所有 51 项只出现一次。 */ item.id)).size).toBe(51)
    expect((await page({ workspaceId: ws.id, limit: 200 })).items).toHaveLength(51)
    for (const limit of [0, -1, 201, 1.5, '2']) {
      expect(await query({ workspaceId: ws.id, limit })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_ARGUMENT' } } })
    }
  }, 15_000)

  it('rejects malformed and cross-workspace cursors without exposing another workspace', async () => {
    // 验证游标绑定工作区，并拒绝非法编码、字段、时间和身份。
    const ws = await workspace(), other = await workspace()
    await upload(ws.id, 'first.txt'); await upload(ws.id, 'second.txt')
    const first = await page({ workspaceId: ws.id, limit: 1 })
    expect(await query({ workspaceId: other.id, cursor: first.nextCursor })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_CURSOR' } } })
    const encode = (/* 需要编码为规范 Base64URL 游标的测试对象。 */ value: unknown) => /* 将用例构造的游标对象编码为协议格式，用于注入不同非法字段。 */ Buffer.from(JSON.stringify(value)).toString('base64url')
    const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString())
    for (const invalid of ['not-json', '%%%invalid', first.nextCursor + '=', encode({}), encode({ ...cursor, createdAt: 'not-a-date' }),
      encode({ ...cursor, id: { $gt: '' } }), encode({ ...cursor, extra: true })]) {
      expect(await query({ workspaceId: ws.id, cursor: invalid })).toMatchObject({ status: 400, body: { error: { code: 'INVALID_CURSOR' } } })
    }
    expect(await query({ workspaceId: ws.id, cursor: '', limit: 2 })).toMatchObject({ status: 400 })
    expect(await query({ workspaceId: ws.id, state: 'deleted' })).toMatchObject({ status: 400 })
  })

  it('allows Viewer reads but rechecks membership and token validity on every page', async () => {
    // 验证 Viewer 可分页读取，但每一页都重新检查成员资格和令牌是否有效。
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
    // 先检查成员资格，再解码游标和查询附件，未授权者不能借游标错误推测工作区内容。
    expect(await query({ workspaceId: ws.id, cursor: '%%%invalid' }, credentials.token)).toMatchObject({ status: 404 })
    expect(await query({ workspaceId: randomUUID() }, credentials.token)).toMatchObject({ status: 404 })
    await api.auth.revokeToken(credentials.tokenId)
    expect(await query({ workspaceId: ws.id }, credentials.token)).toMatchObject({ status: 401 })
  })

  it('never lists an in-flight GridFS upload or logically deleted asset', async () => {
    // 在上传流中途暂停，验证未发布附件不可列出，提交后可见且删除后消失。
    const ws = await workspace()
    const bytes = Buffer.alloc(300_000, 'a')
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(/* 上传流到达断点时完成 entered Promise 的回调。 */ resolve => {
      // 保存上传已到达中断点的通知回调，避免依靠固定等待猜测上传进度。
      enter = resolve })
    const resumed = new Promise<void>(/* 用例允许上传继续时完成 resumed Promise 的回调。 */ resolve => {
      // 保存恢复上传的控制回调，供断言完成或 finally 清理时放行。
      release = resolve })
    async function* chunks() {
      // 分两段产出上传内容，在中间用受控 Promise 暂停以观察未完成上传。
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
