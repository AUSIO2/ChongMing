// 校验固定消费者使用历史，摘要不加载正文，详情绑定原内容版本与独立摘要。
import { EvidenceMessage, type EvidenceUse, type EvidenceUseSummary } from '../../../contracts/evidence-library'
import { storeCreateInputHash } from '../graph/graph-record'
import { GraphError } from '../shared/domain-error'
import { evidenceParseNodeSnapshot } from './evidence-record'

export interface EvidenceUseDocument extends EvidenceUse {
  _id: string
  identityHash: string
  consumerDigest: string
}
export interface EvidenceUsageCatalogDocument {
  _id: string
  workspaceId: string
  entryId: string
  revision: number
}

export function evidenceCreateUseIdentity(
  /* 已确认精确库、消费者版本及本轮运行上下文的使用摘要。 */ usage: EvidenceUseSummary,
): string {
  // 新Run即使复用同一正式节点也有独立身份，状态时间不改变原使用业务身份。
  return storeCreateInputHash({ workspaceId: usage.workspaceId, ref: usage.ref, consumer: usage.consumer,
    reason: usage.reason, kind: usage.kind, runId: usage.runId, operationId: usage.operationId,
    workId: usage.workId, reusedFromOperationId: usage.reusedFromOperationId })
}

export function evidenceParseUseSummary(
  /* Mongo轻量投影或完整历史记录中的未知摘要字段。 */ value: unknown,
): EvidenceUseSummary {
  // 校验原版本、引用摘要及运行上下文，manual不从保留的producer推导Work身份。
  const use = readObject(value), ref = readObject(use.ref), consumer = readObject(use.consumer)
  const kind = use.kind
  if (kind !== 'work' && kind !== 'manual') invalidRecord()
  const runId = readNullableId(use.runId), operationId = readNullableId(use.operationId)
  const workId = use.workId === null ? null : readText(use.workId)
  const reusedFromOperationId = readNullableId(use.reusedFromOperationId)
  if (kind === 'manual' && (runId !== null || operationId !== null || workId !== null || reusedFromOperationId !== null)
    || kind === 'work' && (runId === null || operationId === null || workId === null)) invalidRecord()
  const startedAt = readTimestamp(use.startedAt), endedAt = use.endedAt === null ? null : readTimestamp(use.endedAt)
  if (endedAt !== null && Date.parse(endedAt) < Date.parse(startedAt)) invalidRecord()
  return { id: readId(use.id), workspaceId: readId(use.workspaceId), ref: { entryId: readId(ref.entryId), contentDigest: readDigest(ref.contentDigest) },
    consumer: { mapId: readId(consumer.mapId), nodeId: readId(consumer.nodeId), revision: readRevision(consumer.revision) },
    reason: readText(use.reason), kind, runId, operationId, workId, reusedFromOperationId, startedAt, endedAt }
}

export function evidenceParseUseDocument(
  /* 完整历史记录，含原消费者快照及内部身份和正文摘要。 */ value: unknown,
): EvidenceUseDocument {
  // 身份、节点精确版本及原消费者内容同时成立才允许返回历史详情。
  const stored = readObject(value), summary = evidenceParseUseSummary(stored)
  const consumerSnapshot = evidenceParseNodeSnapshot(stored.consumerSnapshot)
  const _id = readId(stored._id), identityHash = readDigest(stored.identityHash), consumerDigest = readDigest(stored.consumerDigest)
  if (_id !== summary.id || summary.consumer.nodeId !== consumerSnapshot.id || summary.consumer.revision !== consumerSnapshot.revision
    || identityHash !== evidenceCreateUseIdentity(summary) || consumerDigest !== storeCreateInputHash(consumerSnapshot)) invalidRecord()
  const reference = consumerSnapshot.libraryClaimRefs?.find((
    /* 消费者当时明确保存的库引用。 */ reference,
  ) => /* 使用记录必须对应真实声明而非后补引用。 */ reference.entryId === summary.ref.entryId)
  if (!reference || reference.contentDigest !== summary.ref.contentDigest || reference.reason !== summary.reason) invalidRecord()
  return { ...summary, _id, identityHash, consumerDigest, consumerSnapshot }
}

export function evidenceParseUsageCatalog(
  /* 独立使用目录集合中的未知版本记录。 */ value: unknown,
): EvidenceUsageCatalogDocument {
  // 目录绑定具体库条目；其他条目的使用变化不令此页失效。
  const catalog = readObject(value), workspaceId = readId(catalog.workspaceId), entryId = readId(catalog.entryId)
  const _id = readDigest(catalog._id)
  if (_id !== storeCreateInputHash({ workspaceId, entryId })) invalidRecord()
  return { _id, workspaceId, entryId, revision: readRevision(catalog.revision) }
}

export function evidenceReadUseView(
  /* 已验证身份与固定正文的历史记录。 */ document: EvidenceUseDocument,
): EvidenceUse {
  // 返回独立公共副本，不泄露内部唯一身份和正文摘要字段。
  return structuredClone({ id: document.id, workspaceId: document.workspaceId, ref: document.ref,
    consumer: document.consumer, reason: document.reason, kind: document.kind,
    runId: document.runId, operationId: document.operationId, workId: document.workId,
    reusedFromOperationId: document.reusedFromOperationId, startedAt: document.startedAt,
    endedAt: document.endedAt, consumerSnapshot: document.consumerSnapshot })
}

function readObject(
  /* 尚未验证JSON/BSON字段对象形状的历史值。 */ value: unknown,
): Record<string, unknown> {
  // 外部持久化值必须为字段对象，数组和null不能进入属性读取。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidRecord()
  return value as Record<string, unknown>
}
function readText(
  /* 必须保留原值的历史身份、工作键或使用理由。 */ value: unknown,
): string {
  // 拒绝缺失和空白原文，不在历史读取中裁剪理由。
  if (typeof value !== 'string' || !value.trim()) invalidRecord()
  return value
}
function readId(
  /* 历史workspace、entry、消费者或Run/Operation的UUID。 */ value: unknown,
): string {
  // 工作键单独校验，其余公共身份保持UUID约定。
  const id = readText(value)
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) invalidRecord()
  return id
}
function readNullableId(
  /* manual上下文明确为null、Work上下文可为UUID的字段。 */ value: unknown,
): string | null {
  // 缺失字段不等同于明确没有运行身份。
  return value === null ? null : readId(value)
}
function readDigest(
  /* 绑定固定库材料、业务使用身份或消费者正文的完整摘要。 */ value: unknown,
): string {
  // 拒绝非规范SHA-256，避免历史读出现隐式修补。
  const digest = readText(value)
  if (!/^[a-f0-9]{64}$/.test(digest)) invalidRecord()
  return digest
}
function readRevision(
  /* 消费者内容版本或使用目录版本。 */ value: unknown,
): number {
  // 版本只能是非负安全整数。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidRecord()
  return value
}
function readTimestamp(
  /* 本次使用开始或结束的已保存时间。 */ value: unknown,
): string {
  // 保持原保存时间，拒绝不可解释的值。
  const timestamp = readText(value)
  if (!Number.isFinite(Date.parse(timestamp))) invalidRecord()
  return timestamp
}
function invalidRecord(): never {
  // 统一报告损坏历史，不泄露消费者正文或底层解码异常。
  throw new GraphError(500, 'EVIDENCE_RECORD_INVALID', EvidenceMessage.RECORD_INVALID)
}
