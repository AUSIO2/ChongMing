// 定义工作区、成员、Agent、资产与导入导出的公共数据和命令协议。
import type { GraphAgentProfile, GraphEdge, GraphNode, GraphRunConfiguration } from './graph'
import type { DefinitionCatalog, DefinitionPackage, DefinitionRef, ExecutionAgentDefinition } from './data-definition'

// 工作区成员的所有者、编辑者和只读角色。
export type Role = 'owner' | 'editor' | 'viewer'
// 解析、拆分及核验各角色对应的提示词种类。
export type PromptKind = string
// Agent 在通用转换阶段承担的结果职责；具体输入输出仍由精确转换定义约束。
export type AgentRole = 'producer' | 'planner' | 'selector'
// Agent 可参与的转换阶段；发布和执行时同时核对转换版本与阶段身份。
export interface AgentBinding { transition: DefinitionRef; stageId: string }
// 已认证用户的公开身份，hostAdmin 表示部署管理权限。
export interface Identity { userId: string; displayName: string; hostAdmin: boolean }
// 可选分页游标与页大小。
export interface PageInput { cursor?: string; limit?: number }
// 一页结果及后续游标，null 表示分页结束。
export interface Page<T> { items: T[]; nextCursor: string | null }
// Agent 配置所在的共享库或指定工作区。
export type AgentScope = { kind: 'library' } | { kind: 'workspace'; workspaceId: string }
// 可写 Agent 配置；提供方和模型为 null 时由共享设置补齐。
export interface AgentInput extends Omit<GraphAgentProfile, 'provider' | 'model'> {
  promptPath: string
  kind: PromptKind
  provider: string | null
  model: string | null
  promptVars: string[]
  defaultPriority: 'high' | 'medium' | 'low'
  claimCategory: 'data' | 'quote' | 'causal' | null
  role?: AgentRole
  bindings?: AgentBinding[]
}
// 带版本、删除能力和更新时间的已保存 Agent。
export interface AgentProfile extends AgentInput { revision: number; deletable: boolean; updatedAt: string }
// 某一作用域的 Agent 列表及用于并发写入检查的集合版本。
export interface AgentList { scope: AgentScope; revision: number; items: AgentProfile[] }
// 工作区成员的用户身份及角色。
export interface Member { userId: string; displayName: string; role: Role }
// 用户在工作区内的独立界面偏好，使用自己的版本控制打开图与节点选择。
export interface Preferences {
  workspaceId: string; revision: number; openMapIds: string[]; currentMapId: string | null
  nodeSelection: Record<string, string | null>
}
// 当前用户可见的工作区概况，包含该用户角色及图数量。
export interface WorkspaceSummary { id: string; name: string; description: string; revision: number; role: Role; mapCount: number; updatedAt: string }
// 工作区详情，组合 Agent、成员及当前用户偏好。
export interface WorkspaceView extends WorkspaceSummary { agents: AgentProfile[]; members: Member[]; preferences: Preferences }
// 带版本的共享模型默认值、工具目录和 Agent 槽位上限。
export interface ClusterSettings {
  revision: number
  llm: { provider: string; model: string }
  tools: GraphRunConfiguration['tools']
  limits: { maxAgentSlots: number }
}
// 认证后的界面初始化数据，包含用户、共享设置及提示词元数据。
export interface AppBootstrap {
  identity: Identity
  settings: ClusterSettings
  metadata: {
    // 服务端决定是否要求客户端租约；省略时客户端保守采用 required。
    clientLeases?: 'required' | 'none'
    version: string; promptKinds: PromptKind[]; executableKinds: Array<'parse' | 'split' | 'verify'>; scores: [0, 0.5, 1]
    variables: Record<PromptKind, string[]>
    outputs: Array<{ kind: PromptKind; content: string }>
    definitions: { queryMethod: 'definition.get'; publishMethod: 'definition.publish' }
  }
}
// 工作区已发布定义目录及可选精确包；目录中的定义都是独立只读副本。
export interface DefinitionView {
  workspaceId: string
  catalog: DefinitionCatalog
  package?: DefinitionPackage
}
// 定义整包发布结果，workspaceRevision 用于后续同工作区写入的版本条件。
export interface DefinitionPublishResult {
  workspaceId: string
  workspaceRevision: number
  package: { ref: DefinitionRef; digest: string }
}
// 工作区资产元信息，摘要与大小用于校验内容完整性。
export interface Asset { id: string; workspaceId: string; filename: string; mediaType: string; size: number; sha256: string; createdAt: string }
// 导出包内的资产元信息及 Base64 内容，不保留原工作区归属。
export interface BundleAsset extends Omit<Asset, 'workspaceId' | 'createdAt'> { contentBase64: string }
// 导出包中的图编号、名称、节点及边。
export interface BundleMap { id: string; name: string; nodes: GraphNode[]; edges: GraphEdge[] }
// v4 包携带节点精确类型所属包及其包依赖闭包；摘要用于拒绝包体被篡改。
export interface BundleDefinitions {
  packages: DefinitionPackage[]
  agents: ExecutionAgentDefinition[]
  digests: Array<{ ref: DefinitionRef; digest: string }>
}
// 可编辑 Agent 在原工作区的精确版本，用于导入时重写定义中对当前配置的引用。
export interface BundleAgent extends AgentInput { revision: number }
// 版本 4 的单图导出包，不包含 Run、租约或收据等可执行状态。
export interface MapBundle {
  format: 'chongming-map'; version: 4; id: string; exportedAt: string
  map: BundleMap; agents: BundleAgent[]; definitions: BundleDefinitions; assets: BundleAsset[]
}
// 版本 4 的工作区导出包，包含工作区配置、多个图、精确定义闭包与资产。
export interface WorkspaceBundle {
  format: 'chongming-workspace'; version: 4; id: string; exportedAt: string
  workspace: { name: string; description: string; agents: BundleAgent[] }
  maps: BundleMap[]; definitions: BundleDefinitions; assets: BundleAsset[]
}
// 导入完成后的目标工作区及新建图、资产编号集合。
export interface ImportResult { workspaceId: string; mapIds: string[]; assetIds: string[] }
// 公共管理查询的判别联合，方法名称决定参数结构。
export type ControlQuery =
  | { method: 'app.bootstrap'; params: Record<string, never> }
  | { method: 'workspace.list'; params: PageInput }
  | { method: 'workspace.get'; params: { workspaceId: string } }
  | { method: 'agent.list'; params: { scope: AgentScope; kind?: PromptKind } }
  | { method: 'definition.get'; params: { workspaceId: string; packageId?: string; packageVersion?: number } }
  | { method: 'asset.get'; params: { assetId: string } }
  | { method: 'asset.list'; params: PageInput & { workspaceId: string } }
