// 为已核对旧stock的未注册部署规划配置升级；只返回独立候选，不连接数据库。
import { createHash } from 'node:crypto'

import type { AgentProfile, ClusterSettings } from '../../contracts/control'
import type { DefinitionPackage, DefinitionRef, ExecutionAgentDefinition } from '../../contracts/data-definition'
import type { GraphAgentProfile } from '../../contracts/graph-agent'
import { DEFAULT_WORKSPACE_SEED } from '../../apps/config/default-prompts'
import { definitionsDigest, definitionsValidateCatalog } from '../../backend/modules/shared/data-definition'

interface LegacyConfigurationSource {
  agents: AgentProfile[]
  definitionPackages?: DefinitionPackage[]
  definitionAgents?: ExecutionAgentDefinition[]
}
interface LegacyConfigurationPlan {
  agents: AgentProfile[]
  definitionPackages: DefinitionPackage[]
  definitionAgents: ExecutionAgentDefinition[]
  updatedAgentIds: string[]
  changed: boolean
}
interface StockTemplate { kind: string; profile: GraphAgentProfile; worker: boolean }

enum LegacyConfigurationMessage {
  AGENT_ID_CONFLICT = '旧配置包含重复Agent身份，拒绝升级。',
  MISSING_ROLE = '旧配置缺少唯一的默认角色或worker路径，拒绝猜测Agent映射。',
  PARTIAL_TRANSITIONS = '已有部分转换定义，本工具只处理未注册的旧配置。',
  TYPE_CONFLICT = '已有类型与默认数据类型不一致，拒绝更换类型归属。',
  VERSION_CONFLICT = '新Agent版本已有精确归档，拒绝覆盖或复用历史版本。',
  INVALID_REVISION = 'Agent版本已不能安全递增，拒绝升级。',
}

