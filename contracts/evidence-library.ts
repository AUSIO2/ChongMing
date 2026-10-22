// 定义显式收录Claim、固定关系、步骤只读材料与消费者使用追溯，不新增图节点类型。
import type { GraphEdge, GraphNode } from './graph'
import type { DataTypeDefinition } from './data-definition'

export interface EvidenceClaimRef { mapId: string; nodeId: string; revision: number }
export interface EvidenceLibraryRef { entryId: string; contentDigest: string }
export interface EvidenceApplicability {
  subject: string | null
  event: string | null
  time: { from: string; to: string } | null
  place: string | null
  conditions: string[]
}
export type EvidenceBasisRef =
  | { kind: 'manual'; text: string }
  | { kind: 'node'; ref: EvidenceClaimRef }
  | { kind: 'asset'; assetId: string; sha256: string }
  | { kind: 'library'; ref: EvidenceLibraryRef }

export interface EvidenceLibraryEntry {
  id: string
  workspaceId: string
  revision: number
  claim: {
    origin: EvidenceClaimRef
    type: { id: string; version: number }
    definitionDigest: string
    nodeSnapshot: GraphNode
  }
  confidence: 0 | 1
  applicability: EvidenceApplicability
  decision: { reason: string; basisRefs: EvidenceBasisRef[] }
  collectedBy: string
  collectedAt: string
  contentDigest: string
  status: 'active' | 'withdrawn' | 'superseded'
  statusReason: string | null
  replacementEntryId: string | null
}
export interface EvidenceCollectParams {
  workspaceId: string
  claim: EvidenceClaimRef
  confidence: unknown
  applicability: EvidenceApplicability
  reason: string
  basisRefs: EvidenceBasisRef[]
}
export interface EvidenceCollectResult {
  entry: EvidenceLibraryEntry
  replayed: boolean
  existing: boolean
  conflictEntryIds: string[]
}
export interface EvidenceSearchParams {
  workspaceId: string
  query?: string
  confidence?: 0 | 1
  subject?: string
  event?: string
  cursor?: string
  limit?: number
  includeInactive?: boolean
}
export interface EvidenceEntrySummary {
  id: string
  content: string
  confidence: 0 | 1
  contentDigest: string
  status: EvidenceLibraryEntry['status']
}
export interface EvidencePage {
  items: EvidenceEntrySummary[]
  nextCursor: string | null
  libraryRevision: number
}

// 关系邻域保存收录时的精确版本；其他核查分数不成为库的固定判断。
export interface EvidenceRelationNode {
  key: string
  ref: EvidenceClaimRef
  nodeSnapshot: GraphNode
  definitionDigest: string
  role: 'claim' | 'upstream' | 'downstream' | 'basis' | 'dependency'
}
export type EvidenceRelationEdge =
  | { key: string; kind: 'graph'; from: string; to: string; mapId: string; edge: GraphEdge }
  | { key: string; kind: 'payload'; from: string; to: string; mapId: string; path: string }
  | { key: string; kind: 'basis'; from: string; to: string; basisIndex: number }
export interface EvidenceRelationSnapshot {
  version: 1
  capturedAt: string
  rootKey: string
  nodes: EvidenceRelationNode[]
  edges: EvidenceRelationEdge[]
  truncated: boolean
}
export interface EvidenceRelationsView {
  workspaceId: string
  entryId: string
  contentDigest: string
  // null 表示旧条目当时没有保存关系，不能从来源当前版本推断历史。
  snapshot: EvidenceRelationSnapshot | null
}
// 核查步骤只读的精确库材料；完整材料每个步骤在Run内保存一次。
export interface EvidenceFrozenClaim {
  ref: EvidenceLibraryRef
  entry: EvidenceLibraryEntry
  definition: DataTypeDefinition
  // 完整Run快照的独立摘要；Work投影保留此标签，不对投影结果重算。
  snapshotDigest: string
}
// 使用理由属于本次消费者，不能回写库的固定内容或判断。
export interface EvidenceUseRef extends EvidenceLibraryRef { reason: string }
export interface EvidenceUseSummary {
  id: string
  workspaceId: string
  ref: EvidenceLibraryRef
  consumer: EvidenceClaimRef
  reason: string
  kind: 'work' | 'manual'
  runId: string | null
  operationId: string | null
  workId: string | null
  reusedFromOperationId: string | null
  startedAt: string
  endedAt: string | null
}
export interface EvidenceUse extends EvidenceUseSummary { consumerSnapshot: GraphNode }
export interface EvidenceUsesPage {
  workspaceId: string
  entryId: string
  items: EvidenceUseSummary[]
  nextCursor: string | null
  usageRevision: number
}
export type EvidenceQuery =
  | { method: 'evidence.get'; params: { workspaceId: string; entryId: string } }
  | { method: 'evidence.relations'; params: { workspaceId: string; entryId: string } }
  | { method: 'evidence.search'; params: EvidenceSearchParams }
  | { method: 'evidence.uses'; params: { workspaceId: string; entryId: string;
    includeHistory?: boolean; cursor?: string; limit?: number } }
  | { method: 'evidence.use.get'; params: { workspaceId: string; entryId: string; usageId: string } }
export type EvidenceCommand =
  | { method: 'evidence.collect'; requestId: string; params: EvidenceCollectParams }
  | { method: 'evidence.withdraw'; requestId: string; params: {
    workspaceId: string; entryId: string; expectedRevision: number; reason: string
  } }

export enum EvidenceMessage {
  INPUT_INVALID = 'Evidence input has invalid fields or values.',
  TRANSACTION_REQUIRED = 'Evidence writes require an authorized storage transaction.',
  UNAVAILABLE = 'Evidence library requires the MongoDB service.',
  CONFIDENCE_INVALID = 'Evidence confidence must be the number 0 or 1.',
  REASON_REQUIRED = 'Evidence collection requires a non-empty decision reason.',
  CLAIM_TYPE_INVALID = 'Only a registered factcheck Claim can be collected.',
  SOURCE_NOT_FOUND = 'Evidence source is not available.',
  SOURCE_VERSION_CONFLICT = 'Evidence source revision changed.',
  WORKSPACE_MISMATCH = 'Evidence reference belongs to another workspace.',
  NOT_FOUND = 'Evidence entry was not found.',
  REVISION_CONFLICT = 'Evidence entry revision changed.',
  IDEMPOTENCY_CONFLICT = 'Evidence request identity has different input.',
  DIGEST_MISMATCH = 'Evidence reference digest does not match its fixed content.',
  INACTIVE = 'Evidence entry is not active for a new reference.',
  BASIS_INVALID = 'Evidence decision basis is not available or has an invalid digest.',
  ASSET_REFERENCED = 'Asset is retained by an evidence collection.',
  CURSOR_INVALID = 'Evidence cursor belongs to a different query.',
  CURSOR_EXPIRED = 'Evidence library changed between pages.',
  QUERY_LIMIT_INVALID = 'Evidence page size must be an integer from 1 to 100.',
  INPUT_LIMIT = 'Evidence input exceeds its supported size.',
  NOT_IMPLEMENTED = 'This evidence feature is not implemented in the core stage.',
  COMMIT_FAILED = 'Evidence transaction could not commit.',
  RECORD_INVALID = 'Stored evidence record has invalid fields or fixed content.',
  NOT_AUTHORIZED = 'Evidence reference is not in the authorized operation collection.',
  SELECTION_LIMIT = 'Choose at most 32 distinct evidence entries for one step.',
  USE_REASON_REQUIRED = 'Evidence use requires a non-empty reference reason.',
}
