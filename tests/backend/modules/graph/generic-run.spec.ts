import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DefinitionPackage, DefinitionRef, ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import type { GraphNode } from '../../../../contracts/graph'
import type { GraphCommand, GraphQuery } from '../../../../contracts/graph-api'
import type { GraphCandidateRef, GraphOperation, GraphProposedOutput, GraphPublicationPreview, GraphRunStep } from '../../../../contracts/graph-run'
import { definitionsReadPackage, definitionsValidateCatalog } from '../../../../backend/modules/shared/data-definition'
import type { GraphDocument } from '../../../../backend/modules/graph/graph-record'
import { runAnswerReview, runCreateRun, runReadData, runReadPublicationPreview, runUpdateProposal, type GraphRunStartContext } from '../../../../backend/modules/graph/run-state'
import { graphInputReadPayload } from '../../../../backend/modules/graph/graph-input'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { branchReadSnapshot } from '../../../../backend/modules/graph/branch-state'

const inputType = { id: 'demo.text', version: 1 }
const outputType = { id: 'demo.summary', version: 1 }
const transitionRef = { id: 'demo.summarize', version: 1 }
const selectionTransitionRef = { id: 'demo.select-summary', version: 1 }
const agentRef = { id: 'demo.agent', version: 1 }
const agent: ExecutionAgentDefinition = { ref: agentRef, profile: {
  id: agentRef.id, name: 'Summarizer', description: 'Summarizes text', content: 'Summarize {{text}}',
  tools: [], provider: 'fixture', model: 'fixture', promptVars: ['text'],
} }
const packageDefinition: DefinitionPackage = {
  id: 'demo', version: 1, title: 'Demo', schemaDialect: 'http://json-schema.org/draft-07/schema#',
  dependencies: { packages: [], agents: [agentRef] },
  dataTypes: [
    { ...inputType, title: 'Text', schema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
      successorTypes: [outputType], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] } },
    { ...outputType, title: 'Summary', schema: { type: 'object', properties: {
      text: { type: 'string', minLength: 1 }, nextId: { type: 'string', format: 'uuid' },
    }, required: ['text'], additionalProperties: false }, successorTypes: [],
    references: [{ path: '/nextId', target: { kind: 'node', types: [outputType] } }],
    agentProjection: { include: ['/text'], mapEntryFilters: [] } },
  ],
  transitions: [{
    ...transitionRef, title: 'Summarize', cardinality: '1:1', group: { mode: 'explicit-members', ready: 'sealed-all-required' },
    ports: {
      input: [{ name: 'document', inputType, count: { min: 1, max: 1 } }], context: [],
      output: [{ name: 'summary', outputType, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'document' }] }],
    },
    execution: { stages: [{ id: 'summarize', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
      outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
      promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } }], resultStage: 'summarize' },
    review: { mode: 'none', at: 'result', onReject: 'fail' },
  }, {
    ...selectionTransitionRef, title: 'Select summary', cardinality: '1:1', group: { mode: 'explicit-members', ready: 'sealed-all-required' },
    ports: {
      input: [{ name: 'document', inputType, count: { min: 1, max: 1 } }], context: [],
      output: [{ name: 'summary', outputType, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'document' }] }],
    },
    execution: { stages: [
      { id: 'draft-a', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
        outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
        promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } },
      { id: 'draft-b', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
        outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
        promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } },
      { id: 'select', kind: 'agent', agentRef, dependsOn: ['draft-a', 'draft-b'], ready: 'all-dependencies', resultMode: 'selection',
        outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
        promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } },
    ], resultStage: 'select' },
    review: { mode: 'none', at: 'result', onReject: 'fail' },
    publication: { includeReferencedCandidates: true, candidateStages: ['draft-a', 'draft-b'] },
  }],
}

function fixture(): { document: GraphDocument; input: GraphNode } {
  const now = '2026-09-28T00:00:00.000Z'
  const input: GraphNode = { id: randomUUID(), revision: 0, typeId: inputType.id, typeVersion: inputType.version,
    payload: { text: 'A long report' }, createdAt: now, updatedAt: now }
  return { input, document: { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Demo', nodes: [input], edges: [],
    runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now } }
}

function branchProof(document: GraphDocument, rootIds: string[]) {
  const branch = branchReadSnapshot(document, rootIds)
  return { rootIds: branch.scope.rootIds, expectedVersion: branch.version }
}

function defaultFactCheckContext(): GraphRunStartContext {
  // 读取正式核查定义，使用不调用模型的Agent夹具验证相同端口、阶段与发布合同。
  const defaults = definitionsReadPackage(JSON.parse(readFileSync(new URL('../../../../resources/data-definitions/fact-checking.json', import.meta.url), 'utf8')))
  const variables: Record<string, string[]> = {
    'parse-extract': ['rawContent'], 'split-router': ['availableAgents', 'context', 'content'],
    'split-data': ['hint', 'context', 'content'], 'split-quote': ['hint', 'context', 'content'], 'split-causal': ['hint', 'context', 'content'],
    'split-merger': ['content', 'subResults'], 'verify-router': ['availableAgents', 'context', 'claimContent', 'originalContent'],
    sources: ['hint', 'context', 'claimContent', 'originalContent'], logic: ['hint', 'context', 'claimContent', 'originalContent'],
    numbers: ['hint', 'context', 'claimContent', 'originalContent'], 'verify-merger': ['claimContent', 'originalContent', 'opinions'],
  }
  const agents: ExecutionAgentDefinition[] = defaults.dependencies.agents.map((/* 正式包声明的精确Agent版本。 */ ref) =>
    /* 仅替换执行资料，不改变默认转换或Agent身份。 */ ({ ref, profile: {
      id: ref.id, name: ref.id, description: ref.id, content: 'fixture', tools: [], provider: 'fixture', model: 'fixture', promptVars: variables[ref.id],
    } }))
  return { definitions: definitionsValidateCatalog([defaults], agents), agents, tools: [], maxSlots: 5 }
}

interface RunStepsFixture {
  document: GraphDocument
  input: Extract<GraphCommand, { method: 'run.start' }>['params']
  context: GraphRunStartContext
  left: GraphNode[]
  right: GraphNode[]
  contextNode: GraphNode
  first: GraphRunStep
  second: GraphRunStep
}

const auditType = { id: 'fixture.steps-audit', version: 1 }
const finalType = { id: 'fixture.steps-final', version: 1 }

function runStepsFixture(
  /* true让第一步两个输出端口都允许空结果，以核对后步onEmpty。 */ allowsEmptyOutputs = false,
): RunStepsFixture {
  // 复用原真实定义与Work提案seam，只增加两输入、必填上下文、双输出和后继消费转换。
  const { document, input: original } = fixture()
  const left = [original, { ...structuredClone(original), id: randomUUID() }]
  const right = [{ ...structuredClone(original), id: randomUUID() }, { ...structuredClone(original), id: randomUUID() }]
  const contextNode = { ...structuredClone(original), id: randomUUID(), payload: { text: 'Only shared context' } }
  document.nodes = [...left, ...right, contextNode]
  const definition = structuredClone(packageDefinition)
  definition.id = 'fixture.run-steps'
  const source = definition.dataTypes.find((/* 可变测试定义中的类型。 */ type) => /* 取得原文的结构后继许可。 */ type.id === inputType.id)
  const summary = definition.dataTypes.find((/* 可变测试定义中的类型。 */ type) => /* 让正式摘要可继续生成最终结果。 */ type.id === outputType.id)
  if (!source || !summary) throw new Error('Run steps fixture types are missing')
  source.successorTypes.push(auditType)
  summary.successorTypes.push(finalType)
  for (const type of [auditType, finalType]) definition.dataTypes.push({ ...type, title: type.id,
    schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    successorTypes: [], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] } })
  const minimum = allowsEmptyOutputs ? 0 : 1
  const combine = structuredClone(definition.transitions[0])
  if (!combine) throw new Error('Run steps fixture transition is missing')
  combine.id = 'fixture.combine'
  combine.cardinality = 'N:M'
  combine.ports.input = ['left', 'right'].map((/* 一项结构输入的端口名。 */ name) =>
    /* 两项输入分别选材，并按每组数量独立冻结。 */ ({ name, inputType, count: { min: 1, max: 2 } }))
  combine.ports.context = [{ name: 'background', inputType, count: { min: 1, max: 1 } }]
  combine.ports.output = [{ name: 'summary', outputType, count: { min: minimum, max: 1 }, successorOf: [{ source: 'input', port: 'left' }, { source: 'input', port: 'right' }] },
    { name: 'audit', outputType: auditType, count: { min: minimum, max: 1 }, successorOf: [{ source: 'input', port: 'left' }] }]
  const combineStage = combine.execution.stages[0]
  if (!combineStage) throw new Error('Run steps fixture stage is missing')
  combineStage.outputPorts = ['summary', 'audit'].map((/* 第一阶段可发布的端口名。 */ port) =>
    /* 每份实际结果沿真实端口基数校验。 */ ({ port, count: { min: minimum, max: 1 } }))
  combineStage.promptBindings = { text: { source: 'input', port: 'left', path: '/text', format: 'text', required: true } }
  const consume = structuredClone(definition.transitions[0])
  if (!consume) throw new Error('Run steps consumer transition is missing')
  consume.id = 'fixture.consume-summary'
  consume.ports.input = [{ name: 'document', inputType: outputType, count: { min: 1, max: 1 } }]
  consume.ports.output = [{ name: 'final', outputType: finalType, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'document' }] }]
  const consumeStage = consume.execution.stages[0]
  if (!consumeStage) throw new Error('Run steps consumer stage is missing')
  consumeStage.outputPorts = [{ port: 'final', count: { min: 1, max: 1 } }]
  definition.transitions = [combine, consume]
  const first: GraphRunStep = { id: 'combine', transitionRef: { id: combine.id, version: combine.version }, dependsOn: [],
    input: [{ port: 'left', source: { kind: 'scope', nodeIds: left.map((/* 左侧保存节点。 */ node) => /* 引用真实身份。 */ node.id) } },
      { port: 'right', source: { kind: 'scope', nodeIds: right.map((/* 右侧保存节点。 */ node) => /* 引用真实身份。 */ node.id) } }],
    context: [{ port: 'background', source: { kind: 'scope', nodeIds: [contextNode.id] } }], grouping: { mode: 'all' }, onEmpty: 'fail' }
  const second: GraphRunStep = { id: 'consume', transitionRef: { id: consume.id, version: consume.version }, dependsOn: [first.id],
    input: [{ port: 'document', source: { kind: 'step', stepId: first.id, port: 'summary' } }], context: [], grouping: { mode: 'each' }, onEmpty: 'skip' }
  const nodeIds = document.nodes.map((/* 所有显式输入与上下文。 */ node) => /* 去重前已具有独立身份。 */ node.id)
  return { document, left, right, contextNode, first, second,
    context: { definitions: definitionsValidateCatalog([definition], [agent]), agents: [agent], tools: [], maxSlots: 4 },
    input: { mapId: document.id, id: randomUUID(), branch: branchProof(document, nodeIds), scope: { nodeIds }, mode: 'auto', plan: { steps: [first, second] } } }
}

