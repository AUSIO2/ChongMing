/**
 * 052 目标接口契约（设计工件，当前生产尚未实现）。
 * 网络 DTO 只使用 JSON 值；不引用 Electron、Mongoose 或 DSH 类型。
 * 字段约束、状态转换、权限和 HTTP 映射见 052-完整接口文档.md。
 */
export type Id = string
export type Timestamp = string
export type Revision = number
export type Priority = 'high' | 'medium' | 'low'
export type Confidence = 0 | 0.5 | 1
export type Mode = 'auto' | 'human-in-loop'
export type OperationKind = 'parse' | 'split' | 'verify'
export type Until = 'news' | 'claims' | 'verified'
export type PromptKind = 'parseExtract' | 'splitRoute' | 'splitSubAgent' | 'splitMerge' | 'verifyRoute' | 'verifySubAgent' | 'verifyMerge'
export type Role = 'owner' | 'editor' | 'viewer'
export interface PageInput { cursor?: string; limit?: number }
export interface Page<T> { items: T[]; nextCursor: string | null }
export interface ContextField { value: string; visibleToAI: boolean }
export type NewsContext = Record<string, ContextField>
export interface NodeRef { id: Id; revision: Revision }
export interface ProfileRef { id: Id; revision: Revision }
export type Locator =
  | { kind: 'asset'; assetId: Id; mediaType: string }
  | { kind: 'url'; url: string }
export interface Opinion {
  id: Id; agentId: Id; agentName: string; slotId: Id; priority: Priority
  score: Confidence; reason: string; evidenceRefs: NodeRef[]; reportId: Id
}
export type NodeData =
  | { kind: 'source'; locator: Locator; label: string | null }
  | { kind: 'news'; content: string; context: NewsContext }
  | { kind: 'claim'; content: string; category: string | null }
  | { kind: 'evidence'; content: string; locator: Locator; capturedAt: Timestamp }
  | { kind: 'verification'; score: Confidence; reason: string; opinions: Opinion[] }
export type NodeKind = NodeData['kind']
export interface NodeProvenance {
  source: 'manual' | 'report' | 'import'
  operationId: Id | null; reportId: Id | null; agentId: Id | null; agentName: string | null; slotId: Id | null
  importedFrom: { bundleId: Id; nodeId: Id; revision: Revision } | null
}
export interface Node {
  id: Id; revision: Revision; data: NodeData
  origin: { kind: 'manual'; userId: Id } | { kind: 'operation'; operationId: Id; receiptId: Id } | { kind: 'import'; bundleId: Id }
  provenance: NodeProvenance[]
  validity: 'current' | 'stale' | 'missing-input'
  createdAt: Timestamp; updatedAt: Timestamp
}
export interface Quote { text: string; sourceRevision: Revision; start: number | null; end: number | null }
export interface EdgeInput {
  id: Id; kind: 'derived-from' | 'mentions' | 'supports' | 'refutes' | 'verifies' | 'related-to'
  from: Id; to: Id; quote: Quote | null
}
export interface Edge extends EdgeInput {
  revision: Revision; validity: 'current' | 'stale'; createdAt: Timestamp
}
export interface Slot { id: Id; agentId: Id; priority: Priority; hint: string }
export interface NodePolicy {
  nodeId: Id; operation: 'split' | 'verify'
  routing: { mode: 'auto'; preferences: Slot[] } | { mode: 'fixed'; slots: Slot[] }
}
export interface CandidateNode { id: Id; data: NodeData; reportIds: Id[] }
export interface ChangeDraft {
  operation: OperationKind; nodes: CandidateNode[]; edges: EdgeInput[]
  acceptedNodeIds: Id[]; reportIds: Id[]
}
export type ReviewContent =
  | { kind: 'route'; slots: Slot[] }
  | { kind: 'validate' | 'save'; draft: ChangeDraft }
