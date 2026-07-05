import { describe, expect, it } from 'vitest'
import { mapIdCreateInstance, mapIdReadAgentName, mapIdUpdateInstance, mapIdReadInterruptFocus, mapIdCreateRoute, mapIdReadSubAgent, mapIdReadRouteClaim } from './ids'

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
      mapIdCreateRoute({ instanceId: 'a#1' }, '__news_root__'),
    ).toBe('sub:a#1')
    expect(mapIdReadSubAgent('sub:2:a#1')).toBe('a#1')
    expect(mapIdReadRouteClaim('sub:2:a#1')).toBe('2')
    expect(mapIdReadRouteClaim('sub:a#1')).toBeUndefined()
  })

  it('mapIdReadInterruptFocus save 拆分指向当前 claim', () => {
    const { focus, pendingTool } = mapIdReadInterruptFocus('split', 'save', {
      saveIndex: 1,
    })
    expect(focus).toEqual({ kind: 'claim', id: '2' })
    expect(pendingTool).toBe('save')
  })

  it('mapIdReadInterruptFocus confirmRoute 核查指向 claim', () => {
    const { focus, pendingTool } = mapIdReadInterruptFocus('verify', 'confirmRoute', {
      claimId: '3',
    })
    expect(focus).toEqual({ kind: 'claim', id: '3' })
    expect(pendingTool).toBe('invoke')
  })
})