describe('C16 existing finite Run plan contracts', () => {
  // 多步骤计划复用真实Run冻结与Work结果，直接通过只作为既有合同绿对照。
  it('groups multiple inputs with required context then feeds only one published output port into the next Run step', () => {
    // 第一步分两组发布摘要与审计；第二步仅消费正式摘要，不消费上下文、其它输出或候选键。
    const f = runStepsFixture()
    f.first.grouping = { mode: 'explicit', groups: [
      { id: 'one', members: { left: [f.left[0].id], right: [f.right[0].id] } },
      { id: 'two', members: { left: [f.left[1].id], right: [f.right[1].id] } },
    ] }
    runCreateRun(f.document, f.input, f.context, f.document.createdAt)
    const initialWorks = workReadItems(f.document)
    expect(initialWorks).toHaveLength(2)
    for (const work of initialWorks) {
      const data = runReadData(f.document, work.operationId, work)
      expect(data.inputs.left).toHaveLength(1)
      expect(data.inputs.right).toHaveLength(1)
      expect(data.context.background).toMatchObject([{ node: { id: f.contextNode.id } }])
      runUpdateProposal(f.document, { mapId: f.document.id, operationId: work.operationId, id: work.workId, specHash: work.specHash,
        kind: 'outputs', reason: 'Two formal output ports', outputs: [
          { key: 'main-candidate', port: 'summary', typeRef: outputType, payload: { text: `Summary ${work.operationId}` } },
          { key: 'audit-candidate', port: 'audit', typeRef: auditType, payload: { text: 'Not a downstream input' } },
        ] }, work, '2026-09-28T00:00:01.000Z')
    }
    const run = f.document.runs[0]
    if (!run) throw new Error('C16 Run was not created')
    const firstOperations = run.operations.filter((/* 当前真实Operation。 */ operation) => /* 只取第一步已完成分组。 */ operation.stepId === f.first.id)
    const summaryIds = firstOperations.flatMap((/* 一个已完成第一步分组。 */ operation) =>
      /* 所指定端口的正式身份来自已发布outputRefs。 */ operation.outputRefs.filter((/* 正式产物引用。 */ ref) => /* 排除另一个输出端口。 */ ref.port === 'summary')
        .map((/* 精确摘要产物引用。 */ ref) => /* 后步使用节点ID，不使用候选key。 */ ref.id))
    const auditIds = firstOperations.flatMap((/* 第一阶段保存的分组。 */ operation) =>
      /* 审计产物虽正式发布也不是所选下游来源。 */ operation.outputRefs.filter((/* 正式引用。 */ ref) => /* 仅审计端口。 */ ref.port === 'audit')
        .map((/* 正式审计引用。 */ ref) => /* 供下游排除断言。 */ ref.id))
    const nextWorks = workReadItems(f.document)
    expect(nextWorks).toHaveLength(2)
    const consumedIds: string[] = []
    for (const work of nextWorks) {
      const data = runReadData(f.document, work.operationId, work)
      expect(data.inputs.document).toHaveLength(1)
      const sourceId = data.inputs.document[0].node.id
      consumedIds.push(sourceId)
      expect(summaryIds).toContain(sourceId)
      expect(auditIds).not.toContain(sourceId)
      expect(sourceId).not.toBe(f.contextNode.id)
      expect(sourceId).not.toBe('main-candidate')
      runUpdateProposal(f.document, { mapId: f.document.id, operationId: work.operationId, id: work.workId, specHash: work.specHash,
        kind: 'outputs', reason: 'Consume accepted summaries', outputs: [{ key: 'final', port: 'final', typeRef: finalType, payload: { text: 'Final result' } }] },
      work, '2026-09-28T00:00:02.000Z')
    }
    expect(consumedIds.sort()).toEqual(summaryIds.sort())
    expect(run).toMatchObject({ status: 'completed', steps: [{ status: 'completed' }, { status: 'completed' }] })
    expect(run.operations).toHaveLength(4)
    expect(run.scope.nodeIds).toContain(f.contextNode.id)
    expect(run.branchState?.scope.nodeIds).toContain(f.contextNode.id)
  })

  it.each(['scope', 'branch', 'required-context'] as const)('keeps context within the actual authorized Run %s contract', (/* 故意遗漏上下文的位置。 */ missing) => {
    // 上下文只读也须显式入scope和分支；缺必填上下文不能用onEmpty跳过。
    const f = runStepsFixture()
    let code = 'INVALID_PLAN'
    if (missing === 'scope') f.input.scope.nodeIds = f.input.scope.nodeIds.filter((/* 已声明范围节点。 */ id) => /* 只移除只读上下文。 */ id !== f.contextNode.id)
    if (missing === 'branch') {
      f.input.branch = branchProof(f.document, f.input.scope.nodeIds.filter((/* 当前Run范围节点。 */ id) => /* 分支故意不覆盖上下文。 */ id !== f.contextNode.id))
      code = 'BRANCH_VERSION_CONFLICT'
    }
    if (missing === 'required-context') {
      f.first.context = [{ port: 'background', source: { kind: 'scope', nodeIds: [] } }]
      f.first.onEmpty = 'skip'
      code = 'OUTPUT_CARDINALITY'
    }
    expect(() => /* 真实Run入口分别核对计划范围、分支与Operation端口基数。 */ runCreateRun(f.document, f.input, f.context, f.document.createdAt))
      .toThrowError(expect.objectContaining({ code }))
  })

  it.each(['unavailable', 'duplicate', 'count', 'unknown-port'] as const)('rejects an invalid static explicit group member: %s', (/* 本组唯一破坏的成员规则。 */ problem) => {
    // 显式成员只能来自本端口真实可用节点，不能靠分组绕过数量、去重或端口声明。
    const f = runStepsFixture()
    const members: Record<string, string[]> = { left: [f.left[0].id], right: [f.right[0].id] }
    let code = 'INVALID_PLAN'
    if (problem === 'unavailable') members.left = [f.contextNode.id]
    if (problem === 'duplicate') { members.left.push(f.left[0].id); code = 'DEFINITION_INVALID' }
    if (problem === 'count') { members.left = []; code = 'OUTPUT_CARDINALITY' }
    if (problem === 'unknown-port') members.background = [f.contextNode.id]
    f.first.grouping = { mode: 'explicit', groups: [{ id: 'invalid-group', members }] }
    expect(() => /* 真实实例化把成员解析为封闭输入并沿定义校验。 */ runCreateRun(f.document, f.input, f.context, f.document.createdAt))
      .toThrowError(expect.objectContaining({ code }))
  })

  it.each(['skip', 'fail'] as const)('applies onEmpty %s only after a previous Run step publishes no formal outputs', (/* 下游整步没有输入时的真实策略。 */ onEmpty) => {
    // 空候选结果合法完成第一步，后步没有Operation而按保存策略成为skipped或failed。
    const f = runStepsFixture(true)
    f.second.onEmpty = onEmpty
    runCreateRun(f.document, f.input, f.context, f.document.createdAt)
    const work = workReadItems(f.document)[0]
    if (!work) throw new Error('C16 empty result Work is missing')
    runUpdateProposal(f.document, { mapId: f.document.id, operationId: work.operationId, id: work.workId, specHash: work.specHash,
      kind: 'outputs', reason: 'No applicable outputs', outputs: [] }, work, '2026-09-28T00:00:01.000Z')
    const run = f.document.runs[0]
    if (!run) throw new Error('C16 empty result Run is missing')
    expect(run.steps[0].status).toBe('completed')
    expect(run.steps[1]).toMatchObject({ status: onEmpty === 'skip' ? 'skipped' : 'failed', operationIds: [] })
    expect(run.status).toBe(onEmpty === 'skip' ? 'completed' : 'failed')
    expect(workReadItems(f.document)).toEqual([])
  })

  it.each(['missing-dependency', 'self', 'cycle', 'multi-input-each', 'wrong-output-port-type'] as const)('rejects a structurally invalid Run plan: %s', (/* 本计划唯一破坏的依赖或分组规则。 */ problem) => {
    // 后步只引用直接依赖及精确类型输出，each不能用在多个输入端口上。
    const f = runStepsFixture()
    if (problem === 'missing-dependency') f.second.dependsOn = []
    if (problem === 'self') f.first.dependsOn = [f.first.id]
    if (problem === 'cycle') f.first.dependsOn = [f.second.id]
    if (problem === 'multi-input-each') f.first.grouping = { mode: 'each' }
    if (problem === 'wrong-output-port-type') f.second.input = [{ port: 'document', source: { kind: 'step', stepId: f.first.id, port: 'audit' } }]
    expect(() => /* 提交真实完整计划，由原有限计划规则拒绝。 */ runCreateRun(f.document, f.input, f.context, f.document.createdAt))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PLAN' }))
  })

  it.each([0, 1, 64, 65])('keeps the actual finite plan boundary at %i steps', (/* 此独立计划实际声明的步骤数量。 */ count) => {
    // 步数与端口节点数、Agent阶段数和槽位预算是不同合同。
    const f = runStepsFixture()
    f.input.plan.steps = Array.from({ length: count }, (/* Array.from的未使用槽值。 */ _value, /* 本步骤稳定序号。 */ index) =>
      /* 独立步骤均使用同一合法scope输入，不把Agent阶段当Run步骤。 */ ({ ...structuredClone(f.first), id: `step-${index}` }))
    const create = () => {
      // 直接调用已有Run建立入口，不搭服务或Host框架。
      runCreateRun(f.document, f.input, f.context, f.document.createdAt)
    }
    if (count === 0 || count === 65) expect(create).toThrowError(expect.objectContaining({ code: 'INVALID_PLAN' }))
    else {
      create()
      expect(f.document.runs[0]?.steps).toHaveLength(count)
      expect(f.document.runs[0]?.operations).toHaveLength(count)
    }
  })
})

