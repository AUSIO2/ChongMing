import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, GraphRun } from '../../contracts/graph'
import { graphCanProcessNode, graphReadCanvasLayout, graphReadCanvasNeighbor, graphReadOperationProgress, graphReadRunProgress } from '../../apps/ui/features/graph/graph-layout'

const time = '2026-09-11T00:00:00.000Z'
function layoutCreateNode(id: string, data: GraphNode['data']): GraphNode {
  return { id, data, revision: 0, createdAt: time, updatedAt: time }
}
function layoutCreateEdge(id: string, from: string, to: string, kind: GraphEdge['kind'] = 'mentions'): GraphEdge {
  return { id, from, to, kind, revision: 0, createdAt: time, updatedAt: time }
}

describe('Client data graph layout', () => {
  it('selects only usable scope roots for each processing boundary', () => {
    const nodes = [layoutCreateNode('source', { kind: 'source', locator: { kind: 'url', url: 'https://example.com' }, label: null }),
      layoutCreateNode('news', { kind: 'news', content: 'News', context: {} }), layoutCreateNode('claim', { kind: 'claim', content: 'Claim', category: null }),
      layoutCreateNode('verification', { kind: 'verification', score: 1, reason: 'Evidence', reportIds: [], opinions: [] })]
    expect(nodes.filter(node => graphCanProcessNode(node, 'news')).map(node => node.id)).toEqual(['source'])
    expect(nodes.filter(node => graphCanProcessNode(node, 'claims')).map(node => node.id)).toEqual(['source', 'news'])
    expect(nodes.filter(node => graphCanProcessNode(node, 'verified')).map(node => node.id)).toEqual(['source', 'news', 'claim'])
    const layout = graphReadCanvasLayout({ nodes, edges: [layoutCreateEdge('derived', 'news', 'source', 'derived-from')] })
    expect(layout.edges.find(edge => edge.id === 'derived')).toMatchObject({ from: 'news', to: 'source', kind: 'derived-from' })
  })

  it('places shared nodes once and draws every real edge, including reverse and same-column relations', () => {
    const nodes = [
      layoutCreateNode('news-a', { kind: 'news', content: 'Source A', context: {} }),
      layoutCreateNode('news-b', { kind: 'news', content: 'Source B', context: {} }),
      layoutCreateNode('claim', { kind: 'claim', content: 'Shared claim', category: null }),
      layoutCreateNode('verification', { kind: 'verification', score: 0.5, reason: 'Explicit merger conclusion', reportIds: [], opinions: [] }),
    ]
    const edges = [layoutCreateEdge('a-c', 'news-a', 'claim'), layoutCreateEdge('b-c', 'news-b', 'claim'),
      layoutCreateEdge('v-c', 'verification', 'claim', 'verifies'), layoutCreateEdge('a-b', 'news-a', 'news-b', 'related-to')]
    const layout = graphReadCanvasLayout({ nodes, edges })
    expect(layout.nodes.filter(item => !item.synthetic).map(item => item.node.id)).toEqual(['news-a', 'news-b', 'claim', 'verification'])
    expect(layout.nodes.filter(item => !item.synthetic && item.node.id === 'claim')).toHaveLength(1)
    expect(layout.edges.filter(edge => edge.kind !== 'branch')).toHaveLength(edges.length)
    expect(layout.edges.find(edge => edge.id === 'v-c')).toMatchObject({ from: 'verification', to: 'claim' })
    expect(new Set(layout.edges.map(edge => edge.path)).size).toBe(layout.edges.length)
    expect(layout.edges.every(edge => !/NaN|Infinity/.test(edge.path))).toBe(true)
    expect(graphReadCanvasLayout({ nodes: [...nodes].reverse(), edges: [...edges].reverse() })).toEqual(layout)
    expect(layout.nodes.find(item => item.id === graphReadCanvasNeighbor(layout, 'news-a', 'ArrowRight'))?.kind).toBe('splitAgent')
    expect(graphReadCanvasNeighbor(layout, 'news-b', 'ArrowUp')).toBe('news-a')
    expect(graphReadCanvasNeighbor(layout, 'news-a', 'ArrowLeft')).toBeNull()
  })

  it('handles empty graphs and each supported kind without a legacy parent tree', () => {
    expect(graphReadCanvasLayout({ nodes: [], edges: [] })).toMatchObject({ nodes: [], edges: [], columns: [] })
    const nodes = [
      layoutCreateNode('source', { kind: 'source', locator: { kind: 'url', url: 'https://example.com' }, label: null }),
      layoutCreateNode('evidence', { kind: 'evidence', content: 'Archive excerpt', locator: { kind: 'url', url: 'https://example.com' }, capturedAt: time }),
    ]
    const layout = graphReadCanvasLayout({ nodes, edges: [] })
    expect(layout.columns.map(column => column.kind)).toEqual(['source', 'evidence'])
    expect(layout.nodes.every(node => node.x >= 0 && node.y >= 0 && node.x + node.width <= layout.width && node.y + node.height <= layout.height)).toBe(true)
  })

  it('keeps independent news subtrees disjoint and centres each parent over its facts', () => {
    const news = ['a', 'b'].map(id => layoutCreateNode(id, { kind: 'news', content: id, context: {} }))
    const claims = ['a1', 'a2', 'b1', 'b2'].map(id => layoutCreateNode(id, { kind: 'claim', content: id, category: null }))
    const layout = graphReadCanvasLayout({ nodes: [...news, ...claims], edges: claims.map(node => layoutCreateEdge(node.id, node.id, node.id[0], 'derived-from')) })
    const find = (id: string) => layout.nodes.find(node => node.id === id)!
    expect(find('a').y).toBeCloseTo((find('a1').y + find('a2').y) / 2)
    expect(find('b').y).toBeCloseTo((find('b1').y + find('b2').y) / 2)
    expect(find('a2').y + find('a2').height).toBeLessThan(find('b1').y)
    expect(layout.nodes.filter(node => node.kind === 'splitAgent')).toHaveLength(2)
    for (const node of layout.nodes) for (const other of layout.nodes) {
      if (node.id !== other.id && node.x === other.x) expect(Math.abs(node.y - other.y)).toBeGreaterThanOrEqual(node.height)
    }
  })

  it('restores all saved opinion branches even without a current run', () => {
    const claim = layoutCreateNode('claim', { kind: 'claim', content: 'Claim', category: null })
    const result = layoutCreateNode('result', { kind: 'verification', score: 0.5, reason: 'Summary', reportIds: ['r1', 'r2'],
      opinions: ['r1', 'r2'].map(id => ({ id, slotId: id, agentId: id, agentName: id, angle: id, tools: [], routeRevision: 1, score: 1, reason: 'Evidence ' + id, createdAt: time })) })
    const layout = graphReadCanvasLayout({ nodes: [claim, result], edges: [layoutCreateEdge('result-claim', 'result', 'claim', 'verifies')], run: null })
    const agents = layout.nodes.filter(node => node.kind === 'verifyAgent')
    const opinions = layout.nodes.filter(node => node.kind === 'opinion')
    expect(agents).toHaveLength(2)
    expect(opinions).toHaveLength(2)
    expect(agents.every(node => node.parentId === claim.id && node.selectId === claim.id)).toBe(true)
    expect(opinions.every(node => node.selectId === result.id)).toBe(true)
    expect(layout.nodes.find(node => node.id === result.id)!.y).toBe((opinions[0].y + opinions[1].y) / 2)
    expect(layout.edges.filter(edge => edge.displayTo === result.id)).toHaveLength(2)
  })

  it('reports only persisted progress and does not turn collected reports into a final verdict', () => {
    const profile = { id: 'agent', name: 'Agent', description: 'Evidence', content: 'Review', tools: [], provider: 'fixture', model: 'fixture' }
    const run: GraphRun = {
      id: 'run', scope: { nodeIds: ['claim'] }, until: 'verified', paused: false, regenerate: false, mode: 'human-in-loop', status: 'running', createdAt: time, updatedAt: time,
      configuration: { router: profile, merger: profile, agents: [profile], tools: [], maxSlots: 2 },
      operations: [{ id: 'operation', kind: 'verify', targetId: 'claim', status: 'running', inputRefs: [], configurationHash: 'fixture', outputRefs: [], splitReports: [], contentDraft: null, route: null, draft: null, reports: [], review: null, resultNodeId: null }],
    }
    expect(graphReadRunProgress(run)).toContain('规划')
    run.operations[0].route = { revision: 1, approved: true, reason: 'Two angles', slots: ['one', 'two'].map(id => ({ id, agentId: 'agent', angle: id, priority: 'medium', hint: '', tools: [] })) }
    expect(graphReadRunProgress(run)).toBe('已收集 0 / 2 份意见')
    run.operations[0].reports = ['one', 'two'].map(slotId => ({ id: slotId, slotId, agentId: 'agent', agentName: 'Agent', angle: slotId, tools: [], routeRevision: 1, score: 1, reason: 'Evidence', createdAt: time }))
    expect(graphReadRunProgress(run)).toBe('意见已收齐，等待汇总结果')
    const claim = layoutCreateNode('claim', { kind: 'claim', content: 'Claim', category: null })
    const branches = graphReadCanvasLayout({ nodes: [claim], edges: [], run })
    expect(branches.nodes.filter(node => node.kind === 'verifyAgent')).toHaveLength(2)
    expect(branches.nodes.filter(node => node.kind === 'opinion')).toHaveLength(2)
    expect(branches.nodes.every(node => node.selectId === claim.id)).toBe(true)
    expect(branches.nodes.some(node => node.kind === 'verification')).toBe(false)
    run.status = 'waiting'
    run.operations[0].status = 'waiting'
    run.operations[0].review = { id: 'review', kind: 'result', revision: 0, state: 'pending', decision: null, createdAt: time, answeredAt: null }
    expect(graphReadRunProgress(run)).toBe('等待保存处理结果')
    run.paused = true
    expect(graphReadRunProgress(run)).toBe('已暂停 · 0 / 1 项已完成')
    expect(graphReadCanvasLayout({ nodes: [claim], edges: [], run }).nodes.filter(node => node.kind === 'verifyAgent').every(node => node.status === '已提交')).toBe(true)
    expect(graphReadOperationProgress(run.operations[0])).toBe('等待保存处理结果')
    run.status = 'completed'
    run.operations[0].status = 'completed'
    expect(graphReadRunProgress(run)).toBe('处理已完成 · 1 / 1 项已完成')
    run.status = 'waiting'
    run.paused = false
    const operation = run.operations[0]
    operation.kind = 'parse'
    operation.status = 'waiting'
    operation.targetId = 'source'
    operation.contentDraft = { kind: 'parse', reason: 'Extract', news: [{ content: 'Candidate A', context: {} }, { content: 'Candidate B', context: {} }] }
    const source = layoutCreateNode('source', { kind: 'source', locator: { kind: 'url', url: 'https://example.com' }, label: null })
    const parse = graphReadCanvasLayout({ nodes: [source], edges: [], run })
    expect(parse.nodes.filter(node => node.kind === 'parseAgent')).toHaveLength(1)
    expect(parse.nodes.filter(node => node.kind === 'news')).toHaveLength(2)
    expect(parse.nodes.filter(node => node.kind === 'news').every(node => node.synthetic && node.status === '待保存' && node.selectId === source.id)).toBe(true)
    operation.kind = 'split'
    operation.targetId = 'news'
    operation.contentDraft = { kind: 'split', reason: 'Select', reportIds: ['split-report'], selected: [{ reportId: 'split-report', index: 0 }] }
    operation.splitReports = [{ id: 'split-report', slotId: 'one', agentId: 'agent', agentName: 'Agent', angle: 'one', tools: [], routeRevision: 1, reason: 'Extract', createdAt: time,
      claims: [{ content: 'Selected', category: null }, { content: 'Excluded', category: null }] }]
    const news = layoutCreateNode('news', { kind: 'news', content: 'News', context: {} })
    const split = graphReadCanvasLayout({ nodes: [news], edges: [], run })
    expect(split.nodes.filter(node => node.kind === 'splitAgent')).toHaveLength(2)
    expect(split.nodes.filter(node => node.kind === 'claim').map(node => node.status)).toEqual(['待保存', '未采用'])

  })
})
