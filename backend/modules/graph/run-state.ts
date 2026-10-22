// 推进通用转换的封闭输入组、冻结 Agent 阶段、候选结果、审核与正式发布。
import { randomUUID } from 'node:crypto'
import type {
  DataInstanceRef,
  DataTypeDefinition,
  DefinitionCatalog,
  DefinitionRef,
  ExecutionAgentDefinition,
  ExecutionSpec,
  JsonValue,
} from '../../../contracts/data-definition'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphCommand, GraphQuery } from '../../../contracts/graph-api'
import type {
  GraphCandidateRef,
  GraphOperation,
  GraphOperationGroup,
  GraphPlanSlot,
  GraphPortDataRef,
  GraphProposedOutput,
  GraphPublicationPreview,
  GraphReview,
  GraphRun,
  GraphCurrentRun,
  GraphRunStep,
  GraphStageGroup,
  GraphStageResult,
} from '../../../contracts/graph-run'
import type { GraphDataProposal, GraphDataRead, GraphWork } from '../../../contracts/graph-work'
import type { GraphNode, GraphPayload } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import {
  definitionsFreezeExecution,
  definitionsDigest,
  definitionsReadTransition,
} from '../shared/data-definition'
import type { GraphDocument } from './graph-record'
import { EvidenceMessage, type EvidenceFrozenClaim } from '../../../contracts/evidence-library'
import type { GraphLibraryClaimSet } from '../../../contracts/graph-run'
import { graphInputReadLibraryClaimRefs, graphInputReadLibraryUseRefs } from './library-claim-input'
import { workCreateId } from './work-state'
import { graphParseNodePayload, type ParsedGraphNode } from '../shared/data-reference-index'
import { branchReadSnapshot } from './branch-state'

export interface GraphRunStartContext {
  definitions: DefinitionCatalog
  agents: ExecutionAgentDefinition[]
  tools: Array<{ name: string; description: string }>
  maxSlots: number
  // app已在同一授权事务冻结的各步骤库材料，Run接纳时复制并校验与plan的对应关系。
  libraryClaimSets?: GraphLibraryClaimSet[]
}

export interface RunPublicationResult {
  nodeIds: string[]
  edgeIds: string[]
  publishedNodes: ParsedGraphNode[]
}

function runRefEqual(a: DefinitionRef, b: DefinitionRef): boolean {
  return a.id === b.id && a.version === b.version
}

export function runReadRun(
  /* 已通过存储协议检查或由当前领域规则建立的图文档。 */ document: GraphDocument,
  /* 需要从当前 Run 集合读取的稳定身份。 */ runId: string,
): GraphRun {
  // 读取当前集合中的指定 Run，未知身份仍以业务错误拒绝。
  const run = document.runs.find(item => item.id === runId)
  if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
  return run
}

function runReadExecution(
  /* 已通过存储读取边界的图记录，包含当前运行和历史终态归档。 */ document: GraphDocument,
  /* 本次要继续执行的 Run 身份。 */ runId: string,
): GraphCurrentRun {
  // 按身份读取运行，再用状态缩窄到可执行协议，排除只读终态归档。
  const run = runReadRun(document, runId)
  if (run.status !== 'running' && run.status !== 'waiting') throw new GraphError(409, 'RUN_NOT_ACTIVE', RuntimeMessage.RUN_IS_TERMINAL)
  return run
}

export function runReadOperation(run: GraphRun, id: string): GraphOperation {
  const operation = run.operations.find(item => item.id === id)
  if (!operation) throw new GraphError(404, 'OPERATION_NOT_FOUND', RuntimeMessage.UNKNOWN_OPERATION)
  return operation
}

function runReadNode(document: GraphDocument, ref: Pick<GraphPortDataRef, 'id' | 'revision' | 'type'>): GraphNode {
  const node = document.nodes.find(item => item.id === ref.id && item.revision === ref.revision
    && item.typeId === ref.type.id && item.typeVersion === ref.type.version)
  if (!node) throw new GraphError(409, 'INPUT_STALE', messageFormat(RuntimeMessage.OPERATION_INPUT_CHANGED_VALUE, ref.id))
  return node
}

interface RunPortNode { ref: GraphPortDataRef; node: GraphNode }

function runValidateInputs(
  /* 本次操作读取的同一事务图快照。 */ document: GraphDocument,
  /* 已从当前执行集合取得、具备分支证明的运行。 */ run: GraphCurrentRun,
  /* 需要校验规格及冻结输入的 Operation。 */ operation: GraphOperation,
): { inputs: RunPortNode[]; context: RunPortNode[] } {
  // 核对分支和规格，并返回本次已经解析的精确节点，供随后读取直接复用。
  runValidateBranch(document, run)
  return runReadOperationInputs(document, operation)
}

function runValidateBranch(
  /* 本次检查共用、尚未改变的图快照。 */ document: GraphDocument,
  /* 已通过执行状态缩窄、持有冻结分支证明的Run。 */ run: GraphCurrentRun,
): void {
  // 对当前Run核对一次完整分支版本；各Operation随后只验证自己的输入和规格。
  const branch = run.branchState
  if (branchReadSnapshot(document, branch.scope.rootIds).version !== branch.version) {
    throw new GraphError(409, 'INPUT_STALE', RuntimeMessage.RUN_BRANCH_CHANGED_AFTER_START)
  }
}

function runReadOperationInputs(
  /* 已核对本Run分支的同一图快照。 */ document: GraphDocument,
  /* 需核对每份精确输入、上下文和规格的Operation。 */ operation: GraphOperation,
): { inputs: RunPortNode[]; context: RunPortNode[] } {
  // 返回同次验证的引用与真实节点配对，不重新计算整个Run的分支摘要。
  const readNodes = (/* 当前端口组冻结的精确输入引用。 */ refs: GraphPortDataRef[]): RunPortNode[] =>
    /* 一次完成节点身份、版本及类型检查，保留引用与节点的对应关系。 */
    refs.map((/* 一个已冻结的端口输入引用。 */ ref) =>
      /* 将后续投影需要的节点与原端口信息配对。 */ ({ ref, node: runReadNode(document, ref) }))
  const inputs = readNodes(operation.group.inputRefs), context = readNodes(operation.group.contextRefs)
  if (!operation.group.sealed || operation.specHash !== operation.executionSpec.specHash) {
    throw new GraphError(409, 'EXECUTION_SPEC_CONFLICT', RuntimeMessage.EXECUTION_SPEC_DOES_NOT_MATCH_OPERATION)
  }
  return { inputs, context }
}

function runValidatePlan(plan: GraphRun['plan'], scope: string[], catalog: DefinitionCatalog): void {
  if (!plan.steps.length || plan.steps.length > 64) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, 'step count'))
  const byId = new Map(plan.steps.map(step => [step.id, step]))
  if (byId.size !== plan.steps.length) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, 'duplicate step id'))
  const scopeIds = new Set(scope)
  for (const step of plan.steps) {
    if (step.libraryClaimRefs !== undefined) graphInputReadLibraryClaimRefs(step.libraryClaimRefs, `plan.${step.id}.libraryClaimRefs`)
    if (!step.id.trim() || !step.dependsOn.every(id => byId.has(id) && id !== step.id) || new Set(step.dependsOn).size !== step.dependsOn.length) {
      throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, step.id))
    }
    const transition = definitionsReadTransition(catalog, step.transitionRef)
    const validateBindings = (bindings: GraphRunStep['input'], ports: typeof transition.ports.input, kind: string) => {
      if (bindings.length !== ports.length || new Set(bindings.map(binding => binding.port)).size !== bindings.length
        || !ports.every(port => bindings.some(binding => binding.port === port.name))) {
        throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${step.id}.${kind}`))
      }
      for (const binding of bindings) {
        const targetPort = ports.find(port => port.name === binding.port)!
        if (binding.source.kind === 'scope') {
          if (binding.source.nodeIds.some(id => !scopeIds.has(id))) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${step.id}.${binding.port}`))
        } else {
          const sourcePort = binding.source.port
          const source = byId.get(binding.source.stepId)
          if (!source || !step.dependsOn.includes(source.id)) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${step.id}.${binding.port}`))
          const sourceTransition = definitionsReadTransition(catalog, source.transitionRef)
          const outputPort = sourceTransition.ports.output.find(port => port.name === sourcePort)
          if (!outputPort || !runRefEqual(outputPort.outputType, targetPort.inputType)) {
            throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${step.id}.${binding.port}`))
          }
        }
      }
    }
    validateBindings(step.input, transition.ports.input, 'input')
    validateBindings(step.context, transition.ports.context, 'context')
    if (step.grouping.mode === 'each' && step.input.length !== 1) {
      throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${step.id}.grouping`))
    }
    if (step.grouping.mode === 'explicit') {
      const ports = new Set(step.input.map(binding => binding.port))
      if (!step.grouping.groups.length || new Set(step.grouping.groups.map(group => group.id)).size !== step.grouping.groups.length
        || step.grouping.groups.some(group => !group.id.trim() || Object.keys(group.members).some(port => !ports.has(port)))) {
        throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${step.id}.grouping`))
      }
    }
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const visit = (id: string) => {
    if (visiting.has(id)) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, 'cycle'))
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id)!.dependsOn) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const id of byId.keys()) visit(id)
}

