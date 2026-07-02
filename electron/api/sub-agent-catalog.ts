/** SubAgent 注册表 — 前后端共用的名称与环节映射（不含 LLM 配置） */

export type SubAgentModule = 'split' | 'verify'

export interface SubAgentCatalogEntry {
  name: string
  module: SubAgentModule
  promptPath: string
}

export const SPLIT_SUB_AGENT_CATALOG: SubAgentCatalogEntry[] = [
  {
    name: '数据事实',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/data-claims',
  },
  {
    name: '引用观点',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/quote-claims',
  },
  {
    name: '因果关系',
    module: 'split',
    promptPath: 'fact-extractor/sub-agents/causal-claims',
  },
]

export const VERIFY_SUB_AGENT_CATALOG: SubAgentCatalogEntry[] = [
  {
    name: '来源可信度',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/source-credibility',
  },
  {
    name: '逻辑一致性',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/logic-consistency',
  },
  {
    name: '数据可验证性',
    module: 'verify',
    promptPath: 'fact-verifier/sub-agents/data-verifiability',
  },
]

export function getSubAgentCatalog(module: SubAgentModule): SubAgentCatalogEntry[] {
  return module === 'split' ? SPLIT_SUB_AGENT_CATALOG : VERIFY_SUB_AGENT_CATALOG
}
