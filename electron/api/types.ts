import type {
  AgentDoc,
  AgentType,
  Priority,
} from '../shared/types'
import type {
  MapperAPI,
  MapperMapSummary,
} from '../mapper/types'
import type { CatalogSubAgent } from './sub-agent-catalog'

export type { AgentDoc, AgentType, Priority, CatalogSubAgent }

export interface DisplayWorkspaceSummary {
  _id: string
  name: string
  description?: string
  agentCount: number
  mapCount: number
  updatedAt: string
}

export interface DisplayWorkspace {
  _id: string
  name: string
  description?: string
  agents: AgentDoc[]
  ui?: { currentMapId?: string; openMapIds?: string[] }
  createdAt: string
  updatedAt: string
}

export interface CreateWorkspaceInput {
  _id?: string
  name: string
  description?: string
  copyLocalAgents?: boolean
  agents?: AgentDoc[]
}

export interface UpdateWorkspaceInput {
  name?: string
  description?: string
  agents?: AgentDoc[]
  ui?: DisplayWorkspace['ui']
}

export type UploadLocalAgentsMode = 'merge' | 'replace'

export interface WorkspaceAPI {
  list(): Promise<DisplayWorkspaceSummary[]>
  get(workspaceId: string): Promise<DisplayWorkspace | null>
  create(input: CreateWorkspaceInput): Promise<DisplayWorkspace>
  update(workspaceId: string, patch: UpdateWorkspaceInput): Promise<DisplayWorkspace>
  delete(workspaceId: string): Promise<void>
  uploadLocalAgents(
    workspaceId: string,
    mode?: UploadLocalAgentsMode,
  ): Promise<DisplayWorkspace>
}

export interface CatalogAPI {
  list(module: 'split' | 'verify'): Promise<CatalogSubAgent[]>
  listAll(): Promise<{ split: CatalogSubAgent[]; verify: CatalogSubAgent[] }>
  get(module: 'split' | 'verify', agentName: string): Promise<CatalogSubAgent & {
    content: string
    promptVars: string[]
    claimCategory?: ClaimCategory
    tools?: string[]
    model?: string
    baseUrl?: string
  }>
  create(module: 'split' | 'verify', input: CatalogWriteInput): Promise<CatalogSubAgent>
  update(
    module: 'split' | 'verify',
    agentName: string,
    patch: Partial<CatalogWriteInput>,
  ): Promise<CatalogSubAgent>
  delete(module: 'split' | 'verify', agentName: string): Promise<void>
  reload(): Promise<void>
}

export interface CatalogWriteInput {
  agentName: string
  displayLabel: string
  content: string
  promptVars?: string[]
  claimCategory?: ClaimCategory
  defaultPriority?: Priority
  description?: string
  tools?: string[]
  model?: string
  baseUrl?: string
  fileSlug?: string
}

export type ClaimCategory = 'data' | 'quote' | 'causal'

export type PromptKind =
  | 'splitSubAgent'
  | 'verifySubAgent'
  | 'splitRoute'
  | 'splitMerge'
  | 'verifyRoute'
  | 'verifyMerge'
  | 'parseExtract'

export interface AgentRegistryItem {
  id: string
  agentType: AgentType
  promptPath: string
  displayLabel: string
  agentName?: string
  kind: PromptKind
  deletable: boolean
}

export interface AgentRegistryDetail extends AgentRegistryItem {
  content: string
  promptVars: string[]
  description?: string
  defaultPriority?: Priority
  tools?: string[]
  model?: string
  baseUrl?: string
  claimCategory?: ClaimCategory
}

export interface AgentRegistryCreateInput {
  agentType: 'split' | 'verify'
  agentName: string
  displayLabel: string
  content: string
  endpointSlug: string
  promptVars?: string[]
  claimCategory?: ClaimCategory
  defaultPriority?: Priority
  description?: string
  tools?: string[]
  model?: string
  baseUrl?: string
}