function runReadBindingNodes(document: GraphDocument, run: GraphRun, binding: GraphRunStep['input'][number]): GraphNode[] {
  if (binding.source.kind === 'scope') return binding.source.nodeIds.map(id => {
    const node = document.nodes.find(item => item.id === id)
    if (!node) throw new GraphError(422, 'INVALID_SCOPE', messageFormat(RuntimeMessage.SCOPE_NODE_IS_MISSING_VALUE, id))
    return node
  })
  const sourceStepId = binding.source.stepId, sourcePort = binding.source.port
  return run.operations.filter(operation => operation.stepId === sourceStepId && operation.status === 'completed')
    .flatMap(operation => operation.outputRefs.filter(ref => ref.port === sourcePort)
      .map(ref => document.nodes.find(node => node.id === ref.id && node.revision === ref.revision)))
    .filter((node): node is GraphNode => !!node)
}

function runCreatePortRefs(port: string, nodes: GraphNode[]): GraphPortDataRef[] {
  return nodes.map((node, index) => ({
    key: `${port}:${index}:${node.id}`,
    port,
    id: node.id,
    revision: node.revision,
    type: { id: node.typeId, version: node.typeVersion },
  }))
}

function runCreateStageGroups(operationId: string, spec: ExecutionSpec): GraphStageGroup[] {
  const planned = new Set(spec.stages.flatMap(stage => stage.plan?.stageIds ?? []))
  return spec.stages.map(stage => {
    if (planned.has(stage.id)) return { stageId: stage.id, expectedWorkIds: [], results: [], planSlots: [], closed: false }
    const slot: GraphPlanSlot = {
      id: stage.id,
      stageId: stage.id,
      agentRef: structuredClone(stage.agent.ref),
      angle: '',
      hint: '',
      priority: stage.agent.profile.defaultPriority ?? 'medium',
      tools: [...stage.agent.profile.tools],
    }
    return { stageId: stage.id, expectedWorkIds: [workCreateId(operationId, stage.id, stage.id)], results: [], planSlots: [slot], closed: false }
  })
}

function runCreateOperation(
  /* 已接纳且保存完整冻结材料的Run。 */ run: GraphRun,
  /* 当前待实例化的计划步骤。 */ step: GraphRunStep,
  /* 本次封闭输入与上下文组。 */ group: GraphOperationGroup,
): GraphOperation {
  // 建立Operation规格与阶段，仅绑定本步骤库refs及定义摘要，不复制材料全文。
  const groupRefs = (/* 封闭输入或上下文中的精确端口引用。 */ refs: GraphPortDataRef[]): Record<string, GraphPortDataRef[]> => {
    // 用Map分组端口，避免合法端口名被对象继承属性冒充已有数组。
    const grouped = new Map<string, GraphPortDataRef[]>()
    for (const ref of refs) {
      const group = grouped.get(ref.port)
      if (group) group.push(ref)
      else grouped.set(ref.port, [ref])
    }
    return Object.fromEntries(grouped)
  }
  const inputs = groupRefs(group.inputRefs)
  const context = groupRefs(group.contextRefs)
  const toInstances = (/* 已存在端口组中的完整引用数组。 */ refs: GraphPortDataRef[]): DataInstanceRef[] =>
    /* 将已冻结端口引用投影为执行规格使用的数据实例身份。 */ refs.map((/* 端口中的一项精确输入。 */ ref) =>
      /* 仅复制实例身份、内容版本及精确类型，不补造缺失端口。 */ ({
        id: ref.id,
        revision: ref.revision,
        type: structuredClone(ref.type),
      }))
  const spec = definitionsFreezeExecution({
    catalog: run.definitions,
    transitionRef: step.transitionRef,
    agents: run.agents,
    tools: run.tools,
    inputs: Object.fromEntries(Object.entries(inputs).map((/* 已存在的输入端口及完整引用数组。 */ [port, refs]) =>
      /* 为每个实际输入端口建立精确实例绑定。 */ [port, toInstances(refs)])),
    context: Object.fromEntries(Object.entries(context).map((/* 已存在的上下文端口及完整引用数组。 */ [port, refs]) =>
      /* 为每个实际上下文端口建立精确实例绑定。 */ [port, toInstances(refs)])),
    libraryClaims: run.libraryClaimSets?.find((/* Run一次保存的完整步骤材料。 */ set) => /* Operation只取得所属step集合。 */ set.stepId === step.id)?.claims,
  })
  const id = randomUUID()
  return {
    id,
    stepId: step.id,
    transitionRef: structuredClone(step.transitionRef),
    specHash: spec.specHash,
    executionSpec: spec,
    group,
    externalInputs: {},
    status: 'running',
    stages: runCreateStageGroups(id, spec),
    outputRefs: [],
    review: null,
  }
}

function runReuseOperation(document: GraphDocument, run: GraphRun, operation: GraphOperation): GraphOperation {
  // 精确规格已包含类型、转换、Agent、工具和输入版本；产物仍存在且版本一致时才复用历史完成结果。
  if (run.regenerate) return operation
  const prior = [...document.runHistory, ...document.runs.filter(item => item.id !== run.id)].reverse().flatMap(item => item.operations).find(item => item.status === 'completed'
    && item.specHash === operation.specHash && runRefEqual(item.transitionRef, operation.transitionRef)
    && item.outputRefs.every(ref => document.nodes.some(node => node.id === ref.id && node.revision === ref.revision)))
  if (!prior) return operation
  return {
    ...operation,
    status: 'completed',
    stages: structuredClone(prior.stages),
    externalInputs: structuredClone(prior.externalInputs),
    outputRefs: structuredClone(prior.outputRefs),
    review: structuredClone(prior.review),
    reusedFromOperationId: prior.id,
  }
}

function runCreateGroups(
  /* 已获得Run分支授权的当前图快照。 */ document: GraphDocument,
  /* 具有完整有限计划和冻结目录的当前Run。 */ run: GraphRun,
  /* 本次待实例化Operation的计划步骤。 */ step: GraphRunStep,
): GraphOperationGroup[] {
  // 解析步骤实际输入，按all、each或显式成员规则建立封闭Operation组。
  const inputNodes = Object.fromEntries(step.input.map((/* 计划声明的输入端口及来源。 */ binding) =>
    /* 读取该端口实际可用的完整节点。 */ [binding.port, runReadBindingNodes(document, run, binding)]))
  const contextRefs = step.context.flatMap((/* 计划声明的上下文端口及来源。 */ binding) =>
    /* 上下文为每组提供同一份精确引用。 */ runCreatePortRefs(binding.port, runReadBindingNodes(document, run, binding)))
  if (step.grouping.mode === 'all') return [{
    id: `${step.id}:all`,
    inputRefs: step.input.flatMap((/* all组包含的一个声明输入端口。 */ binding) =>
      /* 汇入该端口全部可用节点。 */ runCreatePortRefs(binding.port, inputNodes[binding.port])),
    contextRefs,
    sealed: true,
  }]
  if (step.grouping.mode === 'each') {
    const binding = step.input[0]
    return inputNodes[binding.port].map((/* each规则的一项独立输入。 */ node) =>
      /* 每个输入建立一个独立且已封闭的Operation组。 */ ({
        id: `${step.id}:${node.id}`,
        inputRefs: runCreatePortRefs(binding.port, [node]),
        contextRefs: structuredClone(contextRefs),
        sealed: true,
      }))
  }
  const available = new Map(step.input.map((/* 显式分组可使用的声明输入端口。 */ binding) =>
    /* 为各端口建立可用节点索引，不接受其他端口的同名节点。 */ [binding.port,
      new Map(inputNodes[binding.port].map((/* 该端口一项实际可用节点。 */ node) => /* 按节点身份解析显式成员。 */ [node.id, node]))]))
  return step.grouping.groups.map((/* 用户已经声明的一个显式成员分组。 */ group) =>
    /* 只从各端口自有成员表读取输入，缺省可选端口按空集合参与基数检查。 */ ({
      id: group.id,
      inputRefs: step.input.flatMap((/* 当前组需要解析的声明输入端口。 */ binding) =>
        /* 继承字段不构成用户提供的成员列表。 */ (Object.prototype.hasOwnProperty.call(group.members, binding.port) ? group.members[binding.port] : []).map((
          /* 当前端口明确选定的一个节点身份。 */ id,
        ) => {
          // 显式成员必须位于本端口已封闭的可用输入中。
          const node = available.get(binding.port)?.get(id)
          if (!node) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, `${step.id}.${group.id}`))
          return runCreatePortRefs(binding.port, [node])[0]
        })),
      contextRefs: structuredClone(contextRefs),
      sealed: true,
    }))
}

function runInstantiateReadySteps(document: GraphDocument, run: GraphRun): void {
  let changed = true
  while (changed) {
    changed = false
    for (const state of run.steps) {
      const step = run.plan.steps.find(item => item.id === state.stepId)!
      if (state.status === 'running') {
        const operations = state.operationIds.map(id => runReadOperation(run, id))
        if (operations.some(operation => operation.status === 'failed')) { state.status = 'failed'; changed = true }
        else if (operations.length && operations.every(operation => ['completed', 'skipped'].includes(operation.status))) { state.status = 'completed'; changed = true }
        continue
      }
      if (state.status !== 'pending') continue
      if (!step.dependsOn.every(id => ['completed', 'skipped'].includes(run.steps.find(item => item.stepId === id)!.status))) continue
      const groups = runCreateGroups(document, run, step)
      if (!groups.length || groups.every(group => group.inputRefs.length === 0)) {
        state.status = step.onEmpty === 'skip' ? 'skipped' : 'failed'
        changed = true
        continue
      }
      const operations = groups.map(group => runReuseOperation(document, run, runCreateOperation(run, step, group)))
      run.operations.push(...operations)
      state.operationIds.push(...operations.map(operation => operation.id))
      state.status = 'running'
      changed = true
    }
  }
}