export function planLegacyConfigurationUpgrade(
  /* 一个共享库或工作区的原配置；调用方负责读取授权和最终CAS写入。 */ source: LegacyConfigurationSource,
  /* 原共享模型设置，只用于冻结可继承的执行模型，不修改此设置。 */ settings: ClusterSettings,
  /* promptPath到旧正文UTF-8 SHA256十六进制摘要的已核对字典。 */ previousStockHashes: Record<string, string>,
  /* 仅用于本次实际升级Agent的ISO时间，调用方在事务外固定。 */ now: string,
): LegacyConfigurationPlan {
  // 只升级精确stock正文，补齐默认定义和精确快照；完整注册配置验证后直接保持不变。
  const agents = structuredClone(source.agents), packages = structuredClone(source.definitionPackages ?? [])
  const archived = structuredClone(source.definitionAgents ?? []), updatedAgentIds: string[] = []
  if (new Set(agents.map((/* 原作用域已保存的Agent。 */ agent) => /* 检查身份唯一性。 */ agent.id)).size !== agents.length) throw new Error(LegacyConfigurationMessage.AGENT_ID_CONFLICT)
  const originalSnapshots = appendSnapshots(archived, agents, settings)
  const existing = definitionsValidateCatalog(packages, originalSnapshots)
  const defaults = DEFAULT_WORKSPACE_SEED.definitionPackage
  if (defaults.transitions.every((/* 正式默认转换的精确版本。 */ expected) => /* 不用任意三个自定义转换冒充已完整升级。 */
    existing.transitions.some((/* 当前已注册转换。 */ transition) => /* 同时核对默认身份与版本。 */ transition.id === expected.id && transition.version === expected.version))) {
    return { agents, definitionPackages: packages, definitionAgents: archived, updatedAgentIds, changed: false }
  }
  if (existing.transitions.length) throw new Error(LegacyConfigurationMessage.PARTIAL_TRANSITIONS)
  const templates = readTemplates(), targetByTemplate = bindTemplates(agents, templates)
  const templateByTarget = new Map<string, GraphAgentProfile>()
  for (const template of templates) {
    const target = targetByTemplate.get(template.profile.id)
    if (!target) throw new Error(LegacyConfigurationMessage.MISSING_ROLE)
    templateByTarget.set(target.id, template.profile)
  }
  for (const agent of agents) {
    const template = templateByTarget.get(agent.id)
    if (!template || template.content === agent.content) continue
    const hash = createHash('sha256').update(agent.content).digest('hex')
    if (!Object.prototype.hasOwnProperty.call(previousStockHashes, agent.promptPath) || previousStockHashes[agent.promptPath] !== hash) continue
    if (!Number.isSafeInteger(agent.revision) || agent.revision < 0 || agent.revision === Number.MAX_SAFE_INTEGER) throw new Error(LegacyConfigurationMessage.INVALID_REVISION)
    if (archived.some((/* 不可变历史执行快照。 */ snapshot) => /* 不允许递增到已经存在的历史身份。 */ snapshot.ref.id === agent.id && snapshot.ref.version === agent.revision + 1)) throw new Error(LegacyConfigurationMessage.VERSION_CONFLICT)
    agent.content = template.content
    agent.revision += 1
    agent.updatedAt = now
    updatedAgentIds.push(agent.id)
  }
  const candidate = remapDefaultPackage(agents, templates)
  if (existing.dataTypes.length) {
    if (existing.dataTypes.length !== defaults.dataTypes.length) throw new Error(LegacyConfigurationMessage.TYPE_CONFLICT)
    for (const type of defaults.dataTypes) {
      const current = existing.dataTypes.find((/* 当前已发布的数据类型。 */ item) => /* 找到默认类型的原归属版本。 */ item.id === type.id && item.version === type.version)
      if (!current || definitionsDigest(current) !== definitionsDigest(type)) throw new Error(LegacyConfigurationMessage.TYPE_CONFLICT)
    }
    candidate.id = 'chongming.fact-checking-transitions'
    candidate.title = '重明事实核查转换'
    candidate.dataTypes = []
    const owners = new Map<string, DefinitionRef>()
    for (const item of existing.index) {
      if (item.kind === 'dataType') owners.set(refKey(item.packageRef), item.packageRef)
    }
    candidate.dependencies.packages = [...owners.values()]
  }
  const definitionAgents = appendSnapshots(originalSnapshots, agents, settings), definitionPackages = [...packages, candidate]
  definitionsValidateCatalog(definitionPackages, definitionAgents)
  return { agents, definitionPackages, definitionAgents, updatedAgentIds, changed: true }
}

function readTemplates(): StockTemplate[] {
  // 只枚举随本次版本发布的正式默认角色，保留其独立正文与模板身份。
  const defaults = DEFAULT_WORKSPACE_SEED
  return [
    { kind: 'parseExtract', profile: defaults.parse, worker: false },
    { kind: 'splitRoute', profile: defaults.split.router, worker: false },
    { kind: 'splitMerge', profile: defaults.split.merger, worker: false },
    ...defaults.split.agents.map((/* 正式默认拆分worker。 */ profile) => /* 路径末段匹配精确模板身份。 */ ({ kind: 'splitSubAgent', profile, worker: true })),
    { kind: 'verifyRoute', profile: defaults.router, worker: false },
    { kind: 'verifyMerge', profile: defaults.merger, worker: false },
    ...defaults.agents.map((/* 正式默认核查worker。 */ profile) => /* 不用数组位置猜测worker职责。 */ ({ kind: 'verifySubAgent', profile, worker: true })),
  ]
}

function bindTemplates(
  /* 当前作用域的独立Agent身份及精确版本。 */ agents: readonly AgentProfile[],
  /* 正式默认包对应的固定角色与worker模板。 */ templates: readonly StockTemplate[],
): Map<string, AgentProfile> {
  // 固定阶段按唯一kind、worker按kind和路径尾模板ID匹配，不修改Agent身份。
  const result = new Map<string, AgentProfile>()
  for (const template of templates) {
    const matches = agents.filter((/* 原作用域的一份配置。 */ agent) => /* 仅接受明确角色及worker路径。 */
      agent.kind === template.kind && (!template.worker || agent.promptPath.split('/').slice(-1)[0] === template.profile.id))
    if (matches.length !== 1) throw new Error(LegacyConfigurationMessage.MISSING_ROLE)
    const target = matches[0]
    if (!target) throw new Error(LegacyConfigurationMessage.MISSING_ROLE)
    result.set(template.profile.id, target)
  }
  return result
}

