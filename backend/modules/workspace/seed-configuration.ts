// 定义完整工作区种子输入；运行期间使用 ExecutionCatalog，不读取此初始化结构。
import type { DefinitionPackage } from '../../../contracts/data-definition'
import type { GraphAgentProfile } from '../../../contracts/graph-agent'
import { RuntimeMessage } from '../../../contracts/messages'

import { definitionsReadPackage } from '../shared/data-definition'
import { GraphError } from '../shared/domain-error'
import { inputReadArray, inputReadObject, inputReadRevision } from '../shared/input-validation'
import { configurationReadProfile, configurationReadTools, configurationValidateAgents } from './agent-configuration'

// 显式初始化需要完整阶段配置，不从部署默认值猜测缺失的解析或拆分 Agent。
export interface WorkspaceSeedInput {
  parse: GraphAgentProfile
  split: { router: GraphAgentProfile; merger: GraphAgentProfile; agents: GraphAgentProfile[] }
  router: GraphAgentProfile
  merger: GraphAgentProfile
  agents: GraphAgentProfile[]
  tools: Array<{ name: string; description: string }>
  maxSlots: number
}

// 部署装配额外提供定义包模板，播种时绑定到实际初始化 Agent 的精确版本。
export interface WorkspaceSeedConfiguration extends WorkspaceSeedInput {
  definitionPackage: DefinitionPackage
}

export function seedReadInput(
  /* 显式初始化提供的完整阶段配置，不含部署拥有的定义包。 */ value: unknown,
): WorkspaceSeedInput {
  // 验证完整阶段、工具和预算，并拒绝跨阶段重复身份或未注册工具。
  const item = inputReadObject(value, ['parse', 'split', 'router', 'merger', 'agents', 'tools', 'maxSlots'], 'seed configuration')
  return seedReadFields(item)
}

function seedReadFields(
  /* 已在初始化或部署配置入口核对字段白名单的配置对象。 */ item: Readonly<Record<string, unknown>>,
): WorkspaceSeedInput {
  // 解析全部种子字段并核对跨阶段身份和工具，两个真实入口共用一套字段规则。
  if (item.parse === undefined || item.split === undefined) {
    throw new GraphError(500, 'DEFAULT_CONFIGURATION_INVALID', RuntimeMessage.DEFAULT_CONFIGURATION_REQUIRES_PARSE_AND_SPLIT)
  }
  const parse = configurationReadProfile(item.parse)
  const group = inputReadObject(item.split, ['router', 'merger', 'agents'], 'configuration.split')
  const split = {
    router: configurationReadProfile(group.router),
    merger: configurationReadProfile(group.merger),
    agents: inputReadArray(group.agents, 'configuration.split.agents').map(configurationReadProfile),
  }
  const router = configurationReadProfile(item.router)
  const merger = configurationReadProfile(item.merger)
  const agents = inputReadArray(item.agents, 'configuration.agents').map(configurationReadProfile)
  const tools = configurationReadTools(item.tools)
  const maxSlots = inputReadRevision(item.maxSlots, 'configuration.maxSlots')
  if (!split.agents.length || split.agents.length > 64) {
    throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.PROVIDE_1_64_SPLIT_AGENTS)
  }
  if (!agents.length || agents.length > 64 || maxSlots < 1 || maxSlots > 32) {
    throw new GraphError(400, 'INVALID_CONFIGURATION', RuntimeMessage.PROVIDE_1_64_AGENTS_AND_MAXSLOTS_BETWEEN_1_AND_32)
  }
  configurationValidateAgents([parse, split.router, split.merger, ...split.agents, router, merger, ...agents], tools)
  return { parse, split, router, merger, agents, tools, maxSlots }
}

export function seedReadConfiguration(
  /* 应用装配注入的完整初始化配置和默认定义包模板。 */ value: unknown,
): WorkspaceSeedConfiguration {
  // 独立校验定义包与初始化内容，禁止配置中夹带未知字段。
  const item = inputReadObject(value, ['parse', 'split', 'router', 'merger', 'agents', 'tools', 'maxSlots', 'definitionPackage'], 'seed configuration')
  return { ...seedReadFields(item), definitionPackage: definitionsReadPackage(item.definitionPackage) }
}