function runUpdateProgress(document: GraphDocument, run: GraphRun, now: string): void {
  runInstantiateReadySteps(document, run)
  if (run.steps.some(step => step.status === 'failed') || run.operations.some(operation => operation.status === 'failed')) run.status = 'failed'
  else if (run.steps.every(step => ['completed', 'skipped'].includes(step.status))) run.status = 'completed'
  else if (run.operations.some(operation => operation.status === 'running')) run.status = 'running'
  else if (run.operations.some(operation => operation.status === 'waiting')) run.status = 'waiting'
  else run.status = 'running'
  run.updatedAt = now
  document.updatedAt = now
}

function runReadPointer(
  /* 已通过JSON边界检查的正文或投影对象。 */ value: JsonValue,
  /* 定义声明的确定路径；未提供时读取整个值。 */ pointer?: string,
): JsonValue | undefined {
  // 仅沿自有属性读取模型可见字段，不把继承原型当作正文。
  if (!pointer || pointer === '/') return value
  let current: JsonValue | undefined = value
  for (const part of pointer.split('/').slice(1).map((/* 已编码的路径段。 */ item) =>
    /* 还原JSON Pointer中的斜线和波浪号。 */ item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || typeof current !== 'object' || Array.isArray(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined
    current = current[part]
  }
  return current
}

function runProjectPayload(
  /* 本图中与输入版本匹配的完整节点。 */ node: GraphNode,
  /* 当前Operation的冻结定义闭包。 */ spec: ExecutionSpec,
): GraphPayload {
  // 本图输入按Operation冻结的精确定义投影，不读取当前工作区配置。
  const definition = spec.dataTypes.find(type => type.id === node.typeId && type.version === node.typeVersion)
  if (!definition) throw new GraphError(409, 'EXECUTION_SPEC_CONFLICT', RuntimeMessage.EXECUTION_SPEC_DOES_NOT_MATCH_OPERATION)
  return runProjectDefinitionPayload(node, definition)
}

function runProjectDefinitionPayload(
  /* 待交付Work的完整固定节点，不会原地改写。 */ node: GraphNode,
  /* 当前节点对应的精确冻结定义。 */ definition: DataTypeDefinition,
): GraphPayload {
  // 共用既有字段/可见字典投影规则，使库材料和本图输入遵循相同模型可见边界。
  const output: GraphPayload = {}
  for (const pointer of definition.agentProjection.include) {
    const parts = pointer.split('/').slice(1).map((/* Agent投影声明的路径段。 */ item) => /* 还原字段名称。 */ item.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (!parts.length) continue
    const value = runReadPointer(node.payload, pointer)
    if (value === undefined) continue
    let target: Record<string, JsonValue> = output
    for (const part of parts.slice(0, -1)) {
      const prior = Object.prototype.hasOwnProperty.call(target, part) ? target[part] : undefined
      const next: Record<string, JsonValue> = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}
      if (prior === undefined) Object.defineProperty(target, part, { value: next, enumerable: true, writable: true, configurable: true })
      target = next
    }
    Object.defineProperty(target, parts[parts.length - 1], { value: structuredClone(value), enumerable: true, writable: true, configurable: true })
  }
  for (const filter of definition.agentProjection.mapEntryFilters) {
    const map = runReadPointer(output, filter.path)
    if (!map || typeof map !== 'object' || Array.isArray(map)) continue
    for (const [key, item] of Object.entries(map)) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || item[filter.visibleWhen] !== true) delete map[key]
    }
  }
  return output
}

function runReadStageAgent(operation: GraphOperation, stageId: string, slotId: string): { agent: ExecutionAgentDefinition; tools: Array<{ name: string; description: string }> } {
  const stage = operation.executionSpec.stages.find(item => item.id === stageId)
  const group = operation.stages.find(item => item.stageId === stageId)
  if (!stage || !group) throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.STAGE_WORK_IS_NOT_READY)
  const slot = group.planSlots.find(item => item.id === slotId)
  if (!slot || !group.expectedWorkIds.includes(workCreateId(operation.id, stageId, slotId))) throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.STAGE_WORK_IS_NOT_READY)
  if (slot.id === stage.id && runRefEqual(slot.agentRef, stage.agent.ref)) return { agent: stage.agent, tools: stage.tools }
  const planner = operation.executionSpec.stages.find(item => item.plan?.stageIds.includes(stageId) && item.plan.agents.some(agent => runRefEqual(agent.ref, slot.agentRef)))
  const agent = planner?.plan?.agents.find(item => runRefEqual(item.ref, slot.agentRef))
  if (!agent) throw new GraphError(409, 'WORK_STOPPED', messageFormat(RuntimeMessage.INVALID_PLAN_SLOT_VALUE, slot.id))
  const allowed = new Set(slot.tools)
  return { agent, tools: planner!.plan!.tools.filter(tool => allowed.has(tool.name)) }
}

function runFormatBinding(
  /* 只读模型输入值或已接纳的阶段计划和结果，均已由各自领域入口建立。 */ values: Array<JsonValue | GraphPlanSlot | GraphStageResult[]>,
  /* 冻结绑定声明的文本或JSON呈现格式。 */ format: 'text' | 'json' | 'text-lines',
): string {
  // 只生成字符串，不修改或复制已验阶段材料，也不借断言把阶段合同伪装成通用JSON对象。
  if (format === 'json') return JSON.stringify(values.length === 1 ? values[0] : values)
  const render = (/* 一项已验正文、计划或阶段结果。 */ value: JsonValue | GraphPlanSlot | GraphStageResult[]): string =>
    /* 字符串原样保留，结构值按JSON呈现。 */ typeof value === 'string' ? value : JSON.stringify(value)
  return values.map(render).join(format === 'text-lines' ? '\n' : '\n\n')
}

function runCreatePromptVariables(
  /* 已核对Work阶段资格的Operation及冻结结果。 */ operation: GraphOperation,
  /* 同次领域核验已经取得的实际冻结阶段。 */ stage: ExecutionSpec['stages'][number],
  /* Work在该阶段的真实槽位身份。 */ slotId: string,
  /* 当前Work已投影且按实际端口分组的输入节点。 */ inputs: GraphDataRead['inputs'],
  /* 当前Work已投影且按实际端口分组的上下文节点。 */ context: GraphDataRead['context'],
  /* 同一输入快照已冻结的来源正文，缺省变量不得从原型继承。 */ sourceText: Record<string, string>,
): Record<string, string> {
  // 根据实际自有绑定生成模型变量，缺省可选端口为空，不读取继承的同名函数或对象。
  const variables: Record<string, string> = {}
  for (const [name, binding] of Object.entries(stage.promptBindings)) {
    if (binding.source === 'source-text') {
      if (Object.prototype.hasOwnProperty.call(sourceText, name)) variables[name] = sourceText[name]
      continue
    }
    if (binding.source === 'stage') {
      const group = operation.stages.find((/* Operation中的一个已接纳阶段。 */ item) => /* 取得绑定明确依赖的阶段结果。 */ item.stageId === binding.stageId)
      const plannedSlot = group?.results.flatMap((/* 依赖阶段已经接纳的一份结果。 */ result) =>
        /* 只有计划结果能够为当前槽位提供计划参数。 */ result.mode === 'plan' ? result.plan.slots : []).find((
          /* 依赖计划实际提供的一项槽位。 */ slot,
        ) => /* 选择当前Work所属的精确槽位。 */ slot.id === slotId)
      const value = plannedSlot ?? group?.results ?? []
      variables[name] = runFormatBinding([value], binding.format)
      continue
    }
    if (binding.source === 'agents') {
      variables[name] = JSON.stringify(stage.plan?.agents.map((/* 本阶段获准规划的一份冻结Agent配置。 */ agent) =>
        /* 只交付计划选择需要的身份、说明和工具。 */ ({ id: agent.ref.id, version: agent.ref.version,
          name: agent.profile.name, description: agent.profile.description, tools: agent.profile.tools })) ?? [])
      continue
    }
    const ports = binding.source === 'input' ? inputs : context
    const items = Object.prototype.hasOwnProperty.call(ports, binding.port) ? ports[binding.port] : []
    const values = items.flatMap((/* 本端口实际存在的一项投影输入。 */ item) => {
      // 只读取冻结绑定声明的具体正文路径。
      const value = runReadPointer(item.node.payload, binding.path)
      return value === undefined ? [] : [value]
    })
    if (binding.required && !values.length) throw new GraphError(409, 'PROMPT_INPUT_MISSING', messageFormat(RuntimeMessage.PROMPT_VARIABLE_IS_NOT_AVAILABLE_FOR_THIS_KIND, name))
    variables[name] = runFormatBinding(values, binding.format)
  }
  return variables
}

type RunDataWork = Pick<GraphWork, 'runId' | 'operationId' | 'workId' | 'stageId' | 'slotId' | 'specHash'>

interface RunWorkContext {
  readonly run: GraphCurrentRun
  readonly operation: GraphOperation
  readonly stage: ExecutionSpec['stages'][number]
  readonly resolved: { inputs: RunPortNode[]; context: RunPortNode[] }
  readonly selected: ReturnType<typeof runReadStageAgent>
}

