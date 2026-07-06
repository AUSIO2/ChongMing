import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { PromptKind } from '../shared/prompt-vars'
import { promptReadSlots, promptReadKindForPath } from '../shared/prompt-vars'
import { promptRead, promptReadConfigRoot } from '../shared/prompt-loader'
import { AppError, ErrorCode } from '../shared/errors'

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

export interface PromptConfigWriteInput {
  content?: string
  promptVars?: string[]
  description?: string
  model?: string
  baseUrl?: string
}

const MAIN_AGENT_PROMPT_PATHS = [
  'fact-extractor/main-agent-route',
  'fact-extractor/main-agent-merge',
  'fact-verifier/main-agent-route',
  'fact-verifier/main-agent-merge',
  'fact-parser/extract',
] as const

function promptWriteFile(promptPath: string, data: Record<string, unknown>): void {
  const fullPath = path.join(promptReadConfigRoot(), `${promptPath}.json`)
  writeFileSync(fullPath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8')
}

function promptReadEntry(promptPath: string): PromptConfigEntry {
  const kind = promptReadKindForPath(promptPath)
  if (!kind) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID_SUBAGENT,
      `Unknown prompt path: ${promptPath}`,
    )
  }
  const raw = promptRead(promptPath)
  return {
    promptPath,
    kind,
    description: raw.description,
    content: raw.content,
    promptVars: raw.promptVars ?? [],
    model: raw.model?.trim() || undefined,
    baseUrl: raw.baseUrl?.trim() || undefined,
  }
}

export function promptVarsList(kind: PromptKind): PromptVarDescriptor[] {
  return promptReadSlots(kind)
}

export function promptConfigList(): PromptConfigEntry[] {
  return MAIN_AGENT_PROMPT_PATHS.map(p => promptReadEntry(p))
}

export function promptConfigGet(promptPath: string): PromptConfigEntry {
  if (!MAIN_AGENT_PROMPT_PATHS.includes(promptPath as typeof MAIN_AGENT_PROMPT_PATHS[number])) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID_SUBAGENT,
      `Prompt not editable via prompt-config: ${promptPath}`,
    )
  }
  return promptReadEntry(promptPath)
}

export function promptConfigUpdate(
  promptPath: string,
  patch: PromptConfigWriteInput,
): PromptConfigEntry {
  const entry = promptConfigGet(promptPath)
  const raw = promptRead(promptPath) as unknown as Record<string, unknown>
  const data: Record<string, unknown> = {
    ...raw,
    content: patch.content ?? entry.content,
  }
  if (patch.promptVars !== undefined) data.promptVars = patch.promptVars
  if (patch.description !== undefined) data.description = patch.description
  if (patch.model !== undefined) {
    if (patch.model.trim()) data.model = patch.model.trim()
    else delete data.model
  }
  if (patch.baseUrl !== undefined) {
    if (patch.baseUrl.trim()) data.baseUrl = patch.baseUrl.trim()
    else delete data.baseUrl
  }
  promptWriteFile(promptPath, data)
  return promptReadEntry(promptPath)
}
