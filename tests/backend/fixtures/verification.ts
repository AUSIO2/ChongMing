// 提供自定义核查 Agent、工具目录和槽位，避免测试依赖部署默认提示词。
import type { GraphAgentProfile, GraphRouteSlot, GraphRunConfiguration } from '../../../contracts/graph'

export function verificationConfiguration(/* 测试配置允许建立的最大路由槽位数。 */ maxSlots = 6): GraphRunConfiguration {
  // 生成带三种独立核查角度和自定义工具的配置，槽位上限可由用例覆盖。
  const profile = (/* 用于生成稳定名称和提示词的逻辑 Agent 身份。 */ id: string, /* 该测试 Agent 可以调用的工具名称。 */ tools: string[]): GraphAgentProfile => /* 为指定角度生成确定性的 Agent 名称、提示词和工具能力。 */ ({
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

export function verificationSlots(/* 需要生成的确定性路由槽位数量。 */ count: number): GraphRouteSlot[] {
  // 按数量生成不同角度和优先级的槽位，循环绑定三种测试 Agent。
  const agents = ['archive-expert', 'ledger-expert', 'counterexample-expert']
  const tools = [['archive_lookup'], ['ledger_query'], []]
  return Array.from({ length: count }, (/* Array.from 提供但本测试不使用的占位元素。 */ _, /* 当前槽位的零基序号，用于轮换 Agent、工具和优先级。 */ index) => /* 按序号分配槽位身份、Agent 和工具副本，避免不同槽位共享可变工具数组。 */ ({
    id: `angle-${index + 1}`, agentId: agents[index % agents.length],
    angle: `independent-angle-${index + 1}`,
    priority: (['high', 'medium', 'low'] as const)[index % 3],
    hint: `Follow evidence chain ${index + 1}`, tools: [...tools[index % tools.length]],
  }))
}

export function configuredSlots(/* 包含工作区实际 Agent 身份的冻结运行配置。 */ configuration: GraphRunConfiguration, /* 需要映射到实际 Agent 身份的槽位数量。 */ count: number): GraphRouteSlot[] {
  // 把固定槽位的逻辑 Agent 名称转换为目标工作区实际配置身份。
  return verificationSlots(count).map(/* 当前替换逻辑 Agent 身份的测试槽位。 */ slot => {
    // 在工作区配置中找到相同名称的 Agent，并替换槽位中的旧测试身份。
    const agent = configuration.agents.find(/* 当前与槽位逻辑显示名匹配的配置 Agent。 */ agent => /* 根据测试约定的显示名匹配复制后身份已改变的 Agent。 */ agent.name === `Custom ${slot.agentId}`)
    if (!agent) throw new Error(`Fixture Agent is missing: ${slot.agentId}`)
    return { ...slot, agentId: agent.id }
  })
}