export function runReadWorkContext(
  /* 本次读取或来源缓存提交所依据的当前图快照。 */ document: GraphDocument,
  /* data_read明确请求的Operation身份。 */ operationId: string,
  /* 已确认当前租约、但仍需核对领域归属与阶段资格的Work。 */ work: RunDataWork,
): RunWorkContext {
  // 在任何外部来源读取前核对Operation归属、冻结输入与阶段资格；异步后仍以新快照复验。
  const run = runReadExecution(document, work.runId), operation = runReadOperation(run, operationId)
  const resolved = runValidateInputs(document, run, operation)
  if (work.operationId !== operation.id || operation.status !== 'running' || operation.specHash !== work.specHash) throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.OPERATION_IS_NOT_EXECUTABLE)
  const group = operation.stages.find((/* Operation中的一个阶段组。 */ item) => /* 取得获权Work所属阶段。 */ item.stageId === work.stageId)
  const stage = operation.executionSpec.stages.find((/* 冻结执行规格中的阶段声明。 */ item) => /* 只读取获权Work声明的阶段。 */ item.id === work.stageId)
  if (!group || !stage || !group.expectedWorkIds.includes(work.workId) || group.results.some((/* 当前阶段已接纳的一份结果。 */ result) => /* 已有结果的Work不能再次读取执行输入。 */ result.workId === work.workId)
    || !stage.dependsOn.every((/* 本阶段声明依赖的阶段身份。 */ id) => /* 所有依赖阶段必须封闭。 */ operation.stages.some((/* Operation中的依赖阶段组。 */ item) => /* 按身份确认当前封闭状态。 */ item.stageId === id && item.closed))) {
    throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.STAGE_WORK_IS_NOT_READY)
  }
  const selected = runReadStageAgent(operation, work.stageId, work.slotId)
  return { run, operation, stage, resolved, selected }
}

export function runReadData(
  /* 本次获权Work的图事务快照。 */ document: GraphDocument,
  /* 与Work授权绑定的Operation身份。 */ operationId: string,
  /* 服务端已经确认租约的阶段与冻结规格身份。 */ work: RunDataWork,
  /* 来源读取器已冻结的正文变量，默认没有外部来源正文。 */ sourceText: Record<string, string> = {},
): Omit<GraphDataRead, 'work'> {
  // 核对输入版本与Work阶段，返回本图投影、当前步骤库投影和完整冻结输出合同。
  const { run, operation, stage, resolved, selected } = runReadWorkContext(document, operationId, work)
  const groupNodes = (/* 本次验证已取得的端口引用和节点配对。 */ nodes: RunPortNode[]): GraphDataRead['inputs'] => {
    // 按真实端口名称分组，为每个节点建立独立的模型可见投影。
    const grouped = new Map<string, GraphDataRead['inputs'][string]>()
    for (const { ref, node } of nodes) {
      const item = { key: ref.key, node: { ...structuredClone(node), payload: runProjectPayload(node, operation.executionSpec) } }
      const group = grouped.get(ref.port)
      if (group) group.push(item)
      else grouped.set(ref.port, [item])
    }
    return Object.fromEntries(grouped)
  }
  const inputs = groupNodes(resolved.inputs)
  const context = groupNodes(resolved.context)
  const priorStageResults = stage.dependsOn.flatMap((/* 当前Work明确依赖的阶段身份。 */ id) => /* 只交付这些阶段已接纳的结果。 */ operation.stages.find((/* Operation中的一个阶段组。 */ item) => /* 按依赖身份定位阶段结果。 */ item.stageId === id)?.results ?? [])
  const libraryClaims = run.libraryClaimSets?.find((/* 本Run各步骤完整材料集合。 */ set) => /* 只返回当前Operation所属step。 */ set.stepId === operation.stepId)?.claims ?? []
  return {
    mapId: document.id,
    runId: run.id,
    operationId,
    transitionRef: structuredClone(operation.transitionRef),
    specHash: operation.specHash,
    inputs,
    context,
    ...(libraryClaims.length ? { libraryClaims: libraryClaims.map((/* 当前步骤获权的完整固定材料。 */ claim) => {
      // 复制整份材料后投影原节点payload，原0/1、范围和出处身份仍保留。
      const result = structuredClone(claim)
      result.entry.claim.nodeSnapshot.payload = runProjectDefinitionPayload(claim.entry.claim.nodeSnapshot, claim.definition)
      return result
    }) } : {}),
    priorStageResults: structuredClone(priorStageResults),
    promptVariables: runCreatePromptVariables(operation, stage, work.slotId, inputs, context, sourceText),
    stage: { id: work.stageId, slotId: work.slotId, agent: structuredClone(selected.agent), tools: structuredClone(selected.tools),
      ...(stage.plan ? { plan: structuredClone(stage.plan) } : {}) },
    outputContract: structuredClone(stage.outputContract),
    proposalId: work.workId,
  }
}

function runReadCandidates(operation: GraphOperation): Array<GraphProposedOutput & { workId: string; stageId: string; slotId: string }> {
  return operation.stages.flatMap(group => group.results.flatMap(result => result.mode === 'outputs'
    ? result.outputs.map(output => ({ ...structuredClone(output), workId: result.workId, stageId: result.stageId, slotId: result.slotId })) : []))
}

function runCandidateKey(workId: string, key: string): string { return `${workId}\u0000${key}` }

function runResolveCandidateRefs(value: JsonValue, ids: Map<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map(item => runResolveCandidateRefs(item, ids))
  if (!value || typeof value !== 'object') return value
  if (Object.keys(value).length === 1 && 'candidate' in value) {
    const candidate = value.candidate
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)
      || typeof candidate.workId !== 'string' || typeof candidate.key !== 'string') return value
    return ids.get(runCandidateKey(candidate.workId, candidate.key)) ?? value
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, runResolveCandidateRefs(item, ids)]))
}

interface RunValidatedOutput {
  // 仅本次提案分配的稳定正式身份，和下方已物化正文配对。
  nodeId: string
  parsed: ReturnType<typeof graphParseNodePayload>
}

