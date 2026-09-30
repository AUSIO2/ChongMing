// 从冻结阶段的声明式变量投影生成提示词，不按业务类型或阶段名称猜测字段。
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphAgentProfile, GraphDataRead, GraphWorkGrant } from '../../../contracts/graph'

/** Render only variables produced from the authorized ExecutionSpec projection. */
/**
 * 阶段身份和 specHash 必须与授权一致；模板只执行一次替换，输入中的 {{...}} 保持字面值。
 *
 * @param profile 当前冻结阶段选定的 Agent 配置。
 * @param data 数据服务按 Work 授权生成的输入投影和提示词变量。
 * @param grant 当前租约绑定的阶段、槽位与执行规格。
 */
export function promptReadWork(
  profile: GraphAgentProfile,
  data: GraphDataRead,
  grant: GraphWorkGrant,
): string {
  if (grant.stageId !== data.stage.id || grant.slotId !== data.stage.slotId || grant.specHash !== data.specHash
    || data.work.stageId !== grant.stageId || data.work.slotId !== grant.slotId || data.work.specHash !== grant.specHash) {
    throw new Error(RuntimeMessage.DATA_API_RETURNED_ANOTHER_WORK_GRANT)
  }
  const variables = data.promptVariables
  const names = profile.promptVars ?? Object.keys(variables)
  for (const name of names) if (!Object.prototype.hasOwnProperty.call(variables, name)) {
    throw new Error(messageFormat(RuntimeMessage.UNSUPPORTED_VALUE_PROMPT_VARIABLE_VALUE, data.stage.id, name))
  }
  const rendered = profile.content.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (
    match,
    name: string,
  ) => names.includes(name) ? variables[name] : match)
  return [rendered, ...names.map(name => `${name}:\n${variables[name]}`)].join('\n\n')
}
