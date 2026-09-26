import { RuntimeMessage } from '../../../../contracts/messages'
import type { GraphStore } from '../../../ports/graph-store'
import type { GraphDocument, GraphReceipt } from '../../../modules/graph/graph-record'
import { GRAPH_COLLECTION } from '../../../modules/graph/graph-record'
import type { GraphWorkGrant, GraphWorkProof } from '../../../../contracts/graph'
import type { Persistence, StorageSession } from '../../../ports/persistence'
import { GraphError } from '../../../modules/shared/domain-error'

type StoredGraph = GraphDocument & { _id: string; dispatch: { version: number; pending: boolean } }
// 用途：创建图，供后续流程使用。
export function sqliteCreateGraphStore(database: Persistence, session: StorageSession | null = null): GraphStore {
  const records = database.records<StoredGraph>(GRAPH_COLLECTION)
  const read = (id: string) => records.get(id, session)
  const atomic = <T>(callback: (store: GraphStore, tx: StorageSession) => Promise<T>): Promise<T> =>
    session ? callback(sqliteCreateGraphStore(database, session), session) : database.transaction(tx => callback(sqliteCreateGraphStore(database, tx), tx))
  // 用途：校验图输入，发现不符合约束时立即报错。
  function sqliteValidateGraph(document: GraphDocument, receipt?: GraphReceipt) {
    if (receipt && ['run.pause', 'run.cancel', 'map.delete', 'work.fail'].includes(receipt.method)) return
    if (Buffer.byteLength(JSON.stringify(receipt ? { ...document, receipts: [...document.receipts, receipt] } : document)) > 8 * 1024 * 1024) throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.GRAPH_EXCEEDS_THE_8_MIB_DOCUMENT_LIMIT)
  }
  // 用途：判断SQLite 数据是否满足当前条件。
  function sqliteIsLease(document: GraphDocument | null, proof: GraphWorkProof): document is GraphDocument {
    const grant = document?.leases[proof.workId]
    return !!document && !document.deletedAt && !!grant && grant.holderId === proof.holderId && grant.fence === proof.fence
      && Date.parse(grant.expiresAt) > Date.now() && document.run?.id === grant.runId && !document.run.paused
      && ['running', 'waiting', 'completed'].includes(document.run.status)
  }
  return {
    initialize: async () => {},
    read,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async create(document) {
      sqliteValidateGraph(document)
      return atomic(async (_store, tx) => {
        if (await records.get(document.id, tx)) return false
        await records.insert({ ...document, _id: document.id, dispatch: { version: document.revision, pending: true } }, tx)
        return true
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async *discover() {
      for (const doc of await records.list({ 'run.status': 'running', 'run.paused': false, deletedAt: null }, session)) yield doc
    },
    // 用途：分发当前模块命令到对应处理路径。
    async *readDispatch() {
      for (const doc of await records.list({ 'dispatch.pending': true }, session)) yield { ...doc, dispatchVersion: doc.dispatch.version }
    },
    // 用途：分发当前模块命令到对应处理路径。
    async clearDispatch(id, version) {
      return !!await records.change(id, doc => doc.dispatch.version === version && doc.dispatch.pending ? { ...doc, dispatch: { version, pending: false } } : null, session)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readLeaseDelay(id, workId) { const doc = await read(id); return Math.max(0, Date.parse(doc?.leases[workId]?.expiresAt ?? new Date(0).toISOString()) - Date.now()) },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async claim(document, work, hostId, holderId, leaseMs) {
      return atomic(async (_store, tx) => {
        const current = await records.get(document.id, tx)
        if (!current || current.deletedAt || current.revision !== document.revision || current.run?.id !== work.runId || current.run.status !== 'running' || current.run.paused) return null
        const prior = current.leases[work.workId]
        if (prior && Date.parse(prior.expiresAt) > Date.now()) return null
        const grant: GraphWorkGrant = { ...work, hostId, holderId, leaseMs, fence: (prior?.fence ?? 0) + 1, expiresAt: new Date(Date.now() + leaseMs).toISOString() }
        current.leases[work.workId] = grant
        await records.replace(current, tx)
        return grant
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readLease(id, proof) { const doc = await read(id); return sqliteIsLease(doc, proof) ? doc : null },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async renew(id, proof) {
      return atomic(async (_store, tx) => {
        const doc = await records.get(id, tx)
        if (!sqliteIsLease(doc, proof)) return null
        const grant = doc.leases[proof.workId]
        grant.expiresAt = new Date(Date.now() + grant.leaseMs).toISOString()
        await records.replace(doc as StoredGraph, tx)
        return grant
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async release(id, proof) {
      return !!await records.change(id, doc => {
        const grant = doc.leases[proof.workId]
        if (!grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence) return null
        grant.expiresAt = new Date(0).toISOString()
        return doc
      }, session)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async list(workspaceId) {
      return (await records.list({ workspaceId, deletedAt: null }, session)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .map(doc => ({ id: doc.id, workspaceId, revision: doc.revision, name: doc.name, nodeCount: doc.nodes.length,
          claimCount: doc.nodes.filter(node => node.data.kind === 'claim').length, updatedAt: doc.updatedAt }))
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async commit(document, expectedRevision, receipt, grant) {
      sqliteValidateGraph(document, receipt)
      if (receipt.method === 'run.pause' && !session?.inTransaction()) throw new Error(RuntimeMessage.RUN_PAUSE_REQUIRES_THE_AUTHORIZATION_TRANSACTION)
      return atomic(async (_store, tx) => {
        const current = await records.get(document.id, tx)
        if (!current || current.revision !== expectedRevision || (grant && (!sqliteIsLease(current, grant) || current.run?.status !== 'running'))) return false
        const leases = current.leases // Never overwrite renewals with a stale graph snapshot.
        if (receipt.method === 'run.pause') for (const lease of Object.values(leases)) if (lease.runId === document.run!.id) lease.expiresAt = new Date(0).toISOString()
        await records.replace({ ...document, _id: document.id, revision: expectedRevision + 1, leases,
          receipts: [...current.receipts, receipt], dispatch: { version: expectedRevision + 1, pending: true } }, tx)
        return true
      })
    },
  }
}
