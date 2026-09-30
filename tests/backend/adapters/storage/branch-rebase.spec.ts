// 文件职责：用相同契约验证 Mongo 与 SQLite 对分支级重放提供安全的整图 CAS 基础。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { describe, expect, it } from 'vitest'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { storeCreateGraphStore } from '../../../../backend/adapters/storage/mongo/graph-store'
import { sqliteCreatePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { branchReadScope, branchReadVersion } from '../../../../backend/modules/graph/branch-state'
import type { GraphDocument, GraphReceipt } from '../../../../backend/modules/graph/graph-record'
import type { GraphStore } from '../../../../backend/ports/graph-store'

/**
 * 构造完整收据，失败的 CAS 不应留下它，成功重放只能追加一次。
 *
 * @param method 本次测试提交的稳定方法名，用来区分两个逻辑分支。
 */
function branchCreateReceipt(method: string): GraphReceipt {
  return { requestId: randomUUID(), method, inputHash: method, createdNodeIds: [], createdEdgeIds: [], createdAt: new Date().toISOString() }
}

function branchCreateDocument(): { document: GraphDocument; leftId: string; rightId: string } {
  // 两个没有 successor/reference 联系的根代表彼此不相交的实际分支。
  const now = new Date().toISOString(), leftId = randomUUID(), rightId = randomUUID()
  return { leftId, rightId, document: {
    id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Independent branches',
    nodes: [
      { id: leftId, revision: 0, typeId: 'test.value', typeVersion: 1, payload: { value: 'left:0' }, createdAt: now, updatedAt: now },
      { id: rightId, revision: 0, typeId: 'test.value', typeVersion: 1, payload: { value: 'right:0' }, createdAt: now, updatedAt: now },
    ],
    edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now,
  } }
}

/**
 * 模拟服务层把局部变化重放到给定快照；图 revision 留作该快照的存储 CAS token。
 *
 * @param document 作为修改基线的完整最新图快照。
 * @param nodeId 本次局部修改所属的节点身份。
 * @param value 用来确认并发更新没有互相覆盖的新值。
 */
function branchChangeNode(document: GraphDocument, nodeId: string,
  value: string): GraphDocument {
  const updated = structuredClone(document), node = updated.nodes.find(item => item.id === nodeId)
  if (!node) throw new Error('Branch fixture node disappeared')
  node.revision += 1
  node.payload = { value }
  node.updatedAt = new Date().toISOString()
  updated.updatedAt = node.updatedAt
  return updated
}

/**
 * 先制造同一基线的并发草稿，再证明旧草稿不能伪装成新基线，而从最新图重放可同时保留两侧修改。
 *
 * @param store 任一 GraphStore 适配器，必须遵守相同提交契约。
 */
async function branchExpectSafeRebase(store: GraphStore): Promise<void> {
  await store.initialize()
  const { document, leftId, rightId } = branchCreateDocument()
  expect(await store.create(document)).toBe(true)
  const base = (await store.read(document.id))!
  const leftScope = branchReadScope(base, [leftId]), rightScope = branchReadScope(base, [rightId])
  const leftVersion = branchReadVersion(base, leftScope), rightVersion = branchReadVersion(base, rightScope)
  const leftReceipt = branchCreateReceipt('fixture.branch.left'), rightReceipt = branchCreateReceipt('fixture.branch.right')
  const leftDraft = branchChangeNode(base, leftId, 'left:1')
  const staleRightDraft = branchChangeNode(base, rightId, 'right:1')

  expect(await store.commit(leftDraft, base.revision, leftReceipt)).toBe(true)
  const afterLeft = (await store.read(document.id))!
  expect(afterLeft.revision).toBe(1)
  expect(branchReadVersion(afterLeft, leftScope)).not.toBe(leftVersion)
  expect(branchReadVersion(afterLeft, rightScope)).toBe(rightVersion)

  // 正常 CAS 拒绝旧版本；即使调用方误把 expectedRevision 抬到最新值，草稿自身的旧 revision 也必须阻止盲写丢失左分支。
  expect(await store.commit(staleRightDraft, base.revision, rightReceipt)).toBe(false)
  expect(await store.commit(staleRightDraft, afterLeft.revision, rightReceipt)).toBe(false)
  expect((await store.read(document.id))!.nodes.find(node => node.id === leftId)?.payload).toEqual({ value: 'left:1' })

  const rebasedRightDraft = branchChangeNode(afterLeft, rightId, 'right:1')
  expect(await store.commit(rebasedRightDraft, afterLeft.revision, rightReceipt)).toBe(true)
  const final = (await store.read(document.id))!
  expect(final).toMatchObject({ revision: 2, nodes: [
    { id: leftId, revision: 1, payload: { value: 'left:1' } },
    { id: rightId, revision: 1, payload: { value: 'right:1' } },
  ] })
  expect(final.receipts.map(receipt => receipt.requestId)).toEqual([leftReceipt.requestId, rightReceipt.requestId])
}

describe('GraphStore branch rebase contract', () => {
  // 两种持久化实现都必须允许服务层串行化不相交分支，同时拒绝会丢更新的旧草稿。
  it('rebases disjoint branch commits without lost updates in SQLite', async () => {
    // 本机事务适配器也以全图 revision 作为物理 token，并保留分支级逻辑并发。
    const directory = await mkdtemp(path.join(tmpdir(), 'chongming-branch-cas-'))
    const database = sqliteCreatePersistence(directory)
    try { await branchExpectSafeRebase(database.graph()) }
    finally { await database.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it('rebases disjoint branch commits without lost updates in Mongo', async () => {
    // 协作部署使用相同契约；单成员副本集保留生产连接的 majority 读写语义。
    const replica = new MongoMemoryReplSet({ replSet: { count: 1, storageEngine: 'wiredTiger', name: `branch-cas-${randomUUID()}` } })
    let connection: Awaited<ReturnType<typeof storeCreateConnection>> | undefined
    try {
      await replica.start()
      connection = await storeCreateConnection(replica.getUri(`branch_cas_${randomUUID().replaceAll('-', '')}`))
      await branchExpectSafeRebase(storeCreateGraphStore(connection))
    } finally {
      await connection?.close()
      await replica.stop({ doCleanup: true, force: true })
    }
  }, 30_000)
})
