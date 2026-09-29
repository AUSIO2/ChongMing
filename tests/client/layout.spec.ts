// 通用数据图布局测试：验证精确定义展示、真实关系、有限计划与阶段进度。
import { describe, expect, it } from 'vitest'
import type { DefinitionCatalog, TransitionDefinition } from '../../contracts/data-definition'
import type { GraphEdge, GraphNode, GraphOperation, GraphRun } from '../../contracts/graph'
import {
  graphCanProcessNode, graphCreateRunPlan, graphReadAvailableTransitions, graphReadCanvasLayout,
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

function node(id: string, type = textType, payload = { body: id }): GraphNode {
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
  return { id: 'run', scope: { nodeIds: [] }, plan: { steps: [] }, definitions: catalog, agents: [], tools: [], paused: false, regenerate: false,
    mode: 'human-in-loop', status: 'running', steps: [], operations: [op], createdAt: time, updatedAt: time }
}

describe('generic client data graph layout', () => {
  it('uses exact registered types to select a transition and build a finite plan', () => {
    const input = node('input')
    const wrongVersion = node('old', { ...textType, version: 2 })
    expect(graphCanProcessNode(input, transition)).toBe(true)
    expect(graphCanProcessNode(wrongVersion, transition)).toBe(false)
    expect(graphReadAvailableTransitions([input], catalog)).toEqual([transition])
    expect(graphReadAvailableTransitions([wrongVersion], catalog)).toEqual([])
    expect(graphCreateRunPlan(transition, [input.id])).toMatchObject({ steps: [{ transitionRef: { id: transition.id, version: 1 },
      input: [{ port: 'document', source: { kind: 'scope', nodeIds: ['input'] } }], grouping: { mode: 'each' } }] })
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
