// 提供自定义核查 Agent、工具目录和槽位，避免测试依赖部署默认提示词。
import type { GraphAgentProfile } from '../../../contracts/graph-agent'
import type { WorkspaceSeedInput } from '../../../backend/modules/workspace/seed-configuration'
import { DEFAULT_WORKSPACE_SEED } from '../../../apps/config/default-prompts'

/**
 * 显式组合默认解析/拆分和三种自定义核查角度，不依赖播种时补齐缺失阶段。
 *
 * @param maxSlots 测试配置允许建立的最大路由槽位数。
 */
export function verificationConfiguration(maxSlots = 6): WorkspaceSeedInput {
  /**
   * @param id 用于生成稳定名称和提示词的逻辑 Agent 身份。
   * @param tools 该测试 Agent 可以调用的工具名称。
   */
  const profile = (id: string, tools: string[]): GraphAgentProfile => /* 为指定角度生成确定性的 Agent 名称、提示词和工具能力。 */ ({
    id, name: `Custom ${id}`, description: `Review the ${id} perspective`,
    content: `Investigate ${id} evidence and submit a structured report.`,
    tools, provider: 'openai', model: 'fixture-model',
  })
  const defaults = structuredClone(DEFAULT_WORKSPACE_SEED)
  const parsingProfile = (
    /* 本夹具显式采用的默认解析或拆分 Agent。 */ agent: GraphAgentProfile,
  ): GraphAgentProfile => /* 固定测试模型，保持初始化过程不依赖环境模型设置。 */ ({
    ...agent, provider: 'openai', model: 'fixture-model',
  })
  return {
    parse: parsingProfile(defaults.parse),
    split: {
      router: parsingProfile(defaults.split.router),
      merger: parsingProfile(defaults.split.merger),
      agents: defaults.split.agents.map(parsingProfile),
    },
    router: profile('custom-router', []),
    merger: profile('custom-merger', []),
    agents: [
      profile('archive-expert', ['archive_lookup']),
      profile('ledger-expert', ['ledger_query']),
      profile('counterexample-expert', []),
    ],
    tools: [
      { name: 'archive_lookup', description: 'Read a primary archive entry' },
      { name: 'ledger_query', description: 'Read a published numerical ledger' },
    ],
    maxSlots,
  }
}