function runValidateStageOutputs(
  /* 保存本图类型目录及运行策略的Run。 */ run: GraphRun,
  /* 本次提案所属且已冻结材料集合的Operation。 */ operation: GraphOperation,
  /* 入口已核对Work获权及依赖资格的具体冻结阶段。 */ stage: ExecutionSpec['stages'][number],
  /* 用于候选引用身份组合的当前Work身份。 */ workId: string,
  /* 当前尝试独占且已经分配正式节点身份的候选输出副本。 */ outputs: Array<GraphProposedOutput & { nodeId: string }>,
): Map<string, RunValidatedOutput> {
  // 校验候选授权和引用后完整解析已物化正文，供本次同步发布直接复用。
  const validated = new Map<string, RunValidatedOutput>()
  const candidates = runReadCandidates(operation)
  const candidateIds = new Map<string, string>()
  for (const candidate of candidates) {
    if (candidate.nodeId !== undefined) candidateIds.set(runCandidateKey(candidate.workId, candidate.key), candidate.nodeId)
  }
  for (const candidate of outputs) candidateIds.set(runCandidateKey(workId, candidate.key), candidate.nodeId)
  if (new Set(outputs.map((/* 本次独占候选输出。 */ output) => /* 提取候选唯一键。 */ output.key)).size !== outputs.length) throw new GraphError(422, 'INVALID_OUTPUT', messageFormat(RuntimeMessage.DUPLICATE_VALUE, 'output key'))
  for (const contract of stage.outputContract.ports) {
    const items = outputs.filter((/* 待分配到当前输出端口的候选。 */ output) => /* 只计入同名端口。 */ output.port === contract.port)
    if (items.length < contract.count.min || items.length > contract.count.max) throw new GraphError(422, 'OUTPUT_CARDINALITY', messageFormat(RuntimeMessage.OUTPUT_CARDINALITY_VALUE, contract.port))
    for (const output of items) {
      for (const reference of output.libraryClaimRefs ?? []) {
        const allowed = operation.executionSpec.libraryClaimRefs?.find((/* Operation已冻结的获权库身份。 */ ref) => /* 库引用必须属于此集合。 */ ref.entryId === reference.entryId)
        if (!allowed) throw new GraphError(422, 'EVIDENCE_NOT_AUTHORIZED', EvidenceMessage.NOT_AUTHORIZED)
        if (allowed.contentDigest !== reference.contentDigest) throw new GraphError(422, 'EVIDENCE_DIGEST_MISMATCH', EvidenceMessage.DIGEST_MISMATCH)
      }
      if (!runRefEqual(output.typeRef, contract.type)) throw new GraphError(422, 'INVALID_OUTPUT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, output.key))
      if (output.sourceKeys) {
        const allowed = new Set(contract.successorOf.flatMap((/* 当前输出允许继承的输入或候选端口。 */ anchor) => /* 汇总合法sourceKeys。 */ anchor.source === 'input'
          ? operation.group.inputRefs.filter((/* 已冻结输入引用。 */ ref) => /* 只使用声明锚点端口。 */ ref.port === anchor.port).map((/* 合法输入来源。 */ ref) => /* 提取精确来源键。 */ ref.key)
          : candidates.filter((/* 历史已接纳候选。 */ candidate) => /* 限制到声明候选端口。 */ candidate.port === anchor.port).map((/* 合法候选来源。 */ candidate) => /* 组合候选来源身份。 */ `${candidate.workId}:${candidate.key}`)))
        if (!output.sourceKeys.length || new Set(output.sourceKeys).size !== output.sourceKeys.length || output.sourceKeys.some((/* 当前输出指定的来源键。 */ key) => /* 不接受声明锚点以外的来源。 */ !allowed.has(key))) {
          throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
        }
      }
      const candidateReferences: Array<{ path: string; key: string }> = []
      const scan = (
        /* 当前候选正文或其子值。 */ value: JsonValue,
        /* 当前成员已编码的具体JSON Pointer，根为零长度。 */ path = '',
      ): void => {
        // 一次收集候选引用的位置与身份，路径授权和依赖授权共用这份结果。
        if (Array.isArray(value)) {
          value.forEach((/* 数组中的候选子值。 */ item, /* 具体数组下标。 */ index) =>
            /* 继续检查数组每个成员。 */ scan(item, `${path}/${index}`))
          return
        }
        if (!value || typeof value !== 'object') return
        const candidate = value.candidate
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          && typeof candidate.workId === 'string' && typeof candidate.key === 'string') {
          candidateReferences.push({ path, key: runCandidateKey(candidate.workId, candidate.key) })
        } else for (const [key, item] of Object.entries(value)) scan(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
      }
      scan(output.payload)
      const type = operation.executionSpec.dataTypes.find((/* 该Operation的冻结类型闭包。 */ item) => /* 使用当前候选的精确类型。 */ runRefEqual(item, output.typeRef))
      const patterns = type?.references.filter((/* 冻结类型的引用声明。 */ reference) => /* 候选只能用于节点引用。 */ reference.target.kind === 'node').map((/* 合法节点引用声明。 */ reference) => /* 取已编码路径用于通配匹配。 */ reference.path.split('/').slice(1)) ?? []
      const pathAllowed = (/* 本次扫描得到的具体候选引用路径。 */ path: string): boolean => {
        // 具体候选引用必须处于类型声明允许的节点引用位置。
        const parts = path.split('/').slice(1)
        return patterns.some((/* 冻结声明的一个节点引用路径模式。 */ pattern) => /* 按相同段数及通配语义匹配具体路径。 */ pattern.length === parts.length && pattern.every((/* 声明路径的一个已编码段。 */ part, /* 该段在具体路径中的位置。 */ index) => /* 只允许精确字段或声明星号。 */ part === '*' || part === parts[index]))
      }
      const dependencies = new Set(candidates.filter((/* 历史候选及其所属阶段。 */ candidate) => /* 只能引用本阶段已声明依赖的结果。 */ stage.dependsOn.includes(candidate.stageId))
        .map((/* 本阶段获准使用的历史候选。 */ candidate) => /* 提取候选依赖组合键。 */ runCandidateKey(candidate.workId, candidate.key)))
      for (const item of outputs) dependencies.add(runCandidateKey(workId, item.key))
      if (candidateReferences.some((/* 单个已收集的候选引用。 */ reference) =>
        /* 同一具体引用必须同时获准路径、阶段依赖和已分配身份。 */ !pathAllowed(reference.path)
          || !dependencies.has(reference.key) || !candidateIds.get(reference.key))) {
        throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
      }
      const parsed = graphParseNodePayload(run.definitions, output.typeRef, runResolveCandidateRefs(output.payload, candidateIds))
      validated.set(runCandidateKey(workId, output.key), { nodeId: output.nodeId, parsed })
    }
  }
  if (outputs.some((/* 当前提交的一个候选。 */ output) => /* 不接纳未在阶段声明的输出端口。 */ !stage.outputContract.ports.some((/* 本阶段的一个输出端口合同。 */ contract) => /* 按端口名确认候选归属。 */ contract.port === output.port))) {
    throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  }
  return validated
}

function runValidateSelection(operation: GraphOperation, stageId: string, selection: GraphDataProposal & { kind: 'selection' }): void {
  const stage = operation.executionSpec.stages.find(item => item.id === stageId)!
  const candidates = runReadCandidates(operation)
  const keys = new Set<string>()
  const chosen = selection.selection.map(ref => {
    const key = runCandidateKey(ref.workId, ref.key)
    const candidate = candidates.find(item => runCandidateKey(item.workId, item.key) === key)
    if (!candidate || keys.has(key) || !stage.dependsOn.includes(candidate.stageId)) throw new GraphError(422, 'INVALID_SELECTION', RuntimeMessage.SELECT_EACH_EXISTING_CANDIDATE_AT_MOST_ONCE)
    keys.add(key); return candidate
  })
  for (const contract of stage.outputContract.ports) {
    const count = chosen.filter(candidate => candidate.port === contract.port && runRefEqual(candidate.typeRef, contract.type)).length
    if (count < contract.count.min || count > contract.count.max) throw new GraphError(422, 'OUTPUT_CARDINALITY', messageFormat(RuntimeMessage.OUTPUT_CARDINALITY_VALUE, contract.port))
  }
  if (chosen.some(candidate => !stage.outputContract.ports.some(contract => contract.port === candidate.port && runRefEqual(contract.type, candidate.typeRef)))) {
    throw new GraphError(422, 'INVALID_SELECTION', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  }
}

function runValidatePlanSlots(run: GraphCurrentRun, operation: GraphOperation, stageId: string, slots: GraphPlanSlot[]): GraphPlanSlot[] {
  const stage = operation.executionSpec.stages.find(item => item.id === stageId)!
  const contract = stage.plan
  if (!contract || !slots.length || slots.length > Math.min(contract.maxSlots, run.maxAgentSlots) || new Set(slots.map(slot => slot.id)).size !== slots.length) {
    throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.INVALID_PLAN_SLOT_VALUE, stageId))
  }
  for (const slot of slots) {
    const agent = contract.agents.find(item => runRefEqual(item.ref, slot.agentRef))
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(slot.id) || !contract.stageIds.includes(slot.stageId) || !agent || new Set(slot.tools).size !== slot.tools.length
      || slot.tools.some(tool => !agent.profile.tools.includes(tool))) {
      throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.INVALID_PLAN_SLOT_VALUE, slot.id))
    }
  }
  return structuredClone(slots)
}

function runApplyPlan(operation: GraphOperation, result: Extract<GraphStageResult, { mode: 'plan' }>): void {
  result.plan.approved = true
  const planner = operation.executionSpec.stages.find(stage => stage.id === result.stageId)!
  for (const stageId of planner.plan?.stageIds ?? []) {
    const target = operation.stages.find(group => group.stageId === stageId)!
    const slots = result.plan.slots.filter(slot => slot.stageId === stageId)
    target.planSlots = structuredClone(slots)
    target.expectedWorkIds = slots.map(slot => workCreateId(operation.id, slot.stageId, slot.id))
    target.closed = target.expectedWorkIds.length === 0
  }
  const group = operation.stages.find(item => item.stageId === result.stageId)!
  group.closed = group.results.length === group.expectedWorkIds.length
}

function runCreateReview(operation: GraphOperation, kind: GraphReview['kind'], now: string): void {
  operation.review = { id: randomUUID(), kind, revision: 0, state: 'pending', decision: null, createdAt: now, answeredAt: null }
  operation.status = 'waiting'
}

function runReadCandidateReferences(
  /* 候选正文中尚未物化为节点身份的 JSON 值。 */ value: JsonValue,
): GraphCandidateRef[] {
  // 读取候选直接引用，供发布闭包和引用解释使用同一解析规则。
  if (Array.isArray(value)) return value.flatMap(runReadCandidateReferences)
  if (!value || typeof value !== 'object') return []
  const candidate = value.candidate
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    && typeof candidate.workId === 'string' && typeof candidate.key === 'string') {
    return [{ workId: candidate.workId, key: candidate.key }]
  }
  return Object.values(value).flatMap(runReadCandidateReferences)
}

