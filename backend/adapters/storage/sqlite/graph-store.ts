// 文件职责：在本机持久化事务中维护图版本、执行租约、收据和工作通知。
import { RuntimeMessage } from '../../../../contracts/messages'
import type { GraphStore } from '../../../ports/graph-store'
import type { GraphDocument, GraphReceipt } from '../../../modules/graph/graph-record'
import { GRAPH_COLLECTION } from '../../../modules/graph/graph-record'
import type { GraphWorkGrant, GraphWorkProof } from '../../../../contracts/graph'
import type { Persistence, StorageSession } from '../../../ports/persistence'
import { GraphError } from '../../../modules/shared/domain-error'

type StoredGraph = GraphDocument & { _id: string; dispatch: { version: number; pending: boolean } }
export function sqliteCreateGraphStore(/* 本机统一持久化入口，图操作复用其记录和串行事务能力。 */ database: Persistence, /* 可选外部事务会话，默认 null；提供时完整操作复用该事务。 */ session: StorageSession | null = null): GraphStore {
  // 将统一记录存储适配为图操作，并沿用可选外部事务。
  const records = database.records<StoredGraph>(GRAPH_COLLECTION)
  const read = (/* 当前图集合中的文档身份。 */ id: string) => /* 按图身份读取当前会话可见的存储记录。 */  records.get(id, session)
  const atomic = <T>(/* 需要原子完成的图操作，接收同一事务的存储入口与会话。 */ callback: (/* 绑定本次事务的图存储接口，内部再次访问图时应复用。 */ store: GraphStore, /* 本次原子操作所处的有效事务会话。 */ tx: StorageSession) => Promise<T>): Promise<T> => /* 有外部事务时复用会话，否则为完整图操作创建新事务。 */
    session ? callback(sqliteCreateGraphStore(database, session), session) : database.transaction(/* 持久化层新建的事务会话，传给图操作及其存储入口。 */ tx => /* 向图操作提供绑定该事务的存储入口和会话。 */  callback(sqliteCreateGraphStore(database, tx), tx))
  function sqliteValidateGraph(/* 待创建或提交的图文档，普通写入需检查序列化大小。 */ document: GraphDocument, /* 可选待追加收据，既计入大小也用于识别收尾操作。 */ receipt?: GraphReceipt) {
    // 限制普通图写入的 JSON 大小，保留暂停、取消、删除和失败收尾路径。
    if (receipt && ['run.pause', 'run.cancel', 'map.delete', 'work.fail'].includes(receipt.method)) return
    if (Buffer.byteLength(JSON.stringify(receipt ? { ...document, receipts: [...document.receipts, receipt] } : document)) > 8 * 1024 * 1024) throw new GraphError(413, 'GRAPH_LIMIT', RuntimeMessage.GRAPH_EXCEEDS_THE_8_MIB_DOCUMENT_LIMIT)
  }
  function sqliteIsLease(/* 读取出的图文档或 null，检查租约时不会修改。 */ document: GraphDocument | null, /* 请求方的工作身份、holder 与 fence，还须核对本机期限及运行状态。 */ proof: GraphWorkProof): document is GraphDocument {
    // 按本机时钟验证 holder/fence、到期时间和当前 Run；暂停或删除会使已有租约失效。
    const grant = document?.leases[proof.workId]
    return !!document && !document.deletedAt && !!grant && grant.holderId === proof.holderId && grant.fence === proof.fence
      && Date.parse(grant.expiresAt) > Date.now() && document.run?.id === grant.runId && !document.run.paused
      && ['running', 'waiting', 'completed'].includes(document.run.status)
  }
  return {
    initialize: async () => {
      // 图存储复用持久化层既有结构，无需独立初始化。
    },
    read,
    async create(/* 需要新建的完整图文档，事务内补充首次分发标记。 */ document) {
      // 在事务中创建图和首次通知标记，图身份重复时返回 false。
      sqliteValidateGraph(document)
      return atomic(async (/* 原子包装器提供的事务图接口，此回调直接使用 records 而未调用它。 */ _store, /* 检查图身份与插入新图共用的事务会话。 */ tx) => {
        // 检查图尚不存在后插入，保证检查与创建同属一个事务。
        if (await records.get(document.id, tx)) return false
        await records.insert({ ...document, _id: document.id, dispatch: { version: document.revision, pending: true } }, tx)
        return true
      })
    },
    async *discover() {
      // 遍历仍运行且未暂停、未删除的图，用于恢复待执行工作。
      for (const doc of await records.list({ 'run.status': 'running', 'run.paused': false, deletedAt: null }, session)) yield doc
    },
    async *readDispatch() {
      // 遍历待通知图并携带当前分发版本。
      for (const doc of await records.list({ 'dispatch.pending': true }, session)) yield { ...doc, dispatchVersion: doc.dispatch.version }
    },
    async clearDispatch(/* 已发布通知的图文档身份。 */ id, /* 发送通知时记录的分发版本，清理必须仍匹配此值。 */ version) {
      // 仅清除调用者已经发布的版本，保留并发产生的新通知标记。
      return !!await records.change(id, /* 事务内当前图记录，仅版本和 pending 匹配时返回更新副本。 */ doc => /* 匹配待发布版本后标记已发送，版本变化时不修改。 */  doc.dispatch.version === version && doc.dispatch.pending ? { ...doc, dispatch: { version, pending: false } } : null, session)
    },
    async readLeaseDelay(/* 需要计算租约等待时间的图身份。 */ id, /* 该图内的工作身份，作为租约映射的键。 */ workId) {
      // 按本机时钟计算指定租约的剩余等待时间。
       const doc = await read(id); return Math.max(0, Date.parse(doc?.leases[workId]?.expiresAt ?? new Date(0).toISOString()) - Date.now()) },
    async claim(/* 领取前业务层读到的图快照，用其 revision 检测并发变化。 */ document, /* 从该快照推导的可执行工作，含角色及路由版本。 */ work, /* 申请执行工作的 Host 身份，保存在租约供追踪。 */ hostId, /* 本次领取实例唯一的持有者身份，防止迟到请求混入新授权。 */ holderId, /* 本次租约时长，单位毫秒；由服务层在配置入口校验。 */ leaseMs) {
      // 在事务内重新核对图版本和运行状态，仅在无租约或旧租约到期后增加 fence 并保存新的持有者。
      return atomic(async (/* 原子包装器提供的图存储接口，此领取实现直接操作事务记录。 */ _store, /* 重新读取当前图并保存新租约共用的事务会话。 */ tx) => {
        // 以事务中读到的版本和租约为准，避免根据领取前的旧快照覆盖其他 Host 的授权。
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
    async readLease(/* 待验证工作租约所属的图身份。 */ id, /* 请求方租约凭证，必须匹配身份、fence、有效期及运行状态。 */ proof) {
      // 读取凭证仍有效的图，授权失效时返回 null。
       const doc = await read(id); return sqliteIsLease(doc, proof) ? doc : null },
    async renew(/* 需要续期的工作所在图身份。 */ id, /* 现有工作凭证，过期或已被替换时不得重新生效。 */ proof) {
      // 只延长仍有效且 holder/fence 匹配的租约，已到期或被接管的授权不能通过续租复活。
      return atomic(async (/* 事务图存储接口，此续租实现只使用 records 因而不读取它。 */ _store, /* 读取、验证和写回到期时间所共用的事务会话。 */ tx) => {
        // 在同一事务中检查租约并写回期限，避免校验与续租之间发生接管。
        const doc = await records.get(id, tx)
        if (!sqliteIsLease(doc, proof)) return null
        const grant = doc.leases[proof.workId]
        grant.expiresAt = new Date(Date.now() + grant.leaseMs).toISOString()
        await records.replace(doc as StoredGraph, tx)
        return grant
      })
    },
    async release(/* 需要释放的租约所属图身份。 */ id, /* 释放申请的工作、holder 与 fence，只允许撤销仍匹配的授权。 */ proof) {
      // 将匹配授权的到期时间置零，保留 fence 和工作身份供后续接管与结果确认使用。
      return !!await records.change(id, /* 记录更新器取得的独立图副本，匹配凭证后将其期限置零。 */ doc => {
        // 迟到的释放只影响自己的 holder/fence，不能撤销后来持有者的租约。
        const grant = doc.leases[proof.workId]
        if (!grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence) return null
        grant.expiresAt = new Date(0).toISOString()
        return doc
      }, session)
    },
    async list(/* 调用方已授权访问的工作区身份，限制摘要列表范围。 */ workspaceId) {
      // 返回未删除图的工作区摘要，并按更新时间与身份稳定排序。
      return (await records.list({ workspaceId, deletedAt: null }, session)).sort((/* 排序比较左侧图记录，以更新时间和身份决定位置。 */ a, /* 排序比较右侧图记录，较新时间优先，同时间按身份排序。 */ b) => /* 优先展示最近更新的图，同时间按图身份排序。 */  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
        .map(/* 当前工作区内的未删除图，投影为列表摘要。 */ doc => /* 投影图列表所需的身份、版本、节点数量和更新时间。 */  ({ id: doc.id, workspaceId, revision: doc.revision, name: doc.name, nodeCount: doc.nodes.length,
          claimCount: doc.nodes.filter(/* 图中的单个节点，仅事实节点进入 claimCount。 */ node => /* 仅将事实节点计入摘要中的事实数量。 */  node.data.kind === 'claim').length, updatedAt: doc.updatedAt }))
    },
    async commit(/* 业务计算的待提交图草稿，最终租约取自事务内最新记录。 */ document, /* 业务计算时的原图版本，最终提交必须仍相等。 */ expectedRevision, /* 随本次状态变化一同写入的请求收据。 */ receipt, /* 可选执行工作授权，存在时必须仍有效且 Run 正在运行。 */ grant) {
      // 在事务中校验版本与可选工作租约，一起保存图变更、收据和待通知标记；暂停同时撤销本 Run 的租约。
      sqliteValidateGraph(document, receipt)
      if (receipt.method === 'run.pause' && !session?.inTransaction()) throw new Error(RuntimeMessage.RUN_PAUSE_REQUIRES_THE_AUTHORIZATION_TRANSACTION)
      return atomic(async (/* 事务图接口，此提交实现直接使用 records 完成最终写入。 */ _store, /* 版本核对、租约检查与文档替换共用的事务会话。 */ tx) => {
        // 最终写入前重新读取当前图，拒绝版本变化、租约失效或已停止运行的工作提交。
        const current = await records.get(document.id, tx)
        if (!current || current.revision !== expectedRevision || (grant && (!sqliteIsLease(current, grant) || current.run?.status !== 'running'))) return false
        // 图计算使用的快照可能早于最近一次续租，必须保留事务中读到的最新租约。
        const leases = current.leases
        if (receipt.method === 'run.pause') for (const lease of Object.values(leases)) if (lease.runId === document.run!.id) lease.expiresAt = new Date(0).toISOString()
        await records.replace({ ...document, _id: document.id, revision: expectedRevision + 1, leases,
          receipts: [...current.receipts, receipt], dispatch: { version: expectedRevision + 1, pending: true } }, tx)
        return true
      })
    },
  }
}
