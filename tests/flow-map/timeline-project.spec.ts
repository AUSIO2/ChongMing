import { describe, expect, it } from 'vitest'
import { mapIdCreateNews, mapIdCreateParse, mapIdCreateSource } from '@flow-map/ids'
import { layoutReadSnapshot } from '@flow-map/layout'
import {
  timelineProjectLines,
  timelineReadGlobalFrame,
  timelineReadGlobalStart,
} from '@flow-map/timeline-project'
import { timelineCreateDefault } from '@flow-map/timeline'
import type { MapSnapshot } from '@flow-map/types'

function snap(nodes: MapSnapshot['nodes']): MapSnapshot {
  return {
    mapId: 'm1',
    nodes,
    edges: [],
    runPhase: 'idle',
    mode: 'human-in-loop',
    timeline: timelineCreateDefault(),
  }
}

describe('timeline-project', () => {
  it('单源链：xStart=0，最短叶为 news 列 2', () => {
    const sourceId = mapIdCreateSource('a')
    const parseId = mapIdCreateParse('a')
    const newsId = mapIdCreateNews('a')
    const s = snap([
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
      { id: parseId, kind: 'parseAgent', parentId: sourceId, params: { agentName: 'parse' } },
      { id: newsId, kind: 'news', parentId: parseId, params: { content: '正文' } },
    ])
    const lines = timelineProjectLines(s)
    expect(lines).toHaveLength(1)
    expect(lines[0].rootId).toBe(sourceId)
    expect(lines[0].xStart).toBe(0)
    expect(lines[0].xEnd).toBe(2)
    expect(lines[0].effectiveFrame).toBe(2)
    expect(lines[0].label).toBe('源1')
  })

  it('标签为根数据类型+同类型编号', () => {
    const sourceA = mapIdCreateSource('a')
    const sourceB = mapIdCreateSource('b')
    const newsId = mapIdCreateNews('n')
    const s = snap([
      { id: sourceA, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
      { id: sourceB, kind: 'source', params: { uri: '/b.txt', kind: 'file' } },
      { id: newsId, kind: 'news', params: { content: '独立新闻' } },
    ])
    const lines = timelineProjectLines(s)
    expect(lines.map(l => l.label).sort()).toEqual(['新闻1', '源1', '源2'])
  })

  it('globalStart 取各线 xStart 最小值', () => {
    const sourceId = mapIdCreateSource('a')
    const newsId = mapIdCreateNews('a')
    const s = snap([
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
      { id: newsId, kind: 'news', params: { content: '独立新闻' } },
    ])
    const lines = timelineProjectLines(s)
    expect(timelineReadGlobalStart(lines)).toBe(0)
  })

  it('globalFrame 取各线 effectiveFrame 最大值', () => {
    const sourceId = mapIdCreateSource('a')
    const newsId = mapIdCreateNews('a')
    const s = snap([
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
      { id: newsId, kind: 'news', params: { content: '正文' } },
      {
        id: 'c1',
        kind: 'claim',
        parentId: newsId,
        dataPhase: 'persisted',
        shouldSave: true,
        params: { content: '事实' },
      },
    ])
    const lines = timelineProjectLines(s)
    expect(timelineReadGlobalFrame(lines)).toBe(4)
  })

  it('layoutY 与拓扑布局 y 一致', () => {
    const sourceId = mapIdCreateSource('a')
    const s = snap([
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
    ])
    const layout = layoutReadSnapshot(s)
    const lines = timelineProjectLines(s)
    expect(lines[0].layoutY).toBe(layout.nodes[0].y)
  })

  it('xEnd 延伸到子树最深列（非最浅叶）', () => {
    const newsId = mapIdCreateNews('a')
    const s = snap([
      { id: newsId, kind: 'news', params: { content: '正文' } },
      {
        id: 'claim:news:a:1',
        kind: 'claim',
        parentId: newsId,
        dataPhase: 'persisted',
        shouldSave: true,
        params: { content: '事实' },
      },
      {
        id: 'sub:claim:news:a:1:agent#1',
        kind: 'subAgent',
        parentId: 'claim:news:a:1',
        params: { agentName: 'agent', priority: 'high', instanceId: 'agent#1' },
      },
      {
        id: 'opinion:claim:news:a:1:0',
        kind: 'opinion',
        parentId: 'sub:claim:news:a:1:agent#1',
        params: { content: 'ok', confidence: 1, priority: 'high' },
        dataPhase: 'persisted',
      },
    ])
    const lines = timelineProjectLines(s)
    expect(lines[0].xEnd).toBe(6)
    expect(lines[0].effectiveFrame).toBe(6)
  })
})