function runBuildPublicationPlan(
  /* 已保存候选与冻结发布规则的 Operation；本函数不修改它。 */ operation: GraphOperation,
): { candidates: ReturnType<typeof runReadCandidates>; ports: GraphPublicationPreview['ports']; items: GraphPublicationPreview['items'] } {
  // 合并最终阶段的全部结果并核对引用和端口，预览与正式发布共用这一份集合。
  const resultGroup = operation.stages.find((/* 冻结执行中的阶段结果组。 */ group) =>
    /* 只有结果阶段决定直接入选集合。 */ group.stageId === operation.executionSpec.resultStage)
  if (!resultGroup) throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  const all = runReadCandidates(operation)
  const byKey = new Map(all.map((/* 已接纳的唯一候选。 */ item) =>
    /* 组合键避免不同 Work 的同名候选混淆。 */ [runCandidateKey(item.workId, item.key), item]))
  const selected = resultGroup.results.flatMap((/* 最终阶段某个槽位的已接纳结果。 */ result) => {
    // outputs 全部直接入选；selection 按保存的精确候选身份读取。
    if (result.mode === 'outputs') return all.filter((/* 本 Operation 的候选。 */ item) =>
      /* 只取当前结果所属 Work。 */ item.workId === result.workId)
    if (result.mode === 'selection') return result.selection.map((/* 选择结果保存的候选身份。 */ ref) => {
      // 无法解析的选择不能出现在权威预览或正式发布中。
      const candidate = byKey.get(runCandidateKey(ref.workId, ref.key))
      if (!candidate) throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.PROPOSAL_REFERENCES_AN_UNAVAILABLE_CANDIDATE)
      return candidate
    })
    return []
  })
  const directlySelected = new Set(selected.map((/* 最终阶段直接选择的候选。 */ item) =>
    /* 保留来源标记，同时去重多份选择。 */ runCandidateKey(item.workId, item.key)))
  const includeReferenced = operation.executionSpec.transition.publication?.includeReferencedCandidates === true
  const allowedStages = new Set(operation.executionSpec.transition.publication?.candidateStages ?? [])
  const included = new Map<string, typeof all[number]>()
  const visiting = new Set<string>(), visited = new Set<string>()
  const include = (/* 本次遍历要加入发布集合的候选。 */ item: typeof all[number]): void => {
    // 仅当冻结规则开启闭包时遍历依赖并检查环，保留原发布语义。
    const key = runCandidateKey(item.workId, item.key)
    if (visiting.has(key)) throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.CANDIDATE_REFERENCES_MUST_NOT_CONTAIN_A_CYCLE)
    if (visited.has(key)) return
    visiting.add(key)
    included.set(key, item)
    for (const ref of includeReferenced ? runReadCandidateReferences(item.payload) : []) {
      const referenced = byKey.get(runCandidateKey(ref.workId, ref.key))
      if (!referenced || !allowedStages.has(referenced.stageId)) {
        throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.PROPOSAL_REFERENCES_AN_UNAVAILABLE_CANDIDATE)
      }
      include(referenced)
    }
    visiting.delete(key); visited.add(key)
  }
  for (const item of selected) include(item)
  const candidates = [...included.values()]
  const referencedBy = new Map<string, Map<string, GraphCandidateRef>>()
  for (const item of candidates) {
    const sourceKey = runCandidateKey(item.workId, item.key)
    for (const ref of runReadCandidateReferences(item.payload)) {
      const targetKey = runCandidateKey(ref.workId, ref.key)
      if (!included.has(targetKey)) throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.PROPOSAL_REFERENCES_AN_UNAVAILABLE_CANDIDATE)
      const sources = referencedBy.get(targetKey) ?? new Map<string, GraphCandidateRef>()
      sources.set(sourceKey, { workId: item.workId, key: item.key })
      referencedBy.set(targetKey, sources)
    }
  }
  const ports = operation.executionSpec.transition.ports.output.map((/* 冻结转换的一个输出端口。 */ port) => {
    // 基数按最终去重并补齐引用后的集合计算，包含允许的零输出端口。
    const count = candidates.filter((/* 实际发布的候选。 */ item) => /* 按命名端口汇总。 */ item.port === port.name).length
    if (count < port.count.min || count > port.count.max) throw new GraphError(422, 'OUTPUT_CARDINALITY', messageFormat(RuntimeMessage.OUTPUT_CARDINALITY_VALUE, port.name))
    return { port: port.name, typeRef: structuredClone(port.outputType), count }
  })
  if (candidates.some((/* 实际发布的候选。 */ candidate) =>
    /* 每个候选必须匹配冻结端口的精确类型。 */ !ports.some((/* 已核对数量的输出端口。 */ port) =>
      /* 同时匹配名称与类型版本。 */ port.port === candidate.port && runRefEqual(port.typeRef, candidate.typeRef)))) {
    throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  }
  const items = candidates.map((/* 已去重的发布候选正文。 */ candidate) => {
    // 对外仅投影稳定候选身份及发布原因，不泄漏预留 nodeId 或复制正文。
    const key = runCandidateKey(candidate.workId, candidate.key)
    return { workId: candidate.workId, key: candidate.key, stageId: candidate.stageId, slotId: candidate.slotId,
      port: candidate.port, typeRef: structuredClone(candidate.typeRef), directlySelected: directlySelected.has(key),
      referencedBy: [...(referencedBy.get(key)?.values() ?? [])] }
  })
  return { candidates, ports, items }
}

type RunPublicationPlan = ReturnType<typeof runBuildPublicationPlan>

function runCreatePublicationVersion(
  /* 与审核和候选共用的当前图快照。 */ document: GraphDocument,
  /* 持有本次冻结分支与材料的当前 Run。 */ run: GraphCurrentRun,
  /* 保存当前候选和不可变执行规格的 Operation。 */ operation: GraphOperation,
  /* 尚未回答、其身份与版本已由本次入口核对的审核。 */ review: GraphReview,
  /* 本次已构建的权威发布集合摘要。 */ items: GraphPublicationPreview['items'],
): string {
  // 从同一份已验上下文和发布集合计算版本，不重新读取输入或构建计划。
  return definitionsDigest({
    mapId: document.id, runId: run.id, operationId: operation.id, reviewId: review.id, reviewRevision: review.revision,
    executionSpec: operation.executionSpec, group: operation.group, branch: run.branchState,
    stages: operation.stages, items,
    libraryClaims: run.libraryClaimSets?.find((/* Run 已冻结的各步骤材料。 */ set) =>
      /* 只绑定当前 Operation 使用的固定材料。 */ set.stepId === operation.stepId) ?? null,
  })
}

export function runReadPublicationPreview(
  /* 当前存储图的只读快照，查询不改变候选、审核、收据或授权。 */ document: GraphDocument,
  /* 已在公共边界校验的待结果审核身份与版本。 */ input: Extract<GraphQuery, { method: 'run.publication.preview' }>['params'],
): GraphPublicationPreview {
  // 核对当前待结果审核，投影同一发布计划并计算与无关图变化无关的内容版本。
  const run = runReadExecution(document, input.runId), operation = runReadOperation(run, input.operationId), review = operation.review
  if (!review || operation.status !== 'waiting' || review.kind !== 'result' || review.state !== 'pending'
    || review.id !== input.reviewId || review.revision !== input.expectedReviewRevision) {
    throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
  }
  runValidateInputs(document, run, operation)
  const plan = runBuildPublicationPlan(operation)
  const publicationVersion = runCreatePublicationVersion(document, run, operation, review, plan.items)
  return { mapId: document.id, runId: run.id, operationId: operation.id, reviewId: review.id, reviewRevision: review.revision,
    specHash: operation.specHash, publicationVersion, ports: plan.ports, items: plan.items }
}

function runCreateOutputs(
  /* 本次正式发布会写入的事务图草稿。 */ document: GraphDocument,
  /* 当前执行及审核状态已允许发布且具备分支证明的 Run。 */ run: GraphCurrentRun,
  /* 保存所有合法候选和冻结输出边界的Operation。 */ operation: GraphOperation,
  /* 本次接纳或审核已构建的完整发布计划。 */ plan: RunPublicationPlan,
  /* 同一提案已物化并完整解析的输出；历史候选与后续审核不在此集合。 */ validated: ReadonlyMap<string, RunValidatedOutput>,
  /* 本次正式发布统一使用的ISO时间。 */ now: string,
): RunPublicationResult {
  // 发布已接受的候选节点和实际后继边，保留产物使用理由及可信producer身份。
  const { candidates } = plan
  const ids = new Map(candidates.map((/* 本次权威计划内的正式发布候选。 */ candidate) => /* 复用服务端候选身份，历史未分配身份的候选在本次分配。 */ [runCandidateKey(candidate.workId, candidate.key), candidate.nodeId ?? randomUUID()]))
  const publishedNodes: ParsedGraphNode[] = candidates.map((/* 本次正式发布的已接纳候选。 */ candidate) => {
    // 重映射候选引用后完整解析一次，节点和真实引用共同交给后续提交检查。
    const accepted = validated.get(runCandidateKey(candidate.workId, candidate.key))
    const parsed = accepted ? accepted.parsed
      : graphParseNodePayload(run.definitions, candidate.typeRef, runResolveCandidateRefs(candidate.payload, ids))
    const selected = runReadStageAgent(operation, candidate.stageId, candidate.slotId)
    const node: GraphNode = {
      id: accepted ? accepted.nodeId : ids.get(runCandidateKey(candidate.workId, candidate.key))!,
      revision: 0,
      typeId: candidate.typeRef.id,
      typeVersion: candidate.typeRef.version,
      payload: parsed.payload,
      payloadReferences: parsed.payloadReferences,
      ...(candidate.libraryClaimRefs === undefined ? {} : { libraryClaimRefs: structuredClone(candidate.libraryClaimRefs) }),
      createdAt: now,
      updatedAt: now,
      producer: {
        operationId: operation.id,
        transitionRef: structuredClone(operation.transitionRef),
        stageId: candidate.stageId,
        workId: candidate.workId,
        agentRef: structuredClone(selected.agent.ref),
        agentName: selected.agent.profile.name,
      },
    }
    return { node, references: parsed.references }
  })
  const nodes = publishedNodes.map((/* 已完整解析的正式节点与引用。 */ parsed) => /* 图状态保存该份已验节点。 */ parsed.node)
  const allowedReferenceTargets = new Set([...run.branchState.scope.nodeIds, ...nodes.map((/* 本次正式发布的完整节点。 */ node) => /* 返回正式节点身份。 */ node.id)])
  if (nodes.some((/* 本次准备发布的一个节点。 */ node) => /* 节点引用不能越过当前分支或本次新节点集合。 */ (node.payloadReferences ?? []).some((/* 从已验正文派生的节点引用。 */ reference) => /* 拒绝分支之外的引用目标。 */ !allowedReferenceTargets.has(reference.targetId)))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.GRAPH_CHANGE_AFFECTS_DATA_OUTSIDE_THE_ACQUIRED_BRANCH)
  }
  const nodeByCandidate = new Map(candidates.map((/* 发布计划中的一项候选。 */ candidate, /* 与已物化节点数组相同的位置。 */ index) => /* 配对候选组合身份与正式节点。 */ [runCandidateKey(candidate.workId, candidate.key), nodes[index]]))
  const availableNodes = new Map([...document.nodes, ...nodes].map((/* 当前图或本次准备新增的完整节点。 */ node) => /* 为引用闭包验证建立真实目标索引。 */ [node.id, node]))
  for (const parsed of publishedNodes) {
    for (const reference of parsed.references) {
      if (reference.definition.target.kind !== 'node') continue
      const target = availableNodes.get(reference.value)
      if (!target || !reference.definition.target.types.some((/* 引用声明允许的精确节点类型。 */ type) =>
        /* 真实目标必须具有同一不可变类型版本。 */ type.id === target.typeId && type.version === target.typeVersion)) {
        throw new GraphError(422, 'INVALID_OUTPUT_REFERENCE', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, reference.definition.path))
      }
    }
  }
  const edges = candidates.flatMap((/* 本次正式发布且已物化的候选。 */ candidate) => {
    // 按冻结输出锚点为该节点建立实际后继边。
    const node = nodeByCandidate.get(runCandidateKey(candidate.workId, candidate.key))!
    const output = operation.executionSpec.transition.ports.output.find((/* 冻结转换的一个输出端口。 */ port) => /* 使用候选已核对的同名端口规则。 */ port.name === candidate.port)!
    return output.successorOf.flatMap((/* 当前输出声明的一个输入或输出锚点。 */ anchor) => {
      // sourceKeys选择合法父节点；未提供时使用声明锚点的全部父节点。
      const parents = anchor.source === 'input'
        ? operation.group.inputRefs.filter((/* 已冻结的一个输入引用。 */ ref) => /* 限制到声明端口和候选选定的来源。 */ ref.port === anchor.port && (!candidate.sourceKeys || candidate.sourceKeys.includes(ref.key))).map((/* 获准使用的输入锚点。 */ ref) => /* 返回真实输入节点身份。 */ ref.id)
        : candidates.filter((/* 同批发布的一个候选父节点。 */ item) => /* 仅使用声明输出端口和已选择的候选来源。 */ item.port === anchor.port && (!candidate.sourceKeys || candidate.sourceKeys.includes(`${item.workId}:${item.key}`)))
          .map((/* 获准充当父节点的同批候选。 */ item) => {
            // 父候选必须已经物化为本次正式发布节点。
            const parent = nodeByCandidate.get(runCandidateKey(item.workId, item.key))
            if (!parent) throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
            return parent.id
          })
      return parents.map((/* 已核对的真实父节点身份。 */ parent) => /* 为每项父子关系分配独立后继边身份。 */ ({ id: randomUUID(), revision: 0, kind: 'successor' as const, from: parent, to: node.id,
        label: `${operation.transitionRef.id}@${operation.transitionRef.version}:${candidate.port}`, createdAt: now, updatedAt: now }))
    })
  })
  const branch = run.branchState
  const nextBranch = branchReadSnapshot({ ...document, nodes: [...document.nodes, ...nodes], edges: [...document.edges, ...edges] }, branch.scope.rootIds)
  if (nodes.some((/* 本次准备新增的正式节点。 */ node) => /* 所有新节点都必须从当前授权分支根可达。 */ !nextBranch.scope.nodeIds.includes(node.id))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.NEW_DATA_MUST_BE_REACHABLE_FROM_THE_AUTHORIZED_BRANCH)
  }
  document.nodes.push(...nodes)
  document.edges.push(...edges)
  operation.outputRefs = candidates.map((/* 已完成正式物化的发布候选。 */ candidate) => /* 保存正式节点与端口及原Work候选身份。 */ ({
    id: nodeByCandidate.get(runCandidateKey(candidate.workId, candidate.key))!.id,
    revision: 0,
    port: candidate.port,
    workId: candidate.workId,
    key: candidate.key,
  }))
  operation.status = 'completed'
  run.branchState = { scope: nextBranch.scope, version: nextBranch.version }
  return { nodeIds: nodes.map((/* 本次正式发布的完整节点。 */ node) => /* 返回正式节点身份。 */ node.id), edgeIds: edges.map((/* 已写入图草稿的正式后继边。 */ edge) => /* 返回本次建立的边身份。 */ edge.id), publishedNodes }
}