export interface AgentRegistryUpdateInput {
  agentName?: string
  displayLabel?: string
  content?: string
  promptVars?: string[]
  claimCategory?: ClaimCategory
  defaultPriority?: Priority
  description?: string
  tools?: string[]
  model?: string
  baseUrl?: string
}

export interface AgentRegistryAPI {
  list(): Promise<AgentRegistryItem[]>
  get(promptPath: string): Promise<AgentRegistryDetail>
  create(input: AgentRegistryCreateInput): Promise<AgentRegistryDetail>
  update(promptPath: string, patch: AgentRegistryUpdateInput): Promise<AgentRegistryDetail>
  delete(promptPath: string): Promise<void>
  reload(): Promise<void>
  previewOutput(
    kind: PromptKind,
    params?: { claimCategory?: ClaimCategory },
  ): Promise<string>
}

export interface SkillDescriptor {
  id: string
  displayLabel: string
  description: string
  requiredKeys: Array<'tavilyApiKey'>
}

export interface AppLlmSettingsDto {
  apiKey?: string
  baseUrl?: string
  model?: string
}

export interface AppSkillSettingsDto {
  tavilyApiKey?: string
}

export interface AppSettingsDto {
  llm: AppLlmSettingsDto
  skills: AppSkillSettingsDto
  defaults: { baseUrl: string; model: string }
  configured: { llmApiKey: boolean; tavilyApiKey: boolean }
}

export interface AppEndpointPingDto {
  ok: boolean
  latencyMs: number
  host: string
  baseUrl: string
  error?: string
}

export interface AppAPI {
  getSettings(): Promise<AppSettingsDto>
  saveSettings(input: {
    llm?: AppLlmSettingsDto
    skills?: AppSkillSettingsDto
  }): Promise<void>
  testLlm(): Promise<{ ok: boolean; error?: string }>
  getVersion(): Promise<string>
  pingEndpoint(): Promise<AppEndpointPingDto>
  setTitle(title: string): Promise<void>
}

export interface PromptVarDescriptor {
  id: string
  label: string
  placeholder: string
  description?: string
}

export interface PromptConfigEntry {
  promptPath: string
  kind: PromptKind
  description?: string
  content: string
  promptVars: string[]
  model?: string
  baseUrl?: string
}

export interface PromptVarsAPI {
  list(kind: PromptKind): Promise<PromptVarDescriptor[]>
}

export interface PromptConfigAPI {
  list(): Promise<PromptConfigEntry[]>
  get(promptPath: string): Promise<PromptConfigEntry>
  update(
    promptPath: string,
    patch: {
      content?: string
      promptVars?: string[]
      description?: string
      model?: string
      baseUrl?: string
    },
  ): Promise<PromptConfigEntry>
}

export interface SkillsAPI {
  list(): Promise<SkillDescriptor[]>
}

export interface FileAPI {
  exportMap(mapId: string): Promise<{ ok: boolean; path?: string; cancelled?: boolean }>
  exportWorkspace(workspaceId: string): Promise<{
    ok: boolean
    path?: string
    cancelled?: boolean
  }>
  importWorkspace(): Promise<{
    ok: boolean
    workspaceId?: string
    cancelled?: boolean
    error?: string
  }>
}

export interface DbAPI {
  getSettings(): Promise<{ uri: string; defaultUri: string }>
  saveSettings(uri: string): Promise<void>
  getStatus(): Promise<{
    uri: string
    connected: boolean
    readyState: number
    databaseName?: string
  }>
  testConnection(uri: string): Promise<{ ok: boolean; error?: string }>
  reconnect(): Promise<MapperMapSummary[]>
  switch(uri: string): Promise<MapperMapSummary[]>
}

export interface ElectronAPI {
  mapper: MapperAPI
  workspace: WorkspaceAPI
  catalog: CatalogAPI
  file: FileAPI
  db: DbAPI
  app: AppAPI
  skills: SkillsAPI
  promptVars: PromptVarsAPI
  promptConfig: PromptConfigAPI
  agentRegistry: AgentRegistryAPI
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