export interface Review {
  id: Id; operationId: Id; revision: Revision; draftRevision: Revision; draftFingerprint: string; content: ReviewContent
  state: 'pending' | 'answered' | 'superseded'
  decision: { value: 'approve' | 'reject' | 'revise'; userId: Id; note: string | null; at: Timestamp } | null
}
export type Scope = { kind: 'map' } | { kind: 'nodes'; nodeIds: Id[] }
export type RunStatus = 'accepted' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export type OperationStatus = 'ready' | 'executing' | 'waiting' | 'completed' | 'failed' | 'cancelled'
export interface PublicError {
  code: string; message: string; retryable: boolean
  fields?: Array<{ path: string; message: string }>
  conflict?: { resource: 'map' | 'workspace' | 'agent' | 'review' | 'settings' | 'preferences'; id: Id; currentRevision: Revision }
}
export interface OperationSummary {
  id: Id; kind: OperationKind; targetId: Id; status: OperationStatus
  resultNodeIds: Id[]; reviewIds: Id[]; error: PublicError | null
}
export interface RunSummary {
  id: Id; scope: Scope; until: Until; mode: Mode; status: RunStatus
  operations: OperationSummary[]; error: PublicError | null
  createdAt: Timestamp; updatedAt: Timestamp
}
export interface Receipt {
  id: Id; operationId: Id; inputRefs: NodeRef[]; inputFingerprint: string
  configFingerprint: string; draftRevision: Revision; nodeIds: Id[]; edgeIds: Id[]; acceptedAt: Timestamp
}
export interface Report {
  id: Id; operationId: Id; slotId: Id; producer: ProfileRef; inputRefs: NodeRef[]
  content: { kind: 'parse'; news: Array<{ content: string; context: NewsContext }> }
    | { kind: 'split'; claims: Array<{ content: string; category: string | null }> }
    | { kind: 'verify'; score: Confidence; reason: string; evidence: Array<{ content: string; locator: Locator; capturedAt: Timestamp }> }
  createdAt: Timestamp
}
export interface OperationView extends OperationSummary {
  inputRefs: NodeRef[]; context: OperationContext; reports: Report[]; reviews: Review[]; receipt: Receipt | null
}
export interface OperationContext {
  route: { revision: Revision; slots: Slot[]; approved: boolean } | null
  draft: { revision: Revision; fingerprint: string; content: ChangeDraft; validated: boolean; saveApproved: boolean } | null
  decisions: Array<{ kind: 'route' | 'validate' | 'save'; draftRevision: Revision; draftFingerprint: string; value: 'approve' | 'reject' | 'revise'; source: 'auto' | 'user'; reviewId: Id | null; at: Timestamp }>
  reportIds: Id[]
}
export interface RunView extends RunSummary { operationDetails: OperationView[]; policyFingerprint: string }
export interface GraphSnapshot {
  mapId: Id; workspaceId: Id; revision: Revision; name: string
  nodes: Node[]; edges: Edge[]; policies: NodePolicy[]; missingInputs: NodeRef[]
  run: RunSummary | null; reviews: Review[]
  capabilities: { editGraph: boolean; startRun: boolean; cancelRun: boolean; answerReview: boolean }
  updatedAt: Timestamp
}
export interface MapSummary {
  id: Id; workspaceId: Id; name: string; revision: Revision
  nodeCount: number; claimCount: number; runStatus: RunStatus | null; updatedAt: Timestamp
}
export interface GraphWriteResult { snapshot: GraphSnapshot; createdNodeIds: Id[]; createdEdgeIds: Id[]; runId: Id | null }
export interface MapMutation { mapId: Id; expectedRevision: Revision }
export interface GraphChanges {
  name?: string
  nodes?: { put?: Array<{ id: Id; data: NodeData }>; remove?: Id[] }
  edges?: { put?: EdgeInput[]; remove?: Id[] }
  policies?: NodePolicy[]
}
export interface MergeGroup { keepId: Id; removeIds: Id[] }
export interface WorkspaceSummary { id: Id; name: string; revision: Revision; role: Role; mapCount: number; updatedAt: Timestamp }
export interface Workspace extends WorkspaceSummary { description: string; agents: AgentProfile[] }
export interface WorkspaceView extends Workspace { members: Member[]; preferences: Preferences }
export interface Member { userId: Id; displayName: string; role: Role }
export interface MemberWriteResult { userId: Id; member: Member | null; workspaceRevision: Revision }
export interface WorkspaceMutation { workspaceId: Id; expectedRevision: Revision }
export interface Preferences {
  workspaceId: Id; revision: Revision; openMapIds: Id[]; currentMapId: Id | null
  nodeSelection: Record<Id, Id | null>
}
export type AgentScope = { kind: 'library' } | { kind: 'workspace'; workspaceId: Id }
export interface AgentInput {
  id: Id; promptPath: string; kind: PromptKind; agentType: 'parse' | 'split' | 'verify' | 'coordinator'
  agentName: string | null; displayLabel: string; description: string; content: string
  promptVars: string[]; tools: string[]; model: string | null; baseUrl: string | null
  defaultPriority: Priority; claimCategory: 'data' | 'quote' | 'causal' | null
}
export interface AgentProfile extends AgentInput { revision: Revision; deletable: boolean; updatedAt: Timestamp }
export interface AgentMutation { scope: AgentScope; expectedRevision: Revision }
export interface AgentList { scope: AgentScope; revision: Revision; items: AgentProfile[] }
export interface PromptVariable { id: string; label: string; placeholder: string; description: string }
export interface Skill { id: string; displayLabel: string; description: string; requiredSecrets: string[] }
export interface ClusterSettings {
  revision: Revision; llm: { baseUrl: string; model: string }
  limits: { maxAgentSlots: number; maxOperationsPerHost: number }
}
export interface EndpointHealth { ok: boolean; latencyMs: number; error: PublicError | null }
export interface HostStatus {
  hostId: Id; version: string; status: 'ready' | 'draining' | 'unavailable'
  database: { connected: boolean; clusterId: string; databaseName: string }
  capabilities: { modelConfigured: boolean; tools: string[] }; lastSeenAt: Timestamp
}
export interface Me { userId: Id; displayName: string; hostAdmin: boolean }
export interface AppBootstrap {
  identity: Me; settings: ClusterSettings
  metadata: {
    version: string
    variables: Record<PromptKind, PromptVariable[]>
    outputs: Array<{ kind: PromptKind; claimCategory: 'data' | 'quote' | 'causal' | null; text: string }>
    skills: Skill[]
  }
}
export interface Asset {
  id: Id; workspaceId: Id; filename: string; mediaType: string; size: number; sha256: string; createdAt: Timestamp
}
export interface ImportResult { workspaceId: Id; mapIds: Id[]; assetIds: Id[] }
export interface BundleNode { id: Id; revision: Revision; data: NodeData; validity: Node['validity']; provenance: NodeProvenance[] }
export interface MapBundle {
  format: 'chongming-map'; version: 3; exportedAt: Timestamp
  map: { id: Id; name: string; nodes: BundleNode[]; edges: Edge[]; policies: NodePolicy[]; missingInputs: NodeRef[] }
  agents: AgentInput[]
  assets: Array<{ id: Id; filename: string; mediaType: string; size: number; sha256: string; contentBase64: string }>
}
export interface WorkspaceBundle {
  format: 'chongming-workspace'; version: 3; exportedAt: Timestamp
  workspace: { name: string; description: string; agents: AgentInput[] }
  maps: Array<MapBundle['map']>; assets: MapBundle['assets']
}
export interface Spec<I, O> { input: I; output: O }
export interface QueryMap {
  'app.bootstrap': Spec<Record<string, never>, AppBootstrap>
  'workspace.list': Spec<PageInput, Page<WorkspaceSummary>>
  'workspace.get': Spec<{ workspaceId: Id }, WorkspaceView>
  'map.list': Spec<{ workspaceId: Id } & PageInput, Page<MapSummary>>
  'map.get': Spec<{ mapId: Id }, GraphSnapshot>
  'run.get': Spec<{ mapId: Id; runId: Id }, RunView>
  'agent.list': Spec<{ scope: AgentScope; kind?: PromptKind }, AgentList>
  'host.list': Spec<Record<string, never>, HostStatus[]>
  'asset.get': Spec<{ assetId: Id }, Asset>
}
export interface CommandMap {
  'workspace.create': Spec<{ id: Id; name: string; description: string; agentSource: 'empty' | 'library' }, Workspace>
  'workspace.update': Spec<WorkspaceMutation & { name: string; description: string }, Workspace>
  'workspace.delete': Spec<WorkspaceMutation, { workspaceId: Id; deleted: true }>
  'member.set': Spec<WorkspaceMutation & { userId: Id; role: Role | null }, MemberWriteResult>
  'preferences.set': Spec<{ workspaceId: Id; expectedRevision: Revision; openMapIds: Id[]; currentMapId: Id | null; nodeSelection: Record<Id, Id | null> }, Preferences>
  'map.create': Spec<WorkspaceMutation & { id: Id; name: string }, GraphWriteResult>
  'map.delete': Spec<MapMutation, { mapId: Id; deleted: true }>
  'graph.apply': Spec<MapMutation & { changes: GraphChanges }, GraphWriteResult>
  'claims.merge': Spec<MapMutation & { groups: MergeGroup[] }, GraphWriteResult>
  'run.start': Spec<MapMutation & { id: Id; scope: Scope; until: Until; mode: Mode }, GraphWriteResult>
  'run.retry': Spec<MapMutation & { previousRunId: Id; id: Id }, GraphWriteResult>
  'run.cancel': Spec<MapMutation & { runId: Id }, GraphWriteResult>
  'run.set-mode': Spec<MapMutation & { runId: Id; mode: Mode }, GraphWriteResult>
  'review.update': Spec<MapMutation & { runId: Id; reviewId: Id; expectedReviewRevision: Revision; content: ReviewContent }, GraphWriteResult>
  'review.answer': Spec<MapMutation & { runId: Id; reviewId: Id; expectedReviewRevision: Revision; decision: 'approve' | 'reject' | 'revise'; note: string | null }, GraphWriteResult>
  'agent.create': Spec<AgentMutation & { agent: AgentInput }, AgentList>
  'agent.update': Spec<AgentMutation & { agentId: Id; expectedAgentRevision: Revision; agent: AgentInput }, AgentList>
  'agent.delete': Spec<AgentMutation & { agentId: Id; expectedAgentRevision: Revision }, AgentList>
  'agent.copy': Spec<WorkspaceMutation & { libraryRevision: Revision; agentIds: Id[]; mode: 'merge' | 'replace' }, Workspace>
  'settings.update': Spec<{ expectedRevision: Revision; llm: ClusterSettings['llm']; limits: ClusterSettings['limits'] }, ClusterSettings>
  'endpoint.test': Spec<{ hostId: Id; kind: 'llm' | 'network' }, EndpointHealth>
  'asset.delete': Spec<{ assetId: Id; expectedSha256: string }, { assetId: Id; deleted: true }>
  'workspace.import': Spec<{ id: Id; bundleAssetId: Id; stagingWorkspaceId: Id; name: string | null }, ImportResult>
}
export type QueryName = keyof QueryMap
export type CommandName = keyof CommandMap
export type QueryRequest = { [K in QueryName]: { method: K; params: QueryMap[K]['input'] } }[QueryName]
export type CommandRequest = { [K in CommandName]: { requestId: Id; method: K; params: CommandMap[K]['input'] } }[CommandName]
export type Success<T> = { ok: true; requestId: Id; data: T; replayed: boolean }
export interface Failure { ok: false; requestId: Id; error: PublicError }
export type Activity = {
  operationId: Id; attemptId: string; seq: number
  nodeId: Id; displayLabel: string; phase: 'routing' | 'working' | 'merging' | 'tool' | 'waiting' | 'stopped'
  text: string; tool: { name: string; summary: string } | null
}
export type GraphEvent =
  | { type: 'snapshot'; snapshot: GraphSnapshot }
  | { type: 'activity-reset'; operationId: Id; attemptId: string; frame: Activity | null }
  | { type: 'activity'; frame: Activity }
  | { type: 'map.deleted'; mapId: Id; revision: Revision }
  | { type: 'access.revoked'; mapId: Id }