function runFinishResult(
  /* 本次接纳结果使用的独立图草稿。 */ document: GraphDocument,
  /* 已通过执行入口核对、持有当前分支证明的运行。 */ run: GraphCurrentRun,
  /* 结果阶段已经结束的 Operation。 */ operation: GraphOperation,
  /* 本次新接纳提案已完整解析的输出，未跨越异步或持久化边界。 */ validated: ReadonlyMap<string, RunValidatedOutput>,
  /* 本次审核或正式发布共用的 ISO 时间。 */ now: string,
): RunPublicationResult {
  // 按冻结审核策略等待结果确认，或使用当前分支证明直接发布正式产物。
  if (operation.executionSpec.review.mode === 'required' && run.mode === 'human-in-loop') {
    if (!operation.review || operation.review.state === 'answered' || operation.review.kind !== 'result') runCreateReview(operation, 'result', now)
    return { nodeIds: [], edgeIds: [], publishedNodes: [] }
  }
  return runCreateOutputs(document, run, operation, runBuildPublicationPlan(operation), validated, now)
}

export function runUpdateProposal(
  /* 接纳候选和推进运行状态的事务图草稿。 */ document: GraphDocument,
  /* 已通过公开边界解析的当前阶段提案。 */ proposal: GraphDataProposal,
  /* 当前获权Work的真实阶段、槽位和规格身份。 */ work: Pick<GraphWork, 'runId' | 'workId' | 'operationId' | 'stageId' | 'slotId' | 'specHash'>,
  /* 本次接纳与可能正式发布的统一ISO时间。 */ now: string,
): RunPublicationResult & { document: GraphDocument } {
  // 核对Work授权后接纳合法提案，随后按审核和有限计划规则正式发布或继续执行。
  const run = runReadExecution(document, work.runId), operation = runReadOperation(run, proposal.operationId)
  if (run.paused || operation.status !== 'running' || work.operationId !== operation.id || work.specHash !== operation.specHash
    || proposal.specHash !== operation.specHash || proposal.id !== work.workId) {
    throw new GraphError(409, 'PROPOSAL_CONFLICT', RuntimeMessage.PROPOSAL_DOES_NOT_BELONG_TO_THIS_WORK_GRANT)
  }
  runValidateInputs(document, run, operation)
  const group = operation.stages.find((/* 获权Operation中的阶段组。 */ item) => /* 找到当前Work的阶段结果容器。 */ item.stageId === work.stageId)
  const stage = operation.executionSpec.stages.find((/* 当前Operation的冻结阶段声明。 */ item) => /* 取得当前Work的输出合同。 */ item.id === work.stageId)
  if (!group || !stage || stage.outputContract.mode !== proposal.kind || !group.expectedWorkIds.includes(work.workId)
    || !stage.dependsOn.every((/* 当前阶段声明的依赖身份。 */ id) => /* 提案只能在全部依赖封闭后接纳。 */ operation.stages.some((/* 当前Operation的一个阶段组。 */ item) => /* 同一依赖必须已经封闭。 */ item.stageId === id && item.closed))) {
    throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  }
  if (group.results.some((/* 当前阶段已保存的一份结果。 */ result) => /* 每个Work只接纳一次结果。 */ result.workId === work.workId)) throw new GraphError(409, 'RESULT_EXISTS', RuntimeMessage.STAGE_RESULT_WAS_ALREADY_ACCEPTED)
  let result: GraphStageResult
  let validated = new Map<string, RunValidatedOutput>()
  if (proposal.kind === 'outputs') {
    const outputs = proposal.outputs.map((/* 模型已通过HTTP边界或直接Graph协议提交的候选。 */ output) => {
      // 候选本次独占副本保存经过校验的使用元信息，正式节点身份仍由服务端生成。
      return { ...structuredClone(output), nodeId: randomUUID(), ...(output.libraryClaimRefs === undefined ? {} : {
        libraryClaimRefs: graphInputReadLibraryUseRefs(output.libraryClaimRefs, `outputs.${output.key}.libraryClaimRefs`),
      }) }
    })
    validated = runValidateStageOutputs(run, operation, stage, work.workId, outputs)
    result = { workId: work.workId, stageId: work.stageId, slotId: work.slotId, acceptedAt: now,
      reason: proposal.reason, mode: 'outputs', outputs }
  } else if (proposal.kind === 'selection') {
    runValidateSelection(operation, work.stageId, proposal)
    result = { workId: work.workId, stageId: work.stageId, slotId: work.slotId, acceptedAt: now,
      reason: proposal.reason, mode: 'selection', selection: structuredClone(proposal.selection) }
  } else {
    const slots = runValidatePlanSlots(run, operation, work.stageId, proposal.slots)
    result = { workId: work.workId, stageId: work.stageId, slotId: work.slotId, acceptedAt: now,
      reason: proposal.reason, mode: 'plan', plan: { revision: 1, reason: proposal.reason, slots, approved: run.mode === 'auto' } }
  }
  group.results.push(result)
  let published: RunPublicationResult = { nodeIds: [], edgeIds: [], publishedNodes: [] }
  if (result.mode === 'plan') {
    if (run.mode === 'human-in-loop') runCreateReview(operation, 'plan', now)
    else runApplyPlan(operation, result)
  } else {
    group.closed = group.results.length === group.expectedWorkIds.length
    if (group.closed && group.stageId === operation.executionSpec.resultStage) published = runFinishResult(document, run, operation, validated, now)
  }
  runUpdateProgress(document, run, now)
  return { document, ...published }
}

