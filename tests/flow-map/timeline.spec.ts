import { describe, expect, it } from 'vitest'
import {
  timelineCreateDefault,
  timelineDeriveStateIndex,
  timelinePickWork,
  timelinePickWorks,
  timelineReadEffectiveIndex,
  timelineReadNextStateIndex,
  timelineReadParents,
  timelineReadPending,
  timelineReadRunParent,
  timelineReadInterruptStale,
  timelineResolveKeys,
  timelineValidate,
} from '@flow-map/timeline'
import { mapIdCreateNews, mapIdCreateSource, MAP_DEFAULT_NEWS_ID } from '@flow-map/ids'
import type { DisplayClaim } from '../../electron/api/types'
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

function mockClaim(claimId: string, verified = false): DisplayClaim {
  return {
    claimId,
    content: claimId,
    verifyResult: verified
      ? { score: 0.9, reason: '', opinions: [], rawMergeResponse: '', verifiedAt: '' }
      : undefined,
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
    expect(timelineDeriveStateIndex(s, [])).toBe(0)
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
    expect(timelineReadEffectiveIndex(tl, s, [])).toBe(2)
  })

  it('readRunParent 1-2 源链串行时返回 activeLine 的 news', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
    ])
    const tl = timelineCreateDefault(newsA)
    expect(timelineReadRunParent(s, tl, '1-2', newsB)).toBe(newsA)
  })

  it('readRunParent 无 parent 抛 MAP_SCOPE_NOT_FOUND', () => {
    const s = snap([])
    const tl = timelineCreateDefault()
    expect(() => timelineReadRunParent(s, tl, '1-2')).toThrow('no parent for transition 1-2')
  })

  it('readPending 2-3 排除已核查 claim', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
    ])
    const claims: DisplayClaim[] = [
      mockClaim('claim:news:aaaa:1', true),
      mockClaim('claim:news:aaaa:2', true),
      mockClaim('claim:news:bbbb:1'),
    ]
    const pending = timelineReadPending(s, claims, '2-3')
    expect(pending.map(w => w.parentNodeId)).toEqual(['claim:news:bbbb:1'])
    expect(timelineReadParents(s, '2-3', newsA, claims)).toEqual([])
    expect(timelineReadParents(s, '2-3', newsB, claims)).toEqual(['claim:news:bbbb:1'])
  })

  it('readPending 0-1 全部已解析时为空', () => {
    const newsId = mapIdCreateNews('aaaa')
    const sourceId = mapIdCreateSource('aaaa')
    const s = snap([
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
      { id: newsId, kind: 'news', params: { content: '已解析' } },
    ])
    expect(timelineReadPending(s, [], '0-1')).toEqual([])
    expect(timelineReadParents(s, '0-1', '', [])).toEqual([])
  })

  it('readPending 1-2 已有 claim 时不重复拆分', () => {
    const newsA = mapIdCreateNews('aaaa')
    const subId = 'sub:aaaa:split:0'
    const s = snap([
      { id: newsA, kind: 'news', params: { content: '正文' } },
      { id: subId, kind: 'subAgent', parentId: newsA, params: { agentName: 'a', priority: 'high' } },
      { id: 'claim:news:aaaa:1', kind: 'claim', parentId: subId, dataPhase: 'persisted', params: { content: 'c1' } },
    ])
    const claims: DisplayClaim[] = [mockClaim('claim:news:aaaa:1')]
    expect(timelineReadPending(s, claims, '1-2')).toEqual([])
    expect(timelineReadParents(s, '1-2', newsA, claims)).toEqual([])
  })

  it('readInterruptStale 识别已完成的中断', () => {
    const newsId = mapIdCreateNews('aaaa')
    const sourceId = mapIdCreateSource('aaaa')
    const s = snap([
      { id: sourceId, kind: 'source', params: { uri: '/a.txt', kind: 'file' } },
      { id: newsId, kind: 'news', params: { content: '已解析' } },
    ])
    expect(timelineReadInterruptStale(s, [], '0-1', sourceId)).toBe(true)
    expect(timelineReadInterruptStale(s, [mockClaim('claim:news:aaaa:1')], '1-2', newsId)).toBe(true)
    expect(timelineReadInterruptStale(
      s,
      [mockClaim('claim:news:aaaa:1', true)],
      '2-3',
      'claim:news:aaaa:1',
    )).toBe(true)
  })

  it('stateIndex 规则：仍有 pending 时不应 bump 到下一列', () => {
    const newsA = mapIdCreateNews('aaaa')
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
    ])
    const claims: DisplayClaim[] = [
      mockClaim('claim:news:aaaa:1', true),
      mockClaim('claim:news:aaaa:2'),
    ]
    expect(timelineDeriveStateIndex(s, claims)).toBe(2)
    expect(timelineReadNextStateIndex('2-3')).toBe(3)
    expect(timelineReadPending(s, claims, '2-3').length).toBe(1)
  })

  it('源链串行：A 待核查、B 待拆分时 derive=2 且 pick A', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const subA = 'sub:aaaa:split:0'
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
      { id: subA, kind: 'subAgent', parentId: newsA, params: { agentName: 'a', priority: 'high' } },
      { id: 'claim:news:aaaa:1', kind: 'claim', parentId: subA, dataPhase: 'persisted', params: { content: 'c1' } },
    ])
    const claims: DisplayClaim[] = [mockClaim('claim:news:aaaa:1')]
    const tl = timelineCreateDefault()
    expect(timelineDeriveStateIndex(s, claims, tl)).toBe(2)
    const work = timelinePickWork(s, claims, '2-3', timelineReadPending(s, claims, '2-3'), tl)
    expect(work?.scopeNodeId).toBe(newsA)
    expect(work?.parentNodeId).toBe('claim:news:aaaa:1')
  })

  it('源链串行：A 全部核查完才调度 B 拆分', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const subA = 'sub:aaaa:split:0'
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
      { id: subA, kind: 'subAgent', parentId: newsA, params: { agentName: 'a', priority: 'high' } },
      { id: 'claim:news:aaaa:1', kind: 'claim', parentId: subA, dataPhase: 'persisted', params: { content: 'c1' } },
    ])
    const claims: DisplayClaim[] = [mockClaim('claim:news:aaaa:1', true)]
    const tl = timelineCreateDefault()
    expect(timelineDeriveStateIndex(s, claims, tl)).toBe(1)
    const work = timelinePickWork(s, claims, '1-2', timelineReadPending(s, claims, '1-2'), tl)
    expect(work?.parentNodeId).toBe(newsB)
  })

  it('多 subAgent：按 layoutY 顺序核查 claim', () => {
    const newsB = mapIdCreateNews('bbbb')
    const sub1 = 'sub:bbbb:split:0'
    const sub2 = 'sub:bbbb:split:1'
    const s = snap([
      { id: newsB, kind: 'news', params: { content: 'B' } },
      { id: sub1, kind: 'subAgent', parentId: newsB, params: { agentName: 'a', priority: 'high' } },
      { id: sub2, kind: 'subAgent', parentId: newsB, params: { agentName: 'b', priority: 'high' } },
      { id: 'claim:news:bbbb:1', kind: 'claim', parentId: sub1, dataPhase: 'persisted', params: { content: 'c1' } },
      { id: 'claim:news:bbbb:2', kind: 'claim', parentId: sub2, dataPhase: 'persisted', params: { content: 'c2' } },
    ])
    const claims: DisplayClaim[] = [
      mockClaim('claim:news:bbbb:1', true),
      mockClaim('claim:news:bbbb:2'),
    ]
    const tl = timelineCreateDefault(newsB)
    const work = timelinePickWork(s, claims, '2-3', timelineReadPending(s, claims, '2-3'), tl)
    expect(work?.parentNodeId).toBe('claim:news:bbbb:2')
  })

  it('endX=1 有正文时不调度拆分', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
    ])
    const tl = { ...timelineCreateDefault(), endX: 1 as const }
    expect(timelineDeriveStateIndex(s, [], tl)).toBe(1)
  })

  it('endX=2 有 claim 未核查时不调度 verify', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const subA = 'sub:aaaa:split:0'
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
      { id: subA, kind: 'subAgent', parentId: newsA, params: { agentName: 'a', priority: 'high' } },
      { id: 'claim:news:aaaa:1', kind: 'claim', parentId: subA, dataPhase: 'persisted', params: { content: 'c1' } },
    ])
    const claims: DisplayClaim[] = [mockClaim('claim:news:aaaa:1')]
    const tl = { ...timelineCreateDefault(), endX: 2 as const }
    expect(timelineDeriveStateIndex(s, claims, tl)).toBe(1)
    const work = timelinePickWork(s, claims, '1-2', timelineReadPending(s, claims, '1-2'), tl)
    expect(work?.parentNodeId).toBe(newsB)
  })

  it('activeLine 优先于 selectedNewsId', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
    ])
    const tl = timelineCreateDefault(newsA)
    const pending = timelineReadPending(s, [], '1-2')
    void pending
    expect(timelinePickWork(s, [], '1-2', pending, tl, newsB)?.parentNodeId).toBe(newsA)
  })

  it('timelinePickWorks limit=1 等同 pickWork', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
    ])
    const tl = timelineCreateDefault(newsA)
    const pending = timelineReadPending(s, [], '1-2')
    const works = timelinePickWorks(s, [], '1-2', pending, tl, 1)
    expect(works).toHaveLength(1)
    expect(works[0]?.parentNodeId).toBe(newsA)
  })

  it('timelinePickWorks auto limit>1 跨源链取多个 news', () => {
    const newsA = mapIdCreateNews('aaaa')
    const newsB = mapIdCreateNews('bbbb')
    const s = snap([
      { id: newsA, kind: 'news', params: { content: 'A' } },
      { id: newsB, kind: 'news', params: { content: 'B' } },
    ])
    const tl = timelineCreateDefault()
    const pending = timelineReadPending(s, [], '1-2')
    const works = timelinePickWorks(s, [], '1-2', pending, tl, 2)
    expect(works).toHaveLength(2)
    expect(works.map(w => w.parentNodeId).sort()).toEqual([newsA, newsB].sort())
  })
})
