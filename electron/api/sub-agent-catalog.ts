/** SubAgent 注册表 — 前后端共用的名称与环节映射（不含 LLM 配置） */

import type { Priority } from '../shared/types'

export type SubAgentModule = 'split' | 'verify'

/**
 * Catalog 唯一形状。
 * IPC / Map 列表暴露时去掉 promptPath（运行时配置不进渲染进程）。
 */
export interface CatalogSubAgentEntry {
  agentName: string
  module: SubAgentModule
  promptPath: string
  displayLabel: string
  defaultPriority?: Priority
  description?: string
}

/** 给渲染进程 / Map 的目录项（无 promptPath）。 */
export type CatalogSubAgent = Omit<CatalogSubAgentEntry, 'promptPath'>

export const SPLIT_SUB_AGENT_CATALOG: CatalogSubAgentEntry[] = [
  {
    agentName: '数据事实',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/data-claims',
    displayLabel: '数据事实',
    defaultPriority: 'high',
    description: '提取数值、统计、日期等数据型事实',
  },
  {
    agentName: '引用观点',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/quote-claims',
    displayLabel: '引用观点',
    defaultPriority: 'medium',
    description: '抽取直接引语与当事人表态',
  },
  {
    agentName: '因果关系',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/causal-claims',
    displayLabel: '因果关系',
    defaultPriority: 'low',
    description: '提取因果与推断类陈述',
  },
]

export const VERIFY_SUB_AGENT_CATALOG: CatalogSubAgentEntry[] = [
  {
    agentName: '来源可信度',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/source-credibility',
    displayLabel: '来源可信度',
    defaultPriority: 'high',
    description: '核对报道来源与原始出处',
  },
  {
    agentName: '逻辑一致性',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/logic-consistency',
    displayLabel: '逻辑一致性',
    defaultPriority: 'medium',
    description: '检查事实内部逻辑是否自洽',
  },
  {
    agentName: '数据可验证性',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/data-verifiability',
    displayLabel: '数据可验证性',
    defaultPriority: 'low',
    description: '核对数据是否可独立验证',
  },
]

export function getSubAgentCatalog(module: SubAgentModule): CatalogSubAgentEntry[] {
  return module === 'split' ? SPLIT_SUB_AGENT_CATALOG : VERIFY_SUB_AGENT_CATALOG
}

export function listCatalogEntries(module: SubAgentModule): CatalogSubAgent[] {
  return getSubAgentCatalog(module).map(({ promptPath: _p, ...item }) => item)
}
