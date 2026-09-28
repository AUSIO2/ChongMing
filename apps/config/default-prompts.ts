// 把随构建发布的解析、分流与核验提示词装配为工作区默认 Agent 配置。
import type { GraphAgentProfile } from '../../contracts/graph'
import type { GraphSeedConfiguration } from '../../backend/modules/workspace/agent-configuration'
import defaults from '../../resources/prompts/verify/configuration.json'
import router from '../../resources/prompts/verify/router.json'
import merger from '../../resources/prompts/verify/merger.json'
import sources from '../../resources/prompts/verify/agents/sources.json'
import logic from '../../resources/prompts/verify/agents/logic.json'
import numbers from '../../resources/prompts/verify/agents/numbers.json'
import parser from '../../resources/prompts/parse/extract.json'
import splitRouter from '../../resources/prompts/split/router.json'
import splitMerger from '../../resources/prompts/split/merger.json'
import splitData from '../../resources/prompts/split/agents/data.json'
import splitQuote from '../../resources/prompts/split/agents/quote.json'
import splitCausal from '../../resources/prompts/split/agents/causal.json'

/** 由构建提供默认资源，在应用装配入口注入业务层。 */
export const DEFAULT_RUN_CONFIGURATION: GraphSeedConfiguration = {
  ...defaults, router, merger, agents: [sources, logic, numbers], parse: parser,
  split: { router: splitRouter, merger: splitMerger,
    agents: [splitData, splitQuote, splitCausal] as GraphAgentProfile[] },
}