// 工作区写入目标与调用方预期版本，用于拒绝并发覆盖。
export type WorkspaceMutation = { workspaceId: string; expectedRevision: number }
// 携带稳定请求编号的管理写命令，资源变更同时携带相应版本条件。
export type ControlCommand = { requestId: string } & (
  | { method: 'workspace.create'; params: { id: string; name: string; description: string; agentSource: 'empty' | 'library' } }
  | { method: 'workspace.update'; params: WorkspaceMutation & { name: string; description: string } }
  | { method: 'workspace.delete'; params: WorkspaceMutation }
  | { method: 'member.set'; params: WorkspaceMutation & { userId: string; role: Role | null } }
  | { method: 'preferences.set'; params: WorkspaceMutation & Omit<Preferences, 'workspaceId' | 'revision'> }
  | { method: 'agent.create'; params: { scope: AgentScope; expectedRevision: number; agent: AgentInput } }
  | { method: 'agent.update'; params: { scope: AgentScope; expectedRevision: number; agentId: string; expectedAgentRevision: number; agent: AgentInput } }
  | { method: 'agent.delete'; params: { scope: AgentScope; expectedRevision: number; agentId: string; expectedAgentRevision: number } }
  | { method: 'agent.copy'; params: WorkspaceMutation & { libraryRevision: number; agentIds: string[]; mode: 'merge' | 'replace' } }
  | { method: 'definition.publish'; params: WorkspaceMutation & { package: DefinitionPackage } }
  | { method: 'settings.update'; params: Omit<ClusterSettings, 'revision'> & { expectedRevision: number } }
  | { method: 'asset.delete'; params: { assetId: string; expectedSha256: string } }
  | { method: 'workspace.import'; params: { id: string; bundleAssetId: string; stagingWorkspaceId: string; name: string | null } }
)
