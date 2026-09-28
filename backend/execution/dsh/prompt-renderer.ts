// 文件职责：从授权输入按 Agent 声明的变量顺序生成阶段提示词。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphAgentProfile, GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'

/** Render only the authorized read projection, in the profile's chosen variable order. */
export function promptReadWork(/* 本工作选定的冻结 Agent 配置，决定提示词正文与变量追加顺序。 */ profile: GraphAgentProfile, /* 已由数据服务授权的目标、上下文、报告及冻结配置，不应再读取其他图数据。 */ data: GraphDataRead, /* 可信工作授权，worker 槽位决定允许使用的补充提示。 */ grant: GraphWorkGrant): string {
  // 按解析、拆分或核查阶段准备变量，替换已声明占位符并按配置顺序附加内容。
  const actor = grant.actor
  const slot = actor.role === 'worker' ? data.route?.slots.find(/* 授权路由中的候选槽位，按 worker 绑定的 slotId 选择。 */ slot => /* 取得 worker 自己槽位的提示补充。 */  slot.id === actor.slotId) : undefined
  const content = 'content' in data.target.data ? data.target.data.content : ''
  const variables: Record<string, string> = data.operationKind === 'parse' ? {
    rawContent: data.rawContent ?? '',
  } : data.operationKind === 'split' ? {
    content,
    context: JSON.stringify(data.context.map(/* 拆分输入中的新闻上下文投影，已过滤不可给 AI 的字段。 */ news => /* 投影拆分输入的新闻身份和已授权上下文。 */  ({ id: news.id, context: news.context }))),
    availableAgents: JSON.stringify(data.configuration.split?.agents ?? []),
    hint: slot?.hint ?? '',
    subResults: JSON.stringify(data.splitReports),
  } : {
    claimContent: content,
    originalContent: data.context.map(/* 核查依赖的新闻投影，按原输入顺序提取正文。 */ news => /* 提取核查所依赖的新闻正文，保留输入顺序。 */  news.content).join('\n\n'),
    context: JSON.stringify(data.context.map(/* 核查依赖的新闻上下文投影，仅保留授权字段。 */ news => /* 投影核查输入的新闻身份和已授权上下文。 */  ({ id: news.id, context: news.context }))),
    availableAgents: JSON.stringify(data.configuration.agents),
    hint: slot?.hint ?? '',
    opinions: JSON.stringify(data.reports),
  }
  const names = profile.promptVars ?? []
  for (const name of names) if (!(name in variables)) throw new Error(messageFormat(RuntimeMessage.UNSUPPORTED_VALUE_PROMPT_VARIABLE_VALUE, data.operationKind, name))
  const rendered = profile.content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (/* 正文中完整的占位符文本，变量未被声明时原样保留。 */ match, /* 占位符中的变量名，仅允许替换 Agent promptVars 声明的名字。 */ name: string) => /* 只替换配置声明的变量，其他占位符保持字面内容。 */  names.includes(name) ? variables[name] : match)
  return [rendered, ...names.map(/* 按配置顺序遍历的已验证变量名，用于追加具名内容区块。 */ name => /* 按 Agent 指定顺序生成具名变量区块。 */  `${name}:\n${variables[name]}`)].join('\n\n')
}
