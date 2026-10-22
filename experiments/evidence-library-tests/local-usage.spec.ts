// 验证无证据库适配器的真实SQLite/公共HTTP拒绝非空库引用，不把成功写入当作已登记使用。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { GraphNodeInput } from '../../contracts/graph'
import { applicationCreateLocalService } from '../../apps/local-server/application'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { sqliteCreatePersistence } from '../../backend/adapters/storage/sqlite/persistence'
import { clientCreateApi } from '../../client/graph-client'

enum LocalUsageTestMessage {
  ADDRESS_MISSING = 'Local usage fixture did not bind its HTTP port.',
  TYPE_MISSING = 'Local usage fixture has no actual registered Claim type.',
  CLEANUP_FAILED = 'Local usage fixture cleanup failed.',
}

let directory: string
let database: ReturnType<typeof sqliteCreatePersistence>
let application: ReturnType<typeof applicationCreateLocalService>
let server: ReturnType<typeof apiCreateServer>
let client: ReturnType<typeof clientCreateApi>
let workspaceId: string
let mapId: string
let claim: GraphNodeInput

beforeAll(async () => {
  // 启动自有临时SQLite与HTTP，app故意没有Mongo evidence adapter。
  directory = await mkdtemp(path.join(tmpdir(), 'chongming-local-library-'))
  database = sqliteCreatePersistence(directory)
  application = applicationCreateLocalService(database)
  await application.initialize()
  await application.control.seed()
  await application.startMessaging()
  const owner = await application.auth.createUser({ id: randomUUID(), displayName: 'Local library test', hostAdmin: true })
  const token = (await application.auth.createToken(owner.userId)).token
  server = apiCreateServer(application, { internalToken: randomUUID() })
  await new Promise<void>((/* 实际HTTP监听就绪入口。 */ resolve, /* 端口绑定失败入口。 */ reject) => {
    // 临时回环监听有明确失败终点。
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { /* 就绪后解除启动错误监听。 */ server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(LocalUsageTestMessage.ADDRESS_MISSING)
  client = clientCreateApi({ baseUrl: `http://127.0.0.1:${address.port}`, token })
})

beforeEach(async () => {
  // 每例从真实空Map开始，Claim精确版本来自当前注册目录。
  workspaceId = randomUUID()
  const workspace = (await client.dispatch(randomUUID(), 'workspace.create', { id: workspaceId, name: 'Local library checks',
    description: '', agentSource: 'empty' })).data
  const definitions = await client.read('definition.get', { workspaceId })
  const type = definitions.catalog.dataTypes.find((/* 实际注册类型。 */ item) => /* 不依赖旧Opinion引用字段。 */ item.id === 'factcheck.claim')
  if (!type) throw new Error(LocalUsageTestMessage.TYPE_MISSING)
  claim = { id: randomUUID(), typeId: type.id, typeVersion: type.version, payload: { content: '本地普通陈述。', category: null } }
  mapId = randomUUID()
  await client.dispatch(randomUUID(), 'map.create', { id: mapId, workspaceId, expectedRevision: workspace.revision, name: 'Local test Map' })
})

afterAll(async () => {
  // 任一测试失败仍依次释放客户端、监听、应用、SQLite和自有目录。
  const errors: unknown[] = []
  client?.close()
  if (server) {
    server.beginShutdown()
    server.closeAllConnections()
    if (server.listening) try {
      await new Promise<void>((/* HTTP关闭完成入口。 */ resolve, /* 实际关闭错误入口。 */ reject) => {
        // 关闭回调决定资源排空结果。
        server.close((/* 原生关闭错误。 */ error) => /* 保留实际清理结果。 */ error ? reject(error) : resolve())
      })
    } catch (error) { errors.push(error) }
  }
  try { await application?.closeMessaging() } catch (error) { errors.push(error) }
  try { await database?.close() } catch (error) { errors.push(error) }
  if (directory) try { await rm(directory, { recursive: true, force: true }) } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, LocalUsageTestMessage.CLEANUP_FAILED)
})

async function createPlainClaim(): Promise<void> {
  // 新根在本地服务沿用真实空根证明，不触发证据库读写。
  await client.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [claim.id], expectedVersion: null },
    changes: { nodes: { put: [claim] } } })
}

describe('SQLite without evidence adapter refuses unverifiable library references', () => {
  // 只测新增业务输入的适配器可用性，不新增底层锁/持久化工程验证。
  it.each(['new node', 'existing node'] as const)('rejects nonempty references on a %s and rolls back its Graph write and receipt', async (
    /* 本例使用新根或既有普通节点的实际写入方式。 */ mode,
  ) => {
    // 合法UUID/摘要形状不能在无库服务时被当作已授权材料。
    if (mode === 'existing node') await createPlainClaim()
    const before = await client.read('map.get', { mapId })
    const proof = mode === 'new node' ? { rootIds: [claim.id], expectedVersion: null }
      : { rootIds: [claim.id], expectedVersion: (await client.read('branch.get', { mapId, rootIds: [claim.id] })).version }
    const requestId = randomUUID()
    const params = { mapId, branch: proof, changes: { nodes: { put: [{ ...claim,
      payload: { content: '不应被提交的新正文。', category: null },
      libraryClaimRefs: [{ entryId: randomUUID(), contentDigest: 'a'.repeat(64), reason: '不能核对的库引用。' }],
    }] } } }
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(client.dispatch(requestId, 'graph.apply', params)).rejects.toMatchObject({ status: 503, code: 'EVIDENCE_UNAVAILABLE' })
      expect(await client.read('map.get', { mapId })).toEqual(before)
    }
  })

  it('keeps ordinary no-reference editing and an explicit empty reference array available', async () => {
    // 空refs不要求启动Mongo证据库，普通本地图仍按原版本证明编辑。
    await createPlainClaim()
    const branch = await client.read('branch.get', { mapId, rootIds: [claim.id] })
    const changed = await client.dispatch(randomUUID(), 'graph.apply', { mapId,
      branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, changes: { nodes: { put: [{ ...claim,
        payload: { content: '正常本地编辑。', category: null }, libraryClaimRefs: [],
      }] } } })
    expect(changed.data.snapshot.nodes[0]).toMatchObject({ revision: 1, payload: { content: '正常本地编辑。' }, libraryClaimRefs: [] })
  })
})