export interface ClientAPI {
  read<K extends QueryName>(method: K, params: QueryMap[K]['input']): Promise<QueryMap[K]['output']>
  dispatch<K extends CommandName>(requestId: Id, method: K, params: CommandMap[K]['input']): Promise<CommandMap[K]['output']>
  watch(mapId: Id, listener: (event: GraphEvent) => void): () => void
  uploadAsset(input: { requestId: Id; workspaceId: Id; filename: string; mediaType: string; size: number; sha256: string; content: Uint8Array }): Promise<Asset>
  downloadAsset(assetId: Id): Promise<Uint8Array>
  exportMap(mapId: Id): Promise<MapBundle>
  exportWorkspace(workspaceId: Id): Promise<WorkspaceBundle>
  close(): void
}
/** Desktop-only methods do not cross the network. */
export interface DesktopAPI {
  getConnection(): Promise<{ baseUrl: string; configuredToken: boolean }>
  setConnection(input: { baseUrl: string; token: string | null }): Promise<void>
  setTitle(title: string): Promise<void>
  getVersion(): Promise<string>
  importWorkspace(): Promise<{ cancelled: true } | { cancelled: false; result: ImportResult }>
  exportMap(mapId: Id): Promise<{ cancelled: true } | { cancelled: false; path: string }>
  exportWorkspace(workspaceId: Id): Promise<{ cancelled: true } | { cancelled: false; path: string }>
  pickSource(workspaceId: Id): Promise<{ cancelled: true } | { cancelled: false; asset: Asset }>
}
/** Only the local Host admin CLI may call these methods. They are not public HTTP/Renderer methods. */
export interface HostAdminAPI {
  readSettings(): Promise<{ hostId: Id; mongoUriRedacted: string; clusterId: string; sessionDir: string }>
  testDatabase(uri: string): Promise<{ ok: boolean; replicaSet: boolean; databaseName: string | null; error: string | null }>
  stageDatabase(input: { uri: string; clusterId: string }): Promise<void>
  drain(): Promise<{ running: number }>
  reconnect(): Promise<void>
  setSecret(input: { name: 'llmApiKey' | 'tavilyApiKey'; value: string | null }): Promise<{ configured: boolean }>
  importAgentSeeds(): Promise<{ libraryRevision: Revision; agentCount: number }>
  createUser(input: { id: Id; displayName: string; hostAdmin: boolean }): Promise<Me>
  createToken(userId: Id): Promise<{ tokenId: Id; token: string }>
  revokeToken(tokenId: Id): Promise<void>
  disableUser(userId: Id): Promise<void>
}
/** Host-private contracts. ExecutionGrant is never supplied by a model or renderer. */
export interface ExecutionGrant {
  mapId: Id; runId: Id; operationId: Id; hostId: Id; holderId: Id; fence: number; leaseUntil: Timestamp
}
export interface ClaimInput { hostId: Id; holderId: Id; operations: OperationKind[]; policyVersions: string[] }
export interface LeaseResult { grant: ExecutionGrant; sessionKey: string; inputRefs: NodeRef[]; policyFingerprint: string }
export type DshRead =
  | { kind: 'input' }
  | { kind: 'nodes'; nodeIds: Id[]; relations: boolean }
  | { kind: 'evidence'; claimId: Id; cursor: string | null; limit: number }
  | { kind: 'reports'; reportIds: Id[] }
  | { kind: 'reviews' }
