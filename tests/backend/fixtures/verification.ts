// 提供自定义核查 Agent、工具目录和槽位，避免测试依赖部署默认提示词。
import type { GraphAgentProfile, GraphRunConfiguration } from '../../../contracts/graph'

export interface VerificationSlot {
  id: string
  agentId: string
  angle: string
  priority: 'high' | 'medium' | 'low'
  hint: string
  tools: string[]
}

/**
 * 生成带三种独立核查角度和自定义工具的配置，槽位上限可由用例覆盖。
 *
 * @param maxSlots 测试配置允许建立的最大路由槽位数。
 */
export function verificationConfiguration(maxSlots = 6): GraphRunConfiguration {
  /**
   * @param id 用于生成稳定名称和提示词的逻辑 Agent 身份。
   * @param tools 该测试 Agent 可以调用的工具名称。
   */
  const profile = (id: string, tools: string[]): GraphAgentProfile => /* 为指定角度生成确定性的 Agent 名称、提示词和工具能力。 */ ({
    id, name: `Custom ${id}`, description: `Review the ${id} perspective`,
    content: `Investigate ${id} evidence and submit a structured report.`,
    tools, provider: 'openai', model: 'fixture-model',
  })
  return {
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

/**
 * 按数量生成不同角度和优先级的槽位，循环绑定三种测试 Agent。
 *
 * @param count 需要生成的确定性路由槽位数量。
 */
export function verificationSlots(count: number): VerificationSlot[] {
  const agents = ['archive-expert', 'ledger-expert', 'counterexample-expert']
  const tools = [['archive_lookup'], ['ledger_query'], []]
  return Array.from({ length: count }, (_, index) => /* 按序号分配槽位身份、Agent 和工具副本，避免不同槽位共享可变工具数组。 */ ({
    id: `angle-${index + 1}`, agentId: agents[index % agents.length],
    angle: `independent-angle-${index + 1}`,
    priority: (['high', 'medium', 'low'] as const)[index % 3],
    hint: `Follow evidence chain ${index + 1}`, tools: [...tools[index % tools.length]],
  }))
}

/**
 * 把固定槽位的逻辑 Agent 名称转换为目标工作区实际配置身份。
 *
 * @param configuration 包含工作区实际 Agent 身份的冻结运行配置。
 * @param count 需要映射到实际 Agent 身份的槽位数量。
 */
export function configuredSlots(configuration: GraphRunConfiguration, count: number): VerificationSlot[] {
  return verificationSlots(count).map(slot => {
    // 在工作区配置中找到相同名称的 Agent，并替换槽位中的旧测试身份。
    const agent = configuration.agents.find(agent => /* 根据测试约定的显示名匹配复制后身份已改变的 Agent。 */ agent.name === `Custom ${slot.agentId}`)
    if (!agent) throw new Error(`Fixture Agent is missing: ${slot.agentId}`)
    return { ...slot, agentId: agent.id }
  })
}
