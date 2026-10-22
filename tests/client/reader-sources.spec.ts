import { describe, expect, it } from 'vitest'
import type { GraphNode, GraphSourceAnchor } from '../../contracts/graph'
import type { DataTypeDefinition } from '../../contracts/data-definition'
import type { GraphSnapshot } from '../../contracts/graph-api'
import { readerCreateSourceAnchors, readerReadSourceNotes, readerReadLineMarkers, readerReadFocusStatus } from '../../apps/ui/features/reader/reader-sources'
import { readerReadFieldLabel } from '../../apps/ui/features/reader/reader-content'

const identity = { workspaceId: 'workspace', mapId: 'map', nodeId: 'child' }
const time = '2026-10-06T00:00:00.000Z'
function node(id: string, content: string): GraphNode {
  return { id, typeId: 'text', typeVersion: 1, revision: 0, payload: { content }, createdAt: time, updatedAt: time }
}
function snapshot(anchors?: GraphSourceAnchor[]): GraphSnapshot {
  return { ...identity, revision: 1, name: '来源测试', updatedAt: time, ownershipRevision: 0, ownerships: [], runControls: [], runs: [],
    nodes: [node('parent', '第一行\r\n\r\n第三行'), node('child', '从不同位置归纳的事实')],
    edges: [{ id: 'edge', kind: 'successor', from: 'parent', to: 'child', revision: 0, createdAt: time, updatedAt: time,
      ...(anchors ? { sourceAnchors: anchors } : {}) }] }
}

describe('reader source footnotes', () => {
  it('labels prototype-named dynamic fields from their published additionalProperties schema', () => {
    // constructor没有被声明成固定属性，阅读标签必须采用真正扩展字段的标题。
    const definition: DataTypeDefinition = { id: 'demo.dynamic', version: 1, title: '字典', schema: { type: 'object', properties: {},
      additionalProperties: { type: 'string', title: '扩展正文' } }, successorTypes: [], references: [], agentProjection: { include: [], mapEntryFilters: [] } }
    expect(readerReadFieldLabel('/constructor', definition)).toBe('扩展正文')
    expect(readerReadFieldLabel('/toString', definition)).toBe('扩展正文')
  })
  it('keeps disjoint lines separate and preserves source line endings in quoted ranges', () => {
    const parent = snapshot().nodes[0]
    expect(readerCreateSourceAnchors(parent, '/content', '1,3')).toEqual([
      { path: '/content', sourceRevision: 0, startLine: 1, endLine: 1, quote: '第一行' },
      { path: '/content', sourceRevision: 0, startLine: 3, endLine: 3, quote: '第三行' },
    ])
    expect(readerCreateSourceAnchors(parent, '/content', '1-3')[0].quote).toBe('第一行\r\n\r\n第三行')
    expect(readerCreateSourceAnchors(parent, '/content', '')).toEqual([])
  })

  it('rejects ambiguous, overlapping and out of range locations', () => {
    const parent = snapshot().nodes[0]
    for (const input of ['0', '4', '3-1', '1-2,2', '一三']) expect(() => readerCreateSourceAnchors(parent, '/content', input)).toThrow()
    expect(() => readerCreateSourceAnchors(parent, '/missing', '1')).toThrow()
  })

  it('shows a known parent without inventing line locations when metadata is absent', () => {
    const notes = readerReadSourceNotes(snapshot(), identity, null)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ source: { nodeId: 'parent' }, child: identity, ranges: [] })
    expect(readerReadLineMarkers(notes)).toEqual([])
  })

  it('links each current source line to the child while reference edges remain unrelated', () => {
    const graph = snapshot(readerCreateSourceAnchors(snapshot().nodes[0], '/content', '1,3'))
    graph.edges.push({ ...graph.edges[0], id: 'reference', kind: 'reference' })
    const parentIdentity = { ...identity, nodeId: 'parent' }
    const notes = readerReadSourceNotes(graph, parentIdentity, null, 'outgoing')
    expect(notes).toHaveLength(1)
    expect(readerReadLineMarkers(notes).map(marker => [marker.line, marker.target.nodeId])).toEqual([[1, 'child'], [3, 'child']])
    expect(readerReadSourceNotes(graph, { ...identity, mapId: 'another-map' }, null)).toEqual([])
  })

  it('retains historical quotes without highlighting newer or mismatched source text', () => {
    const anchors = readerCreateSourceAnchors(snapshot().nodes[0], '/content', '1,3')
    const graph = snapshot(anchors)
    graph.nodes[0].revision = 1
    graph.nodes[0].payload.content = '新版正文'
    const notes = readerReadSourceNotes(graph, identity, null)
    expect(notes[0].ranges.map(range => range.status)).toEqual(['stale', 'stale'])
    expect(notes[0].ranges[1].anchor.quote).toBe('第三行')
    expect(readerReadLineMarkers(notes)).toEqual([])
    expect(readerReadFocusStatus(graph, { target: { ...identity, nodeId: 'parent' }, anchor: anchors[0] })).toBe('stale')
    graph.nodes[0].revision = 0
    expect(readerReadSourceNotes(graph, identity, null)[0].ranges[0].status).toBe('invalid')
  })
})
