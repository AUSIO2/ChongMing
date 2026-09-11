import type { GraphAgentProfile, GraphRouteSlot, GraphRunConfiguration } from '../../../contracts/graph'

export function verificationConfiguration(maxSlots = 6): GraphRunConfiguration {
  const profile = (id: string, tools: string[]): GraphAgentProfile => ({
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

export function verificationSlots(count: number): GraphRouteSlot[] {
  const agents = ['archive-expert', 'ledger-expert', 'counterexample-expert']
  const tools = [['archive_lookup'], ['ledger_query'], []]
  return Array.from({ length: count }, (_, index) => ({
    id: `angle-${index + 1}`, agentId: agents[index % agents.length],
    angle: `independent-angle-${index + 1}`,
    priority: (['high', 'medium', 'low'] as const)[index % 3],
    hint: `Follow evidence chain ${index + 1}`, tools: [...tools[index % tools.length]],
  }))
}

export function configuredSlots(configuration: GraphRunConfiguration, count: number): GraphRouteSlot[] {
  return verificationSlots(count).map(slot => {
    const agent = configuration.agents.find(agent => agent.name === `Custom ${slot.agentId}`)
    if (!agent) throw new Error(`Fixture Agent is missing: ${slot.agentId}`)
    return { ...slot, agentId: agent.id }
  })
}
