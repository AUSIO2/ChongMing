// 只定义未来真实证据库实现的测试接入口，不提供业务或存储实现。
import type { GraphNode } from '../../contracts/graph'

export type TestBackend = 'sqlite' | 'mongo'
export type Actor = 'owner' | 'editor' | 'viewer' | 'outsider'
export type Confidence = 0 | 1

export interface ClaimRef { mapId: string; nodeId: string; revision: number }
export interface LibraryRef { entryId: string; contentDigest: string }
export interface Applicability {
  subject: string | null
  event: string | null
  time: { from: string; to: string } | null
  place: string | null
  conditions: string[]
}
export type BasisRef =
  | { kind: 'manual'; text: string }
  | { kind: 'node'; ref: ClaimRef }
  | { kind: 'asset'; assetId: string; sha256: string }
  | { kind: 'library'; ref: LibraryRef }

export interface Entry {
  id: string
  workspaceId: string
  revision: number
  claim: { origin: ClaimRef; type: { id: string; version: number }; definitionDigest: string; nodeSnapshot: GraphNode }
  confidence: Confidence
  applicability: Applicability
  decision: { reason: string; basisRefs: BasisRef[] }
  collectedBy: string
  collectedAt: string
  contentDigest: string
  status: 'active' | 'withdrawn' | 'superseded'
  statusReason: string | null
  replacementEntryId: string | null
}
export interface CollectInput {
  workspaceId: string
  requestId: string
  claim: ClaimRef
  confidence: unknown                 // 故意保留外部输入，用于验证拒绝非数字 0/1。
  applicability: Applicability
  reason: string
  basisRefs: BasisRef[]
}
export interface SearchInput {
  workspaceId: string
  query?: string
  confidence?: Confidence
  subject?: string
  event?: string
  cursor?: string
  limit?: number
  includeInactive?: boolean
}
export interface EntrySummary { id: string; content: string; confidence: Confidence; contentDigest: string; status: Entry['status'] }
export type ScopeField = 'subject' | 'event' | 'time' | 'place' | 'conditions'
export interface MatchCandidate {
  entry: EntrySummary
  reason: string
  scope: { status: 'compatible' | 'different' | 'unknown'; differences: ScopeField[] }
}
export interface Page<T> { items: T[]; nextCursor: string | null; libraryRevision: number }
export interface CollectResult { entry: Entry; replayed: boolean; existing: boolean; conflictEntryIds: string[] }
export interface Snapshot { id: string; workspaceId: string; entries: LibraryRef[]; digest: string }
export interface FrozenWork {
  workId: string
  runId: string
  workspaceId: string
  mapId: string
  target: ClaimRef
  entries: Entry[]
  specHash: string
  scopeNodeIds: string[]
}
export interface Usage {
  id: string
  entryId: string
  consumer: ClaimRef
  workId: string | null
  current: boolean
}
export interface Relation {
  kind: 'source' | 'verification' | 'usage' | 'replacement'
  entryId: string
  node: ClaimRef | null
  usage: Usage | null
}
export interface Bundle {
  format: string
  version: number
  entries: Entry[]
  snapshots: Snapshot[]
  usages: Usage[]
  assets: Array<{ id: string; sha256: string; contentBase64: string }>
}
export interface ImportResult {
  replayed: boolean
  entryIds: Record<string, string>
  digests: Record<string, string>       // 与 entryIds 同键：原 entryId -> 目标 contentDigest。
  assetIds: Record<string, string>
  snapshotIds: Record<string, string>
}

// request 的动作名是测试协议；接入层须映射到真实服务，不能代行业务判断。
export interface MethodInputs {
  collect: CollectInput
  get: { workspaceId: string; entryId: string }
  search: SearchInput
  match: { workspaceId: string; claim: ClaimRef; applicability: Applicability; limit: number }
  withdraw: { workspaceId: string; entryId: string; expectedRevision: number; reason: string; requestId: string }
  supersede: { workspaceId: string; entryId: string; replacementEntryId: string; expectedRevision: number; reason: string; requestId: string }
  relations: { workspaceId: string; entryId: string; direction: 'upstream' | 'downstream'; depth: number; limit: number; cursor?: string }
  snapshotCreate: { workspaceId: string; refs: LibraryRef[]; requestId: string }
  snapshotGet: { workspaceId: string; snapshotId: string }
  freeze: { workspaceId: string; target: ClaimRef; refs: LibraryRef[]; mode: 'live' | 'historical'; snapshotId?: string }
  readFrozen: { workspaceId: string; workId: string }
  submitUse: { workspaceId: string; workId: string; refs: LibraryRef[]; reason: string; requestId: string }
  endUse: { workspaceId: string; usageId: string; requestId: string }
  export: { workspaceId: string; snapshotId: string }
  import: { workspaceId: string; bundle: Bundle; requestId: string }
}
export interface MethodResults {
  collect: CollectResult
  get: Entry
  search: Page<EntrySummary>
  match: MatchCandidate[]
  withdraw: Entry
  supersede: Entry
  relations: Page<Relation>
  snapshotCreate: Snapshot
  snapshotGet: Snapshot
  freeze: FrozenWork
  readFrozen: FrozenWork
  submitUse: { usages: Usage[]; replayed: boolean }
  endUse: Usage
  export: Bundle
  import: ImportResult
}
export type Method = keyof MethodInputs

