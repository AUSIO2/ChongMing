import type { Priority } from '../shared/types'
import type { ClaimCategory } from '../shared/prompt-output'
import type { PromptKind } from '../shared/prompt-vars'
import {
  promptReadKindForPath,
  promptReadKindForSubAgent,
  promptReadSlotIds,
} from '../shared/prompt-vars'
import { promptFormatOutput } from '../shared/prompt-output'
import { promptRead } from '../shared/prompt-loader'
import { AppError, ErrorCode } from '../shared/errors'
import {
  catalogCreate,
  catalogDelete,
  catalogGet,
  catalogReload,
  catalogUpdate,
  type CatalogWriteInput,
} from './catalog-service'
import {
  promptConfigGet,
  promptConfigList,
  promptConfigUpdate,
} from './prompt-config-service'
import { catalogRead } from './sub-agent-catalog'

export type AgentType = 'split' | 'verify' | 'parse' | 'coordinator'

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

const COORDINATOR_LABELS: Record<string, string> = {
  'fact-extractor/main-agent-route': '事实拆分 · 路由',
  'fact-extractor/main-agent-merge': '事实拆分 · 合并',
  'fact-verifier/main-agent-route': '事实核查 · 路由',
  'fact-verifier/main-agent-merge': '事实核查 · 合并',
}

const TYPE_ORDER: Record<AgentType, number> = {
  coordinator: 0,
  parse: 1,
  split: 2,
  verify: 3,
}

function registryReadAgentType(promptPath: string): AgentType {
  if (promptPath === 'fact-parser/extract') return 'parse'
  if (promptPath.includes('/main-agent-')) return 'coordinator'
  if (promptPath.startsWith('fact-extractor/sub-agents/')) return 'split'
  if (promptPath.startsWith('fact-verifier/sub-agents/')) return 'verify'
  throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, `Unknown agent path: ${promptPath}`)
}

function registryReadDisplayLabel(
  promptPath: string,
  agentType: AgentType,
  fallback?: string,
): string {
  if (agentType === 'coordinator') {
    return COORDINATOR_LABELS[promptPath] ?? fallback ?? promptPath
  }
  if (agentType === 'parse') return fallback ?? '稿件解析'
  return fallback ?? promptPath
}

function registryReadSubAgentModule(agentType: AgentType): 'split' | 'verify' {
  if (agentType === 'split') return 'split'
  if (agentType === 'verify') return 'verify'
  throw new AppError(
    ErrorCode.CONFIG_INVALID_SUBAGENT,
    `Not a SubAgent type: ${agentType}`,
  )
}

function registryReadClaimCategory(raw: Record<string, unknown>): ClaimCategory | undefined {
  const value = raw.claimCategory
  if (value === 'data' || value === 'quote' || value === 'causal') return value
  return undefined
}

export function registryList(): AgentRegistryItem[] {
  const items: AgentRegistryItem[] = []

  for (const entry of catalogRead('split')) {
    items.push({
      id: entry.promptPath,
      agentType: 'split',
      promptPath: entry.promptPath,
      displayLabel: entry.displayLabel,
      agentName: entry.agentName,
      kind: 'splitSubAgent',
      deletable: true,
    })
  }

  for (const entry of catalogRead('verify')) {
    items.push({
      id: entry.promptPath,
      agentType: 'verify',
      promptPath: entry.promptPath,
      displayLabel: entry.displayLabel,
      agentName: entry.agentName,
      kind: 'verifySubAgent',
      deletable: true,
    })
  }

  for (const promptPath of promptConfigList().map(e => e.promptPath)) {
    const agentType = registryReadAgentType(promptPath)
    const kind = promptReadKindForPath(promptPath)!
    const raw = promptRead(promptPath)
    items.push({
      id: promptPath,
      agentType,
      promptPath,
      displayLabel: registryReadDisplayLabel(promptPath, agentType, raw.description),
      kind,
      deletable: false,
    })
  }

  return items.sort((a, b) => {
    const ta = TYPE_ORDER[a.agentType] - TYPE_ORDER[b.agentType]
    if (ta !== 0) return ta
    return a.displayLabel.localeCompare(b.displayLabel, 'zh')
  })
}

