// 复制 Agent 编辑输入，并从精确转换绑定推导可用变量和阶段输出合同。
import type { AgentBinding, AgentInput, AgentProfile, AgentRole } from '../../../../contracts/control'
import type { DefinitionCatalog, OutputContract, StageResultMode, TransitionStageDefinition } from '../../../../contracts/data-definition'

export interface AgentBindingChoice { binding: AgentBinding; title: string }

const AGENT_STAGE_ROLES: Record<StageResultMode, AgentRole> = { outputs: 'producer', plan: 'planner', selection: 'selector' }

interface AgentStageContract {
  binding: AgentBinding
  title: string
  output: OutputContract
  plan?: TransitionStageDefinition['plan']
}

interface AgentEditorContract {
  // null 表示当前目录不能完整验证变量，保存时交给服务端校验。
  variables: string[] | null
  stages: AgentStageContract[]
  unresolved: AgentBinding[]
}

export function agentCreateDraft(
  /* 服务端已保存的 Agent；草稿不能共享可变数组或绑定引用。 */ agent: AgentProfile,
): AgentInput {
  // 复制全部可编辑字段，保留通用角色和精确阶段绑定，剔除服务端版本元数据。
  return {
    id: agent.id, name: agent.name, description: agent.description, content: agent.content,
    promptPath: agent.promptPath, kind: agent.kind, provider: agent.provider, model: agent.model,
    tools: [...agent.tools], promptVars: [...agent.promptVars],
    defaultPriority: agent.defaultPriority, claimCategory: agent.claimCategory,
    ...(agent.role === undefined ? {} : { role: agent.role }),
    ...(agent.bindings === undefined ? {} : { bindings: agent.bindings.map(
      /* 一个已保存的精确阶段绑定。 */ binding =>
        /* 深复制转换引用，隔离草稿和服务端目录。 */ ({ ...binding, transition: { ...binding.transition } }),
    ) }),
  }
}

export function agentReadEditorContract(
  /* 当前编辑草稿；null 表示尚未选择 Agent。 */ agent: AgentInput | null,
  /* 当前 Agent 所在真实作用域的目录；旧服务缺能力时可为null。 */ catalog: DefinitionCatalog | null,
  /* 未声明通用绑定的现有配置所使用的变量清单。 */ legacyVariables: Record<string, string[]>,
): AgentEditorContract {
  // 已绑定配置按全部精确阶段约束变量；未绑定配置沿用已有变量规则。
  if (!agent) return { variables: [], stages: [], unresolved: [] }
  if (agent.bindings === undefined) {
    const variables = new Map(Object.entries(legacyVariables)).get(agent.kind)
    return { variables: variables ?? null, stages: [], unresolved: [] }
  }
  const stages: AgentStageContract[] = [], unresolved: AgentBinding[] = []
  let variables: string[] | null = null
  for (const binding of agent.bindings) {
    const transition = catalog?.transitions.find(
      /* 当前目录中的一个不可变转换版本。 */ item =>
        /* 同时匹配绑定的转换身份和版本。 */ item.id === binding.transition.id && item.version === binding.transition.version,
    )
    const stage = transition?.execution.stages.find(
      /* 绑定转换中的一个阶段模板。 */ item => /* 匹配声明的阶段身份。 */ item.id === binding.stageId,
    )
    if (!transition || !stage) { unresolved.push(binding); continue }
    const output: OutputContract = { mode: stage.resultMode, ports: [] }
    for (const port of stage.outputPorts) {
      const declared = transition.ports.output.find(
        /* 转换可发布的一个输出端口。 */ item => /* 找到阶段所声明的输出端口。 */ item.name === port.port,
      )
      const type = declared && catalog?.dataTypes.find(
        /* 当前目录中的一个数据类型版本。 */ item =>
          /* 取得端口声明的精确类型及 schema。 */ item.id === declared.outputType.id && item.version === declared.outputType.version,
      )
      if (declared && type) output.ports.push({ port: port.port, type: declared.outputType, count: port.count,
        schema: type.schema, references: type.references, successorOf: declared.successorOf })
    }
    if (output.ports.length !== stage.outputPorts.length) { unresolved.push(binding); continue }
    const available = Object.keys(stage.promptBindings ?? {})
    variables = variables === null ? available : variables.filter(
      /* 已经被前面所有绑定阶段允许的变量。 */ name => /* 仅保留本阶段也允许的变量。 */ available.includes(name),
    )
    stages.push({ binding, title: transition.title, output, ...(stage.plan ? { plan: stage.plan } : {}) })
  }
  return { variables: unresolved.length ? null : variables, stages, unresolved }
}

