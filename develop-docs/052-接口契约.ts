// 保存 052 阶段的历史目标接口契约；当前生产协议以 contracts 目录为准。
/**
 * 052 完整目标接口契约（设计工件，不是当前生产 API 清单）。
 * 053–058 已实现子集；059 本轮字段以正式 contracts/* 为准。
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
export interface Scope { nodeIds: Id[] }
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
  id: Id; scope: Scope; until: Until; mode: Mode; status: RunStatus; paused: boolean
  operations: OperationSummary[]; error: PublicError | null
  createdAt: Timestamp; updatedAt: Timestamp
}
export interface Receipt {
  id: Id; operationId: Id; inputRefs: NodeRef[]; inputFingerprint: string
  configFingerprint: string; outputRefs: NodeRef[]; draftRevision: Revision; nodeIds: Id[]; edgeIds: Id[]; acceptedAt: Timestamp
}
export interface Report {
  id: Id; operationId: Id; slotId: Id; producer: ProfileRef; inputRefs: NodeRef[]
  content: { kind: 'parse'; news: Array<{ content: string; context: NewsContext }> }
    | { kind: 'split'; claims: Array<{ content: string; category: string | null }> }
    | { kind: 'verify'; score: Confidence; reason: string; evidence: Array<{ content: string; locator: Locator; capturedAt: Timestamp }> }
  createdAt: Timestamp
}
export interface OperationView extends OperationSummary {
  inputRefs: NodeRef[]; outputRefs: NodeRef[]; configFingerprint: string
  context: OperationContext; reports: Report[]; reviews: Review[]; receipt: Receipt | null
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
  capabilities: { editGraph: boolean; startRun: boolean; pauseRun: boolean; resumeRun: boolean; cancelRun: boolean; answerReview: boolean }
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
  'run.pause': Spec<MapMutation & { runId: Id }, GraphWriteResult>
  'run.resume': Spec<MapMutation & { runId: Id }, GraphWriteResult>
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
  /**
   * 历史设计：按查询名称读取与输入对应的结果。
   *
   * @param method 历史契约中的查询名称，决定请求与结果类型。
   * @param params 历史查询映射所定义的对应输入。
   */
  read<K extends QueryName>(method: K, params: QueryMap[K]['input']): Promise<QueryMap[K]['output']>
  /**
   * 历史设计：使用稳定请求编号提交命令并返回其业务结果。
   *
   * @param requestId 历史契约中的稳定业务请求编号，用于写命令重放。
   * @param method 历史写命令映射中的名称。
   * @param params 所选历史命令对应的业务参数与版本条件。
   */
  dispatch<K extends CommandName>(requestId: Id, method: K, params: CommandMap[K]['input']): Promise<CommandMap[K]['output']>
  /**
   * 历史设计：监听指定图事件，返回调用方负责执行的退订函数。
   *
   * @param mapId 历史订阅接口的目标图编号。
   * @param listener 历史图事件观察者，调用者负责执行返回的退订函数。
   */
  watch(mapId: Id, listener: (event: GraphEvent) => void): () => void
  /**
   * 历史设计：上传带大小和摘要的字节内容，返回资产元信息。
   *
   * @param input 历史上传输入，包含请求编号、工作区、文件元信息、字节大小、摘要和内容。
   */
  uploadAsset(input: { requestId: Id; workspaceId: Id; filename: string; mediaType: string; size: number; sha256: string; content: Uint8Array }): Promise<Asset>
  /**
   * 历史设计：按资产编号取得内容字节。
   *
   * @param assetId 要下载的历史资产业务编号。
   */
  downloadAsset(assetId: Id): Promise<Uint8Array>
  /**
   * 历史设计：取得指定图的数据包。
   *
   * @param mapId 要导出为数据包的历史图编号。
   */
  exportMap(mapId: Id): Promise<MapBundle>
  /**
   * 历史设计：取得工作区及其图和资产的数据包。
   *
   * @param workspaceId 要导出的历史工作区编号。
   */
  exportWorkspace(workspaceId: Id): Promise<WorkspaceBundle>
  // 历史设计：关闭客户端持有的请求与订阅资源。
  close(): void
}
/** 历史设计中的桌面专用方法，不通过网络调用。 */
export interface DesktopAPI {
  // 历史设计：查询桌面服务地址和令牌是否已配置，不返回令牌。
  getConnection(): Promise<{ baseUrl: string; configuredToken: boolean }>
  /**
   * 历史设计：设置服务地址及令牌，null 表示清除令牌。
   *
   * @param input 历史桌面连接设置；token 为 null 表示清除令牌。
   */
  setConnection(input: { baseUrl: string; token: string | null }): Promise<void>
  /**
   * 历史设计：修改原生窗口标题。
   *
   * @param title 历史桌面接口要求显示的原生窗口标题。
   */
  setTitle(title: string): Promise<void>
  // 历史设计：取得桌面应用版本。
  getVersion(): Promise<string>
  // 历史设计：通过原生文件选择导入工作区，并显式返回用户取消。
  importWorkspace(): Promise<{ cancelled: true } | { cancelled: false; result: ImportResult }>
  /**
   * 历史设计：把图导出到用户选择的位置，返回路径或取消结果。
   *
   * @param mapId 经原生保存流程导出的目标图编号。
   */
  exportMap(mapId: Id): Promise<{ cancelled: true } | { cancelled: false; path: string }>
  /**
   * 历史设计：把工作区导出到用户选择的位置，返回路径或取消结果。
   *
   * @param workspaceId 经原生保存流程导出的目标工作区编号。
   */
  exportWorkspace(workspaceId: Id): Promise<{ cancelled: true } | { cancelled: false; path: string }>
  /**
   * 历史设计：选择本机来源文件并上传至工作区，支持用户取消。
   *
   * @param workspaceId 所选来源文件上传后归属的工作区编号。
   */
  pickSource(workspaceId: Id): Promise<{ cancelled: true } | { cancelled: false; asset: Asset }>
}
/** 历史设计中的本机 Host 管理接口，仅由管理命令行调用，不向公共 HTTP 或渲染器开放。 */
export interface HostAdminAPI {
  // 历史设计：读取 Host 配置，数据库地址应为脱敏值。
  readSettings(): Promise<{ hostId: Id; mongoUriRedacted: string; clusterId: string; sessionDir: string }>
  /**
   * 历史设计：检查数据库连通性和副本集能力，返回诊断结果。
   *
   * @param uri 待检查连通性与事务能力的数据库 URI，属于本机管理输入。
   */
  testDatabase(uri: string): Promise<{ ok: boolean; replicaSet: boolean; databaseName: string | null; error: string | null }>
  /**
   * 历史设计：暂存待切换数据库地址及集群身份。
   *
   * @param input 待暂存的数据库 URI 与预期集群身份，供后续重新连接使用。
   */
  stageDatabase(input: { uri: string; clusterId: string }): Promise<void>
  // 历史设计：停止新工作进入并报告仍在执行的数量。
  drain(): Promise<{ running: number }>
  // 历史设计：按已暂存配置重新连接服务依赖。
  reconnect(): Promise<void>
  /**
   * 历史设计：设置或删除指定密钥，只返回配置状态。
   *
   * @param input 历史允许的密钥名称及原文，value 为 null 表示删除。
   */
  setSecret(input: { name: 'llmApiKey' | 'tavilyApiKey'; value: string | null }): Promise<{ configured: boolean }>
  // 历史设计：导入默认 Agent 并返回库版本与数量。
  importAgentSeeds(): Promise<{ libraryRevision: Revision; agentCount: number }>
  /**
   * 历史设计：创建指定身份及管理权限的用户。
   *
   * @param input 由本机管理员指定的新用户身份、显示名和管理权限。
   */
  createUser(input: { id: Id; displayName: string; hostAdmin: boolean }): Promise<Me>
  /**
   * 历史设计：为用户签发令牌并在创建结果中返回原文。
   *
   * @param userId 将获签认证令牌的用户业务编号。
   */
  createToken(userId: Id): Promise<{ tokenId: Id; token: string }>
  /**
   * 历史设计：撤销指定令牌的认证能力。
   *
   * @param tokenId 需要撤销的令牌业务编号，不是令牌原文。
   */
  revokeToken(tokenId: Id): Promise<void>
  /**
   * 历史设计：停用指定用户。
   *
   * @param userId 需要停用的用户业务编号。
   */
  disableUser(userId: Id): Promise<void>
}
/** 历史设计中的 Host 私有协议；执行授权不由模型或渲染器提供。 */
export interface ExecutionGrant {
  mapId: Id; runId: Id; operationId: Id; hostId: Id; holderId: Id; fence: number; expiresAt: Timestamp
}
export interface ClaimInput { hostId: Id; holderId: Id; operations: OperationKind[]; policyVersions: string[] }
export interface LeaseResult { grant: ExecutionGrant; inputRefs: NodeRef[]; policyFingerprint: string }
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
  /**
   * 历史设计：为 Host 领取匹配的执行授权，无可用工作时返回 null。
   *
   * @param input 历史 Host 领取身份和可执行操作、策略版本筛选条件。
   */
  claim(input: ClaimInput): Promise<LeaseResult | null>
  /**
   * 历史设计：续期既有授权并返回更新后的授权。
   *
   * @param grant Host 当前持有的可信执行授权，用于延长同一租约。
   */
  renew(grant: ExecutionGrant): Promise<ExecutionGrant>
  /**
   * 历史设计：交还当前执行授权。
   *
   * @param grant Host 要交还的当前执行授权。
   */
  release(grant: ExecutionGrant): Promise<void>
  /**
   * 历史设计：使用受信任的执行绑定读取 Agent 可见工作数据。
   *
   * @param binding 由可信 Host 绑定的租约、角色、槽位及配置身份，不由模型自报。
   * @param query 历史数据读取种类及其节点、报告或分页选择。
   */
  read(binding: DshBinding, query: DshRead): Promise<DshReadResult>
  /**
   * 历史设计：使用执行绑定提交提案，返回记录、审核或接纳结果。
   *
   * @param binding 提交方的可信执行绑定，用于确定授权及角色范围。
   * @param proposal 历史 Agent 提案，须使用 Host 提供的提案编号和草稿版本。
   */
  propose(binding: DshBinding, proposal: DshProposal): Promise<DshProposalResult>
  /**
   * 历史设计：在执行授权下报告结构化工作失败。
   *
   * @param grant 报告失败所对应的当前执行授权。
   * @param error 需要记录的公开业务错误，不携带私有运行时故障负载。
   */
  fail(grant: ExecutionGrant, error: PublicError): Promise<void>
}

/** 第一阶段 DSH 专用外观接口，与图、Run、Mongo 和执行授权无关。 */
export interface DshFacadeEvent { method: string; params: Record<string, DshFacadeJson> }
export type DshFacadeJson = null | boolean | number | string | DshFacadeJson[] | { [key: string]: DshFacadeJson }
export interface DshFacadeRunResult { sessionId: string; finalResponse: string; events: DshFacadeEvent[] }
export interface DshRuntimeAPI {
  // 历史设计：启动独立 DSH 运行时外观。
  start(): Promise<void>
  /**
   * 历史设计：执行会话一轮并通过回调观察 DSH 事件。
   *
   * @param input 历史 DSH 一轮提示词与可选既有会话编号。
   * @param onEvent 可选 DSH 事件观察者，未提供时仍返回累积事件结果。
   */
  run(input: { prompt: string; sessionId?: string }, onEvent?: (event: DshFacadeEvent) => void): Promise<DshFacadeRunResult>
  // 历史设计：停止运行时并等待资源释放。
  close(): Promise<void>
}