export function registryGet(promptPath: string): AgentRegistryDetail {
  const agentType = registryReadAgentType(promptPath)
  const kind = promptReadKindForPath(promptPath)!

  if (agentType === 'split' || agentType === 'verify') {
    const module = registryReadSubAgentModule(agentType)
    const entry = catalogRead(module).find(e => e.promptPath === promptPath)
    if (!entry) {
      throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, `Agent not found: ${promptPath}`)
    }
    const detail = catalogGet(module, entry.agentName)
    const raw = promptRead(promptPath) as unknown as Record<string, unknown>
    return {
      id: promptPath,
      agentType,
      promptPath,
      displayLabel: detail.displayLabel,
      agentName: detail.agentName,
      kind,
      deletable: true,
      content: detail.content,
      promptVars: detail.promptVars,
      description: detail.description,
      defaultPriority: detail.defaultPriority,
      tools: detail.tools,
      model: detail.model,
      baseUrl: detail.baseUrl,
      claimCategory: registryReadClaimCategory(raw),
    }
  }

  const config = promptConfigGet(promptPath)
  return {
    id: promptPath,
    agentType,
    promptPath,
    displayLabel: registryReadDisplayLabel(promptPath, agentType, config.description),
    kind,
    deletable: false,
    content: config.content,
    promptVars: config.promptVars,
    description: config.description,
    model: config.model,
    baseUrl: config.baseUrl,
  }
}

export function registryCreate(input: AgentRegistryCreateInput): AgentRegistryDetail {
  const module = registryReadSubAgentModule(input.agentType)
  const catalogInput: CatalogWriteInput = {
    agentName: input.agentName,
    displayLabel: input.displayLabel,
    content: input.content,
    fileSlug: input.endpointSlug,
    promptVars: input.promptVars,
    claimCategory: input.claimCategory,
    defaultPriority: input.defaultPriority,
    description: input.description,
    tools: input.tools,
    model: input.model,
    baseUrl: input.baseUrl,
  }
  catalogCreate(module, catalogInput)
  const promptPath = module === 'split'
    ? `fact-extractor/sub-agents/${input.endpointSlug}`
    : `fact-verifier/sub-agents/${input.endpointSlug}`
  return registryGet(promptPath)
}

export function registryUpdate(
  promptPath: string,
  patch: AgentRegistryUpdateInput,
): AgentRegistryDetail {
  const agentType = registryReadAgentType(promptPath)

  if (agentType === 'split' || agentType === 'verify') {
    const module = registryReadSubAgentModule(agentType)
    const entry = catalogRead(module).find(e => e.promptPath === promptPath)
    if (!entry) {
      throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, `Agent not found: ${promptPath}`)
    }
    catalogUpdate(module, entry.agentName, {
      agentName: patch.agentName,
      displayLabel: patch.displayLabel,
      content: patch.content,
      promptVars: patch.promptVars,
      claimCategory: patch.claimCategory,
      defaultPriority: patch.defaultPriority,
      description: patch.description,
      tools: patch.tools,
      model: patch.model,
      baseUrl: patch.baseUrl,
    })
    const nextName = patch.agentName ?? entry.agentName
    const nextEntry = catalogRead(module).find(e => e.agentName === nextName)
    return registryGet(nextEntry?.promptPath ?? promptPath)
  }

  const existing = promptConfigGet(promptPath)
  promptConfigUpdate(promptPath, {
    content: patch.content ?? existing.content,
    promptVars: patch.promptVars,
    description: patch.displayLabel ?? patch.description,
    model: patch.model,
    baseUrl: patch.baseUrl,
  })
  return registryGet(promptPath)
}

export function registryDelete(promptPath: string): void {
  const detail = registryGet(promptPath)
  if (!detail.deletable) {
    throw new AppError(ErrorCode.CONFIG_INVALID_SUBAGENT, `Agent not deletable: ${promptPath}`)
  }
  const module = registryReadSubAgentModule(detail.agentType)
  catalogDelete(module, detail.agentName!)
}

export function registryReload(): void {
  catalogReload()
}

export function registryPreviewOutput(
  kind: PromptKind,
  params?: { claimCategory?: ClaimCategory },
): string {
  return promptFormatOutput(kind, params)
}

export function registryReadDefaultPromptVars(agentType: AgentType): string[] {
  if (agentType === 'split') return promptReadSlotIds('splitSubAgent')
  if (agentType === 'verify') return promptReadSlotIds('verifySubAgent')
  if (agentType === 'parse') return promptReadSlotIds('parseExtract')
  return []
}

export function registryReadKind(agentType: AgentType, promptPath?: string): PromptKind {
  if (agentType === 'split') return 'splitSubAgent'
  if (agentType === 'verify') return 'verifySubAgent'
  if (agentType === 'parse') return 'parseExtract'
  if (promptPath) {
    const kind = promptReadKindForPath(promptPath)
    if (kind) return kind
  }
  return 'splitRoute'
}

export function registryReadEndpointPrefix(agentType: AgentType): string {
  if (agentType === 'split') return 'fact-extractor/sub-agents/'
  if (agentType === 'verify') return 'fact-verifier/sub-agents/'
  if (agentType === 'parse') return 'fact-parser/'
  return ''
}

export { promptReadKindForSubAgent }
