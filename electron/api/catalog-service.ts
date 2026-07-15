import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Priority } from '../shared/types'
import { promptRead, promptReadConfigRoot } from '../shared/prompt-loader'
import { promptReadKindForSubAgent, promptReadSlotIds } from '../shared/prompt-vars'
import { AppError, ErrorCode } from '../shared/errors'
import {
  catalogDeleteCache,
  catalogRead,
  type CatalogSubAgent,
  type CatalogSubAgentEntry,
  type SubAgentModule,
} from './sub-agent-catalog'

export interface CatalogWriteInput {
  agentName: string
  displayLabel: string
  content: string
  promptVars?: string[]
  claimCategory?: 'data' | 'quote' | 'causal'
  defaultPriority?: Priority
  description?: string
  tools?: string[]
  model?: string
  baseUrl?: string
  fileSlug?: string
}

function catalogReadEntry(
  module: SubAgentModule,
  agentName: string,
): CatalogSubAgentEntry {
  const entry = catalogRead(module).find(e => e.agentName === agentName)
  if (!entry) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID_SUBAGENT,
      `SubAgent not found: ${module}/${agentName}`,
    )
  }
  return entry
}

function catalogReadFileJson(promptPath: string): Record<string, unknown> {
  return promptRead(promptPath) as unknown as Record<string, unknown>
}

function catalogWriteFile(promptPath: string, data: Record<string, unknown>): void {
  const fullPath = path.join(promptReadConfigRoot(), `${promptPath}.json`)
  writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  catalogDeleteCache()
}

function catalogSlugify(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-_]/g, '')
  return slug || `agent-${Date.now()}`
}

export function catalogListAll(): { split: CatalogSubAgent[], verify: CatalogSubAgent[] } {
  return {
    split: catalogRead('split').map(({ promptPath: _p, tools: _t, model: _m, baseUrl: _b, ...item }) => item),
    verify: catalogRead('verify').map(({ promptPath: _p, tools: _t, model: _m, baseUrl: _b, ...item }) => item),
  }
}

export function catalogGet(module: SubAgentModule, agentName: string): CatalogSubAgent & {
  content: string
  promptVars: string[]
  claimCategory?: 'data' | 'quote' | 'causal'
  tools?: string[]
  model?: string
  baseUrl?: string
} {
  const entry = catalogReadEntry(module, agentName)
  const raw = catalogReadFileJson(entry.promptPath)
  const promptVars = Array.isArray(raw.promptVars)
    ? raw.promptVars.filter((v): v is string => typeof v === 'string')
    : []
  const claimCategory = raw.claimCategory
  return {
    agentName: entry.agentName,
    module: entry.module,
    displayLabel: entry.displayLabel,
    defaultPriority: entry.defaultPriority,
    description: entry.description,
    content: String(raw.content ?? ''),
    promptVars,
    claimCategory: claimCategory === 'data' || claimCategory === 'quote' || claimCategory === 'causal'
      ? claimCategory
      : undefined,
    tools: entry.tools,
    model: entry.model,
    baseUrl: entry.baseUrl,
  }
}

export function catalogCreate(module: SubAgentModule, input: CatalogWriteInput): CatalogSubAgent {
  const relativeDir = module === 'split'
    ? 'fact-extractor/sub-agents'
    : 'fact-verifier/sub-agents'
  const slug = input.fileSlug?.trim() || catalogSlugify(input.agentName)
  const promptPath = `${relativeDir}/${slug}`
  const fullPath = path.join(promptReadConfigRoot(), `${promptPath}.json`)
  if (existsSync(fullPath)) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID_SUBAGENT,
      `SubAgent file already exists: ${promptPath}`,
    )
  }

  const data: Record<string, unknown> = {
    agentName: input.agentName,
    displayLabel: input.displayLabel,
    content: input.content,
  }
  if (input.promptVars?.length) {
    data.promptVars = input.promptVars
  } else {
    data.promptVars = promptReadSlotIds(promptReadKindForSubAgent(module))
  }
  if (module === 'split') {
    data.claimCategory = input.claimCategory ?? 'data'
  } else if (input.claimCategory) {
    data.claimCategory = input.claimCategory
  }
  if (input.defaultPriority) data.defaultPriority = input.defaultPriority
  if (input.description) data.description = input.description
  if (input.tools?.length) data.tools = input.tools
  if (input.model?.trim()) data.model = input.model.trim()
  if (input.baseUrl?.trim()) data.baseUrl = input.baseUrl.trim()

  writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
  catalogDeleteCache()
  void import('./local-agent-service').then(m => m.localAgentSyncFromDiskPath(promptPath))
  return catalogGet(module, input.agentName)
}

export function catalogUpdate(
  module: SubAgentModule,
  agentName: string,
  patch: Partial<CatalogWriteInput>,
): CatalogSubAgent {
  const entry = catalogReadEntry(module, agentName)
  const raw = catalogReadFileJson(entry.promptPath)
  const nextName = patch.agentName ?? agentName
  const data: Record<string, unknown> = {
    ...raw,
    agentName: nextName,
    displayLabel: patch.displayLabel ?? raw.displayLabel,
  }
  if (patch.content !== undefined) data.content = patch.content
  if (patch.promptVars !== undefined) data.promptVars = patch.promptVars
  if (patch.claimCategory !== undefined) data.claimCategory = patch.claimCategory
  if (patch.defaultPriority !== undefined) data.defaultPriority = patch.defaultPriority
  if (patch.description !== undefined) data.description = patch.description
  if (patch.tools !== undefined) data.tools = patch.tools
  if (patch.model !== undefined) {
    if (patch.model.trim()) data.model = patch.model.trim()
    else delete data.model
  }
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl.trim()) data.baseUrl = patch.baseUrl.trim()
    else delete data.baseUrl
  }
  catalogWriteFile(entry.promptPath, data)
  void import('./local-agent-service').then(m =>
    m.localAgentSyncFromDiskPath(entry.promptPath),
  )
  return catalogGet(module, nextName)
}

export function catalogDelete(module: SubAgentModule, agentName: string): void {
  const entry = catalogReadEntry(module, agentName)
  const fullPath = path.join(promptReadConfigRoot(), `${entry.promptPath}.json`)
  unlinkSync(fullPath)
  catalogDeleteCache()
  void import('./local-agent-service').then(m => m.localAgentDelete(entry.promptPath))
}

export function catalogReload(): void {
  catalogDeleteCache()
  void import('./local-agent-service').then(m => m.localAgentSeedFromDisk(true))
}