describe('generic data execution', () => {
  it('preserves own prototype-named JSON fields when copying an unknown payload', () => {
    // JSON自有字段应按数据复制，不能触发原型setter或丢失正文。
    const payload = JSON.parse('{"__proto__":{"text":"kept"},"constructor":"data"}')
    const parsed = graphInputReadPayload(payload, 'payload')
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype)
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true)
    expect(parsed).toEqual(payload)
  })

  it('starts and reads a registered constructor port as an own data binding', () => {
    // 合法端口名称与原型属性同名时仍应正常冻结、分组和投影。
    const { document, input } = fixture()
    const definition = structuredClone(packageDefinition)
    const transition = definition.transitions[0]
    transition.ports.input[0].name = 'constructor'
    transition.ports.output[0].successorOf[0].port = 'constructor'
    transition.execution.stages[0].promptBindings = { text: { source: 'input', port: 'constructor', path: '/text', format: 'text', required: true } }
    const catalog = definitionsValidateCatalog([definition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'constructor', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, document.createdAt)
    const work = workReadItems(document)[0]
    const data = runReadData(document, work.operationId, work)
    expect(Object.prototype.hasOwnProperty.call(data.inputs, 'constructor')).toBe(true)
    expect(data.promptVariables.text).toBe('A long report')
  })

  it('treats an omitted optional constructor member as an empty explicit group binding', () => {
    // 显式分组允许可选端口为空，继承的constructor函数不能冒充成员列表。
    const { document, input } = fixture()
    const definition = structuredClone(packageDefinition)
    definition.transitions[0].cardinality = 'N:1'
    definition.transitions[0].ports.input.push({ name: 'constructor', inputType, count: { min: 0, max: 1 } })
    definition.transitions[0].execution.stages[0].promptBindings = { text: { source: 'input', port: 'constructor', path: '/text', format: 'text', required: false } }
    const catalog = definitionsValidateCatalog([definition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [
        { port: 'document', source: { kind: 'scope', nodeIds: [input.id] } },
        { port: 'constructor', source: { kind: 'scope', nodeIds: [] } },
      ], context: [], grouping: { mode: 'explicit', groups: [{ id: 'one', members: { document: [input.id] } }] }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, document.createdAt)
    const operation = document.runs[0].operations[0]
    expect(Object.prototype.hasOwnProperty.call(operation.executionSpec.inputs, 'constructor')).toBe(true)
    expect(operation.executionSpec.inputs.constructor).toEqual([])
    const work = workReadItems(document)[0]
    expect(runReadData(document, work.operationId, work).promptVariables.text).toBe('')
  })

  it('projects own prototype-named nested fields without changing Object.prototype', () => {
    // Agent投影只能建立独立JSON容器，不能沿继承的__proto__对象写入全局原型。
    const { document, input } = fixture()
    const definition = structuredClone(packageDefinition)
    definition.transitions = [definition.transitions[0]]
    const field = 'domainProjectionMarker104'
    definition.dataTypes[0].schema = { type: 'object', properties: Object.fromEntries([['__proto__', {
      type: 'object', properties: { [field]: { type: 'string' } }, required: [field], additionalProperties: false,
    }]]), required: ['__proto__'], additionalProperties: false }
    definition.dataTypes[0].agentProjection.include = [`/__proto__/${field}`]
    definition.transitions[0].execution.stages[0].promptBindings = { text: {
      source: 'input', port: 'document', path: `/__proto__/${field}`, format: 'text', required: true,
    } }
    input.payload = Object.fromEntries([['__proto__', { [field]: 'projected' }]])
    const catalog = definitionsValidateCatalog([definition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, document.createdAt)
    try {
      const work = workReadItems(document)[0]
      const data = runReadData(document, work.operationId, work)
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, field)).toBe(false)
      expect(Object.prototype.hasOwnProperty.call(data.inputs.document[0].node.payload, '__proto__')).toBe(true)
      expect(data.promptVariables.text).toBe('projected')
    } finally {
      Reflect.deleteProperty(Object.prototype, field)
    }
  })

  it('rejects a missing or invalid run slot budget at the domain boundary', () => {
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    for (const maxSlots of [undefined, 0, 1.5, 33]) {
      const { document, input } = fixture()
      const context = { definitions: catalog, agents: [agent], tools: [], maxSlots } as unknown as GraphRunStartContext
      expect(() => runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
        id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
        context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
      }] } }, context, '2026-09-28T00:00:01.000Z')).toThrow()
      expect(document.runs).toEqual([])
    }
  })

  it('freezes a registered transition, derives its stage Work and publishes a typed successor', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent], 3)
    const now = '2026-09-28T00:00:01.000Z'
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, now)
    const work = workReadItems(document)
    expect(work).toHaveLength(1)
    expect(work[0]).toMatchObject({ stageId: 'summarize', slotId: 'summarize', specHash: document.runs[0].operations[0].specHash })
    const data = runReadData(document, work[0].operationId, work[0])
    expect(data.promptVariables).toEqual({ text: 'A long report' })
    expect(data.inputs.document).toMatchObject([{ node: { typeId: 'demo.text', payload: { text: 'A long report' } } }])
    const detached = structuredClone(document)
    expect(() => runUpdateProposal(detached, { mapId: detached.id, operationId: work[0].operationId, id: work[0].workId,
      specHash: work[0].specHash, kind: 'outputs', reason: 'Detached', outputs: [{ key: 'summary', port: 'summary', typeRef: outputType,
        payload: { text: 'Detached report' }, sourceKeys: [] }] }, work[0], '2026-09-28T00:00:01.500Z')).toThrow(/stage contract/i)
    const update = runUpdateProposal(document, { mapId: document.id, operationId: work[0].operationId, id: work[0].workId,
      specHash: work[0].specHash, kind: 'outputs', reason: 'Condensed', outputs: [{ key: 'summary', port: 'summary', typeRef: outputType,
        payload: { text: 'Short report' } }] }, work[0], '2026-09-28T00:00:02.000Z')
    expect(update.nodeIds).toHaveLength(1)
    expect(document.nodes.at(-1)).toMatchObject({ typeId: 'demo.summary', typeVersion: 1, payload: { text: 'Short report' } })
    expect(document.nodes.at(-1)).toHaveProperty('producer.agentName', 'Summarizer')
    expect(document.nodes.at(-1)).not.toHaveProperty('manualOrigin')
    expect(document.edges).toContainEqual(expect.objectContaining({ kind: 'successor', from: input.id, to: update.nodeIds[0] }))
    expect(document.runs[0]).toMatchObject({ status: 'completed', operations: [{ status: 'completed' }] })
    const firstOperationId = document.runs[0].operations[0].id
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:03.000Z')
    expect(workReadItems(document)).toEqual([])
    expect(document.runs[0]).toMatchObject({ status: 'completed', operations: [{ reusedFromOperationId: firstOperationId }] })
  })

  it('rejects payloads outside the frozen output schema before changing graph state', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:01.000Z')
    const work = workReadItems(document)[0], before = structuredClone(document)
    expect(() => runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId,
      specHash: work.specHash, kind: 'outputs', reason: 'Invalid', outputs: [{ key: 'summary', port: 'summary', typeRef: outputType,
        payload: { unexpected: true } }] }, work, '2026-09-28T00:00:02.000Z')).toThrow(/Payload/)
    expect(document).toEqual(before)
  })

  it('runs independent Agent stages concurrently and only publishes the final selection', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'select-step', transitionRef: selectionTransitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:01.000Z')
    const drafts = workReadItems(document)
    expect(new Set(drafts.map(work => work.stageId))).toEqual(new Set(['draft-a', 'draft-b']))
    drafts.forEach((work, index) => runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId,
      specHash: work.specHash, kind: 'outputs', reason: 'Draft', outputs: [{ key: `draft-${index}`, port: 'summary', typeRef: outputType,
        payload: { text: `Draft ${index}` } }] }, work, `2026-09-28T00:00:0${index + 2}.000Z`))
    const select = workReadItems(document)
    expect(select).toMatchObject([{ stageId: 'select', slotId: 'select' }])
    const candidates = runReadData(document, select[0].operationId, select[0]).priorStageResults
    const chosen = candidates.find(result => result.mode === 'outputs')!
    if (chosen.mode !== 'outputs') throw new Error('expected outputs')
    runUpdateProposal(document, { mapId: document.id, operationId: select[0].operationId, id: select[0].workId,
      specHash: select[0].specHash, kind: 'selection', reason: 'Best draft', selection: [{ workId: chosen.workId, key: chosen.outputs[0].key }] },
    select[0], '2026-09-28T00:00:05.000Z')
    expect(document.nodes.filter(node => node.typeId === outputType.id)).toHaveLength(1)
    expect(document.runs[0]?.status).toBe('completed')
  })

  it('rejects a cycle in the candidate dependency closure before formal publication', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'select-step', transitionRef: selectionTransitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:01.000Z')
    const drafts = workReadItems(document)
    for (const [index, work] of drafts.entries()) runUpdateProposal(document, { mapId: document.id, operationId: work.operationId,
      id: work.workId, specHash: work.specHash, kind: 'outputs', reason: 'Draft', outputs: [{ key: `draft-${index}`, port: 'summary', typeRef: outputType,
        payload: index === 0 ? { text: 'Cycle', nextId: { candidate: { workId: work.workId, key: 'draft-0' } } } : { text: 'Other' } }] },
    work, `2026-09-28T00:00:0${index + 2}.000Z`)
    const select = workReadItems(document)[0]
    const cyclic = document.runs[0].operations[0].stages.find(stage => stage.stageId === 'draft-a')!.results[0]
    if (cyclic.mode !== 'outputs') throw new Error('expected outputs')
    const copy = structuredClone(document)
    expect(() => runUpdateProposal(copy, { mapId: copy.id, operationId: select.operationId, id: select.workId,
      specHash: select.specHash, kind: 'selection', reason: 'Choose cyclic draft', selection: [{ workId: cyclic.workId, key: cyclic.outputs[0].key }] },
    select, '2026-09-28T00:00:05.000Z')).toThrow(/cycle/i)
  })

  it('runs the default fact-check plan and atomically publishes opinions referenced by its verification', () => {
    // 单事实合同保留真实模型错误形状的拒绝，并验证合法候选引用只发布所需意见。
    const now = '2026-09-28T00:00:00.000Z', claimId = randomUUID(), newsId = randomUUID()
    const claim: GraphNode = { id: claimId, revision: 0, typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: 'The claim', category: 'data' }, createdAt: now, updatedAt: now }
    const news: GraphNode = { id: newsId, revision: 0, typeId: 'factcheck.news', typeVersion: 1,
      payload: { content: 'Original report', context: { public: { value: 'visible', visibleToAI: true }, secret: { value: 'hidden', visibleToAI: false } } },
      createdAt: now, updatedAt: now }
    const document: GraphDocument = { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Fact check', nodes: [claim, news], edges: [],
      runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [claimId, newsId]), scope: { nodeIds: [claimId, newsId] }, mode: 'auto', plan: { steps: [{
      id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [claimId] } }], context: [{ port: 'news', source: { kind: 'scope', nodeIds: [newsId] } }],
      grouping: { mode: 'all' }, onEmpty: 'fail',
    }] } }, defaultFactCheckContext(), now)
    const route = workReadItems(document)[0]
    const constrained = structuredClone(document)
    constrained.runs[0].maxAgentSlots = 1
    expect(() => /* 运行预算仍限制正式plan可创建的槽位数量。 */ runUpdateProposal(constrained, { mapId: constrained.id, operationId: route.operationId, id: route.workId,
      specHash: route.specHash, kind: 'plan', reason: 'Too many checks', slots: [
        { id: 'one', stageId: 'assess', agentRef: { id: 'sources', version: 0 }, angle: 'one', hint: '', priority: 'high', tools: [] },
        { id: 'two', stageId: 'assess', agentRef: { id: 'logic', version: 0 }, angle: 'two', hint: '', priority: 'medium', tools: [] },
      ] }, route, '2026-09-28T00:00:00.500Z')).toThrow(/plan slot/i)
    runUpdateProposal(document, { mapId: document.id, operationId: route.operationId, id: route.workId, specHash: route.specHash, kind: 'plan', reason: 'Two checks', slots: [
      { id: 'source-slot', stageId: 'assess', agentRef: { id: 'sources', version: 0 }, angle: 'sources', hint: 'Check sources', priority: 'high', tools: [] },
      { id: 'logic-slot', stageId: 'assess', agentRef: { id: 'logic', version: 0 }, angle: 'logic', hint: 'Check logic', priority: 'medium', tools: [] },
    ] }, route, '2026-09-28T00:00:01.000Z')
    const assess = workReadItems(document)
    expect(assess.map((/* 当前可执行的评估Work。 */ work) => /* 保留两个实际槽位身份。 */ work.slotId)).toEqual(['source-slot', 'logic-slot'])
    const assessed = runReadData(document, assess[0].operationId, assess[0])
    expect(assessed.promptVariables).toMatchObject({ hint: expect.stringContaining('Check sources') })
    expect(assessed.context.news[0].node.payload).toEqual({ content: 'Original report', context: { public: { value: 'visible', visibleToAI: true } } })
    for (const [index, work] of assess.entries()) runUpdateProposal(document, { mapId: document.id, operationId: work.operationId,
      id: work.workId, specHash: work.specHash, kind: 'outputs', reason: 'Opinion', outputs: [{ key: `opinion-${index}`, port: 'opinions',
        typeRef: { id: 'factcheck.opinion', version: 1 }, payload: { score: index ? 0.5 : 1, reason: `Reason ${index}`, evidenceClaimIds: [] } }] },
    work, `2026-09-28T00:00:0${index + 2}.000Z`)
    const merge = workReadItems(document)[0]
    const prior = runReadData(document, merge.operationId, merge).priorStageResults.filter((/* merge可读取的已接纳结果。 */ result) => /* 只读前序输出候选。 */ result.mode === 'outputs')
    const opinionRefs = prior.flatMap((/* 一项前序已接纳结果。 */ result) => /* 将意见键转换成协议声明的候选引用。 */ result.mode === 'outputs'
      ? result.outputs.map((/* 该结果中的意见候选。 */ output) => /* 保留候选所属Work，避免预留节点ID混用。 */ ({ candidate: { workId: result.workId, key: output.key } })) : [])
    const referencedOpinions = [opinionRefs[0]]
    const firstOpinion = prior.flatMap((/* 前序真实已接纳结果。 */ result) => /* 保留来源Work及候选，不能把预留ID当已发布节点。 */ result.mode === 'outputs'
      ? result.outputs.map((/* 一份已接纳意见。 */ output) => /* 同一候选的两类身份用于复现真实错误。 */ ({ workId: result.workId, output })) : [])[0]
    const operation = document.runs[0].operations.find((/* 当前Run的处理项。 */ item) => /* 精确找到merge所在Operation。 */ item.id === merge.operationId)
    const claimSourceKey = operation?.group.inputRefs[0]?.key
    if (!firstOpinion?.output.nodeId || !claimSourceKey) throw new Error('Expected accepted opinion reservation and Claim input key')
    const mergeOutput: GraphProposedOutput = { key: 'verification', port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 },
      payload: { score: 1, reason: 'Only supplied material supports the claim.', opinionIds: [firstOpinion.output.nodeId] }, sourceKeys: [claimSourceKey] }
    const beforeRejected = structuredClone(document), wrongInputAnchor = structuredClone(document)
    expect(() => {
      // 105真实Codex拒绝体：Verification错用Claim inputKey，先守原后端锚点合同。
      runUpdateProposal(wrongInputAnchor, { mapId: document.id, operationId: merge.operationId, id: merge.workId, specHash: merge.specHash,
        kind: 'outputs', reason: 'Reproduce rejected model shape', outputs: [mergeOutput] }, merge, '2026-09-28T00:00:04.100Z')
    }).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT', status: 422 }))
    const reservedNodeReference = structuredClone(document)
    expect(() => {
      // 修正sourceKeys后仍不能把尚未发布的Opinion预留ID字符串当候选闭包。
      runUpdateProposal(reservedNodeReference, { mapId: document.id, operationId: merge.operationId, id: merge.workId, specHash: merge.specHash,
        kind: 'outputs', reason: 'Reserved node identity is not a candidate reference', outputs: [{ ...mergeOutput,
          sourceKeys: [`${firstOpinion.workId}:${firstOpinion.output.key}`] }] }, merge, '2026-09-28T00:00:04.200Z')
    }).toThrow(expect.objectContaining({ code: 'OUTPUT_CARDINALITY', status: 422 }))
    expect(document).toEqual(beforeRejected)
    expect(() => /* 非引用字段不能放候选占位对象。 */ runUpdateProposal(document, { mapId: document.id, operationId: merge.operationId, id: merge.workId, specHash: merge.specHash,
      kind: 'outputs', reason: 'Invalid reference location', outputs: [{ key: 'verification', port: 'verification',
        typeRef: { id: 'factcheck.verification', version: 1 }, payload: { score: 0.5, reason: opinionRefs[0], opinionIds: referencedOpinions } }] },
    merge, '2026-09-28T00:00:05.000Z')).toThrow(/stage contract/)
    runUpdateProposal(document, { mapId: document.id, operationId: merge.operationId, id: merge.workId, specHash: merge.specHash,
      kind: 'outputs', reason: 'Merged', outputs: [{ key: 'verification', port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 },
        sourceKeys: [`${firstOpinion.workId}:${firstOpinion.output.key}`], payload: { score: 0.5, reason: 'Merged result', opinionIds: referencedOpinions } }] }, merge, '2026-09-28T00:00:05.000Z')
    const opinions = document.nodes.filter((/* 图内已正式发布的节点。 */ node) => /* 取得实际引用闭包发布的意见。 */ node.typeId === 'factcheck.opinion')
    const verification = document.nodes.find((/* 图内已正式发布的节点。 */ node) => /* 取得汇总后的唯一结论。 */ node.typeId === 'factcheck.verification')
    if (!verification) throw new Error('Expected published verification')
    expect(opinions).toHaveLength(1)
    expect(verification.payload.opinionIds).toEqual(opinions.map((/* 已发布意见。 */ node) => /* 读取正式节点ID。 */ node.id))
    expect(document.edges.filter((/* 已保存图边。 */ edge) => /* 只读结论的实际结构父节点。 */ edge.to === verification.id)
      .map((/* 结论入边。 */ edge) => /* 取得该边的意见来源。 */ edge.from)).toEqual(opinions.map((/* 已发布意见。 */ node) => /* 对照正式意见身份。 */ node.id))
    expect(document.runs[0]?.status).toBe('completed')
  })

  it('publishes two independent claim branches with two opinions and one verification each in a single default fact-check run', () => {
    // 手动提交确定性提案验证正式多分叉合同；该夹具不执行模型，也不证明模型会自行分叉。
    const now = '2026-10-21T00:00:00.000Z', { document } = fixture()
    const news: GraphNode = { id: randomUUID(), revision: 0, typeId: 'factcheck.news', typeVersion: 1,
      payload: { content: 'Report: the bridge opened in 2020. Its length is 120 metres.', context: {} }, createdAt: now, updatedAt: now }
    document.nodes = [news]
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [news.id]),
      scope: { nodeIds: [news.id] }, mode: 'auto', plan: { steps: [
        { id: 'split', transitionRef: { id: 'factcheck.split-news', version: 1 }, dependsOn: [],
          input: [{ port: 'news', source: { kind: 'scope', nodeIds: [news.id] } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail' },
        { id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: ['split'],
          input: [{ port: 'claim', source: { kind: 'step', stepId: 'split', port: 'claims' } }],
          context: [{ port: 'news', source: { kind: 'scope', nodeIds: [news.id] } }], grouping: { mode: 'each' }, onEmpty: 'fail' },
      ] } }, defaultFactCheckContext(), now)
    const route = workReadItems(document)[0]
    if (!route) throw new Error('Expected split routing work')
    runUpdateProposal(document, { mapId: document.id, operationId: route.operationId, id: route.workId, specHash: route.specHash,
      kind: 'plan', reason: 'Extract both independent facts', slots: [
        { id: 'extract-facts', stageId: 'extract', agentRef: { id: 'split-data', version: 0 },
          angle: 'data', hint: 'Extract the opening date and the length separately', priority: 'high', tools: [] },
      ] }, route, now)
    const extract = workReadItems(document)[0]
    if (!extract) throw new Error('Expected split extraction work')
    runUpdateProposal(document, { mapId: document.id, operationId: extract.operationId, id: extract.workId, specHash: extract.specHash,
      kind: 'outputs', reason: 'Two independent claims', outputs: [
        { key: 'opening-date', port: 'claims', typeRef: { id: 'factcheck.claim', version: 1 }, payload: { content: 'The bridge opened in 2020.', category: 'data' } },
        { key: 'bridge-length', port: 'claims', typeRef: { id: 'factcheck.claim', version: 1 }, payload: { content: 'The bridge is 120 metres long.', category: 'data' } },
      ] }, extract, now)
    const splitMerge = workReadItems(document)[0]
    if (!splitMerge) throw new Error('Expected split selection work')
    runUpdateProposal(document, { mapId: document.id, operationId: splitMerge.operationId, id: splitMerge.workId, specHash: splitMerge.specHash,
      kind: 'selection', reason: 'Retain both independent claims', selection: [
        { workId: extract.workId, key: 'opening-date' }, { workId: extract.workId, key: 'bridge-length' },
      ] }, splitMerge, now)
    const run = document.runs[0]
    if (!run) throw new Error('Expected the complete fact-check run')
    const claims = document.nodes.filter((/* split已发布的正式节点。 */ node) => /* 列出下一步必须分别消费的Claim。 */ node.typeId === 'factcheck.claim')
    const verifyOperations = run.operations.filter((/* 同Run已实例化的Operation。 */ operation) => /* 只取each创建的核查组。 */ operation.stepId === 'verify')
    expect(claims).toHaveLength(2)
    expect(verifyOperations).toHaveLength(2)
    const verifyRoutes = workReadItems(document)
    expect(verifyRoutes).toHaveLength(2)
    for (const work of verifyRoutes) {
      expect(work.stageId).toBe('route')
      runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId, specHash: work.specHash,
        kind: 'plan', reason: 'Two independent checks for this claim', slots: [
          { id: 'source-slot', stageId: 'assess', agentRef: { id: 'sources', version: 0 }, angle: 'sources', hint: 'Check this claim against the report', priority: 'high', tools: [] },
          { id: 'logic-slot', stageId: 'assess', agentRef: { id: 'logic', version: 0 }, angle: 'logic', hint: 'Check the reasoning for this claim', priority: 'medium', tools: [] },
        ] }, work, now)
    }
    const assessWorks = workReadItems(document)
    expect(assessWorks).toHaveLength(4)
    for (const work of assessWorks) {
      expect(work.stageId).toBe('assess')
      runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId, specHash: work.specHash,
        kind: 'outputs', reason: `Independent ${work.slotId} assessment`, outputs: [
          { key: `opinion-${work.slotId}`, port: 'opinions', typeRef: { id: 'factcheck.opinion', version: 1 },
            payload: { score: work.slotId === 'source-slot' ? 1 : 0.5, reason: `${work.operationId}: ${work.slotId}`, evidenceClaimIds: [] } },
        ] }, work, now)
    }
    const mergeWorks = workReadItems(document)
    expect(mergeWorks).toHaveLength(2)
    for (const work of mergeWorks) {
      expect(work.stageId).toBe('merge')
      const opinionRefs: Array<{ candidate: { workId: string; key: string } }> = [], sourceKeys: string[] = []
      for (const result of runReadData(document, work.operationId, work).priorStageResults) {
        if (result.mode !== 'outputs') continue
        expect(result.stageId).toBe('assess')
        for (const output of result.outputs) {
          opinionRefs.push({ candidate: { workId: result.workId, key: output.key } })
          sourceKeys.push(`${result.workId}:${output.key}`)
        }
      }
      expect(opinionRefs).toHaveLength(2)
      runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId, specHash: work.specHash,
        kind: 'outputs', reason: 'Merge both opinions for this claim', outputs: [
          { key: 'verification', port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 }, sourceKeys,
            payload: { score: 0.5, reason: `${work.operationId}: combined checks`, opinionIds: opinionRefs } },
        ] }, work, now)
    }
    expect(run.status).toBe('completed')
    expect(run.steps).toMatchObject([{ stepId: 'split', status: 'completed', operationIds: [route.operationId] },
      { stepId: 'verify', status: 'completed', operationIds: verifyOperations.map((/* 每个Claim对应的核查Operation。 */ operation) => /* 对照真实each实例身份。 */ operation.id) }])
    expect(run.operations).toHaveLength(3)
    expect(document.nodes).toHaveLength(9)
    expect(document.edges).toHaveLength(10)
    expect(workReadItems(document)).toEqual([])
    const splitOperation = run.operations.find((/* 同Run的实际Operation。 */ operation) => /* 精确读取最初拆分的生产者。 */ operation.id === route.operationId)
    if (!splitOperation) throw new Error('Expected the completed split operation')
    expect(splitOperation.group.inputRefs).toMatchObject([{ id: news.id, port: 'news', revision: 0, type: { id: 'factcheck.news', version: 1 } }])
    expect(splitOperation.outputRefs.map((/* 拆分正式产物。 */ output) => /* 两个候选必须在同图成为下一步的Claim节点。 */ output.id).sort())
      .toEqual(claims.map((/* 拆分发布的正式Claim。 */ claim) => /* 对照真实节点身份。 */ claim.id).sort())
    const expectedEdges: string[] = []
    for (const claim of claims) {
      expect(claim.producer).toMatchObject({ operationId: route.operationId, transitionRef: { id: 'factcheck.split-news', version: 1 },
        stageId: 'extract', workId: extract.workId, agentRef: { id: 'split-data', version: 0 } })
      const operation = verifyOperations.find((/* 已实例化的核查组。 */ item) => /* 以唯一结构输入找到本Claim的Operation。 */ item.group.inputRefs[0]?.id === claim.id)
      if (!operation) throw new Error('Expected one verification operation for each claim')
      expect(operation.transitionRef).toEqual({ id: 'factcheck.verify-claim', version: 1 })
      expect(operation.group.inputRefs).toMatchObject([{ id: claim.id, revision: 0, port: 'claim', type: { id: 'factcheck.claim', version: 1 } }])
      expect(operation.group.contextRefs).toMatchObject([{ id: news.id, revision: 0, port: 'news', type: { id: 'factcheck.news', version: 1 } }])
      expect(operation.status).toBe('completed')
      expect(operation.outputRefs).toHaveLength(3)
      const opinions = document.nodes.filter((/* 图内正式节点。 */ node) => /* 只取本Operation发布的意见，隔离另一Claim。 */ node.typeId === 'factcheck.opinion' && node.producer?.operationId === operation.id)
      const verification = document.nodes.find((/* 图内正式节点。 */ node) => /* 取得本Operation唯一结论。 */ node.typeId === 'factcheck.verification' && node.producer?.operationId === operation.id)
      if (!verification) throw new Error('Expected one published verification for this claim')
      const mergeWork = mergeWorks.find((/* 两个Claim的汇总Work。 */ work) => /* 锁定本结论实际提交的Work身份。 */ work.operationId === operation.id)
      if (!mergeWork) throw new Error('Expected the merge work for this claim')
      expect(opinions).toHaveLength(2)
      expect(new Set(opinions.map((/* 本Claim的正式意见。 */ opinion) => /* 两种核查必须保留不同内容。 */ opinion.payload.reason)).size).toBe(2)
      const opinionIds = opinions.map((/* 本Claim的正式意见。 */ opinion) => /* 对照结论引用与结构父节点。 */ opinion.id)
      expect(verification.payload.opinionIds).toEqual(expect.arrayContaining(opinionIds))
      expect(verification.payload.opinionIds).toHaveLength(2)
      expect(verification.payloadReferences).toHaveLength(2)
      expect(verification.payloadReferences).toEqual(expect.arrayContaining(opinionIds.map((/* 一项正式意见引用。 */ targetId) =>
        /* 索引保留schema声明的通配路径和本Claim的正式节点身份。 */ ({ path: '/opinionIds/*', targetId }))))
      expect(verification.producer).toMatchObject({ operationId: operation.id, transitionRef: operation.transitionRef,
        stageId: 'merge', workId: mergeWork.workId, agentRef: { id: 'verify-merger', version: 0 } })
      expect(operation.outputRefs.map((/* Operation的正式产物映射。 */ output) => /* 只允许该组两意见与一结论。 */ output.id).sort()).toEqual([...opinionIds, verification.id].sort())
      expectedEdges.push(`${news.id}->${claim.id}`)
      for (const opinion of opinions) {
        const work = assessWorks.find((/* 两Claim的已完成评估Work。 */ item) => /* 根据生产者Work确认意见没有借用另一组结果。 */ item.workId === opinion.producer?.workId)
        if (!work) throw new Error('Expected an accepted assessment work for each opinion')
        expect(work.operationId).toBe(operation.id)
        expect(opinion.producer).toMatchObject({ transitionRef: operation.transitionRef, stageId: 'assess',
          agentRef: { id: work.slotId === 'source-slot' ? 'sources' : 'logic', version: 0 } })
        expectedEdges.push(`${claim.id}->${opinion.id}`, `${opinion.id}->${verification.id}`)
      }
    }
    expect(document.edges.map((/* 同图全部正式边。 */ edge) => {
      // 完整集合同时核对边类型，排除漏边与跨组连线。
      expect(edge.kind).toBe('successor')
      return `${edge.from}->${edge.to}`
    }).sort()).toEqual(expectedEdges.sort())
  })
})

