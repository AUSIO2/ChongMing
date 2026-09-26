import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphAgentProfile, GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'

/** Render only the authorized read projection, in the profile's chosen variable order. */
// 用途：读取工作，并把结构化结果交给调用方。
export function promptReadWork(profile: GraphAgentProfile, data: GraphDataRead, grant: GraphWorkGrant): string {
  const actor = grant.actor
  const slot = actor.role === 'worker' ? data.route?.slots.find(slot => slot.id === actor.slotId) : undefined
  const content = 'content' in data.target.data ? data.target.data.content : ''
  const variables: Record<string, string> = data.operationKind === 'parse' ? {
    rawContent: data.rawContent ?? '',
  } : data.operationKind === 'split' ? {
    content,
    context: JSON.stringify(data.context.map(news => ({ id: news.id, context: news.context }))),
    availableAgents: JSON.stringify(data.configuration.split?.agents ?? []),
    hint: slot?.hint ?? '',
    subResults: JSON.stringify(data.splitReports),
  } : {
    claimContent: content,
    originalContent: data.context.map(news => news.content).join('\n\n'),
    context: JSON.stringify(data.context.map(news => ({ id: news.id, context: news.context }))),
    availableAgents: JSON.stringify(data.configuration.agents),
    hint: slot?.hint ?? '',
    opinions: JSON.stringify(data.reports),
  }
  const names = profile.promptVars ?? []
  for (const name of names) if (!(name in variables)) throw new Error(messageFormat(RuntimeMessage.UNSUPPORTED_VALUE_PROMPT_VARIABLE_VALUE, data.operationKind, name))
  const rendered = profile.content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (match, name: string) => names.includes(name) ? variables[name] : match)
  return [rendered, ...names.map(name => `${name}:\n${variables[name]}`)].join('\n\n')
}
