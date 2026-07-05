/** SubAgent 注册表 — 从 subagentconfig 扫描加载（不含 LLM 实例） */

import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { Priority } from '../shared/types'
import { promptReadConfigRoot } from '../shared/prompt-loader'
import { AppError, ErrorCode } from '../shared/errors'

export type SubAgentModule = 'split' | 'verify'

/**
 * Catalog 唯一形状。
 * IPC / Map 列表暴露时去掉 promptPath / tools（运行时配置不进渲染进程）。
 */
export interface CatalogSubAgentEntry {
  agentName: string
  module: SubAgentModule
  promptPath: string
  displayLabel: string
  defaultPriority?: Priority
  description?: string
  tools?: string[]
}

/** 给渲染进程 / Map 的目录项（无 promptPath / tools）。 */
export type CatalogSubAgent = Omit<CatalogSubAgentEntry, 'promptPath' | 'tools'>

const MODULE_SUBAGENT_DIRS: Record<SubAgentModule, string> = {
  split: 'fact-extractor/sub-agents',
  verify: 'fact-verifier/sub-agents',
}

const PRIORITIES = new Set<Priority>(['high', 'medium', 'low'])

const PRIORITY_RANK: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
}


interface SubAgentConfigFile {
  agentName?: unknown
  displayLabel?: unknown
  defaultPriority?: unknown
  description?: unknown
  tools?: unknown
  content?: unknown
}

const catalogCache = new Map<SubAgentModule, CatalogSubAgentEntry[]>()

function isPriority(value: unknown): value is Priority {
  return typeof value === 'string' && PRIORITIES.has(value as Priority)
}

function parseTools(raw: unknown, promptPath: string): string[] | undefined {
  if (raw === undefined) return undefined
  if (!Array.isArray(raw) || !raw.every((t) => typeof t === 'string')) {
    throw new AppError(
      ErrorCode.CONFIG_INVALID_SUBAGENT,
      `Invalid tools in ${promptPath}.json: expected string[]`,
    )
  }
  return raw.length > 0 ? raw : undefined
}

function loadModuleCatalog(module: SubAgentModule): CatalogSubAgentEntry[] {
  const relativeDir = MODULE_SUBAGENT_DIRS[module]
  const dir = path.join(promptReadConfigRoot(), relativeDir)
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'))

  const entries = files.map((file) => {
    const promptPath = `${relativeDir}/${file.slice(0, -'.json'.length)}`
    const fullPath = path.join(dir, file)
    const raw = JSON.parse(readFileSync(fullPath, 'utf-8')) as SubAgentConfigFile

    if (typeof raw.agentName !== 'string' || !raw.agentName.trim()) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID_SUBAGENT,
        `Missing agentName in ${promptPath}.json`,
      )
    }
    if (typeof raw.displayLabel !== 'string' || !raw.displayLabel.trim()) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID_SUBAGENT,
        `Missing displayLabel in ${promptPath}.json`,
      )
    }
    if (typeof raw.content !== 'string') {
      throw new AppError(
        ErrorCode.CONFIG_INVALID_SUBAGENT,
        `Missing content in ${promptPath}.json`,
      )
    }
    if (raw.defaultPriority !== undefined && !isPriority(raw.defaultPriority)) {
      throw new AppError(
        ErrorCode.CONFIG_INVALID_SUBAGENT,
        `Invalid defaultPriority in ${promptPath}.json`,
      )
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
      throw new AppError(
        ErrorCode.CONFIG_INVALID_SUBAGENT,
        `Invalid description in ${promptPath}.json`,
      )
    }

    return {
      agentName: raw.agentName,
      module,
      promptPath,
      displayLabel: raw.displayLabel,
      defaultPriority: raw.defaultPriority as Priority | undefined,
      description: raw.description as string | undefined,
      tools: parseTools(raw.tools, promptPath),
    }
  })

  return entries.sort((a, b) => {
    const ra = a.defaultPriority ? PRIORITY_RANK[a.defaultPriority] : 99
    const rb = b.defaultPriority ? PRIORITY_RANK[b.defaultPriority] : 99
    return ra - rb || a.agentName.localeCompare(b.agentName, 'zh')
  })
}

export function catalogRead(module: SubAgentModule): CatalogSubAgentEntry[] {
  let entries = catalogCache.get(module)
  if (!entries) {
    entries = loadModuleCatalog(module)
    catalogCache.set(module, entries)
  }
  return entries
}

/** 测试 / 热重载时清空缓存 */
export function catalogDeleteCache(): void {
  catalogCache.clear()
}

export function catalogReadEntries(module: SubAgentModule): CatalogSubAgent[] {
  return catalogRead(module).map(({ promptPath: _p, tools: _t, ...item }) => item)
}
