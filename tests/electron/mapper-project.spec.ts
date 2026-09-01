import { describe, expect, it } from 'vitest'
import { projectSnapshot } from '../../electron/mapper/project'
import type { MapperDocument } from '../../electron/mapper/types'

function document(): MapperDocument {
  return {
    id: 'map-1',
    workspaceId: 'workspace-1',
    sources: [{ id: 'source:1', uri: '/tmp/a.txt', kind: 'file' }],
    news: [{
      id: 'news:1',
      sourceId: 'source:1',
      content: 'news',
      context: {},
    }],
    routes: [{
      parentId: 'news:1',
      agentName: 'data',
      priority: 'high',
      instanceId: 'data#1',
    }, {
      parentId: 'claim:1',
      agentName: 'verify',
      priority: 'medium',
      instanceId: 'verify#1',
    }],
    claims: [{
      id: 'claim:1',
      newsId: 'news:1',
      content: 'claim',
      sourceAgent: 'data',
      verify: {
        score: 1,
        reason: 'ok',
        opinions: [{
          agentName: 'verify',
          instanceId: 'verify#1',
          priority: 'medium',
          score: 1,
          reason: 'verified',
        }],
      },
    }],
    timeline: { startX: 0, endX: 3, activeScope: 'news:1' },
    revision: 0,
    createdAt: '2026-08-31T00:00:00.000Z',
    updatedAt: '2026-08-31T00:00:00.000Z',
  }
}

describe('Mapper projection', () => {
  it('derives nodes and edges from the canonical document', () => {
    const snapshot = projectSnapshot(document())

    expect(snapshot.nodes.map(node => node.kind)).toEqual([
      'source',
      'news',
      'subAgent',
      'subAgent',
      'parseAgent',
      'claim',
      'opinion',
    ])
    expect(snapshot.edges).toHaveLength(6)
    expect(snapshot.runPhase).toBe('idle')
  })

  it('derives HITL state without persisting view fields', () => {
    const doc = document()
    doc.run = {
      runId: 'run-1',
      stage: 'split',
      step: 'validate',
      status: 'interrupted',
      mode: 'human-in-loop',
      targetId: 'news:1',
      draft: { routes: [], calls: [], saveIndex: 0 },
      updatedAt: '2026-08-31T00:00:00.000Z',
    }

    expect(projectSnapshot(doc)).toMatchObject({
      runPhase: 'interrupted',
      activeNodeId: 'news:1',
      pendingAction: 'validate',
    })
  })
})
