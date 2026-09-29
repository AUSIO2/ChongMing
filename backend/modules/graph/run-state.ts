// 推进通用转换的封闭输入组、冻结 Agent 阶段、候选结果、审核与正式发布。
import { randomUUID } from 'node:crypto'
import type {
  DataInstanceRef,
  DefinitionCatalog,
  DefinitionRef,
  ExecutionAgentDefinition,
  ExecutionSpec,
  JsonValue,
} from '../../../contracts/data-definition'
import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type {
  GraphCommand,
  GraphCandidateRef,
  GraphDataProposal,
  GraphDataRead,
  GraphNode,
  GraphOperation,
  GraphOperationGroup,
  GraphPayload,
  GraphPlanSlot,
  GraphPortDataRef,
  GraphProposedOutput,
  GraphReview,
  GraphRun,
  GraphRunStep,
  GraphStageGroup,
  GraphStageResult,
  GraphWork,
} from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import {
  definitionsFreezeExecution,
  definitionsReadTransition,
  definitionsValidatePayload,
} from '../shared/data-definition'
import type { GraphDocument } from './graph-record'
import { workCreateId } from './work-state'
import { graphReadPayloadReferenceIndex } from '../shared/data-reference-index'
import { branchReadSnapshot } from './branch-state'

export interface GraphRunStartContext {
  definitions: DefinitionCatalog
  agents: ExecutionAgentDefinition[]
  tools: Array<{ name: string; description: string }>
  maxSlots: number
}

function runRefEqual(a: DefinitionRef, b: DefinitionRef): boolean {
  return a.id === b.id && a.version === b.version
}

export function runReadRun(document: GraphDocument, runId: string): GraphRun {
  const run = document.runs.find(item => item.id === runId)
  if (!run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.RUN_NOT_FOUND)
  if (!Array.isArray(run.operations) || !Array.isArray(run.steps) || !run.plan) {
    throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', RuntimeMessage.USE_THE_EXPLICIT_NODE_RUN_MIGRATION)
  }
  if (['running', 'waiting'].includes(run.status) && !run.branchState) {
    throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', RuntimeMessage.USE_THE_EXPLICIT_NODE_RUN_MIGRATION)
  }
  return run
}

