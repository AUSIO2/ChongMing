import type { GraphAgentProfile, GraphEdge, GraphNode, GraphRunConfiguration } from './graph'

export type Role = 'owner' | 'editor' | 'viewer'
export type PromptKind = 'parseExtract' | 'splitRoute' | 'splitSubAgent' | 'splitMerge' | 'verifyRoute' | 'verifySubAgent' | 'verifyMerge'
export interface Identity { userId: string; displayName: string; hostAdmin: boolean }
export interface PageInput { cursor?: string; limit?: number }
export interface Page<T> { items: T[]; nextCursor: string | null }
export type AgentScope = { kind: 'library' } | { kind: 'workspace'; workspaceId: string }
export interface AgentInput extends Omit<GraphAgentProfile, 'provider' | 'model'> {
  promptPath: string
  kind: PromptKind
  provider: string | null
  model: string | null
  promptVars: string[]
  defaultPriority: 'high' | 'medium' | 'low'
  claimCategory: 'data' | 'quote' | 'causal' | null
}
export interface AgentProfile extends AgentInput { revision: number; deletable: boolean; updatedAt: string }
export interface AgentList { scope: AgentScope; revision: number; items: AgentProfile[] }
export interface Member { userId: string; displayName: string; role: Role }
export interface Preferences {
  workspaceId: string; revision: number; openMapIds: string[]; currentMapId: string | null
  nodeSelection: Record<string, string | null>
}
export interface WorkspaceSummary { id: string; name: string; description: string; revision: number; role: Role; mapCount: number; updatedAt: string }
export interface WorkspaceView extends WorkspaceSummary { agents: AgentProfile[]; members: Member[]; preferences: Preferences }
export interface ClusterSettings {
  revision: number
  llm: { provider: string; model: string }
  tools: GraphRunConfiguration['tools']
  limits: { maxAgentSlots: number }
}
export interface AppBootstrap {
  identity: Identity
  settings: ClusterSettings
  metadata: {
    version: string; promptKinds: PromptKind[]; executableKinds: ['verify']; scores: [0, 0.5, 1]
    variables: Record<PromptKind, string[]>
    outputs: Array<{ kind: 'verifyRoute' | 'verifySubAgent' | 'verifyMerge'; content: string }>
  }
}
export interface Asset { id: string; workspaceId: string; filename: string; mediaType: string; size: number; sha256: string; createdAt: string }
export interface BundleAsset extends Omit<Asset, 'workspaceId' | 'createdAt'> { contentBase64: string }
export interface BundleMap { id: string; name: string; nodes: GraphNode[]; edges: GraphEdge[] }
export interface MapBundle { format: 'chongming-map'; version: 3; id: string; exportedAt: string; map: BundleMap; agents: AgentInput[]; assets: BundleAsset[] }
export interface WorkspaceBundle {
  format: 'chongming-workspace'; version: 3; id: string; exportedAt: string
  workspace: { name: string; description: string; agents: AgentInput[] }
  maps: BundleMap[]; assets: BundleAsset[]
}
export interface ImportResult { workspaceId: string; mapIds: string[]; assetIds: string[] }
export type ControlQuery =
  | { method: 'app.bootstrap'; params: Record<string, never> }
  | { method: 'workspace.list'; params: PageInput }
  | { method: 'workspace.get'; params: { workspaceId: string } }
  | { method: 'agent.list'; params: { scope: AgentScope; kind?: PromptKind } }
  | { method: 'asset.get'; params: { assetId: string } }
export type WorkspaceMutation = { workspaceId: string; expectedRevision: number }
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
  | { method: 'settings.update'; params: Omit<ClusterSettings, 'revision'> & { expectedRevision: number } }
  | { method: 'asset.delete'; params: { assetId: string; expectedSha256: string } }
  | { method: 'workspace.import'; params: { id: string; bundleAssetId: string; stagingWorkspaceId: string; name: string | null } }
)
