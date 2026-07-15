/** 本地 Agent 池 — Mongo `local_agents`，由磁盘 subagentconfig 种子导入 */

import { LocalAgentModel } from '../shared/database'
import { promptRead } from '../shared/prompt-loader'
import type { AgentDoc, AgentType, Priority } from '../shared/types'
import { catalogDeleteCache, catalogRead } from './sub-agent-catalog'

const COORDINATOR_AND_PARSE: Array<{
  promptPath: string
  agentType: AgentType
  displayLabel: string
}> = [
  {
    promptPath: 'fact-extractor/main-agent-route',
    agentType: 'coordinator',
    displayLabel: '事实拆分 · 路由',
  },
  {
    promptPath: 'fact-extractor/main-agent-merge',
    agentType: 'coordinator',
    displayLabel: '事实拆分 · 合并',
  },
  {
    promptPath: 'fact-verifier/main-agent-route',
    agentType: 'coordinator',
    displayLabel: '事实核查 · 路由',
  },
  {
    promptPath: 'fact-verifier/main-agent-merge',
    agentType: 'coordinator',
    displayLabel: '事实核查 · 合并',
  },
  {
    promptPath: 'fact-parser/extract',
    agentType: 'parse',
    displayLabel: '源解析',
  },
]

function agentDocFromDisk(opts: {
  promptPath: string
  agentType: AgentType
  displayLabel: string
  agentName?: string
  defaultPriority?: Priority
  tools?: string[]
  model?: string
  baseUrl?: string
}): AgentDoc {
  const raw = promptRead(opts.promptPath) as PromptConfigLike
  return {
    promptPath: opts.promptPath,
    agentType: opts.agentType,
    agentName: opts.agentName,
    displayLabel: opts.displayLabel,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    content: String(raw.content ?? ''),
    promptVars: Array.isArray(raw.promptVars)
      ? raw.promptVars.filter((v): v is string => typeof v === 'string')
      : [],
    defaultPriority: opts.defaultPriority,
    claimCategory: raw.claimCategory === 'data' || raw.claimCategory === 'quote'
      || raw.claimCategory === 'causal'
      ? raw.claimCategory
      : undefined,
    tools: opts.tools,
    model: opts.model ?? (typeof raw.model === 'string' ? raw.model : undefined),
    baseUrl: opts.baseUrl ?? (typeof raw.baseUrl === 'string' ? raw.baseUrl : undefined),
    updatedAt: new Date(),
  }
}

interface PromptConfigLike {
  description?: unknown
  content?: unknown
  promptVars?: unknown
  claimCategory?: unknown
  model?: unknown
  baseUrl?: unknown
}

/** 从磁盘扫描组装全量 AgentDoc（不写库） */
export function localAgentReadFromDisk(): AgentDoc[] {
  catalogDeleteCache()
  const docs: AgentDoc[] = []

  for (const module of ['split', 'verify'] as const) {
    for (const entry of catalogRead(module)) {
      docs.push(agentDocFromDisk({
        promptPath: entry.promptPath,
        agentType: module,
        displayLabel: entry.displayLabel,
        agentName: entry.agentName,
        defaultPriority: entry.defaultPriority,
        tools: entry.tools,
        model: entry.model,
        baseUrl: entry.baseUrl,
      }))
    }
  }

  for (const item of COORDINATOR_AND_PARSE) {
    docs.push(agentDocFromDisk(item))
  }

  return docs
}

export function localAgentToPlain(doc: {
  _id: string
  promptPath: string
  agentType: AgentType
  agentName?: string
  displayLabel: string
  description?: string
  content: string
  promptVars?: string[]
  defaultPriority?: Priority
  claimCategory?: 'data' | 'quote' | 'causal'
  tools?: string[]
  model?: string
  baseUrl?: string
  updatedAt?: Date
}): AgentDoc {
  return {
    promptPath: doc.promptPath,
    agentType: doc.agentType,
    agentName: doc.agentName,
    displayLabel: doc.displayLabel,
    description: doc.description,
    content: doc.content,
    promptVars: doc.promptVars ?? [],
    defaultPriority: doc.defaultPriority,
    claimCategory: doc.claimCategory,
    tools: doc.tools,
    model: doc.model,
    baseUrl: doc.baseUrl,
    updatedAt: doc.updatedAt,
  }
}

/** 空库时从磁盘种子导入；已有数据则跳过（force 时覆盖同步） */
export async function localAgentSeedFromDisk(force = false): Promise<number> {
  const count = await LocalAgentModel.countDocuments()
  if (count > 0 && !force) return 0

  const docs = localAgentReadFromDisk()
  if (force) {
    await LocalAgentModel.deleteMany({})
  }

  for (const agent of docs) {
    await LocalAgentModel.findByIdAndUpdate(
      agent.promptPath,
      {
        _id: agent.promptPath,
        ...agent,
        updatedAt: new Date(),
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    )
  }

  console.log(`[local-agents] 已从磁盘种子导入 ${docs.length} 条`)
  return docs.length
}

export async function localAgentList(): Promise<AgentDoc[]> {
  const docs = await LocalAgentModel.find().sort({ agentType: 1, displayLabel: 1 }).lean()
  return docs.map(d => localAgentToPlain(d as Parameters<typeof localAgentToPlain>[0]))
}

export async function localAgentUpsert(agent: AgentDoc): Promise<AgentDoc> {
  const updatedAt = new Date()
  const doc = await LocalAgentModel.findByIdAndUpdate(
    agent.promptPath,
    {
      _id: agent.promptPath,
      ...agent,
      updatedAt,
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean()
  return localAgentToPlain(doc as Parameters<typeof localAgentToPlain>[0])
}

export async function localAgentDelete(promptPath: string): Promise<void> {
  await LocalAgentModel.deleteOne({ _id: promptPath })
}

/** catalog 写文件后同步一条到本地池 */
export async function localAgentSyncFromDiskPath(promptPath: string): Promise<void> {
  const all = localAgentReadFromDisk()
  const match = all.find(a => a.promptPath === promptPath)
  if (match) {
    await localAgentUpsert(match)
  } else {
    await localAgentDelete(promptPath)
  }
}