function remapDefaultPackage(
  /* 已保留用户配置并按需升级正文的Agent。 */ agents: readonly AgentProfile[],
  /* 与默认包精确绑定的正式模板。 */ templates: readonly StockTemplate[],
): DefinitionPackage {
  // 将阶段和允许的worker组绑定到本作用域实际版本，完整重建Agent依赖。
  const targets = bindTemplates(agents, templates), result = structuredClone(DEFAULT_WORKSPACE_SEED.definitionPackage)
  const dependencies = new Map<string, DefinitionRef>()
  function readTarget(/* 默认包引用的模板Agent身份。 */ ref: DefinitionRef): DefinitionRef {
    // 默认包所有固定Agent均必须由明确模板映射，不能回落到其它作用域。
    const target = targets.get(ref.id)
    if (!target) throw new Error(LegacyConfigurationMessage.MISSING_ROLE)
    return { id: target.id, version: target.revision }
  }
  for (const transition of result.transitions) for (const stage of transition.execution.stages) {
    const template = templates.find((/* 正式默认Agent模板。 */ item) => /* 在改写身份前记录planner所属的worker组。 */ item.profile.id === stage.agentRef.id)
    stage.agentRef = readTarget(stage.agentRef)
    dependencies.set(refKey(stage.agentRef), stage.agentRef)
    if (!stage.plan) continue
    let workerKind: string
    if (template?.kind === 'splitRoute') workerKind = 'splitSubAgent'
    else if (template?.kind === 'verifyRoute') workerKind = 'verifySubAgent'
    else throw new Error(LegacyConfigurationMessage.MISSING_ROLE)
    stage.plan.agentRefs = agents.filter((/* 原作用域所有worker，包含用户新增项。 */ agent) => /* 保留本planner可使用的完整同职责组。 */ agent.kind === workerKind)
      .map((/* 已确认属于本worker组的配置。 */ agent) => /* 使用零版本也有效的实际版本。 */ ({ id: agent.id, version: agent.revision }))
    for (const ref of stage.plan.agentRefs) dependencies.set(refKey(ref), ref)
  }
  result.dependencies.agents = [...dependencies.values()]
  return result
}

function appendSnapshots(
  /* 已存在的不可变精确快照，优先保留原内容。 */ archived: readonly ExecutionAgentDefinition[],
  /* 当前作用域保存的Agent配置，不含任何模型密钥。 */ agents: readonly AgentProfile[],
  /* 可继承的共享模型设置。 */ settings: ClusterSettings,
): ExecutionAgentDefinition[] {
  // 按现有controlResolveExecutionAgent的执行字段投影补齐缺失引用，绝不重写历史快照。
  const result = new Map<string, ExecutionAgentDefinition>()
  for (const snapshot of archived) result.set(refKey(snapshot.ref), structuredClone(snapshot))
  for (const agent of agents) {
    const ref = { id: agent.id, version: agent.revision }
    if (result.has(refKey(ref))) continue
    result.set(refKey(ref), { ref, profile: {
      id: agent.id, name: agent.name, description: agent.description, content: agent.content, tools: [...agent.tools],
      provider: agent.provider ?? settings.llm.provider, model: agent.model ?? settings.llm.model,
      promptVars: [...agent.promptVars], defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
    } })
  }
  return [...result.values()]
}

function refKey(/* 一个不可变定义或Agent的精确引用。 */ ref: DefinitionRef): string {
  // 同时编码身份与版本，避免零版本被误当作缺失。
  return JSON.stringify([ref.id, ref.version])
}