function runFreezeLibraryClaimSets(
  /* 本Run已验证的有限步骤计划。 */ plan: GraphRun['plan'],
  /* app在本次授权事务中冻结的完整步骤材料。 */ supplied: readonly GraphLibraryClaimSet[] | undefined,
  /* 当前目标图所属工作区，跨工作区材料不得进入Run。 */ workspaceId: string,
): GraphLibraryClaimSet[] {
  // 将plan的精确引用与完整材料一一绑定，并把全文仅复制到每步一次。
  const sets = new Map<string, GraphLibraryClaimSet>()
  for (const set of supplied ?? []) {
    if (sets.has(set.stepId) || !plan.steps.some((/* 本Run合法步骤。 */ step) => /* 不接纳计划之外的冻结集合。 */ step.id === set.stepId)) {
      throw new GraphError(422, 'EVIDENCE_NOT_AUTHORIZED', EvidenceMessage.NOT_AUTHORIZED)
    }
    sets.set(set.stepId, set)
  }
  const result: GraphLibraryClaimSet[] = []
  let totalBytes = 0
  for (const step of plan.steps) {
    const refs = step.libraryClaimRefs ?? []
    const claims: EvidenceFrozenClaim[] = sets.get(step.id)?.claims ?? []
    if (!refs.length && !claims.length) continue
    if (refs.length !== claims.length || new Set(claims.map((/* app冻结的单份材料。 */ claim) => /* 条目身份不能重复。 */ claim.ref.entryId)).size !== claims.length) {
      throw new GraphError(422, 'EVIDENCE_NOT_AUTHORIZED', EvidenceMessage.NOT_AUTHORIZED)
    }
    for (const claim of claims) {
      const selected = refs.find((/* 步骤明确选定的精确引用。 */ ref) => /* 只接受当前集合中声明的条目。 */ ref.entryId === claim.ref.entryId)
      if (!selected) throw new GraphError(422, 'EVIDENCE_NOT_AUTHORIZED', EvidenceMessage.NOT_AUTHORIZED)
      if (selected.contentDigest !== claim.ref.contentDigest || claim.entry.id !== claim.ref.entryId || claim.entry.contentDigest !== claim.ref.contentDigest) {
        throw new GraphError(422, 'EVIDENCE_DIGEST_MISMATCH', EvidenceMessage.DIGEST_MISMATCH)
      }
      if (!/^[a-f0-9]{64}$/.test(claim.snapshotDigest) || claim.snapshotDigest !== definitionsDigest({ ref: claim.ref, entry: claim.entry, definition: claim.definition })) {
        throw new GraphError(422, 'EVIDENCE_DIGEST_MISMATCH', EvidenceMessage.DIGEST_MISMATCH)
      }
      if (claim.entry.workspaceId !== workspaceId) throw new GraphError(422, 'EVIDENCE_WORKSPACE_MISMATCH', EvidenceMessage.WORKSPACE_MISMATCH)
    }
    const bytes = Buffer.byteLength(JSON.stringify(claims))
    totalBytes += bytes
    if (bytes > 1024 * 1024 || totalBytes > 4 * 1024 * 1024) throw new GraphError(413, 'EVIDENCE_INPUT_LIMIT', EvidenceMessage.INPUT_LIMIT)
    result.push({ stepId: step.id, claims: structuredClone(claims).sort((/* 左侧固定材料。 */ left, /* 右侧固定材料。 */ right) =>
      /* 材料集合不受UI选择顺序影响。 */ left.ref.entryId.localeCompare(right.ref.entryId) || left.ref.contentDigest.localeCompare(right.ref.contentDigest)) })
  }
  return result
}

export function runCreateRun(
  /* 已持有分支写授权的当前图事务草稿。 */ document: GraphDocument,
  /* 用户显式选定的本图范围、步骤和库refs。 */ input: Extract<GraphCommand, { method: 'run.start' }>['params'],
  /* app同事务冻结的配置目录、Agent与完整库材料。 */ context: GraphRunStartContext,
  /* Run建立和首次Operation推进使用的统一ISO时间。 */ now: string,
): GraphDocument {
  // 绑定有限步骤、分支范围和预算，完整材料每步保存一次，再实例化或复用合法Operation。
  if (!Number.isSafeInteger(context.maxSlots) || context.maxSlots < 1 || context.maxSlots > 32) {
    throw new GraphError(422, 'INVALID_CONFIGURATION', RuntimeMessage.MAXAGENTSLOTS_MUST_BE_BETWEEN_1_AND_32)
  }
  if (document.runs.some(run => run.id === input.id) || document.runHistory.some(run => run.id === input.id)) {
    throw new GraphError(409, 'RUN_ID_REUSED', RuntimeMessage.USE_A_NEW_RUN_ID)
  }
  const terminal = document.runs.filter(run => !['running', 'waiting'].includes(run.status))
  document.runHistory.push(...terminal)
  document.runs = document.runs.filter(run => ['running', 'waiting'].includes(run.status))
  if (!input.scope.nodeIds.length || new Set(input.scope.nodeIds).size !== input.scope.nodeIds.length) throw new GraphError(422, 'INVALID_SCOPE', RuntimeMessage.CHOOSE_UNIQUE_SCOPE_NODES)
  for (const id of input.scope.nodeIds) if (!document.nodes.some(node => node.id === id)) throw new GraphError(422, 'INVALID_SCOPE', messageFormat(RuntimeMessage.SCOPE_NODE_IS_MISSING_VALUE, id))
  const branch = branchReadSnapshot(document, input.branch.rootIds)
  if (branch.version !== input.branch.expectedVersion || input.scope.nodeIds.some(id => !branch.scope.nodeIds.includes(id))) {
    throw new GraphError(409, 'BRANCH_VERSION_CONFLICT', RuntimeMessage.BRANCH_VERSION_CHANGED)
  }
  runValidatePlan(input.plan, input.scope.nodeIds, context.definitions)
  const libraryClaimSets = runFreezeLibraryClaimSets(input.plan, context.libraryClaimSets, document.workspaceId)
  const run: GraphCurrentRun = {
    id: input.id,
    scope: structuredClone(input.scope),
    branchState: { scope: structuredClone(branch.scope), version: branch.version },
    plan: structuredClone(input.plan),
    definitions: structuredClone(context.definitions),
    agents: structuredClone(context.agents),
    tools: structuredClone(context.tools),
    ...(libraryClaimSets.length ? { libraryClaimSets } : {}),
    maxAgentSlots: context.maxSlots,
    paused: false,
    regenerate: input.regenerate === true,
    mode: input.mode,
    status: 'running',
    steps: input.plan.steps.map(step => ({ stepId: step.id, status: 'pending', operationIds: [] })),
    operations: [],
    createdAt: now,
    updatedAt: now,
  }
  document.runs.push(run)
  runUpdateProgress(document, run, now)
  return document
}

export function runCancelRun(document: GraphDocument, runId: string, now: string): GraphDocument {
  const run = runReadExecution(document, runId)
  run.status = 'cancelled'
  for (const operation of run.operations) if (['running', 'waiting'].includes(operation.status)) operation.status = 'cancelled'
  run.updatedAt = now; document.updatedAt = now
  return document
}

export function runUpdatePause(
  /* 本次暂停或恢复独占的事务图草稿。 */ document: GraphDocument,
  /* 已获权操作的Run身份。 */ runId: string,
  /* true暂停派发，false恢复派发。 */ paused: boolean,
  /* 本次状态变更统一使用的ISO时间。 */ now: string,
): GraphDocument {
  // 同一Run分支只核对一次，再逐Operation核对不同的冻结输入和规格。
  const run = runReadExecution(document, runId)
  runValidateBranch(document, run)
  for (const operation of run.operations) runReadOperationInputs(document, operation)
  run.paused = paused
  runUpdateProgress(document, run, now)
  return document
}

export function runAnswerReview(
  /* 当前命令独占且尚未提交的图草稿。 */ document: GraphDocument,
  /* 已鉴权的审核身份、决定及可选发布内容条件。 */ input: Extract<GraphCommand, { method: 'review.answer' }>['params'],
  /* 本次审核与发布共用的 ISO 时间。 */ now: string,
): RunPublicationResult & { document: GraphDocument } {
  // 在改变审核状态前核对输入及新结果批准的预览版本，然后沿原流程发布或拒绝。
  const run = runReadExecution(document, input.runId), operation = runReadOperation(run, input.operationId), review = operation.review
  if (!review || review.id !== input.reviewId || review.state !== 'pending'
    || review.revision !== input.expectedReviewRevision) throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
  runValidateInputs(document, run, operation)
  let result: RunPublicationResult = { nodeIds: [], edgeIds: [], publishedNodes: [] }
  if (input.decision === 'reject') operation.status = 'failed'
  else if (review.kind === 'plan') {
    const pending = operation.stages.flatMap(group => group.results).find(item => item.mode === 'plan' && !item.plan.approved)
    if (!pending || pending.mode !== 'plan') throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
    runApplyPlan(operation, pending); operation.status = 'running'
  } else {
    if (input.expectedPublicationVersion !== undefined && operation.status !== 'waiting') {
      throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
    }
    const plan = runBuildPublicationPlan(operation)
    if (input.expectedPublicationVersion !== undefined
      && runCreatePublicationVersion(document, run, operation, review, plan.items) !== input.expectedPublicationVersion) {
      throw new GraphError(409, 'PUBLICATION_PREVIEW_CONFLICT', RuntimeMessage.PUBLICATION_PREVIEW_CHANGED)
    }
    operation.status = 'running'
    result = runCreateOutputs(document, run, operation, plan, new Map(), now)
  }
  review.state = 'answered'; review.decision = input.decision; review.answeredAt = now; review.revision++
  runUpdateProgress(document, run, now)
  return { document, ...result }
}
