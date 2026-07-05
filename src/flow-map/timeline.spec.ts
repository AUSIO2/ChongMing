import { describe, expect, it } from 'vitest'
import {
  timelineCreateDefault,
  timelineDeriveStateIndex,
  timelineReadEffectiveIndex,
  timelineReadParents,
  timelineResolveKeys,
  timelineValidate,
} from './timeline'
import { mapIdCreateNews, mapIdCreateSource, MAP_DEFAULT_NEWS_ID } from './ids'
import type { MapSnapshot } from './types'

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

describe('timeline', () => {
  it('timelineValidate 拒绝 startX > endX', () => {
    expect(() => timelineValidate({ startX: 3, endX: 1, activeScope: '' })).toThrow()
  })

  it('derive x=0 当有待解析源', () => {
    const sourceId = mapIdCreateSource('a')
    const s = snap([
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
    ])
    expect(timelineDeriveStateIndex(s, [], MAP_DEFAULT_NEWS_ID)).toBe(0)
  })

  it('resolveKeys 从 effectiveX 到 endX', () => {
    const tl = timelineCreateDefault()
    expect(timelineResolveKeys({ ...tl, startX: 0, endX: 3 }, 1)).toEqual(['1-2', '2-3'])
    expect(timelineResolveKeys({ ...tl, startX: 0, endX: 1 }, 0)).toEqual(['0-1'])
  })

  it('readParents 1-2 用 activeScope news', () => {
    const newsId = mapIdCreateNews('a')
    const s = snap([
      { id: newsId, kind: 'news', params: { content: '正文' } },
    ])
    expect(timelineReadParents(s, '1-2', newsId, [])).toEqual([newsId])
  })

  it('effectiveIndex 取 stored 与 derive 较大值', () => {
    const newsId = mapIdCreateNews('a')
    const s = snap([
      { id: newsId, kind: 'news', params: { content: '正文' } },
    ])
    const tl = { startX: 0 as const, endX: 3 as const, stateIndex: 2 as const, activeScope: newsId }
    expect(timelineReadEffectiveIndex(tl, s, [], newsId)).toBe(2)
  })
})
