// 在真实图提交的同一事务中登记显式消费者，并永久保留已结束版本和复用运行的上下文。
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

import { EvidenceMessage, type EvidenceUseRef, type EvidenceUseSummary } from '../../../contracts/evidence-library'
import type { GraphNode } from '../../../contracts/graph'
import type { GraphOperation, GraphRun } from '../../../contracts/graph-run'
import type { Persistence, StorageSession } from '../../ports/persistence'
import { storeCreateInputHash, type GraphDocument } from '../graph/graph-record'
import { GraphError } from '../shared/domain-error'
import { evidenceParseNodeSnapshot, type EvidenceEntryDocument } from './evidence-record'
import { evidenceCreateUseIdentity, evidenceParseUsageCatalog, evidenceParseUseDocument, evidenceParseUseSummary,
  type EvidenceUsageCatalogDocument, type EvidenceUseDocument } from './evidence-usage-record'

interface UseContext {
  kind: 'work' | 'manual'
  runId: string | null
  operationId: string | null
  workId: string | null
  reusedFromOperationId: string | null
}

export function evidenceCreateUsageService(
  /* 拥有同图事务、时钟与使用记录集合的真实持久化端口。 */ database: Persistence,
  /* 在同一会话校验库条目工作区、固定内容与历史摘要的库内读取。 */ readEntry: (
    /* 图写入共享的活动存储会话。 */ session: StorageSession,
    /* 消费者实际归属的工作区。 */ workspaceId: string,
    /* 明确引用的库条目身份。 */ entryId: string,
  ) => Promise<EvidenceEntryDocument>,
) {
  // 使用历史和目录只有此模块写入，公开分页始终由有界Mongo查询完成。
  const uses = database.records<EvidenceUseDocument>('evidence_uses')
  const catalogs = database.records<EvidenceUsageCatalogDocument>('evidence_usage_catalogs')

  async function readRevision(
    /* 权限和页查询共用的读取事务。 */ session: StorageSession | null | undefined,
    /* 已授权的证据工作区。 */ workspaceId: string,
    /* 目录精确绑定的库条目。 */ entryId: string,
  ): Promise<number> {
    // 尚无使用的条目从零版本开始，不为只读查询创建目录记录。
    const stored = await catalogs.get(storeCreateInputHash({ workspaceId, entryId }), session)
    return stored ? evidenceParseUsageCatalog(stored).revision : 0
  }

  async function syncGraphUses(
    /* 已取得现有写栅栏、真实图CAS成功且尚未提交的外层事务。 */ session: StorageSession,
    /* 图服务本次成功提交前的真实文档。 */ before: GraphDocument,
    /* 同次真实CAS提交后的文档，含正式节点及完成Operation。 */ after: GraphDocument,
    /* 本次授权动作来源；人工编辑不从旧producer推导Work身份。 */ mode: 'manual' | 'work',
  ): Promise<void> {
    // 先结束旧消费者版本，再登记新增版本和新增运行上下文，失败由外层事务回滚图与使用。
    if (!session.inTransaction()) throw new GraphError(500, 'TRANSACTION_REQUIRED', EvidenceMessage.TRANSACTION_REQUIRED)
    if (before.id !== after.id || before.workspaceId !== after.workspaceId) {
      throw new GraphError(422, 'EVIDENCE_WORKSPACE_MISMATCH', EvidenceMessage.WORKSPACE_MISMATCH)
    }
    const startedAt = new Date(await database.now()).toISOString()
    const changedEntries = new Set<string>()
    const afterNodes = new Map(after.nodes.map((/* 本次正式提交节点。 */ node) => /* 消费者身份仅在本Map内解释。 */ [node.id, node]))
    const beforeNodes = new Map(before.nodes.map((/* 提交前的实际节点。 */ node) => /* 原引用决定是否属于持续引用。 */ [node.id, node]))
    for (const previous of before.nodes) {
      const current = after.deletedAt ? undefined : afterNodes.get(previous.id)
      if (current?.revision === previous.revision) continue
      const active = await uses.list({ workspaceId: before.workspaceId, 'consumer.mapId': before.id,
        'consumer.nodeId': previous.id, 'consumer.revision': previous.revision, endedAt: null }, session)
      for (const stored of active) {
        const use = evidenceParseUseDocument(stored)
        await uses.replace({ ...use, endedAt: startedAt }, session)
        changedEntries.add(use.ref.entryId)
      }
    }
    if (!after.deletedAt && mode === 'manual') {
      for (const node of after.nodes) {
        const previous = beforeNodes.get(node.id)
        if (previous?.revision === node.revision) continue
        for (const reference of node.libraryClaimRefs ?? []) {
          const entry = await readEntry(session, after.workspaceId, reference.entryId)
          assertDigest(entry.contentDigest, reference.contentDigest)
          const continued = previous?.libraryClaimRefs?.some((
            /* 上一消费者版本明确保留的引用。 */ prior,
          ) => /* 同一固定材料可以继续引用，使用理由变化不重选库正文。 */ prior.entryId === reference.entryId && prior.contentDigest === reference.contentDigest)
          if (!continued && entry.status !== 'active') throw new GraphError(409, 'EVIDENCE_INACTIVE', EvidenceMessage.INACTIVE)
          await createUse(node, reference, { kind: 'manual', runId: null, operationId: null,
            workId: null, reusedFromOperationId: null }, after, session, startedAt, changedEntries)
        }
      }
    }
    if (!after.deletedAt && mode === 'work') {
      const previousRuns = new Map([...before.runHistory, ...before.runs].map((
        /* 原文档中的Run或只读历史。 */ run,
      ) => /* Run身份不会随移入runHistory改变。 */ [run.id, run]))
      for (const run of [...after.runHistory, ...after.runs]) {
        const previousRun = previousRuns.get(run.id)
        for (const operation of run.operations) {
          if (operation.status !== 'completed') continue
          const previousOperation = previousRun?.operations.find((
            /* 原Run已保存的Operation。 */ candidate,
          ) => /* 相同正式Operation不得重复登记既有输出。 */ candidate.id === operation.id)
          for (const output of operation.outputRefs) {
            if (previousOperation?.outputRefs.some((
              /* 同一Operation提交前已有的正式输出。 */ prior,
            ) => /* 合法后续状态变更不新建已登记消费者上下文。 */ prior.id === output.id && prior.revision === output.revision && prior.workId === output.workId)) continue
            const node = afterNodes.get(output.id)
            if (!node || node.revision !== output.revision) throw new GraphError(422, 'EVIDENCE_NOT_AUTHORIZED', EvidenceMessage.NOT_AUTHORIZED)
            for (const reference of node.libraryClaimRefs ?? []) {
              assertWorkSelection(run, operation, reference, after.workspaceId)
              const entry = await readEntry(session, after.workspaceId, reference.entryId)
              assertDigest(entry.contentDigest, reference.contentDigest)
              await createUse(node, reference, { kind: 'work', runId: run.id, operationId: operation.id,
                workId: output.workId, reusedFromOperationId: operation.reusedFromOperationId ?? null },
              after, session, startedAt, changedEntries)
            }
          }
        }
      }
    }
    for (const entryId of changedEntries) {
      const key = storeCreateInputHash({ workspaceId: after.workspaceId, entryId })
      const stored = await catalogs.get(key, session)
      if (!stored) await catalogs.insert({ _id: key, workspaceId: after.workspaceId, entryId, revision: 1 }, session)
      else {
        const catalog = evidenceParseUsageCatalog(stored)
        await catalogs.replace({ ...catalog, revision: catalog.revision + 1 }, session)
      }
    }
  }

  async function createUse(
    /* 本次正式保存且内容版本已经确定的消费者节点。 */ node: GraphNode,
    /* 节点明确声明的固定材料与非空理由。 */ reference: EvidenceUseRef,
    /* 由当前授权动作或Operation确定的本轮运行上下文。 */ context: UseContext,
    /* 实际归属的已提交Map快照。 */ map: GraphDocument,
    /* 与真实图写入共用的活动事务。 */ session: StorageSession,
    /* 当前成功图提交登记使用的时间。 */ startedAt: string,
    /* 本次事务实际改变使用的条目目录集合。 */ changedEntries: Set<string>,
  ): Promise<void> {
    // 固定消费者正文与完整运行上下文，业务身份已存在时不刷新历史时间。
    const id = randomUUID()
    const summary: EvidenceUseSummary = { id, workspaceId: map.workspaceId,
      ref: { entryId: reference.entryId, contentDigest: reference.contentDigest },
      consumer: { mapId: map.id, nodeId: node.id, revision: node.revision }, reason: reference.reason,
      ...context, startedAt, endedAt: null }
    const identityHash = evidenceCreateUseIdentity(summary)
    if (await uses.first({ identityHash }, session)) return
    // 图和运行存储的元数据约束较宽，转成使用历史时仍建立严格的 UUID、时间与运行上下文合同。
    const parsedSummary = evidenceParseUseSummary(summary)
    const originalSnapshot = structuredClone(node)
    const consumerSnapshot = evidenceParseNodeSnapshot(originalSnapshot)
    // 保留原摘要一致性检查隐含的约束：跨合同投影不能静默丢弃损坏存储的额外字段。
    if (!isDeepStrictEqual(originalSnapshot, consumerSnapshot)) {
      throw new GraphError(500, 'EVIDENCE_RECORD_INVALID', EvidenceMessage.RECORD_INVALID)
    }
    const document: EvidenceUseDocument = { ...parsedSummary, _id: id, identityHash,
      consumerDigest: storeCreateInputHash(consumerSnapshot), consumerSnapshot }
    await uses.insert(document, session)
    changedEntries.add(reference.entryId)
  }

  return { readRevision, syncGraphUses }
}

