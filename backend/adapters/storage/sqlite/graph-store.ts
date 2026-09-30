// 文件职责：在本机持久化事务中维护图版本、执行租约、收据和工作通知。
import { RuntimeMessage } from '../../../../contracts/messages'
import type { GraphCommitGuard, GraphStore } from '../../../ports/graph-store'
import type { GraphDocument, GraphOwnershipReceipt, GraphOwnershipRecord, GraphReceipt } from '../../../modules/graph/graph-record'
import { GRAPH_COLLECTION, storeAssertCurrentGraphSchema } from '../../../modules/graph/graph-record'
import type { GraphWorkGrant, GraphWorkProof } from '../../../../contracts/graph'
import type { Persistence, StorageSession } from '../../../ports/persistence'
import { GraphError } from '../../../modules/shared/domain-error'

type StoredGraph = GraphDocument & { _id: string; dispatch: { version: number; pending: boolean } }
/**
 * 将统一记录存储适配为图操作，并沿用可选外部事务。
 *
 * @param database 本机统一持久化入口，图操作复用其记录和串行事务能力。
 * @param session 可选外部事务会话，默认 null；提供时完整操作复用该事务。
 */
export function sqliteCreateGraphStore(database: Persistence, session: StorageSession | null = null): GraphStore {
  const records = database.records<StoredGraph>(GRAPH_COLLECTION)
  /**
   * 按图身份读取当前会话可见的存储记录；旧节点、Run 或租约必须先显式迁移。
   *
   * @param id 当前图集合中的文档身份。
   */
  const read = async (id: string) => {
    const document = await records.get(id, session)
    if (document) storeAssertCurrentGraphSchema(document)
    return document
  }
  /**
   * @param callback 需要原子完成的图操作，接收同一事务的存储入口与会话。
   */
  const atomic = <T>(callback: (store: GraphStore, tx: StorageSession) => Promise<T>): Promise<T> => /* 有外部事务时复用会话，否则为完整图操作创建新事务。 */
    session ? callback(sqliteCreateGraphStore(database, session), session) : database.transaction(tx => /* 向图操作提供绑定该事务的存储入口和会话。 */  callback(sqliteCreateGraphStore(database, tx), tx))
  /**
   * 限制普通图写入的 JSON 大小，保留暂停、取消、删除和失败收尾路径。
   *
   * @param document 待创建或提交的图文档，普通写入需检查序列化大小。
   * @param receipt 可选待追加收据，既计入大小也用于识别收尾操作。
   */
  function sqliteValidateGraph(document: GraphDocument, receipt?: GraphReceipt) {
    storeAssertCurrentGraphSchema(document)
    if (receipt && ['run.pause', 'run.cancel', 'map.delete', 'work.fail'].includes(receipt.method)) return
    if (Buffer.byteLength(JSON.stringify(receipt ? { ...document, receipts: [...document.receipts, receipt] } : document)) > 8 * 1024 * 1024) throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.GRAPH_EXCEEDS_THE_8_MIB_DOCUMENT_LIMIT)
  }
  /**
   * 按本机时钟验证 holder/fence、到期时间和当前 Run；暂停或删除会使已有租约失效。
   *
   * @param document 读取出的图文档或 null，检查租约时不会修改。
   * @param proof 请求方的工作身份、holder 与 fence，还须核对本机期限及运行状态。
   */
  function sqliteIsLease(document: GraphDocument | null, proof: GraphWorkProof): document is GraphDocument {
    const grant = document?.leases[proof.workId]
    const run = document?.runs.find(item => item.id === grant?.runId)
    return !!document && !document.deletedAt && !!grant && grant.holderId === proof.holderId && grant.fence === proof.fence
      && Date.parse(grant.expiresAt) > Date.now() && !!run && !run.paused
      && ['running', 'waiting', 'completed'].includes(run.status)
  }
  /**
   * 最终写入同时绑定存储租约、Run、Operation、阶段、槽位和冻结规格，不能只凭 holder/fence 提交。
   *
   * @param document 当前事务中的图状态。
   * @param expected 最终提交携带的完整工作授权。
   */
  function sqliteMatchesGrant(document: GraphDocument, expected: GraphWorkGrant): boolean {
    const stored = document.leases[expected.workId]
    const run = document.runs.find(item => item.id === expected.runId)
    const operation = run?.operations.find(item => item.id === expected.operationId)
    const stage = operation?.stages.find(item => item.stageId === expected.stageId)
    return !!stored && expected.mapId === document.id && !!run
      && operation?.status === 'running' && operation.specHash === expected.specHash
      && !!stage?.expectedWorkIds.includes(expected.workId)
      && !!stage.planSlots.some(slot => slot.id === expected.slotId && slot.stageId === expected.stageId)
      && stored.mapId === expected.mapId && stored.runId === expected.runId && stored.operationId === expected.operationId
      && stored.stageId === expected.stageId && stored.slotId === expected.slotId && stored.specHash === expected.specHash
  }
  /**
   * @param document 当前事务图。
   * @param guard 调用方观察的占有条件。
   */
  function sqliteMatchesCommitGuard(document: GraphDocument, guard?: GraphCommitGuard): boolean {
    if (!guard) return true
    if ((document.ownershipRevision ?? 0) !== guard.ownershipRevision) return false
    if (guard.editor) {
      const ownership = document.branchOwnerships?.[guard.editor.leaseId]
      if (!ownership || ownership.kind !== 'editor' || ownership.ownerUserId !== guard.editor.ownerUserId
        || ownership.holderId !== guard.editor.holderId || ownership.fence !== guard.editor.fence
        || ownership.expiresAt === null || Date.parse(ownership.expiresAt) <= Date.now()) return false
    }
    if (guard.runId) {
      const ownership = document.branchOwnerships?.[guard.runId]
      if (!ownership || ownership.kind !== 'run' || ownership.runId !== guard.runId) return false
    }
    if (guard.control) {
      const control = document.branchOwnerships?.[guard.control.leaseId]
      if (!control || control.kind !== 'control' || control.runId !== guard.control.runId
        || control.ownerUserId !== guard.control.ownerUserId || control.holderId !== guard.control.holderId
        || control.fence !== guard.control.fence || Date.parse(control.expiresAt) <= Date.now()) return false
    }
    return true
  }
  return {
    initialize: async () => {
      // 图存储复用持久化层既有结构，无需独立初始化。
    },
    read,
    /**
     * 在事务中创建图和首次通知标记，图身份重复时返回 false。
     *
     * @param document 需要新建的完整图文档，事务内补充首次分发标记。
     */
    async create(document) {
      sqliteValidateGraph(document)
      return atomic(async (_store, tx) => {
        // 检查图尚不存在后插入，保证检查与创建同属一个事务。
        if (await records.get(document.id, tx)) return false
        await records.insert({ ...document, _id: document.id, dispatch: { version: document.revision, pending: true } }, tx)
        return true
      })
    },
    async *discover() {
      // 遍历仍运行且未暂停、未删除的图，用于恢复待执行工作。
      for (const doc of await records.list({ deletedAt: null }, session)) {
        storeAssertCurrentGraphSchema(doc)
        if (doc.runs.some(run => run.status === 'running' && !run.paused)) yield doc
      }
    },
    async *readDispatch() {
      // 遍历待通知图并携带当前分发版本。
      for (const doc of await records.list({ 'dispatch.pending': true }, session)) {
        storeAssertCurrentGraphSchema(doc)
        yield { ...doc, dispatchVersion: doc.dispatch.version }
      }
    },
    /**
     * 仅清除调用者已经发布的版本，保留并发产生的新通知标记。
     *
     * @param id 已发布通知的图文档身份。
     * @param version 发送通知时记录的分发版本，清理必须仍匹配此值。
     */
    async clearDispatch(id, version) {
      return !!await records.change(id, doc => /* 匹配待发布版本后标记已发送，版本变化时不修改。 */  doc.dispatch.version === version && doc.dispatch.pending ? { ...doc, dispatch: { version, pending: false } } : null, session)
    },
    /**
     * 按本机时钟计算指定租约的剩余等待时间。
     *
     * @param id 需要计算租约等待时间的图身份。
     * @param workId 该图内的工作身份，作为租约映射的键。
     */
    async readLeaseDelay(id, workId) {
       const doc = await read(id); return Math.max(0, Date.parse(doc?.leases[workId]?.expiresAt ?? new Date(0).toISOString()) - Date.now()) },
    /**
     * 在事务内重新核对图版本和运行状态，仅在无租约或旧租约到期后增加 fence 并保存新的持有者。
     *
     * @param document 领取前业务层读到的图快照，用其 revision 检测并发变化。
     * @param work 从该快照推导的可执行工作，含角色及路由版本。
     * @param hostId 申请执行工作的 Host 身份，保存在租约供追踪。
     * @param holderId 本次领取实例唯一的持有者身份，防止迟到请求混入新授权。
     * @param leaseMs 本次租约时长，单位毫秒；由服务层在配置入口校验。
     */
    async claim(document, work, hostId, holderId, leaseMs) {
      return atomic(async (_store, tx) => {
        // 以事务中读到的版本和租约为准，避免根据领取前的旧快照覆盖其他 Host 的授权。
        const current = await records.get(document.id, tx)
        if (current) storeAssertCurrentGraphSchema(current)
        const run = current?.runs.find(item => item.id === work.runId)
        if (!current || current.deletedAt || current.revision !== document.revision || !run || run.status !== 'running' || run.paused) return null
        const prior = current.leases[work.workId]
        if (prior && Date.parse(prior.expiresAt) > Date.now()) return null
        const grant: GraphWorkGrant = { ...work, hostId, holderId, leaseMs, fence: (prior?.fence ?? 0) + 1, expiresAt: new Date(Date.now() + leaseMs).toISOString() }
        current.leases[work.workId] = grant
        await records.replace(current, tx)
        return grant
      })
    },
    /**
     * 读取凭证仍有效的图，授权失效时返回 null。
     *
     * @param id 待验证工作租约所属的图身份。
     * @param proof 请求方租约凭证，必须匹配身份、fence、有效期及运行状态。
     */
    async readLease(id, proof) {
       const doc = await read(id); return sqliteIsLease(doc, proof) ? doc : null },
    /**
     * 只延长仍有效且 holder/fence 匹配的租约，已到期或被接管的授权不能通过续租复活。
     *
     * @param id 需要续期的工作所在图身份。
     * @param proof 现有工作凭证，过期或已被替换时不得重新生效。
     */
    async renew(id, proof) {
      return atomic(async (_store, tx) => {
        // 在同一事务中检查租约并写回期限，避免校验与续租之间发生接管。
        const doc = await records.get(id, tx)
        if (doc) storeAssertCurrentGraphSchema(doc)
        if (!sqliteIsLease(doc, proof)) return null
        const grant = doc.leases[proof.workId]
        grant.expiresAt = new Date(Date.now() + grant.leaseMs).toISOString()
        await records.replace(doc as StoredGraph, tx)
        return grant
      })
    },
    /**
     * 将匹配授权的到期时间置零，保留 fence 和工作身份供后续接管与结果确认使用。
     *
     * @param id 需要释放的租约所属图身份。
     * @param proof 释放申请的工作、holder 与 fence，只允许撤销仍匹配的授权。
     */
    async release(id, proof) {
      return !!await records.change(id, doc => {
        // 迟到的释放只影响自己的 holder/fence，不能撤销后来持有者的租约。
        storeAssertCurrentGraphSchema(doc)
        const grant = doc.leases[proof.workId]
        if (!grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence) return null
        grant.expiresAt = new Date(0).toISOString()
        return doc
      }, session)
    },
    /**
     * 返回未删除图的工作区摘要，并按更新时间与身份稳定排序。
     *
     * @param workspaceId 调用方已授权访问的工作区身份，限制摘要列表范围。
     */
    async list(workspaceId) {
      const documents = await records.list({ workspaceId, deletedAt: null }, session)
      documents.forEach(storeAssertCurrentGraphSchema)
      return documents.sort((a, b) => /* 优先展示最近更新的图，同时间按图身份排序。 */  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .map(doc => ({
          id: doc.id,
          workspaceId,
          revision: doc.revision,
          name: doc.name,
          nodeCount: doc.nodes.length,
          typeCounts: Object.fromEntries([...doc.nodes.reduce((counts, node) => {
            // 本机和协作存储保持相同的 typeId 聚合语义。
            counts.set(node.typeId, (counts.get(node.typeId) ?? 0) + 1)
            return counts
          }, new Map<string, number>())]),
          updatedAt: doc.updatedAt,
        }))
    },
    /**
     * @param mapId 图身份。
     * @param expectedRevision 内容版本。
     * @param expectedOwnershipRevision 协调版本。
     * @param ownerships 新占有字典。
     * @param receipt 幂等收据。
     */
    async commitOwnership(mapId, expectedRevision, expectedOwnershipRevision,
      ownerships: Record<string, GraphOwnershipRecord>, receipt: GraphOwnershipReceipt) {
      return atomic(async (_store, tx) => {
        const current = await records.get(mapId, tx)
        if (!current || current.revision !== expectedRevision || (current.ownershipRevision ?? 0) !== expectedOwnershipRevision) return false
        await records.replace({ ...current, branchOwnerships: ownerships, ownershipRevision: expectedOwnershipRevision + 1,
          ownershipReceipts: [...(current.ownershipReceipts ?? []), receipt],
          dispatch: { version: current.dispatch.version + 1, pending: true } }, tx)
        return true
      })
    },
    /**
     * 先保证草稿确实由 expectedRevision 快照派生，再在事务中校验持久版本与可选租约；CAS 失败后的分支重放必须从最新图重新生成草稿。
     *
     * @param document 业务计算的待提交图草稿，最终租约取自事务内最新记录。
     * @param expectedRevision 业务计算时的原图版本，最终提交必须仍相等。
     * @param receipt 随本次状态变化一同写入的请求收据。
     * @param grant 可选执行工作授权，存在时必须仍有效且 Run 正在运行。
     * @param guard 可选分支占有条件。
     */
    async commit(document, expectedRevision, receipt, grant, guard) {
      sqliteValidateGraph(document, receipt)
      if (document.revision !== expectedRevision) return false
      if (receipt.method === 'run.pause' && !session?.inTransaction()) throw new Error(RuntimeMessage.RUN_PAUSE_REQUIRES_THE_AUTHORIZATION_TRANSACTION)
      return atomic(async (_store, tx) => {
        // 最终写入前重新读取当前图，拒绝版本变化、租约失效或已停止运行的工作提交。
        const current = await records.get(document.id, tx)
        if (current) storeAssertCurrentGraphSchema(current)
        if (!current || current.revision !== expectedRevision || !sqliteMatchesCommitGuard(current, guard)
          || (grant && (!sqliteIsLease(current, grant) || !sqliteMatchesGrant(current, grant)
            || current.runs.find(run => run.id === grant.runId)?.status !== 'running'))) return false
        // 图计算使用的快照可能早于最近一次续租，必须保留事务中读到的最新租约。
        const leases = current.leases
        if (receipt.method === 'run.pause') for (const lease of Object.values(leases)) if (lease.runId === guard?.runId) lease.expiresAt = new Date(0).toISOString()
        await records.replace({ ...document, _id: document.id, revision: expectedRevision + 1, leases,
          ownershipRevision: guard ? document.ownershipRevision : current.ownershipRevision,
          branchOwnerships: guard ? document.branchOwnerships : current.branchOwnerships,
          ownershipReceipts: guard ? document.ownershipReceipts : current.ownershipReceipts,
          receipts: [...current.receipts, receipt], dispatch: { version: current.dispatch.version + 1, pending: true } }, tx)
        return true
      })
    },
  }
}
