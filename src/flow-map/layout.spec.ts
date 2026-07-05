import { describe, expect, it } from 'vitest'
import { layoutReadSnapshot } from './layout'
import { NEWS_ROOT_ID } from './ids'
import type { MapNode, MapSnapshot } from './types'

const newsNode: MapNode = {
  id: NEWS_ROOT_ID,
  kind: 'news',
  params: { content: '' },
}

function make(overrides: Partial<MapSnapshot>): MapSnapshot {
  const { nodes, ...rest } = overrides
  return {
    newsId: 'n1',
    edges: [],
    runPhase: 'idle',
    mode: 'human-in-loop',
    ...rest,
    nodes: [newsNode, ...(nodes ?? [])],
  }
}

describe('layout', () => {
  it('相同 parent 下多 claim 时纵向分行且横坐标一致', () => {
    const snap = make({
      nodes: [
        {
          id: 'sub:a',
          kind: 'subAgent',
          parentId: NEWS_ROOT_ID,
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
        { id: 'e:root->sub:a', from: NEWS_ROOT_ID, to: 'sub:a' },
        { id: 'e:sub:a->claim:a:0', from: 'sub:a', to: 'claim:a:0' },
        { id: 'e:sub:a->claim:a:1', from: 'sub:a', to: 'claim:a:1' },
      ],
    })

    const out = layoutReadSnapshot(snap)
    const c0 = out.nodes.find(n => n.node.id === 'claim:a:0')!
    const c1 = out.nodes.find(n => n.node.id === 'claim:a:1')!
    expect(c0.x).toBe(c1.x)
    expect(c0.y).not.toBe(c1.y)
    const sa = out.nodes.find(n => n.node.id === 'sub:a')!
    expect(sa.x).toBeLessThan(c0.x)
  })

  it('news → subAgent → claim → verify subAgent 深度递增，无 split/verify 特殊分支', () => {
    const snap = make({
      nodes: [
        {
          id: 'sub:a',
          kind: 'subAgent',
          parentId: NEWS_ROOT_ID,
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
        {
          id: 'sub:v',
          kind: 'subAgent',
          parentId: 'claim:a:0',
          params: { agentName: 'v', priority: 'high', instanceId: 'v' },
        },
      ],
      edges: [
        { id: 'e:root->sub:a', from: NEWS_ROOT_ID, to: 'sub:a' },
        { id: 'e:sub:a->claim:a:0', from: 'sub:a', to: 'claim:a:0' },
        { id: 'e:claim:a:0->sub:v', from: 'claim:a:0', to: 'sub:v' },
      ],
    })

    const out = layoutReadSnapshot(snap)
    const news = out.nodes.find(n => n.node.id === NEWS_ROOT_ID)!
    const sa = out.nodes.find(n => n.node.id === 'sub:a')!
    const claim = out.nodes.find(n => n.node.id === 'claim:a:0')!
    const sv = out.nodes.find(n => n.node.id === 'sub:v')!
    expect(news.depth).toBe(0)
    expect(sa.depth).toBe(1)
    expect(claim.depth).toBe(2)
    expect(sv.depth).toBe(3)
    expect(news.x).toBeLessThan(sa.x)
    expect(sa.x).toBeLessThan(claim.x)
    expect(claim.x).toBeLessThan(sv.x)
  })
})
