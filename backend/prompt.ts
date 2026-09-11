import type { GraphAgentProfile, GraphDataRead, GraphWorkGrant } from '../contracts/graph'

/** Render only the authorized read projection, in the profile's chosen variable order. */
export function promptReadWork(profile: GraphAgentProfile, data: GraphDataRead, grant: GraphWorkGrant): string {
  const actor = grant.actor
  const slot = actor.role === 'worker' ? data.route?.slots.find(slot => slot.id === actor.slotId) : undefined
  const variables: Record<string, string> = {
    claimContent: data.claim.data.content,
    originalContent: data.context.map(news => news.content).join('\n\n'),
    context: JSON.stringify(data.context.map(news => ({ id: news.id, context: news.context }))),
    availableAgents: JSON.stringify(data.configuration.agents),
    hint: slot?.hint ?? '',
    opinions: JSON.stringify(data.reports),
  }
  const names = profile.promptVars ?? []
  for (const name of names) if (!(name in variables)) throw new Error(`Unsupported verification prompt variable: ${name}`)
  const content = profile.content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, name: string) => names.includes(name) ? variables[name] : match)
  return [content, ...names.map(name => `${name}:\n${variables[name]}`)].join('\n\n')
}
