/** SubAgent 注册表 — 前后端共用的名称与环节映射（不含 LLM 配置） */

export type SubAgentModule = 'split' | 'verify'
export type CatalogPriority = 'high' | 'medium' | 'low'

export interface SubAgentCatalogEntry {
  name: string
  module: SubAgentModule
  promptPath: string
  displayLabel?: string
  defaultPriority?: CatalogPriority
  description?: string
}

export const SPLIT_SUB_AGENT_CATALOG: SubAgentCatalogEntry[] = [
  {
    name: '数据事实',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/data-claims',
    displayLabel: '数据事实',
    defaultPriority: 'high',
    description: '提取数值、统计、日期等数据型事实',
  },
  {
    name: '引用观点',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/quote-claims',
    displayLabel: '引用观点',
    defaultPriority: 'medium',
    description: '抽取直接引语与当事人表态',
  },
  {
    name: '因果关系',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/causal-claims',
    displayLabel: '因果关系',
    defaultPriority: 'low',
    description: '提取因果与推断类陈述',
  },
]

export const VERIFY_SUB_AGENT_CATALOG: SubAgentCatalogEntry[] = [
  {
    name: '来源可信度',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/source-credibility',
    displayLabel: '来源可信度',
    defaultPriority: 'high',
    description: '核对报道来源与原始出处',
  },
  {
    name: '逻辑一致性',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/logic-consistency',
    displayLabel: '逻辑一致性',
    defaultPriority: 'medium',
    description: '检查事实内部逻辑是否自洽',
  },
  {
    name: '数据可验证性',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/data-verifiability',
    displayLabel: '数据可验证性',
    defaultPriority: 'low',
    description: '核对数据是否可独立验证',
  },
]

export function getSubAgentCatalog(module: SubAgentModule): SubAgentCatalogEntry[] {
  return module === 'split' ? SPLIT_SUB_AGENT_CATALOG : VERIFY_SUB_AGENT_CATALOG
}

export function listCatalogEntries(module: SubAgentModule) {
  return getSubAgentCatalog(module).map(e => ({
    agentName: e.name,
    displayLabel: e.displayLabel ?? e.name,
    description: e.description,
    defaultPriority: e.defaultPriority,
    module: e.module,
  }))
}
