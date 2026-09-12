import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, GraphRun } from '../../contracts/graph'
import { graphReadCanvasLayout, graphReadCanvasNeighbor, graphReadRunProgress } from '../../src/components/client/graph-layout'

const time = '2026-09-11T00:00:00.000Z'
function layoutCreateNode(id: string, data: GraphNode['data']): GraphNode {
  return { id, data, revision: 0, createdAt: time, updatedAt: time }
}
function layoutCreateEdge(id: string, from: string, to: string, kind: GraphEdge['kind'] = 'mentions'): GraphEdge {
  return { id, from, to, kind, revision: 0, createdAt: time, updatedAt: time }
}

describe('Client data graph layout', () => {
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
    expect(layout.nodes.map(item => item.node.id)).toEqual(['news-a', 'news-b', 'claim', 'verification'])
    expect(layout.nodes.filter(item => item.node.id === 'claim')).toHaveLength(1)
    expect(layout.edges).toHaveLength(edges.length)
    expect(layout.edges.find(edge => edge.id === 'v-c')).toMatchObject({ from: 'verification', to: 'claim' })
    expect(new Set(layout.edges.map(edge => edge.path)).size).toBe(edges.length)
    expect(layout.edges.every(edge => !/NaN|Infinity/.test(edge.path))).toBe(true)
    expect(graphReadCanvasLayout({ nodes: [...nodes].reverse(), edges: [...edges].reverse() })).toEqual(layout)
    expect(graphReadCanvasNeighbor(layout, 'news-a', 'ArrowRight')).toBe('claim')
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

  it('reports only persisted progress and does not turn collected reports into a final verdict', () => {
    const profile = { id: 'agent', name: 'Agent', description: 'Evidence', content: 'Review', tools: [], provider: 'fixture', model: 'fixture' }
    const run: GraphRun = {
      id: 'run', mode: 'human-in-loop', status: 'running', createdAt: time, updatedAt: time,
      configuration: { router: profile, merger: profile, agents: [profile], tools: [], maxSlots: 2 },
      operation: { id: 'operation', kind: 'verify', targetId: 'claim', status: 'running', inputRefs: [], route: null, draft: null, reports: [], review: null, resultNodeId: null },
    }
    expect(graphReadRunProgress(run)).toContain('规划')
    run.operation.route = { revision: 1, approved: true, reason: 'Two angles', slots: ['one', 'two'].map(id => ({ id, agentId: 'agent', angle: id, priority: 'medium', hint: '', tools: [] })) }
    expect(graphReadRunProgress(run)).toBe('已收集 0 / 2 份意见')
    run.operation.reports = ['one', 'two'].map(slotId => ({ id: slotId, slotId, agentId: 'agent', agentName: 'Agent', angle: slotId, tools: [], routeRevision: 1, score: 1, reason: 'Evidence', createdAt: time }))
    expect(graphReadRunProgress(run)).toBe('意见已收齐，等待汇总结论')
    run.status = 'waiting'
    run.operation.review = { id: 'review', kind: 'result', revision: 0, state: 'pending', decision: null, createdAt: time, answeredAt: null }
    expect(graphReadRunProgress(run)).toBe('等待保存核查结论')
    run.status = 'completed'
    expect(graphReadRunProgress(run)).toBe('核查已完成')
  })
})