function assertWorkSelection(
  /* 所属Run启动时保存的完整步骤材料。 */ run: GraphRun,
  /* 正式产物所属的已获权Operation规格。 */ operation: GraphOperation,
  /* 正式节点明确声明的引用。 */ reference: EvidenceUseRef,
  /* 目标Map真实归属的工作区。 */ workspaceId: string,
): void {
  // 二次核对规格与Run集合，撤回不否定启动时已经冻结的材料。
  const allowed = operation.executionSpec.libraryClaimRefs?.find((
    /* Operation绑定的一个精确材料引用。 */ ref,
  ) => /* 先区分未获权身份和伪摘要。 */ ref.entryId === reference.entryId)
  if (!allowed) throw new GraphError(422, 'EVIDENCE_NOT_AUTHORIZED', EvidenceMessage.NOT_AUTHORIZED)
  assertDigest(allowed.contentDigest, reference.contentDigest)
  const claim = run.libraryClaimSets?.find((
    /* Run每个步骤保存的一份完整集合。 */ set,
  ) => /* Operation只获权所属步骤。 */ set.stepId === operation.stepId)?.claims.find((
    /* 当前步骤的一份完整冻结材料。 */ frozen,
  ) => /* 规格引用必须有对应完整材料。 */ frozen.ref.entryId === reference.entryId)
  if (!claim || claim.entry.workspaceId !== workspaceId || claim.entry.id !== reference.entryId) {
    throw new GraphError(422, 'EVIDENCE_NOT_AUTHORIZED', EvidenceMessage.NOT_AUTHORIZED)
  }
  assertDigest(claim.ref.contentDigest, reference.contentDigest)
  assertDigest(claim.entry.contentDigest, reference.contentDigest)
}

function assertDigest(
  /* 已获权或持久化固定内容的真实摘要。 */ expected: string,
  /* 消费者明确声明的摘要。 */ actual: string,
): void {
  // 伪摘要有独立领域身份，不与未选材料混为一类拒绝。
  if (expected !== actual) throw new GraphError(422, 'EVIDENCE_DIGEST_MISMATCH', EvidenceMessage.DIGEST_MISMATCH)
}
