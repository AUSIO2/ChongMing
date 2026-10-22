// 092 先行图提交验收：使用真实既有图存储，回调和图变更共享外层事务。
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { GraphNodeInput } from '../../../../contracts/graph'
import { sqliteCreatePersistence, type SqlitePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { graphCreateService } from '../../../../backend/modules/graph/graph-service'
import type { GraphDocument } from '../../../../backend/modules/graph/graph-record'
import { branchReadSnapshot } from '../../../../backend/modules/graph/branch-state'
import { libraryTestCatalog, libraryTestDocument, libraryTestFrozenClaim } from '../../fixtures/library-claims'

const resources: Array<{ database: SqlitePersistence; directory: string }> = []
enum LibraryCommitTestMessage { CALLBACK_REJECTED = 'Commit usage callback rejected', COMMITTED_GRAPH_MISSING = 'Expected graph in commit transaction' }

afterEach(async () => {
  // 关闭本用例的既有SQLite图存储并移除临时目录，不触碰用户数据库。
  for (const resource of resources.splice(0)) {
    await resource.database.close()
    await rm(resource.directory, { recursive: true, force: true })
  }
})

async function fixture() {
  // 库底层仍由Mongo承担；这里仅验收两种既有GraphStore通用提交seam之一。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-library-graph-commit-'))
  const database = sqliteCreatePersistence(directory)
  resources.push({ database, directory })
  await database.initialize()
  const { document, input } = libraryTestDocument()
  await database.graph().create(document)
  return { database, document, input }
}

function inputFor(
  /* 当前真实目标图节点内容。 */ input: GraphNodeInput,
  /* 本次希望写入的原正文。 */ content: string,
): GraphNodeInput {
  // 只更新普通payload，省略库引用字段以检验保留旧元信息约定。
  return { id: input.id, typeId: input.typeId, typeVersion: input.typeVersion, payload: { ...input.payload, content } }
}

describe('092 graph commit library metadata seam', () => {
  // 不模拟库规则，只验证GraphCommit向app提供正确事务时点与节点元信息。
  it('calls the injected hook once after successful CAS, skips receipt replay, and preserves omitted node usage refs', async () => {
    // 真实库使用同步只能跟随实际图提交；节点编辑省略字段保留引用，显式[]清除。
    const f = await fixture()
    const material = libraryTestFrozenClaim()
    const use = { ...material.ref, reason: '人工明确引用固定材料' }
    const hook = vi.fn(async (
      /* 当前图实际CAS前的完整快照。 */ before: GraphDocument,
      /* CAS成功后同事务中可读的完整新图。 */ next: GraphDocument,
      /* 手动图编辑或执行发布模式。 */ mode: 'manual' | 'work',
    ) => {
      // 读取已成功提交的新版本，证明失败CAS之前没有触发不可回放的同步动作。
      expect(next.revision).toBe(before.revision + 1)
      expect(mode).toBe('manual')
    })
    const requestId = randomUUID()
    const firstBranch = branchReadSnapshot(f.document, [f.input.id])
    const command = { requestId, method: 'graph.apply' as const, params: { mapId: f.document.id,
      branch: { rootIds: [f.input.id], expectedVersion: firstBranch.version },
      changes: { nodes: { put: [{ ...inputFor(f.input, '第一次引用'), libraryClaimRefs: [use] }] } } } }
    await f.database.transaction(async (/* 本次真实图写事务。 */ session) => {
      // hook由app装配到当前session图服务，生产库模块不被图模块导入。
      const graph = graphCreateService(f.database.graph(session), { clientLeases: 'none', onGraphCommit: hook })
      await graph.dispatch(command, { definitions: libraryTestCatalog() })
    })
    expect(hook).toHaveBeenCalledOnce()
    await f.database.transaction(async (/* 收据重放所属的授权事务。 */ session) => {
      // 相同命令无需再次同步使用索引。
      const result = await graphCreateService(f.database.graph(session), { clientLeases: 'none', onGraphCommit: hook }).dispatch(command, { definitions: libraryTestCatalog() })
      expect(result.replayed).toBe(true)
    })
    expect(hook).toHaveBeenCalledOnce()
    for (const clear of [false, true]) {
      await f.database.transaction(async (/* 节点后续版本编辑事务。 */ session) => {
        // 省略和显式清除分别表达保留与结束引用，不把undefined默认当删除。
        const store = f.database.graph(session)
        const current = await store.read(f.document.id)
        if (!current) throw new Error(LibraryCommitTestMessage.COMMITTED_GRAPH_MISSING)
        const branch = branchReadSnapshot(current, [f.input.id])
        const input = inputFor(f.input, clear ? '显式结束引用' : '继续保留引用')
        await graphCreateService(store, { clientLeases: 'none', onGraphCommit: hook }).dispatch({ requestId: randomUUID(), method: 'graph.apply', params: {
          mapId: current.id, branch: { rootIds: [f.input.id], expectedVersion: branch.version },
          changes: { nodes: { put: [{ ...input, ...(clear ? { libraryClaimRefs: [] } : {}) }] } },
        } }, { definitions: libraryTestCatalog() })
      })
      expect((await f.database.graph().read(f.document.id))?.nodes[0].libraryClaimRefs).toEqual(clear ? [] : [use])
    }
    expect(hook).toHaveBeenCalledTimes(3)
  })

  it('rolls back graph and callback writes together when the injected synchronization rejects', async () => {
    // 正式图写和app使用登记在同一事务，回调失败不会留下半份图或索引记录。
    const f = await fixture()
    const before = await f.database.graph().read(f.document.id)
    await expect(f.database.transaction(async (/* 待回滚的真实授权事务。 */ session) => {
      const store = f.database.graph(session)
      const graph = graphCreateService(store, { clientLeases: 'none', async onGraphCommit(
        /* 本次真实旧图快照。 */ _before,
        /* 实际CAS成功后的新图快照。 */ next,
        /* 当前提交的业务模式。 */ mode,
      ) {
        // 记录一份普通事务标记，只测试app同步seam，不实现虚构证据索引。
        const stored = await store.read(next.id)
        expect(stored?.revision).toBe(next.revision)
        await f.database.records<{ _id: string; mode: string }>('fixture_graph_commit_marker').insert({ _id: next.id, mode }, session)
        throw new Error(LibraryCommitTestMessage.CALLBACK_REJECTED)
      } })
      const branch = branchReadSnapshot(f.document, [f.input.id])
      await graph.dispatch({ requestId: randomUUID(), method: 'graph.apply', params: { mapId: f.document.id,
        branch: { rootIds: [f.input.id], expectedVersion: branch.version }, changes: { nodes: { put: [inputFor(f.input, '不应留下的新正文')] } } } },
      { definitions: libraryTestCatalog() })
    })).rejects.toThrow(LibraryCommitTestMessage.CALLBACK_REJECTED)
    expect(await f.database.graph().read(f.document.id)).toEqual(before)
    expect(await f.database.records<{ _id: string; mode: string }>('fixture_graph_commit_marker').count()).toBe(0)
  })
})