export interface ResolvedInput {
  source: NodeRef; locator: Locator; mediaType: string; text: string; sha256: string; capturedAt: Timestamp
}
export interface DshReadResult {
  nodes: Node[]; edges: Edge[]; resolvedInputs: ResolvedInput[]; context: OperationContext
  reports: Report[]; reviews: Review[]; inputFingerprint: string; nextCursor: string | null
  proposalTokens: Array<{ kind: 'route' | 'report' | 'validate' | 'save'; proposalId: Id; draftRevision: Revision }>
}
export type DshProposal =
  | { kind: 'route'; proposalId: Id; draftRevision: Revision; slots: Slot[] }
  | { kind: 'report'; proposalId: Id; draftRevision: Revision; content: Report['content'] }
  | { kind: 'validate'; proposalId: Id; draftRevision: Revision; draft: ChangeDraft }
  | { kind: 'save'; proposalId: Id; draftRevision: Revision; draftFingerprint: string }
export type DshProposalResult =
  | { state: 'recorded'; reportId: Id }
  | { state: 'waiting'; reviewId: Id; reviewRevision: Revision }
  | { state: 'approved'; draftRevision: Revision }
  | { state: 'accepted'; receipt: Receipt }
export interface DshBinding {
  grant: ExecutionGrant; role: 'root' | 'worker'; slotId: Id | null; profile: ProfileRef
}
export interface ExecutionAPI {
  claim(input: ClaimInput): Promise<LeaseResult | null>
  renew(grant: ExecutionGrant): Promise<ExecutionGrant>
  release(grant: ExecutionGrant): Promise<void>
  read(binding: DshBinding, query: DshRead): Promise<DshReadResult>
  propose(binding: DshBinding, proposal: DshProposal): Promise<DshProposalResult>
  fail(grant: ExecutionGrant, error: PublicError): Promise<void>
}

/** First-stage DSH-specific facade. Independent of Graph, Run, Mongo and ExecutionGrant. */
export interface DshFacadeEvent { method: string; params: Record<string, DshFacadeJson> }
export type DshFacadeJson = null | boolean | number | string | DshFacadeJson[] | { [key: string]: DshFacadeJson }
export interface DshFacadeRunResult { sessionId: string; finalResponse: string; events: DshFacadeEvent[] }
export interface DshRuntimeAPI {
  start(): Promise<void>
  run(input: { prompt: string; sessionId?: string }, onEvent?: (event: DshFacadeEvent) => void): Promise<DshFacadeRunResult>
  close(): Promise<void>
}