function runReadExecution(document: GraphDocument, runId: string): GraphRun {
  const run = runReadRun(document, runId)
  if (!['running', 'waiting'].includes(run.status)) throw new GraphError(409, 'RUN_NOT_ACTIVE', RuntimeMessage.RUN_IS_TERMINAL)
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

function runValidateInputs(document: GraphDocument, run: GraphRun, operation: GraphOperation): void {
  const branch = run.branchState
  if (!branch || branchReadSnapshot(document, branch.scope.rootIds).version !== branch.version) {
    throw new GraphError(409, 'INPUT_STALE', RuntimeMessage.RUN_BRANCH_CHANGED_AFTER_START)
  }
  for (const ref of [...operation.group.inputRefs, ...operation.group.contextRefs]) runReadNode(document, ref)
  if (!operation.group.sealed || operation.specHash !== operation.executionSpec.specHash) {
    throw new GraphError(409, 'EXECUTION_SPEC_CONFLICT', RuntimeMessage.EXECUTION_SPEC_DOES_NOT_MATCH_OPERATION)
  }
}

function runValidatePlan(plan: GraphRun['plan'], scope: string[], catalog: DefinitionCatalog): void {
  if (!plan.steps.length || plan.steps.length > 64) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, 'step count'))
  const byId = new Map(plan.steps.map(step => [step.id, step]))
  if (byId.size !== plan.steps.length) throw new GraphError(422, 'INVALID_PLAN', messageFormat(RuntimeMessage.RUN_PLAN_INVALID_VALUE, 'duplicate step id'))
  const scopeIds = new Set(scope)
  for (const step of plan.steps) {
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

function runCreateOperation(run: GraphRun, step: GraphRunStep, group: GraphOperationGroup): GraphOperation {
  const groupRefs = (refs: GraphPortDataRef[]): Record<string, GraphPortDataRef[]> => refs.reduce<Record<string, GraphPortDataRef[]>>((result, ref) => {
    (result[ref.port] ??= []).push(ref)
    return result
  }, {})
  const inputs = groupRefs(group.inputRefs)
  const context = groupRefs(group.contextRefs)
  const toInstances = (refs: GraphPortDataRef[] | undefined): DataInstanceRef[] => (refs ?? []).map(ref => ({
    id: ref.id,
    revision: ref.revision,
    type: structuredClone(ref.type),
  }))
  const spec = definitionsFreezeExecution({
    catalog: run.definitions,
    transitionRef: step.transitionRef,
    agents: run.agents,
    tools: run.tools,
    inputs: Object.fromEntries(Object.entries(inputs).map(([port, refs]) => [port, toInstances(refs)])),
    context: Object.fromEntries(Object.entries(context).map(([port, refs]) => [port, toInstances(refs)])),
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

function runCreateGroups(document: GraphDocument, run: GraphRun, step: GraphRunStep): GraphOperationGroup[] {
  const inputNodes = Object.fromEntries(step.input.map(binding => [binding.port, runReadBindingNodes(document, run, binding)]))
  const contextRefs = step.context.flatMap(binding => runCreatePortRefs(binding.port, runReadBindingNodes(document, run, binding)))
  if (step.grouping.mode === 'all') return [{
    id: `${step.id}:all`,
    inputRefs: step.input.flatMap(binding => runCreatePortRefs(binding.port, inputNodes[binding.port])),
    contextRefs,
    sealed: true,
  }]
  if (step.grouping.mode === 'each') {
    const binding = step.input[0]
    return inputNodes[binding.port].map(node => ({
      id: `${step.id}:${node.id}`,
      inputRefs: runCreatePortRefs(binding.port, [node]),
      contextRefs: structuredClone(contextRefs),
      sealed: true,
    }))
  }
  const available = new Map(step.input.map(binding => [binding.port,
    new Map(inputNodes[binding.port].map(node => [node.id, node]))]))
  return step.grouping.groups.map(group => ({
    id: group.id,
    inputRefs: step.input.flatMap(binding => (group.members[binding.port] ?? []).map(id => {
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

function runReadPointer(value: JsonValue, pointer?: string): JsonValue | undefined {
  if (!pointer || pointer === '/') return value
  let current: JsonValue | undefined = value
  for (const part of pointer.split('/').slice(1).map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = current[part]
  }
  return current
}

function runProjectPayload(node: GraphNode, spec: ExecutionSpec): GraphPayload {
  const definition = spec.dataTypes.find(type => type.id === node.typeId && type.version === node.typeVersion)
  if (!definition) throw new GraphError(409, 'EXECUTION_SPEC_CONFLICT', RuntimeMessage.EXECUTION_SPEC_DOES_NOT_MATCH_OPERATION)
  const output: GraphPayload = {}
  for (const pointer of definition.agentProjection.include) {
    const parts = pointer.split('/').slice(1).map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))
    if (!parts.length) continue
    const value = runReadPointer(node.payload, pointer)
    if (value === undefined) continue
    let target: Record<string, JsonValue> = output
    for (const part of parts.slice(0, -1)) {
      const prior = target[part]
      const next: Record<string, JsonValue> = prior && typeof prior === 'object' && !Array.isArray(prior) ? prior : {}
      if (prior === undefined) target[part] = next
      target = next
    }
    target[parts[parts.length - 1]] = structuredClone(value)
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

function runFormatBinding(values: JsonValue[], format: 'text' | 'json' | 'text-lines'): string {
  if (format === 'json') return JSON.stringify(values.length === 1 ? values[0] : values)
  const render = (value: JsonValue) => typeof value === 'string' ? value : JSON.stringify(value)
  return values.map(render).join(format === 'text-lines' ? '\n' : '\n\n')
}

function runCreatePromptVariables(
  operation: GraphOperation,
  stageId: string,
  slotId: string,
  inputs: GraphDataRead['inputs'],
  context: GraphDataRead['context'],
  sourceText: Record<string, string>,
): Record<string, string> {
  const stage = operation.executionSpec.stages.find(item => item.id === stageId)!
  const variables: Record<string, string> = {}
  for (const [name, binding] of Object.entries(stage.promptBindings)) {
    if (binding.source === 'source-text') {
      if (sourceText[name] !== undefined) variables[name] = sourceText[name]
      continue
    }
    if (binding.source === 'stage') {
      const group = operation.stages.find(item => item.stageId === binding.stageId)
      const plannedSlot = group?.results.flatMap(result => result.mode === 'plan' ? result.plan.slots : []).find(slot => slot.id === slotId)
      const value = plannedSlot ?? group?.results ?? []
      variables[name] = runFormatBinding([structuredClone(value) as unknown as JsonValue], binding.format)
      continue
    }
    if (binding.source === 'agents') {
      variables[name] = JSON.stringify(stage.plan?.agents.map(agent => ({ id: agent.ref.id, version: agent.ref.version,
        name: agent.profile.name, description: agent.profile.description, tools: agent.profile.tools })) ?? [])
      continue
    }
    const items = (binding.source === 'input' ? inputs : context)[binding.port] ?? []
    const values = items.flatMap(item => {
      const value = runReadPointer(item.node.payload, binding.path)
      return value === undefined ? [] : [value]
    })
    if (binding.required && !values.length) throw new GraphError(409, 'PROMPT_INPUT_MISSING', messageFormat(RuntimeMessage.PROMPT_VARIABLE_IS_NOT_AVAILABLE_FOR_THIS_KIND, name))
    variables[name] = runFormatBinding(values, binding.format)
  }
  return variables
}

export function runReadData(
  document: GraphDocument,
  operationId: string,
  work: Pick<GraphWork, 'runId' | 'workId' | 'stageId' | 'slotId' | 'specHash'>,
  sourceText: Record<string, string> = {},
): Omit<GraphDataRead, 'work'> {
  const run = runReadExecution(document, work.runId), operation = runReadOperation(run, operationId)
  runValidateInputs(document, run, operation)
  if (operation.status !== 'running' || operation.specHash !== work.specHash) throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.OPERATION_IS_NOT_EXECUTABLE)
  const group = operation.stages.find(item => item.stageId === work.stageId)
  const stage = operation.executionSpec.stages.find(item => item.id === work.stageId)
  if (!group || !stage || !group.expectedWorkIds.includes(work.workId) || group.results.some(result => result.workId === work.workId)
    || !stage.dependsOn.every(id => operation.stages.some(item => item.stageId === id && item.closed))) {
    throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.STAGE_WORK_IS_NOT_READY)
  }
  const groupNodes = (refs: GraphPortDataRef[]): GraphDataRead['inputs'] => refs.reduce<GraphDataRead['inputs']>((result, ref) => {
    const node = runReadNode(document, ref)
    ;(result[ref.port] ??= []).push({ key: ref.key, node: { ...structuredClone(node), payload: runProjectPayload(node, operation.executionSpec) } })
    return result
  }, {})
  const inputs = groupNodes(operation.group.inputRefs)
  const context = groupNodes(operation.group.contextRefs)
  const selected = runReadStageAgent(operation, work.stageId, work.slotId)
  const priorStageResults = stage.dependsOn.flatMap(id => operation.stages.find(item => item.stageId === id)?.results ?? [])
  return {
    mapId: document.id,
    runId: run.id,
    operationId,
    transitionRef: structuredClone(operation.transitionRef),
    specHash: operation.specHash,
    inputs,
    context,
    priorStageResults: structuredClone(priorStageResults),
    promptVariables: runCreatePromptVariables(operation, work.stageId, work.slotId, inputs, context, sourceText),
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

function runReadPathValues(value: JsonValue, pointer: string): JsonValue[] {
  const parts = pointer.split('/').slice(1).map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'))
  let values: JsonValue[] = [value]
  for (const part of parts) values = values.flatMap(item => {
    if (part === '*') return Array.isArray(item) ? item : item && typeof item === 'object' ? Object.values(item) : []
    if (!item || typeof item !== 'object' || Array.isArray(item) || !(part in item)) return []
    return [item[part]]
  })
  return values
}

function runValidateStageOutputs(run: GraphRun, operation: GraphOperation, stageId: string, workId: string, outputs: GraphProposedOutput[]): void {
  const stage = operation.executionSpec.stages.find(item => item.id === stageId)!
  if (new Set(outputs.map(output => output.key)).size !== outputs.length) throw new GraphError(422, 'INVALID_OUTPUT', messageFormat(RuntimeMessage.DUPLICATE_VALUE, 'output key'))
  for (const contract of stage.outputContract.ports) {
    const items = outputs.filter(output => output.port === contract.port)
    if (items.length < contract.count.min || items.length > contract.count.max) throw new GraphError(422, 'OUTPUT_CARDINALITY', messageFormat(RuntimeMessage.OUTPUT_CARDINALITY_VALUE, contract.port))
    for (const output of items) {
      if (!runRefEqual(output.typeRef, contract.type)) throw new GraphError(422, 'INVALID_OUTPUT', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, output.key))
      if (output.sourceKeys) {
        const candidates = runReadCandidates(operation)
        const allowed = new Set(contract.successorOf.flatMap(anchor => anchor.source === 'input'
          ? operation.group.inputRefs.filter(ref => ref.port === anchor.port).map(ref => ref.key)
          : candidates.filter(candidate => candidate.port === anchor.port).map(candidate => `${candidate.workId}:${candidate.key}`)))
        if (!output.sourceKeys.length || new Set(output.sourceKeys).size !== output.sourceKeys.length || output.sourceKeys.some(key => !allowed.has(key))) {
          throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
        }
      }
      const candidateIds = new Map(runReadCandidates(operation).map(candidate => [runCandidateKey(candidate.workId, candidate.key), candidate.nodeId!]))
      for (const candidate of outputs) candidateIds.set(runCandidateKey(workId, candidate.key), candidate.nodeId!)
      const candidatePaths: string[] = []
      const scan = (value: JsonValue, path = '') => {
        if (Array.isArray(value)) { value.forEach((item, index) => scan(item, `${path}/${index}`)); return }
        if (!value || typeof value !== 'object') return
        const candidate = value.candidate
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          && typeof candidate.workId === 'string' && typeof candidate.key === 'string') {
          candidatePaths.push(path)
        } else for (const [key, item] of Object.entries(value)) scan(item, `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`)
      }
      scan(output.payload)
      const type = operation.executionSpec.dataTypes.find(item => runRefEqual(item, output.typeRef))
      const patterns = type?.references.filter(reference => reference.target.kind === 'node').map(reference => reference.path.split('/').slice(1)) ?? []
      const pathAllowed = (path: string) => {
        const parts = path.split('/').slice(1)
        return patterns.some(pattern => pattern.length === parts.length && pattern.every((part, index) => part === '*' || part === parts[index]))
      }
      const dependencies = new Set(runReadCandidates(operation).filter(candidate => stage.dependsOn.includes(candidate.stageId))
        .map(candidate => runCandidateKey(candidate.workId, candidate.key)))
      for (const item of outputs) dependencies.add(runCandidateKey(workId, item.key))
      const referenced = new Set<string>()
      const readRefs = (value: JsonValue) => {
        if (Array.isArray(value)) { value.forEach(readRefs); return }
        if (!value || typeof value !== 'object') return
        const candidate = value.candidate
        if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
          && typeof candidate.workId === 'string' && typeof candidate.key === 'string') referenced.add(runCandidateKey(candidate.workId, candidate.key))
        else Object.values(value).forEach(readRefs)
      }
      readRefs(output.payload)
      if (candidatePaths.some(path => !pathAllowed(path)) || [...referenced].some(key => !dependencies.has(key) || !candidateIds.get(key))) {
        throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
      }
      definitionsValidatePayload(run.definitions, output.typeRef, runResolveCandidateRefs(output.payload, candidateIds))
    }
  }
  if (outputs.some(output => !stage.outputContract.ports.some(contract => contract.port === output.port))) {
    throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  }
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

function runValidatePlanSlots(run: GraphRun, operation: GraphOperation, stageId: string, slots: GraphPlanSlot[]): GraphPlanSlot[] {
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

function runCollectPublication(operation: GraphOperation): Array<GraphProposedOutput & { workId: string; stageId: string; slotId: string }> {
  const resultGroup = operation.stages.find(group => group.stageId === operation.executionSpec.resultStage)!
  const all = runReadCandidates(operation)
  const selected = resultGroup.results.flatMap(result => {
    if (result.mode === 'outputs') return all.filter(item => item.workId === result.workId)
    if (result.mode === 'selection') return result.selection.map(ref => all.find(item => item.workId === ref.workId && item.key === ref.key)!)
    return []
  })
  if (!operation.executionSpec.transition.publication?.includeReferencedCandidates) {
    return [...new Map(selected.map(item => [runCandidateKey(item.workId, item.key), item])).values()]
  }
  const allowedStages = new Set(operation.executionSpec.transition.publication.candidateStages ?? [])
  const byKey = new Map(all.map(item => [runCandidateKey(item.workId, item.key), item]))
  const included = new Map<string, typeof all[number]>()
  const readReferences = (value: JsonValue): GraphCandidateRef[] => {
    if (Array.isArray(value)) return value.flatMap(readReferences)
    if (!value || typeof value !== 'object') return []
    const candidate = value.candidate
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)
      && typeof candidate.workId === 'string' && typeof candidate.key === 'string') return [{ workId: candidate.workId, key: candidate.key }]
    return Object.values(value).flatMap(readReferences)
  }
  const visiting = new Set<string>(), visited = new Set<string>()
  const include = (item: typeof all[number]): void => {
    const key = runCandidateKey(item.workId, item.key)
    if (visiting.has(key)) throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.CANDIDATE_REFERENCES_MUST_NOT_CONTAIN_A_CYCLE)
    if (visited.has(key)) return
    visiting.add(key)
    included.set(key, item)
    for (const ref of readReferences(item.payload)) {
      const referenced = byKey.get(runCandidateKey(ref.workId, ref.key))
      if (!referenced || !allowedStages.has(referenced.stageId)) {
        throw new GraphError(422, 'OUTPUT_REFERENCE_INVALID', RuntimeMessage.PROPOSAL_REFERENCES_AN_UNAVAILABLE_CANDIDATE)
      }
      include(referenced)
    }
    visiting.delete(key); visited.add(key)
  }
  for (const item of selected) include(item)
  return [...included.values()]
}

function runCreateOutputs(document: GraphDocument, run: GraphRun, operation: GraphOperation, now: string): { nodeIds: string[]; edgeIds: string[] } {
  const candidates = runCollectPublication(operation)
  const byPort = new Map(operation.executionSpec.transition.ports.output.map(port => [port.name, candidates.filter(item => item.port === port.name)]))
  for (const port of operation.executionSpec.transition.ports.output) {
    const count = byPort.get(port.name)!.length
    if (count < port.count.min || count > port.count.max) throw new GraphError(422, 'OUTPUT_CARDINALITY', messageFormat(RuntimeMessage.OUTPUT_CARDINALITY_VALUE, port.name))
  }
  if (candidates.some(candidate => !operation.executionSpec.transition.ports.output.some(port => port.name === candidate.port && runRefEqual(port.outputType, candidate.typeRef)))) {
    throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  }
  const ids = new Map(candidates.map(candidate => [runCandidateKey(candidate.workId, candidate.key), candidate.nodeId ?? randomUUID()]))
  const nodes: GraphNode[] = candidates.map(candidate => {
    const payload = runResolveCandidateRefs(candidate.payload, ids)
    definitionsValidatePayload(run.definitions, candidate.typeRef, payload)
    const selected = runReadStageAgent(operation, candidate.stageId, candidate.slotId)
    return {
      id: ids.get(runCandidateKey(candidate.workId, candidate.key))!,
      revision: 0,
      typeId: candidate.typeRef.id,
      typeVersion: candidate.typeRef.version,
      payload: payload as GraphPayload,
      payloadReferences: graphReadPayloadReferenceIndex(run.definitions, candidate.typeRef, payload as GraphPayload),
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
  })
  const allowedReferenceTargets = new Set([...(run.branchState?.scope.nodeIds ?? []), ...nodes.map(node => node.id)])
  if (nodes.some(node => (node.payloadReferences ?? []).some(reference => !allowedReferenceTargets.has(reference.targetId)))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.GRAPH_CHANGE_AFFECTS_DATA_OUTSIDE_THE_ACQUIRED_BRANCH)
  }
  const nodeByCandidate = new Map(candidates.map((candidate, index) => [runCandidateKey(candidate.workId, candidate.key), nodes[index]]))
  const availableNodes = new Map([...document.nodes, ...nodes].map(node => [node.id, node]))
  for (const node of nodes) {
    const definition = operation.executionSpec.dataTypes.find(type => type.id === node.typeId && type.version === node.typeVersion)!
    for (const reference of definition.references) {
      if (reference.when && JSON.stringify(runReadPointer(node.payload, reference.when.path)) !== JSON.stringify(reference.when.equals)) continue
      if (reference.target.kind !== 'node') continue
      for (const id of runReadPathValues(node.payload, reference.path)) {
        const target = typeof id === 'string' ? availableNodes.get(id) : undefined
        if (!target || !reference.target.types.some(type => type.id === target.typeId && type.version === target.typeVersion)) {
          throw new GraphError(422, 'INVALID_OUTPUT_REFERENCE', messageFormat(RuntimeMessage.PAYLOAD_INVALID_VALUE, reference.path))
        }
      }
    }
  }
  const edges = candidates.flatMap(candidate => {
    const node = nodeByCandidate.get(runCandidateKey(candidate.workId, candidate.key))!
    const output = operation.executionSpec.transition.ports.output.find(port => port.name === candidate.port)!
    return output.successorOf.flatMap(anchor => {
      const parents = anchor.source === 'input'
        ? operation.group.inputRefs.filter(ref => ref.port === anchor.port && (!candidate.sourceKeys || candidate.sourceKeys.includes(ref.key))).map(ref => ref.id)
        : candidates.filter(item => item.port === anchor.port && (!candidate.sourceKeys || candidate.sourceKeys.includes(`${item.workId}:${item.key}`)))
          .map(item => {
            const parent = nodeByCandidate.get(runCandidateKey(item.workId, item.key))
            if (!parent) throw new GraphError(422, 'INVALID_OUTPUT', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
            return parent.id
          })
      return parents.map(parent => ({ id: randomUUID(), revision: 0, kind: 'successor' as const, from: parent, to: node.id,
        label: `${operation.transitionRef.id}@${operation.transitionRef.version}:${candidate.port}`, createdAt: now, updatedAt: now }))
    })
  })
  const branch = run.branchState
  if (!branch) throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', RuntimeMessage.USE_THE_EXPLICIT_NODE_RUN_MIGRATION)
  const nextBranch = branchReadSnapshot({ ...document, nodes: [...document.nodes, ...nodes], edges: [...document.edges, ...edges] }, branch.scope.rootIds)
  if (nodes.some(node => !nextBranch.scope.nodeIds.includes(node.id))) {
    throw new GraphError(409, 'BRANCH_SCOPE_CONFLICT', RuntimeMessage.NEW_DATA_MUST_BE_REACHABLE_FROM_THE_AUTHORIZED_BRANCH)
  }
  document.nodes.push(...nodes)
  document.edges.push(...edges)
  operation.outputRefs = candidates.map(candidate => ({
    id: nodeByCandidate.get(runCandidateKey(candidate.workId, candidate.key))!.id,
    revision: 0,
    port: candidate.port,
    workId: candidate.workId,
    key: candidate.key,
  }))
  operation.status = 'completed'
  run.branchState = { scope: nextBranch.scope, version: nextBranch.version }
  return { nodeIds: nodes.map(node => node.id), edgeIds: edges.map(edge => edge.id) }
}

function runFinishResult(document: GraphDocument, run: GraphRun, operation: GraphOperation, now: string): { nodeIds: string[]; edgeIds: string[] } {
  if (operation.executionSpec.review.mode === 'required' && run.mode === 'human-in-loop') {
    if (!operation.review || operation.review.state === 'answered' || operation.review.kind !== 'result') runCreateReview(operation, 'result', now)
    return { nodeIds: [], edgeIds: [] }
  }
  return runCreateOutputs(document, run, operation, now)
}

export function runUpdateProposal(
  document: GraphDocument,
  proposal: GraphDataProposal,
  work: Pick<GraphWork, 'runId' | 'workId' | 'operationId' | 'stageId' | 'slotId' | 'specHash'>,
  now: string,
): { document: GraphDocument; nodeIds: string[]; edgeIds: string[] } {
  const run = runReadExecution(document, work.runId), operation = runReadOperation(run, proposal.operationId)
  if (run.paused || operation.status !== 'running' || work.operationId !== operation.id || work.specHash !== operation.specHash
    || proposal.specHash !== operation.specHash || proposal.id !== work.workId) {
    throw new GraphError(409, 'PROPOSAL_CONFLICT', RuntimeMessage.PROPOSAL_DOES_NOT_BELONG_TO_THIS_WORK_GRANT)
  }
  runValidateInputs(document, run, operation)
  const group = operation.stages.find(item => item.stageId === work.stageId)
  const stage = operation.executionSpec.stages.find(item => item.id === work.stageId)
  if (!group || !stage || stage.outputContract.mode !== proposal.kind || !group.expectedWorkIds.includes(work.workId)
    || !stage.dependsOn.every(id => operation.stages.some(item => item.stageId === id && item.closed))) {
    throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_STAGE_CONTRACT)
  }
  if (group.results.some(result => result.workId === work.workId)) throw new GraphError(409, 'RESULT_EXISTS', RuntimeMessage.STAGE_RESULT_WAS_ALREADY_ACCEPTED)
  let result: GraphStageResult
  if (proposal.kind === 'outputs') {
    const outputs = proposal.outputs.map(output => ({ ...structuredClone(output), nodeId: randomUUID() }))
    runValidateStageOutputs(run, operation, work.stageId, work.workId, outputs)
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
  let published = { nodeIds: [] as string[], edgeIds: [] as string[] }
  if (result.mode === 'plan') {
    if (run.mode === 'human-in-loop') runCreateReview(operation, 'plan', now)
    else runApplyPlan(operation, result)
  } else {
    group.closed = group.results.length === group.expectedWorkIds.length
    if (group.closed && group.stageId === operation.executionSpec.resultStage) published = runFinishResult(document, run, operation, now)
  }
  runUpdateProgress(document, run, now)
  return { document, ...published }
}

export function runCreateRun(
  document: GraphDocument,
  input: Extract<GraphCommand, { method: 'run.start' }>['params'],
  context: GraphRunStartContext,
  now: string,
): GraphDocument {
  if (!Number.isSafeInteger(context.maxSlots) || context.maxSlots < 1 || context.maxSlots > 32) {
    throw new GraphError(422, 'INVALID_CONFIGURATION', RuntimeMessage.MAXAGENTSLOTS_MUST_BE_BETWEEN_1_AND_32)
  }
  for (const existing of document.runs) runReadRun(document, existing.id)
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
  const run: GraphRun = {
    id: input.id,
    scope: structuredClone(input.scope),
    branchState: { scope: structuredClone(branch.scope), version: branch.version },
    plan: structuredClone(input.plan),
    definitions: structuredClone(context.definitions),
    agents: structuredClone(context.agents),
    tools: structuredClone(context.tools),
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

export function runUpdatePause(document: GraphDocument, runId: string, paused: boolean, now: string): GraphDocument {
  const run = runReadExecution(document, runId)
  for (const operation of run.operations) runValidateInputs(document, run, operation)
  run.paused = paused
  runUpdateProgress(document, run, now)
  return document
}

export function runAnswerReview(
  document: GraphDocument,
  input: Extract<GraphCommand, { method: 'review.answer' }>['params'],
  now: string,
): { document: GraphDocument; nodeIds: string[]; edgeIds: string[] } {
  const run = runReadExecution(document, input.runId), operation = runReadOperation(run, input.operationId), review = operation.review
  if (!review || review.id !== input.reviewId || review.state !== 'pending'
    || review.revision !== input.expectedReviewRevision) throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
  runValidateInputs(document, run, operation)
  review.state = 'answered'; review.decision = input.decision; review.answeredAt = now; review.revision++
  let result = { nodeIds: [] as string[], edgeIds: [] as string[] }
  if (input.decision === 'reject') operation.status = 'failed'
  else if (review.kind === 'plan') {
    const pending = operation.stages.flatMap(group => group.results).find(item => item.mode === 'plan' && !item.plan.approved)
    if (!pending || pending.mode !== 'plan') throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
    runApplyPlan(operation, pending); operation.status = 'running'
  } else {
    operation.status = 'running'
    result = runCreateOutputs(document, run, operation, now)
  }
  runUpdateProgress(document, run, now)
  return { document, ...result }
}