export interface Counts { entries: number; receipts: number; usages: number; snapshots: number; assets: number }
export interface QueryObservation {
  // 来自最近一次 evidence.search 的真实执行观测，完整条目物化数不等于词项扫描数。
  implementation: 'mongo-index' | 'sqlite-index'
  indexNames: string[]
  returnedRows: number
  materializedRows: number
  fullWorkspaceScan: boolean
}
export interface Telemetry {
  storageBytes: number | null
  targetRssBytes: number | null
  queryObservation: QueryObservation | null
}
export interface SeedPlan { seed: number; entries: number; usages: number; textBytes: number; hitEvery?: number }
export interface SeedResult {
  entryRefs: LibraryRef[]
  sampleEntries: Entry[]
  query: string
  expectedQueryIds: string[]            // 从输入语料得出的完整预期，不能从 search 的结果反推。
  entries: number
  usages: number
}
export interface CallOptions { signal?: AbortSignal }
export interface NodeFixtureOptions extends CallOptions { nodeId?: string }

export interface EvidenceTestTarget {
  info: { name: string; backend: TestBackend; executionModel: 'single-owner' | 'pooled' | 'remote'; isolated: true }
  workspaceId: string
  otherWorkspaceId: string
  request<M extends Method>(
    /* 由接入模块映射到真实身份的测试角色。 */ actor: Actor,
    /* 本次调用的测试语义动作。 */ method: M,
    /* 交由真实服务验证的输入。 */ input: MethodInputs[M],
    /* 控制真实调用取消的可选信号。 */ options?: CallOptions,
  ): Promise<MethodResults[M]>
  fixtures: {
    createNode(
      /* 测试准备所属的隔离工作区。 */ workspaceId: string,
      /* 用真实图接口创建的节点类型。 */ type: 'claim' | 'news' | 'source',
      /* 要保存的原文。 */ content: string,
      /* 可选节点身份及取消信号；每次调用需在新 Map 创建节点。 */ options?: NodeFixtureOptions,
    ): Promise<ClaimRef>
    updateClaim(/* 原节点版本。 */ ref: ClaimRef, /* 新原文。 */ content: string): Promise<ClaimRef>
    deleteClaim(/* 要删除的原节点。 */ ref: ClaimRef): Promise<void>
    deleteMap(/* 要删除的来源图身份。 */ mapId: string): Promise<void>
    createAsset(/* 隔离工作区。 */ workspaceId: string, /* 附件原文。 */ text: string): Promise<{ id: string; sha256: string }>
    deleteAsset(/* 要通过真实资产接口删除的附件。 */ id: string): Promise<void>
    revoke(/* 从主 workspace 移除成员资格，保留有效系统身份的测试角色。 */ actor: Actor): Promise<void>
    failNextCommit(): Promise<void>
    seed(/* 通过真实目标预置的确定性负载。 */ plan: SeedPlan, /* 准备阶段取消信号。 */ options?: CallOptions): Promise<SeedResult>
  }
  inspect: {
    counts(/* 要观察真实持久化状态的工作区。 */ workspaceId: string, /* 观测取消信号。 */ options?: CallOptions): Promise<Counts>
    telemetry(/* 观测取消信号。 */ options?: CallOptions): Promise<Telemetry>
  }
  close(/* 关闭阶段的独立取消期限。 */ options?: CallOptions): Promise<void>
}
export interface TargetOptions { backend: TestBackend; directory: string; seed: number; signal?: AbortSignal }
export type TargetFactory = (/* 每次测试的新隔离存储配置。 */ options: TargetOptions) => Promise<EvidenceTestTarget>

export enum HarnessMessage {
  TARGET_REQUIRED = '尚未接入证据库实现：请设置 EVIDENCE_TEST_TARGET。',
  FACTORY_REQUIRED = '测试目标必须导出 createEvidenceTestTarget 工厂。',
  TARGET_INVALID = '测试目标缺少必需接口或没有声明隔离存储。',
  BACKEND_INVALID = 'EVIDENCE_TEST_BACKEND 仅支持 sqlite 或 mongo。',
  OPTION_INVALID = '压测选项无效或超过允许范围。',
  TIMEOUT = '真实目标调用超过请求期限。',
  DEADLINE = '压测超过场景总期限。',
  SEED_INVALID = '真实预置结果与场景规模不符。',
  RESPONSE_INVALID = '真实目标结果不符合测试契约。',
  THRESHOLD_FAILED = '压测正确性、错误或性能门槛未满足。',
  CLEANUP_FAILED = '隔离测试环境关闭或清理失败。',
  PHASE_FAILED = '压测准备、测量或校验阶段失败。',
}
