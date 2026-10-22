// 通用数据图布局测试：验证精确定义展示、真实关系、有限计划与阶段进度。
import { describe, expect, it } from 'vitest'
import type { DefinitionCatalog, TransitionDefinition } from '../../contracts/data-definition'
import type { GraphEdge, GraphNode, GraphPayload } from '../../contracts/graph'
import type { GraphOperation, GraphRun } from '../../contracts/graph-run'
import {
  graphCreateRunPlan, graphReadAvailableTransitions, graphReadCanvasLayout,
  graphReadCanvasNeighbor, graphReadNodeText, graphReadOperationProgress, graphReadRunProgress,
} from '../../apps/ui/features/graph/graph-layout'

const time = '2026-09-28T00:00:00.000Z'
const textType = { id: 'demo.text', version: 1 }
const summaryType = { id: 'demo.summary', version: 1 }
const transition: TransitionDefinition = {
  id: 'demo.summarize', version: 1, title: '生成摘要', cardinality: '1:1',
  group: { mode: 'explicit-members', ready: 'sealed-all-required' },
  ports: { input: [{ name: 'document', inputType: textType, count: { min: 1, max: 1 } }], context: [],
    output: [{ name: 'summary', outputType: summaryType, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'document' }] }] },
  execution: { stages: [{ id: 'summarize', kind: 'agent', agentRef: { id: 'demo.agent', version: 1 }, dependsOn: [], ready: 'all-dependencies',
    resultMode: 'outputs', outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }] }], resultStage: 'summarize' },
  review: { mode: 'required', at: 'result', onReject: 'fail' },
}
const catalog: DefinitionCatalog = { revision: 1, packages: [], index: [], dataTypes: [
  { ...textType, title: '原文', schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false },
    successorTypes: [summaryType], presentation: { titlePath: '/body', summaryPath: '/body' }, references: [], agentProjection: { include: ['/body'], mapEntryFilters: [] } },
  { ...summaryType, title: '摘要', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false },
    successorTypes: [], presentation: { summaryPath: '/summary' }, references: [], agentProjection: { include: ['/summary'], mapEntryFilters: [] } },
], transitions: [transition] }

function node(id: string, type = textType, payload: GraphPayload = { body: id }): GraphNode {
  return { id, revision: 0, typeId: type.id, typeVersion: type.version, payload, createdAt: time, updatedAt: time }
}
function edge(id: string, from: string, to: string, kind: GraphEdge['kind'] = 'successor'): GraphEdge {
  return { id, from, to, kind, revision: 0, createdAt: time, updatedAt: time }
}
function operation(status: GraphOperation['status'] = 'running'): GraphOperation {
  return {
    id: 'operation', stepId: 'step', transitionRef: transition, specHash: 'hash', status,
    group: { id: 'group', inputRefs: [], contextRefs: [], sealed: true }, externalInputs: {}, outputRefs: [], review: null,
    executionSpec: { transition, dataTypes: catalog.dataTypes, inputs: {}, context: {}, stages: [], resultStage: 'summarize', review: transition.review, definitionDigests: [], specHash: 'hash' },
    stages: [{ stageId: 'summarize', expectedWorkIds: ['work-a', 'work-b'], results: [], planSlots: [], closed: false }],
  }
}
function run(op: GraphOperation): GraphRun {
  return { id: 'run', scope: { nodeIds: [] }, branchState: { scope: { rootIds: [], nodeIds: [], edgeIds: [] }, version: 'fixture-branch' },
    maxAgentSlots: 4, plan: { steps: [] }, definitions: catalog, agents: [], tools: [], paused: false, regenerate: false,
    mode: 'human-in-loop', status: 'running', steps: [], operations: [op], createdAt: time, updatedAt: time }
}