type PublicationContext = { document: GraphDocument; input: GraphNode; operation: GraphOperation; runId: string }
type PublicationRequest = Extract<GraphQuery, { method: 'run.publication.preview' }>['params']

function readPublicationPreview(
  /* 保存待审核候选和冻结输入的运行夹具。 */ context: PublicationContext,
): GraphPublicationPreview {
  // 从真实领域入口读取当前结果审核的权威计划，复用正式公共契约。
  return runReadPublicationPreview(context.document, publicationRequest(context))
}

function publicationRequest(
  /* 需要读取当前待审核身份的运行夹具。 */ context: PublicationContext,
): PublicationRequest {
  // 每次从同一 Operation 取得当前审核身份，避免测试固定随机 ID 或推测审核版本。
  const review = context.operation.review
  if (!review) throw new Error('fixture must have a pending review')
  return { mapId: context.document.id, runId: context.runId, operationId: context.operation.id,
    reviewId: review.id, expectedReviewRevision: review.revision }
}

function startPublicationRun(
  /* 本次运行的正式结果转换，默认采用单阶段输出。 */ ref: DefinitionRef = transitionRef,
  /* 复用既有定义包，调用者可独占调整槽位或发布规则。 */ definition: DefinitionPackage = packageDefinition,
): PublicationContext {
  // 通过真实冻结和 Run 建立流程创建需要人工结果审核的纯领域夹具。
  const configured = structuredClone(definition)
  for (const transition of configured.transitions) {
    transition.review.mode = 'required'
    if (transition.id !== selectionTransitionRef.id) continue
    transition.cardinality = '1:N'
    for (const port of transition.ports.output) port.count.max = 3
    for (const stage of transition.execution.stages) for (const port of stage.outputPorts) port.count.max = 3
    const secondDraft = transition.execution.stages.find((/* 要串行接纳以便引用前一候选的阶段。 */ stage) => /* 读取第二份草稿阶段。 */ stage.id === 'draft-b')
    if (secondDraft) secondDraft.dependsOn = ['draft-a']
  }
  const { document, input } = fixture(), runId = randomUUID()
  runCreateRun(document, { mapId: document.id, id: runId, branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] },
    mode: 'human-in-loop', plan: { steps: [{ id: 'review-step', transitionRef: ref, dependsOn: [],
      input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail' }] } },
  { definitions: definitionsValidateCatalog([configured], [agent]), agents: [agent], tools: [], maxSlots: 4 }, '2026-10-19T00:00:01.000Z')
  const operation = document.runs[0]?.operations[0]
  if (!operation) throw new Error('fixture must create one operation')
  return { document, input, operation, runId }
}

function acceptPublicationOutput(
  /* 拥有当前 Work 与候选的运行夹具。 */ context: PublicationContext,
  /* 要接纳结果的具体输出阶段。 */ stageId: string,
  /* 当前阶段提交的、仍须经过真实 schema 校验的 payload。 */ payload: GraphNode['payload'],
): GraphCandidateRef {
  // 通过真实提案入口保存一份候选，返回后续选择与引用使用的稳定键。
  const work = workReadItems(context.document).find((/* 当前已就绪的阶段 Work。 */ item) => /* 取得指定阶段唯一 Work。 */ item.stageId === stageId)
  if (!work) throw new Error(`fixture has no work for ${stageId}`)
  const key = `${stageId}-output`
  runUpdateProposal(context.document, { mapId: context.document.id, operationId: context.operation.id, id: work.workId,
    specHash: work.specHash, kind: 'outputs', reason: 'Fixture candidate', outputs: [{ key, port: 'summary', typeRef: outputType, payload }] },
  work, '2026-10-19T00:00:02.000Z')
  return { workId: work.workId, key }
}

function acceptPublicationSelection(
  /* 拥有最终选择阶段的运行夹具。 */ context: PublicationContext,
  /* 此槽位真实选择的候选键。 */ selection: GraphCandidateRef[],
  /* 动态多槽位场景指定具体选择者；默认取得当前首个选择 Work。 */ slotId?: string,
): void {
  // 从已就绪 Work 接纳最终选择，最后一个槽位完成后自然进入结果审核。
  const work = workReadItems(context.document).find((/* 当前可提交的阶段 Work。 */ item) => /* 锁定选择阶段与可选槽位。 */ item.stageId === 'select' && (slotId === undefined || item.slotId === slotId))
  if (!work) throw new Error('fixture has no selection work')
  runUpdateProposal(context.document, { mapId: context.document.id, operationId: context.operation.id, id: work.workId,
    specHash: work.specHash, kind: 'selection', reason: 'Fixture selection', selection }, work, '2026-10-19T00:00:03.000Z')
}

function approvePublication(
  /* 将在真实审核入口内修改的独占事务图草稿。 */ context: PublicationContext,
  /* 调用者核对过的版本；省略用于保护旧合同。 */ expectedPublicationVersion?: string,
): ReturnType<typeof runAnswerReview> {
  // 通过既有审核入口批准，版本参数省略时仍保护旧调用合同。
  const input = { ...publicationRequest(context), decision: 'approve' as const,
    ...(expectedPublicationVersion === undefined ? {} : { expectedPublicationVersion }) }
  return runAnswerReview(context.document, input, '2026-10-19T00:00:04.000Z')
}

function publicationOutputs(
  /* 保存已接纳候选的 Operation。 */ operation: GraphOperation,
): GraphProposedOutput[] {
  // 在异常夹具中精确修改已保存候选，模拟存储边界必须共同拒绝的不一致记录。
  return operation.stages.flatMap((/* 该 Operation 的阶段结果组。 */ stage) => /* 汇集输出阶段接纳的候选。 */ stage.results.flatMap(
    (/* 可能为选择、计划或输出的已保存结果。 */ result) => /* 仅返回输出候选，保留真实对象便于构造坏记录。 */ result.mode === 'outputs' ? result.outputs : [],
  ))
}

describe('authoritative publication preview', () => {
  // 对照真实审核发布流程，保护权威集合、只读查询和版本条件。
  it('previews output results without mutating any graph state and publishes exactly that set', () => {
    // 同一审核重复读取必须稳定；实际发布保留候选键、端口和既有后继规则。
    const context = startPublicationRun(), selected = acceptPublicationOutput(context, 'summarize', { text: 'Reviewed result' })
    const before = structuredClone(context.document), preview = readPublicationPreview(context)
    expect(readPublicationPreview(context)).toEqual(preview)
    expect(context.document).toEqual(before)
    const request = publicationRequest(context)
    expect(preview).toMatchObject({ mapId: request.mapId, runId: request.runId, operationId: request.operationId, reviewId: request.reviewId,
      reviewRevision: 0, specHash: context.operation.specHash,
      ports: [{ port: 'summary', typeRef: outputType, count: 1 }], items: [{ ...selected, stageId: 'summarize', slotId: 'summarize',
        port: 'summary', typeRef: outputType, directlySelected: true, referencedBy: [] }] })
    expect(preview.publicationVersion).toEqual(expect.any(String))
    expect(preview.items[0]).not.toHaveProperty('payload')
    expect(preview.items[0]).not.toHaveProperty('nodeId')
    const result = approvePublication(context, preview.publicationVersion)
    expect(context.operation.outputRefs).toMatchObject(preview.items.map((/* 权威预览中承诺发布的一项。 */ item) => /* 对照实际产物稳定键与端口。 */ ({ workId: item.workId, key: item.key, port: item.port })))
    expect(result.nodeIds).toHaveLength(1)
    expect(context.document.edges).toContainEqual(expect.objectContaining({ kind: 'successor', from: context.input.id, to: result.nodeIds[0] }))
    expect(() => {
      // 已完成运行不再提供待审核发布预览。
      readPublicationPreview(context)
    }).toThrow(expect.objectContaining({ code: 'RUN_NOT_ACTIVE' }))
  })

  it('merges every final selector and deduplicates candidates selected by multiple slots', () => {
    // 使用真实受限 plan 产生两个最终选择槽位，防止预览只读取最后一份 selection。
    const definition = structuredClone(packageDefinition)
    const transition = definition.transitions.find((/* 当前定义包中的转换。 */ item) => /* 读取最终选择转换。 */ item.id === selectionTransitionRef.id)
    if (!transition) throw new Error('selection transition is missing')
    transition.execution.stages.unshift({ id: 'route', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'plan',
      outputPorts: [], promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } },
      plan: { stageIds: ['select'], agentRefs: [agentRef], maxSlots: 2 } })
    const selector = transition.execution.stages.find((/* 最终选择模板。 */ stage) => /* 增加对槽位规划的依赖。 */ stage.id === 'select')
    if (!selector) throw new Error('selection stage is missing')
    selector.dependsOn.push('route')
    const context = startPublicationRun(selectionTransitionRef, definition)
    const route = workReadItems(context.document).find((/* 当前可领取的 Work。 */ work) => /* 取得槽位规划 Work。 */ work.stageId === 'route')
    if (!route) throw new Error('planning work is missing')
    runUpdateProposal(context.document, { mapId: context.document.id, operationId: context.operation.id, id: route.workId,
      specHash: route.specHash, kind: 'plan', reason: 'Two selectors', slots: ['one', 'two'].map((/* 最终选择槽位身份。 */ id) => /* 建立已被冻结允许的槽位。 */
        ({ id, stageId: 'select', agentRef, angle: '', hint: '', priority: 'medium' as const, tools: [] })) }, route, '2026-10-19T00:00:01.500Z')
    expect(() => {
      // 规划审核不属于本批支持的结果发布预览。
      readPublicationPreview(context)
    }).toThrow(expect.objectContaining({ code: 'REVIEW_CONFLICT' }))
    approvePublication(context)
    const first = acceptPublicationOutput(context, 'draft-a', { text: 'First' })
    const second = acceptPublicationOutput(context, 'draft-b', { text: 'Second' })
    acceptPublicationSelection(context, [first], 'one')
    acceptPublicationSelection(context, [first, second], 'two')
    const preview = readPublicationPreview(context)
    expect(preview.items).toHaveLength(2)
    expect(preview.items).toEqual(expect.arrayContaining([expect.objectContaining(first), expect.objectContaining(second)]))
    expect(preview.ports).toEqual([{ port: 'summary', typeRef: outputType, count: 2 }])
    approvePublication(context, preview.publicationVersion)
    expect(context.operation.outputRefs).toHaveLength(2)
    expect(context.operation.outputRefs).toEqual(expect.arrayContaining([expect.objectContaining(first), expect.objectContaining(second)]))
  })

  it.each([false, true])('explains permitted direct references when the dependency is also selected: %s', (/* 依赖候选是否同时被最终 selector 直接选择。 */ alsoSelected) => {
    // 引用闭包中的直接引用方明确；一个候选同时被选择和引用时两类信息均保留。
    const context = startPublicationRun(selectionTransitionRef), first = acceptPublicationOutput(context, 'draft-a', { text: 'Dependency' })
    const second = acceptPublicationOutput(context, 'draft-b', { text: 'Conclusion', nextId: { candidate: { ...first } } })
    acceptPublicationSelection(context, alsoSelected ? [first, second] : [second])
    const preview = readPublicationPreview(context)
    expect(preview.items).toHaveLength(2)
    expect(preview.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ ...first, directlySelected: alsoSelected, referencedBy: [second] }),
      expect.objectContaining({ ...second, directlySelected: true, referencedBy: [] }),
    ]))
    approvePublication(context, preview.publicationVersion)
    const firstOutput = context.operation.outputRefs.find((/* 已正式发布的候选引用。 */ ref) => /* 取得依赖候选的节点身份。 */ ref.workId === first.workId && ref.key === first.key)
    const secondOutput = context.operation.outputRefs.find((/* 已正式发布的候选引用。 */ ref) => /* 取得引用方的节点身份。 */ ref.workId === second.workId && ref.key === second.key)
    if (!firstOutput || !secondOutput) throw new Error('both reference endpoints must be published')
    expect(context.document.nodes.find((/* 本次图内正式节点。 */ node) => /* 对照引用方最终 payload。 */ node.id === secondOutput.id)?.payload.nextId).toBe(firstOutput.id)
  })

  it('keeps only explicitly selected candidates when reference closure is disabled', () => {
    // 关闭闭包不会把无引用且未入选的同阶段候选自动带入正式集合。
    const definition = structuredClone(packageDefinition), transition = definition.transitions[1]
    transition.publication = { includeReferencedCandidates: false }
    const context = startPublicationRun(selectionTransitionRef, definition)
    acceptPublicationOutput(context, 'draft-a', { text: 'Not selected' })
    const chosen = acceptPublicationOutput(context, 'draft-b', { text: 'Selected' })
    acceptPublicationSelection(context, [chosen])
    const preview = readPublicationPreview(context)
    expect(preview.items).toMatchObject([{ ...chosen, directlySelected: true, referencedBy: [] }])
    approvePublication(context, preview.publicationVersion)
    expect(context.operation.outputRefs).toMatchObject([chosen])
  })

  it.each(['cycle', 'missing', 'forbidden', 'closed', 'cardinality', 'type'] as const)('rejects the same invalid publication rule in preview and approval: %s', (/* 该夹具仅破坏的一条发布规则。 */ problem) => {
    // 合法候选经真实提案接纳后，仅构造待发布的单项坏记录，核对两入口共用拒绝规则。
    const context = startPublicationRun(selectionTransitionRef), first = acceptPublicationOutput(context, 'draft-a', { text: 'Dependency' })
    const second = acceptPublicationOutput(context, 'draft-b', { text: 'Conclusion', nextId: { candidate: { ...first } } })
    acceptPublicationSelection(context, [second])
    const outputs = publicationOutputs(context.operation), conclusion = outputs[1]
    if (!conclusion) throw new Error('conclusion candidate is missing')
    const transition = context.operation.executionSpec.transition
    if (problem === 'cycle') conclusion.payload.nextId = { candidate: { ...second } }
    if (problem === 'missing') conclusion.payload.nextId = { candidate: { workId: randomUUID(), key: 'missing' } }
    if (problem === 'forbidden') transition.publication = { includeReferencedCandidates: true, candidateStages: [] }
    if (problem === 'closed') transition.publication = { includeReferencedCandidates: false }
    if (problem === 'cardinality') transition.ports.output[0].count.max = 1
    if (problem === 'type') conclusion.typeRef = inputType
    const code = problem === 'cardinality' ? 'OUTPUT_CARDINALITY' : problem === 'type' ? 'INVALID_OUTPUT' : 'OUTPUT_REFERENCE_INVALID'
    expect(() => {
      // 预览必须命中该坏记录的领域规则，不能以导出缺失等故障冒充通过。
      readPublicationPreview(context)
    }).toThrow(expect.objectContaining({ code }))
    expect(() => {
      // 正式批准对同一个坏记录必须执行同一项领域校验。
      approvePublication(context)
    }).toThrow(expect.objectContaining({ code }))
    expect(context.document.nodes).toEqual([context.input])
    expect(context.document.edges).toEqual([])
  })

  it('ignores unrelated map revisions, time, pause and control metadata in the preview version', () => {
    // 版本只绑定审核与发布依赖；另一分支和控制租约变化不要求重新核对候选。
    const context = startPublicationRun()
    acceptPublicationOutput(context, 'summarize', { text: 'Stable' })
    const preview = readPublicationPreview(context)
    context.document.revision += 1
    context.document.updatedAt = '2026-10-19T01:00:00.000Z'
    context.document.ownershipRevision = 1
    context.document.branchOwnerships = { control: { leaseId: randomUUID(), kind: 'control', runId: context.runId,
      ownerUserId: randomUUID(), holderId: randomUUID(), fence: 1, expiresAt: '2026-10-19T01:01:00.000Z', leaseMs: 60_000 } }
    context.document.nodes.push({ ...context.input, id: randomUUID(), payload: { text: 'Another branch' } })
    const run = context.document.runs[0]
    if (run.status !== 'running' && run.status !== 'waiting') throw new Error('fixture must remain active')
    run.paused = true
    expect(readPublicationPreview(context).publicationVersion).toBe(preview.publicationVersion)
    approvePublication(context, preview.publicationVersion)
    expect(context.operation.status).toBe('completed')
  })

  it('rejects a supplied mismatching publication version before changing the review or graph', () => {
    // 该保护在没有预览导出的旧实现也能独立失败，避免把缺失导出当作全部红灯证据。
    const context = startPublicationRun()
    acceptPublicationOutput(context, 'summarize', { text: 'Reviewed' })
    const before = structuredClone(context.document)
    expect(() => {
      // 未核对当前发布内容的版本必须在任何写入前拒绝。
      approvePublication(context, 'sha256:another-publication')
    }).toThrow(expect.objectContaining({ status: 409, code: 'PUBLICATION_PREVIEW_CONFLICT' }))
    expect(context.document).toEqual(before)
  })

  it('binds the publication version to accepted candidate content rather than candidate identity alone', () => {
    // 直接构造历史记录内容变化以保护版本摘要，候选键未变也不能沿用旧批准条件。
    const context = startPublicationRun()
    acceptPublicationOutput(context, 'summarize', { text: 'Previously reviewed' })
    const preview = readPublicationPreview(context), output = publicationOutputs(context.operation)[0]
    if (!output) throw new Error('output candidate is missing')
    output.payload.text = 'Changed candidate content'
    expect(readPublicationPreview(context).publicationVersion).not.toBe(preview.publicationVersion)
    const before = structuredClone(context.document)
    expect(() => {
      // 旧版本不能批准内容已经不同的候选集合。
      approvePublication(context, preview.publicationVersion)
    }).toThrow(expect.objectContaining({ code: 'PUBLICATION_PREVIEW_CONFLICT' }))
    expect(context.document).toEqual(before)
  })

  it('preserves input and review conflicts rather than allowing an old preview to authorize publication', () => {
    // 真实依赖版本或审核身份改变后，即便携带旧预览也必须沿既有过期语义拒绝。
    const context = startPublicationRun()
    acceptPublicationOutput(context, 'summarize', { text: 'Reviewed' })
    const preview = readPublicationPreview(context), request = publicationRequest(context)
    context.input.revision += 1
    expect(() => {
      // 预览不得掩盖执行输入过期。
      readPublicationPreview(context)
    }).toThrow(expect.objectContaining({ code: 'INPUT_STALE' }))
    expect(() => {
      // 携带旧预览条件也必须优先保留输入过期语义。
      approvePublication(context, preview.publicationVersion)
    }).toThrow(expect.objectContaining({ code: 'INPUT_STALE' }))
    context.input.revision -= 1
    const review = context.operation.review
    if (!review) throw new Error('result review is missing')
    review.revision += 1
    const staleInput = { ...request, decision: 'approve' as const, expectedPublicationVersion: preview.publicationVersion }
    expect(() => {
      // 审核版本改变后仍由既有审核冲突保护身份。
      runAnswerReview(context.document, staleInput, '2026-10-19T00:00:05.000Z')
    }).toThrow(expect.objectContaining({ code: 'REVIEW_CONFLICT' }))
    expect(context.document.nodes).toEqual([context.input])
    expect(context.operation.review?.state).toBe('pending')
  })
})
