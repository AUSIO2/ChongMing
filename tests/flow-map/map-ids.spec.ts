import { describe, expect, it } from 'vitest'
import {
  mapIdCreateInstance,
  mapIdReadAgentName,
  mapIdUpdateInstance,
  mapIdReadInterruptFocus,
  mapIdCreateRoute,
  mapIdReadSubAgent,
  mapIdReadRouteClaim,
  mapIdCreateClaim,
  mapIdCreateDraftClaim,
  mapIdReadClaimSaveIndex,
  mapIdClaimBelongsToNews,
  mapIdReadTransitionScope,
  MAP_DEFAULT_NEWS_ID,
} from '@flow-map/ids'

describe('map-ids', () => {
  it('mapIdCreateInstance 按 parent 已有槽递增', () => {
    expect(
      mapIdCreateInstance('来源可信度', [{ instanceId: '来源可信度#1' }]),
    ).toBe('来源可信度#2')
    expect(
      mapIdCreateInstance('来源可信度', [
        { instanceId: '来源可信度#1' },
        { instanceId: '来源可信度#3' },
      ]),
    ).toBe('来源可信度#4')
  })

  it('mapIdCreateInstance 不同 agentName 互不影响', () => {
    expect(
      mapIdCreateInstance('b', [{ instanceId: 'a#5' }]),
    ).toBe('b#1')
  })

  it('mapIdReadAgentName 解析 agentName#n', () => {
    expect(mapIdReadAgentName('来源可信度#2')).toBe('来源可信度')
    expect(mapIdReadAgentName('plain')).toBe('plain')
  })

  it('mapIdUpdateInstance 同批多同名 agent 递增', () => {
    expect(
      mapIdUpdateInstance([
        { agentName: '来源可信度', priority: 'high' },
        { agentName: '来源可信度', priority: 'medium' },
      ]),
    ).toEqual([
      { agentName: '来源可信度', priority: 'high', instanceId: '来源可信度#1' },
      { agentName: '来源可信度', priority: 'medium', instanceId: '来源可信度#2' },
    ])
  })

  it('mapIdUpdateInstance 尊重 existing 已有槽', () => {
    expect(
      mapIdUpdateInstance(
        [{ agentName: '来源可信度', priority: 'high' }],
        [{ instanceId: '来源可信度#3' }],
      ),
    ).toEqual([
      { agentName: '来源可信度', priority: 'high', instanceId: '来源可信度#4' },
    ])
  })

  it('mapIdUpdateInstance 保留 draft 已有 instanceId', () => {
    expect(
      mapIdUpdateInstance([
        { agentName: 'a', priority: 'low', instanceId: 'a#9' },
      ]),
    ).toEqual([
      { agentName: 'a', priority: 'low', instanceId: 'a#9' },
    ])
  })

  it('mapIdCreateRoute 核查槽含 claimId 作用域', () => {
    expect(
      mapIdCreateRoute({ instanceId: 'a#1' }, '2'),
    ).toBe('sub:2:a#1')
    expect(
      mapIdCreateRoute({ instanceId: 'a#1' }, 'claim:news:abc:1'),
    ).toBe('sub:claim:news:abc:1:a#1')
    expect(
      mapIdCreateRoute({ instanceId: 'a#1' }, MAP_DEFAULT_NEWS_ID),
    ).toBe('sub:a#1')
    expect(mapIdReadSubAgent('sub:2:a#1')).toBe('a#1')
    expect(mapIdReadSubAgent('sub:claim:news:abc:1:a#1')).toBe('a#1')
    expect(mapIdReadRouteClaim('sub:2:a#1')).toBe('2')
    expect(mapIdReadRouteClaim('sub:claim:news:abc:1:a#1')).toBe('claim:news:abc:1')
    expect(mapIdReadRouteClaim('sub:a#1')).toBeUndefined()
  })

  it('scoped news claim/draft id 与 default legacy 隔离', () => {
    const newsA = 'news:aaa'
    const newsB = 'news:bbb'
    expect(mapIdCreateClaim(0, newsA)).toBe('claim:news:aaa:1')
    expect(mapIdCreateClaim(0, newsB)).toBe('claim:news:bbb:1')
    expect(mapIdCreateClaim(0, MAP_DEFAULT_NEWS_ID)).toBe('1')
    expect(mapIdCreateDraftClaim(0, newsA)).toBe('draft:news:aaa:0')
    expect(mapIdReadClaimSaveIndex('claim:news:aaa:2')).toBe(1)
    expect(mapIdClaimBelongsToNews('1', MAP_DEFAULT_NEWS_ID)).toBe(true)
    expect(mapIdClaimBelongsToNews('1', newsA)).toBe(false)
    expect(mapIdClaimBelongsToNews('claim:news:aaa:1', newsA)).toBe(true)
    expect(mapIdClaimBelongsToNews('draft:0', MAP_DEFAULT_NEWS_ID)).toBe(true)
    expect(mapIdClaimBelongsToNews('draft:news:aaa:0', newsA)).toBe(true)
  })

  it('mapIdReadInterruptFocus save 拆分 scoped 指向 scoped claim', () => {
    const newsId = 'news:abc'
    const { focus, pendingTool } = mapIdReadInterruptFocus('1-2', 'save', {
      parentNodeId: newsId,
      saveIndex: 1,
    })
    expect(focus).toEqual({ kind: 'claim', id: 'claim:news:abc:2' })
    expect(pendingTool).toBe('save')
  })

  it('mapIdReadInterruptFocus save 拆分指向当前 claim', () => {
    const { focus, pendingTool } = mapIdReadInterruptFocus('1-2', 'save', {
      parentNodeId: MAP_DEFAULT_NEWS_ID,
      saveIndex: 1,
    })
    expect(focus).toEqual({ kind: 'claim', id: '2' })
    expect(pendingTool).toBe('save')
  })

  it('mapIdReadTransitionScope 2-3 从 scoped claim 解析 news scope', () => {
    expect(
      mapIdReadTransitionScope('2-3', 'claim:news:abc:1'),
    ).toBe('news:abc')
    expect(mapIdReadTransitionScope('2-3', '1')).toBeUndefined()
    expect(
      mapIdReadTransitionScope('1-2', 'news:abc'),
    ).toBe('news:abc')
    expect(
      mapIdReadTransitionScope('1-2', MAP_DEFAULT_NEWS_ID),
    ).toBeUndefined()
  })

  it('mapIdReadInterruptFocus confirmRoute 核查指向 claim', () => {
    const { focus, pendingTool } = mapIdReadInterruptFocus('2-3', 'confirmRoute', {
      parentNodeId: '3',
    })
    expect(focus).toEqual({ kind: 'claim', id: '3' })
    expect(pendingTool).toBe('invoke')
  })
})