describe('generic client data graph layout', () => {
  it('keeps a finished Operation from announcing completion of an unfinished multi-step Run', () => {
    // 一个处理项完成而后步未启动时，摘要必须明确整个计划的真实步骤分母。
    const current = run(operation('completed'))
    current.plan = graphCreateRunPlan(transition, ['input'])
    const first = current.plan.steps[0]
    current.plan.steps.push({ ...structuredClone(first), id: 'later', dependsOn: [first.id] })
    current.steps = [{ stepId: first.id, status: 'completed', operationIds: ['operation'] }, { stepId: 'later', status: 'pending', operationIds: [] }]
    expect(graphReadRunProgress(current)).toContain('1 / 2 步骤已完成')
    expect(graphReadRunProgress(current)).toContain('已实例化')
    expect(graphReadRunProgress(current)).not.toContain('处理已完成')
  })
  it('uses exact registered types to select a transition and build a finite plan', () => {
    const input = node('input')
    const wrongVersion = node('old', { ...textType, version: 2 })
    expect(graphReadAvailableTransitions([input], catalog)).toEqual([transition])
    expect(graphReadAvailableTransitions([wrongVersion], catalog)).toEqual([])
    expect(graphCreateRunPlan(transition, [input.id])).toMatchObject({ steps: [{ transitionRef: { id: transition.id, version: 1 },
      input: [{ port: 'document', source: { kind: 'scope', nodeIds: ['input'] } }], grouping: { mode: 'each' } }] })
  })

  it.each(['multiple-inputs', 'required-context', 'aggregate-count'] as const)('offers a configurable transition seed before %s is complete', (/* 当前单节点尚未填完的计划配置。 */ requirement) => {
    // 节点入口只判断能否为某个输入端口预填，完整端口与数量由统一运行草稿校验。
    const advanced = structuredClone(transition)
    let selected = node('input')
    if (requirement === 'multiple-inputs') {
      advanced.cardinality = 'N:1'
      advanced.ports.input.push({ name: 'comparison', inputType: summaryType, count: { min: 1, max: 1 } })
      selected = node('second-port-seed', summaryType, { summary: '可作为第二输入的保存节点' })
    } else if (requirement === 'required-context') {
      advanced.ports.context = [{ name: 'background', inputType: summaryType, count: { min: 1, max: 1 } }]
    } else {
      advanced.cardinality = 'N:1'
      advanced.ports.input[0].count = { min: 2, max: 8 }
    }
    expect(graphReadAvailableTransitions([selected], { ...catalog, transitions: [advanced] })).toEqual([advanced])
    expect(graphReadAvailableTransitions([{ ...selected, typeVersion: 999 }], { ...catalog, transitions: [advanced] })).toEqual([])
    if (requirement === 'multiple-inputs') expect(graphReadAvailableTransitions([node('first-port'), selected], { ...catalog, transitions: [advanced] })).toEqual([])
  })

  it('does not offer an input seed merely because the node matches a context port', () => {
    // 上下文类型不能冒充结构输入，空选择或缺目录也不产生配置入口。
    const contextual = structuredClone(transition)
    contextual.ports.context = [{ name: 'background', inputType: summaryType, count: { min: 1, max: 1 } }]
    const contextOnly = node('context-only', summaryType, { summary: '仅能作为上下文' })
    expect(graphReadAvailableTransitions([contextOnly], { ...catalog, transitions: [contextual] })).toEqual([])
    expect(graphReadAvailableTransitions([], catalog)).toEqual([])
    expect(graphReadAvailableTransitions([node('input')], null)).toEqual([])
  })

  it('reads presentation paths and lays out every successor/reference relation once', () => {
    const a = node('a', textType, { body: 'Document A' }), b = node('b', textType, { body: 'Document B' })
    const shared = node('summary', summaryType, { summary: 'Shared result' })
    const edges = [edge('a-summary', a.id, shared.id), edge('b-summary', b.id, shared.id), edge('a-b', a.id, b.id, 'reference')]
    const layout = graphReadCanvasLayout({ nodes: [shared, b, a], edges: [...edges].reverse() }, catalog)
    expect(graphReadNodeText(shared, catalog)).toBe('Shared result')
    expect(layout.nodes.filter(item => item.id === shared.id)).toHaveLength(1)
    expect(layout.edges.map(item => item.id).sort()).toEqual(edges.map(item => item.id).sort())
    expect(layout.edges.find(item => item.id === 'a-b')?.cross).toBe(true)
    expect(layout.columns.map(column => column.label)).toEqual(['原文', '摘要'])
    expect(layout.nodes.every(item => item.x + item.width <= layout.width && item.y + item.height <= layout.height)).toBe(true)
    expect(graphReadCanvasNeighbor(layout, 'a', 'ArrowRight')).toBe('summary')
    expect(graphReadCanvasLayout({ nodes: [a, b, shared], edges }, catalog)).toEqual(layout)
  })

  it('reports generic stage and review progress without business operation names', () => {
    const op = operation()
    expect(graphReadOperationProgress(op)).toBe('summarize · 0 / 2 项完成')
    op.stages[0].results.push({ workId: 'work-a', stageId: 'summarize', slotId: 'a', acceptedAt: time, reason: 'done', mode: 'outputs', outputs: [] })
    expect(graphReadOperationProgress(op)).toBe('summarize · 1 / 2 项完成')
    op.status = 'waiting'; op.review = { id: 'review', kind: 'result', revision: 0, state: 'pending', decision: null, createdAt: time, answeredAt: null }
    expect(graphReadRunProgress(run(op))).toBe('等待确认处理结果')
    op.status = 'completed'; op.stages[0].closed = true
    const completed = run(op); completed.status = 'completed'
    expect(graphReadRunProgress(completed)).toBe('处理已完成 · 1 / 1 项已完成')
  })

  it('handles an empty graph without type-specific fallback columns', () => {
    expect(graphReadCanvasLayout({ nodes: [], edges: [] }, catalog)).toMatchObject({ nodes: [], edges: [], columns: [], width: 520, height: 330 })
  })
})
