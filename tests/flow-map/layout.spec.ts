import { describe, expect, it } from 'vitest'
import { layoutReadSnapshot } from '@flow-map/layout'
import { MAP_DEFAULT_NEWS_ID } from '@flow-map/ids'
import { MAP_COLUMN } from '@flow-map/columns'
import { timelineCreateDefault } from '@flow-map/timeline'
import type { MapNode, MapSnapshot } from '@flow-map/types'

const newsNode: MapNode = {
  id: MAP_DEFAULT_NEWS_ID,
  kind: 'news',
  params: { content: '' },
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

describe('layout', () => {
  it('相同 parent 下多 claim 时纵向分行且横坐标一致', () => {
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
        { id: 'e:root->sub:a', from: MAP_DEFAULT_NEWS_ID, to: 'sub:a' },
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

  it('news → subAgent → claim → verify subAgent 列号递增', () => {
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
        {
          id: 'sub:v',
          kind: 'subAgent',
          parentId: 'claim:a:0',
          params: { agentName: 'v', priority: 'high', instanceId: 'v' },
        },
      ],
      edges: [
        { id: 'e:root->sub:a', from: MAP_DEFAULT_NEWS_ID, to: 'sub:a' },
        { id: 'e:sub:a->claim:a:0', from: 'sub:a', to: 'claim:a:0' },
        { id: 'e:claim:a:0->sub:v', from: 'claim:a:0', to: 'sub:v' },
      ],
    })

    const out = layoutReadSnapshot(snap)
    const news = out.nodes.find(n => n.node.id === MAP_DEFAULT_NEWS_ID)!
    const sa = out.nodes.find(n => n.node.id === 'sub:a')!
    const claim = out.nodes.find(n => n.node.id === 'claim:a:0')!
    const sv = out.nodes.find(n => n.node.id === 'sub:v')!
    expect(news.depth).toBe(MAP_COLUMN.news)
    expect(sa.depth).toBe(MAP_COLUMN.splitAgent)
    expect(claim.depth).toBe(MAP_COLUMN.claim)
    expect(sv.depth).toBe(MAP_COLUMN.verifyAgent)
    expect(news.x).toBeLessThan(sa.x)
    expect(sa.x).toBeLessThan(claim.x)
    expect(claim.x).toBeLessThan(sv.x)
  })
})
