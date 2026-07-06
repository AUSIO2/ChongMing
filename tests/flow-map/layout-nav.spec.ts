import { describe, expect, it } from 'vitest'
import { layoutFindNeighbor, layoutReadFirstNodeId } from '@flow-map/layout-nav'
import { layoutReadSnapshot } from '@flow-map/layout'
import { MAP_DEFAULT_NEWS_ID, mapIdCreateNews, mapIdCreateSource } from '@flow-map/ids'
import { timelineCreateDefault } from '@flow-map/timeline'
import type { MapNode, MapSnapshot } from '@flow-map/types'

const newsNode: MapNode = {
  id: MAP_DEFAULT_NEWS_ID,
  kind: 'news',
  params: { content: '正文' },
}

function make(overrides: Partial<MapSnapshot>): MapSnapshot {
  const { nodes, ...rest } = overrides
  return {
    mapId: 'n1',
    edges: [],
    runPhase: 'idle',
    mode: 'human-in-loop',
    timeline: timelineCreateDefault(),
    ...rest,
    nodes: [newsNode, ...(nodes ?? [])],
  }
}

describe('layout-nav', () => {
  it('null 时选布局首节点', () => {
    const snap = make({ nodes: [] })
    const layout = layoutReadSnapshot(snap)
    expect(layoutReadFirstNodeId(layout)).toBe(MAP_DEFAULT_NEWS_ID)
    expect(layoutFindNeighbor(layout, null, 'down')).toBe(MAP_DEFAULT_NEWS_ID)
  })

  it('同列双 claim 上下切换', () => {
    const snap = make({
      nodes: [
        {
          id: 'sub:a',
          kind: 'subAgent',
          parentId: MAP_DEFAULT_NEWS_ID,
          params: { agentName: 'a', priority: 'medium', instanceId: 'a' },
        },
        {
          id: 'claim:a:0',
          kind: 'claim',
          parentId: 'sub:a',
          params: { content: 'c1' },
          dataPhase: 'workerOut',
          shouldSave: true,
        },
        {
          id: 'claim:a:1',
          kind: 'claim',
          parentId: 'sub:a',
          params: { content: 'c2' },
          dataPhase: 'workerOut',
          shouldSave: true,
        },
      ],
      edges: [
        { id: 'e:1', from: MAP_DEFAULT_NEWS_ID, to: 'sub:a' },
        { id: 'e:2', from: 'sub:a', to: 'claim:a:0' },
        { id: 'e:3', from: 'sub:a', to: 'claim:a:1' },
      ],
    })
    const layout = layoutReadSnapshot(snap)
    expect(layoutFindNeighbor(layout, 'claim:a:0', 'down')).toBe('claim:a:1')
    expect(layoutFindNeighbor(layout, 'claim:a:1', 'up')).toBe('claim:a:0')
  })

  it('news → sub → claim 右移', () => {
    const snap = make({
      nodes: [
        {
          id: 'sub:a',
          kind: 'subAgent',
          parentId: MAP_DEFAULT_NEWS_ID,
          params: { agentName: 'a', priority: 'medium', instanceId: 'a' },
        },
        {
          id: 'claim:a:0',
          kind: 'claim',
          parentId: 'sub:a',
          params: { content: 'c' },
          dataPhase: 'persisted',
          shouldSave: true,
        },
      ],
      edges: [
        { id: 'e:1', from: MAP_DEFAULT_NEWS_ID, to: 'sub:a' },
        { id: 'e:2', from: 'sub:a', to: 'claim:a:0' },
      ],
    })
    const layout = layoutReadSnapshot(snap)
    expect(layoutFindNeighbor(layout, MAP_DEFAULT_NEWS_ID, 'right')).toBe('sub:a')
    expect(layoutFindNeighbor(layout, 'sub:a', 'right')).toBe('claim:a:0')
    expect(layoutFindNeighbor(layout, 'claim:a:0', 'left')).toBe('sub:a')
  })

  it('双源链：同列 news 下移到下一链', () => {
    const newsB = mapIdCreateNews('bbbb')
    const sourceB = mapIdCreateSource('bbbb')
    const snap = make({
      nodes: [
        { id: sourceB, kind: 'source', params: { uri: '/b.txt', kind: 'file' } },
        { id: newsB, kind: 'news', params: { content: 'B' } },
      ],
    })
    const layout = layoutReadSnapshot(snap)
    expect(layoutFindNeighbor(layout, MAP_DEFAULT_NEWS_ID, 'down')).toBe(newsB)
    expect(layoutFindNeighbor(layout, newsB, 'up')).toBe(MAP_DEFAULT_NEWS_ID)
  })

  it('双源链：无同列邻居时跨链', () => {
    const sourceA = mapIdCreateSource('aaaa')
    const sourceB = mapIdCreateSource('bbbb')
    const snap: MapSnapshot = {
      mapId: 'm1',
      nodes: [
        { id: sourceA, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
        { id: sourceB, kind: 'source', params: { uri: '/b.txt', kind: 'file' } },
      ],
      edges: [],
      runPhase: 'idle',
      mode: 'human-in-loop',
      timeline: timelineCreateDefault(),
    }
    const layout = layoutReadSnapshot(snap)
    expect(layoutFindNeighbor(layout, sourceA, 'down')).toBe(sourceB)
    expect(layoutFindNeighbor(layout, sourceB, 'up')).toBe(sourceA)
  })

  it('顶行按上返回 null', () => {
    const snap = make({ nodes: [] })
    const layout = layoutReadSnapshot(snap)
    expect(layoutFindNeighbor(layout, MAP_DEFAULT_NEWS_ID, 'up')).toBeNull()
  })
})