export function agentReadBindingChoices(
  /* 当前真实作用域的已发布目录，缺失时不借另一个范围补选项。 */ catalog: DefinitionCatalog | null,
  /* 草稿选择的通用阶段职责。 */ role: AgentRole,
): AgentBindingChoice[] {
  // 根据结果模式列精确同职责阶段，新Agent不必已经被旧阶段引用。
  if (!catalog) return []
  return catalog.transitions.flatMap((/* 当前范围的一份精确转换。 */ transition) =>
    /* 只列同职责阶段，不回落latest或比较旧执行者身份。 */ transition.execution.stages
      .filter((/* 转换中已发布的阶段。 */ stage) => /* 结果模式决定可参与职责。 */ AGENT_STAGE_ROLES[stage.resultMode] === role)
      .map((/* 可参与的同职责阶段。 */ stage) => /* 深复制精确身份，不共享目录引用。 */ ({
        binding: { transition: { id: transition.id, version: transition.version }, stageId: stage.id },
        title: `${transition.title} · ${transition.id}@${transition.version} · ${stage.id}`,
      })))
}

export function agentBuildBoundDraft(
  /* 当前独立编辑草稿，不含服务端配置版本。 */ draft: AgentInput,
  /* 用户明确选择的新职责。 */ role: AgentRole,
  /* 用户明确保留的精确绑定，编辑中允许暂时为空。 */ bindings: readonly AgentBinding[],
): AgentInput {
  // 只复制草稿并替换角色和绑定；变量、身份、kind和提示路径全部保留。
  return { ...draft, tools: [...draft.tools], promptVars: [...draft.promptVars], role,
    bindings: bindings.map((/* 用户当前保留的一项精确绑定。 */ binding) =>
      /* 分别复制绑定和转换身份，避免后续改稿影响输入对象。 */ ({ transition: { ...binding.transition }, stageId: binding.stageId })) }
}

export function agentReadBindingValidation(
  /* 当前编辑稿；无选择时不生成保存错误。 */ agent: AgentInput | null,
  /* 本范围真实目录；缺失时保留旧绑定和未知变量，不伪造校验结论。 */ catalog: DefinitionCatalog | null,
): string[] {
  // 核对通用组合、精确阶段职责与变量；旧未绑定配置继续沿原路径保存。
  if (!agent || agent.role === undefined && agent.bindings === undefined) return []
  if (agent.role === undefined || agent.bindings === undefined || !agent.bindings.length) return ['通用职责需要同时提供至少一个阶段绑定。']
  const errors: string[] = []
  const keys = new Set<string>()
  for (const binding of agent.bindings) {
    const identity = `${binding.transition.id}@${binding.transition.version}:${binding.stageId}`
    if (keys.has(identity)) errors.push(`阶段绑定重复：${identity}。`)
    keys.add(identity)
    if (!catalog) continue
    const transition = catalog.transitions.find((/* 当前范围的一份已发布转换。 */ item) =>
      /* 精确版本缺失时不能换用同名其它版本。 */ item.id === binding.transition.id && item.version === binding.transition.version)
    const stage = transition?.execution.stages.find((/* 精确转换中保存的阶段。 */ item) =>
      /* 不从其它转换借同名阶段。 */ item.id === binding.stageId)
    if (!stage) { errors.push(`当前目录无法定位精确阶段：${identity}。`); continue }
    if (AGENT_STAGE_ROLES[stage.resultMode] !== agent.role) errors.push(`阶段 ${identity} 与所选职责不匹配。`)
    const variables = Object.keys(stage.promptBindings ?? {})
    for (const variable of agent.promptVars) {
      if (!variables.includes(variable)) errors.push(`变量 ${variable} 不被阶段 ${identity} 允许，请明确移除不适用变量。`)
    }
  }
  return errors
}
