// 校验已解析 Agent 与工具目录；初始化和旧数据迁移分别拥有各自的配置结构。
import type { GraphAgentProfile } from '../../../contracts/graph-agent'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { GraphError } from '../shared/domain-error'
import { inputReadArray, inputReadNames, inputReadObject, inputReadString } from '../shared/input-validation'

const reserved = new Set(['data_read', 'data_propose', 'data_delegate', 'subagent', 'subagent_fork', 'send_message', 'interrupt_agent', 'list_agents', 'workflow', 'run_code', 'cordis_define', 'cordis_run'])

/**
 * 限制运行时标识的字符集和长度，使 Agent 与工具名可安全作为配置键使用。
 *
 * @param value 尚未验证字符范围和长度的运行时名称。
 */
function configurationReadName(value: unknown): string {
  const name = inputReadString(value, 'name')
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.INVALID_NAME_VALUE, name))
  return name
}

/**
 * 拒绝工具或 Agent 集合中的重复身份，避免运行时引用含混。
 *
 * @param ids 需要保证互不重复的一组工具或 Agent 标识。
 * @param label 用于重复值错误信息的配置对象名称。
 */
function configurationValidateIds(ids: string[], label: string): void {
  if (new Set(ids).size !== ids.length) throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.DUPLICATE_VALUE, label))
}

/**
 * 逐字段解析执行期 Agent 配置，验证工具唯一性和可选优先级、类别。
 *
 * @param value 尚未解析为执行期 Agent 配置的输入。
 */
export function configurationReadProfile(
  /* 来自初始化配置、尚未通过执行 Agent 合同解析的值。 */ value: unknown,
): GraphAgentProfile {
  // 解析执行字段并严格收窄可选枚举，不用字符串转换接纳数组等错误类型。
  const item = inputReadObject(value, ['id', 'name', 'description', 'content', 'tools', 'provider', 'model', 'baseUrl', 'promptVars', 'defaultPriority', 'claimCategory'], 'profile')
  const tools = inputReadNames(item.tools, 'profile.tools')
  configurationValidateIds(tools, 'profile tool')
  const promptVars = item.promptVars === undefined ? undefined : inputReadNames(item.promptVars, 'profile.promptVars')
  const defaultPriority = item.defaultPriority, claimCategory = item.claimCategory
  if (defaultPriority !== undefined && defaultPriority !== 'high' && defaultPriority !== 'medium' && defaultPriority !== 'low') throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.INVALID_DEFAULTPRIORITY)
  if (claimCategory !== undefined && claimCategory !== null && claimCategory !== 'data' && claimCategory !== 'quote' && claimCategory !== 'causal') throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.INVALID_CLAIMCATEGORY)
  return {
    id: configurationReadName(item.id), name: inputReadString(item.name, 'profile.name'),
    description: inputReadString(item.description, 'profile.description'),
    content: inputReadString(item.content, 'profile.content'), tools,
    provider: inputReadString(item.provider, 'profile.provider'), model: inputReadString(item.model, 'profile.model'),
    ...(item.baseUrl === undefined ? {} : { baseUrl: inputReadString(item.baseUrl, 'profile.baseUrl') }),
    ...(promptVars === undefined ? {} : { promptVars }),
    ...(defaultPriority === undefined ? {} : { defaultPriority }),
    ...(claimCategory === undefined ? {} : { claimCategory }),
  }
}

export function configurationReadTools(
  /* 未经校验的工具目录，每项包含名称和描述。 */ value: unknown,
): Array<{ name: string; description: string }> {
  // 校验工具结构与保留名称，再验证整个目录的身份唯一性。
  const tools = inputReadArray(value, 'configuration.tools').map(
    /* 当前尚未验证的工具记录。 */ value => {
      // 限定工具字段并拒绝模型不能自行调用的宿主能力。
      const tool = inputReadObject(value, ['name', 'description'], 'tool')
      const name = configurationReadName(tool.name)
      if (reserved.has(name) || name.startsWith('cordis_')) {
        throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.TOOL_IS_RESERVED_VALUE, name))
      }
      return { name, description: inputReadString(tool.description, 'tool.description') }
    },
  )
  configurationValidateIds(tools.map(/* 已验证结构的工具。 */ tool => /* 提取目录身份。 */ tool.name), 'tool')
  return tools
}

export function configurationValidateAgents(
  /* 同一份配置中所有阶段的已解析 Agent。 */ profiles: readonly GraphAgentProfile[],
  /* 本次配置实际允许使用的完整工具目录。 */ tools: readonly { name: string; description: string }[],
): void {
  // 验证跨阶段 Agent 身份唯一，并拒绝引用目录之外的工具。
  configurationValidateIds(profiles.map(/* 已解析的阶段 Agent。 */ agent => /* 提取配置身份。 */ agent.id), 'agent id')
  for (const agent of profiles) {
    for (const name of agent.tools) {
      if (!tools.some(/* 一个可用工具定义。 */ tool => /* 按精确工具名匹配能力。 */ tool.name === name)) {
        throw new GraphError(400, 'INVALID_CONFIGURATION', messageFormat(RuntimeMessage.UNKNOWN_TOOL_VALUE_FOR_VALUE, name, agent.id))
      }
    }
  }
}
