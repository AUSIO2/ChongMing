import mongoose from 'mongoose'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createMapper } from '../../electron/mapper/service'
import type { AgentLoop } from '../../electron/mapper/types'
import { mapLeaseSetIdForTest, MAP_LEASE_TTL_MS } from '../../electron/api/map-lease'
import { clientSetIdForTest } from '../../electron/shared/client-identity'
import { dbCreate, dbDelete, MapModel, WorkspaceModel } from '../../electron/shared/database'

const WORKSPACE_ID = 'mapper-recovery-workspace'

function createLoop(calls: string[]): AgentLoop {
  return {
    async run(call) {
      calls.push(call.agent.name)
      if (call.agent.name === 'route') {
        return { text: '[{"agentName":"a","priority":"high"},{"agentName":"b","priority":"medium"}]' }
      }
      if (call.agent.name === 'merge') {
        return { text: '[{"draftIndex":0,"shouldSave":true},{"draftIndex":1,"shouldSave":true}]' }
      }
      await new Promise(resolve => setTimeout(resolve, call.agent.name === 'a' ? 20 : 5))
      return { text: `[{"content":"claim ${call.agent.name}","category":"data"}]` }
    },
    async close() {},
  }
}

describe('Mapper checkpoint recovery', () => {
  beforeAll(async () => {
    clientSetIdForTest('same-install')
    await dbCreate('memory')
    await WorkspaceModel.create({
      _id: WORKSPACE_ID,
      name: 'Recovery',
      agents: [{
        promptPath: 'fact-extractor/main-agent-route',
        agentType: 'coordinator',
        displayLabel: 'Route',
        content: 'ROUTE',
        promptVars: ['availableAgents', 'content'],
      }, {
        promptPath: 'fact-extractor/main-agent-merge',
        agentType: 'coordinator',
        displayLabel: 'Merge',
        content: 'MERGE',
        promptVars: ['content', 'subResults'],
      }, ...['a', 'b'].map(agentName => ({
        promptPath: `fact-extractor/sub-agents/${agentName}`,
        agentType: 'split' as const,
        agentName,
        displayLabel: agentName,
        content: `WORKER ${agentName}`,
        promptVars: ['content'],
      }))],
    })
  })

  beforeEach(async () => {
    await MapModel.deleteMany({ workspaceId: WORKSPACE_ID })
    mapLeaseSetIdForTest('process-a')
  })

  afterAll(async () => {
    await MapModel.deleteMany({ workspaceId: WORKSPACE_ID })
    await WorkspaceModel.deleteOne({ _id: WORKSPACE_ID })
    clientSetIdForTest(null)
    mapLeaseSetIdForTest(null)
    await dbDelete()
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })

  it('keeps completed workers and resumes only unfinished calls after takeover', async () => {
    const mapperA = createMapper(createLoop([]))
    const created = await mapperA.dispatch({ type: 'map.create', workspaceId: WORKSPACE_ID })
    if (created.type !== 'map.updated') throw new Error('create failed')
    const mapId = created.snapshot.mapId
    await mapperA.dispatch({
      type: 'node.create', mapId,
      node: { kind: 'news', content: 'news' },
    })
    await mapperA.dispatch({ type: 'timeline.update', mapId, patch: { endX: 2 } })

    const plannedAt = new Date()
    const call = (name: string) => ({
      callId: `run:${name}-0`,
      prompt: `WORKER ${name}`,
      agent: { name, tools: [] },
    })
    await MapModel.updateOne({ _id: mapId }, {
      $set: {
        run: {
          runId: 'run', stage: 'split', step: 'workers', status: 'running',
          mode: 'auto', targetId: 'news:default', updatedAt: plannedAt,
          draft: {
            routes: [
              { parentId: 'news:default', agentName: 'a', priority: 'high', instanceId: 'a-0' },
              { parentId: 'news:default', agentName: 'b', priority: 'medium', instanceId: 'b-0' },
            ],
            calls: [{
              call: call('a'), role: 'worker', agentName: 'a', instanceId: 'a-0',
              status: 'completed', attempt: 1, result: { text: '[{"content":"claim a","category":"data"}]' },
              plannedAt, startedAt: plannedAt, completedAt: plannedAt,
            }, {
              call: call('b'), role: 'worker', agentName: 'b', instanceId: 'b-0',
              status: 'running', attempt: 1, plannedAt, startedAt: plannedAt,
            }],
            saveIndex: 0,
          },
        },
        'writeLease.heartbeatAt': new Date(Date.now() - MAP_LEASE_TTL_MS - 1000),
      },
    })

    mapLeaseSetIdForTest('process-b')
    const calls: string[] = []
    const mapperB = createMapper(createLoop(calls))
    const lease = await mapperB.dispatch({ type: 'lease.acquire', mapId })
    expect(lease).toMatchObject({ type: 'lease.updated', ok: true })
    const recovered = await mapperB.read({ type: 'map.snapshot', mapId })
    expect(recovered).toMatchObject({
      type: 'map.snapshot', snapshot: { runPhase: 'interrupted' },
    })

    const result = await mapperB.dispatch({ type: 'run.continue', mapId })
    expect(result).toMatchObject({ type: 'map.updated', snapshot: { runPhase: 'idle' } })
    expect(calls).toEqual(['b', 'merge'])
    if (result.type !== 'map.updated') throw new Error('continue failed')
    expect(result.snapshot.nodes.filter(node => node.kind === 'claim')).toHaveLength(2)
    await mapperA.close()
    await mapperB.close()
  })

  it('serializes checkpoints while workers finish out of order', async () => {
    const calls: string[] = []
    const mapper = createMapper(createLoop(calls))
    const created = await mapper.dispatch({ type: 'map.create', workspaceId: WORKSPACE_ID })
    if (created.type !== 'map.updated') throw new Error('create failed')
    const mapId = created.snapshot.mapId
    await mapper.dispatch({ type: 'node.create', mapId, node: { kind: 'news', content: 'news' } })
    await mapper.dispatch({ type: 'timeline.update', mapId, patch: { endX: 2 } })
    const result = await mapper.dispatch({ type: 'run.start', mapId, mode: 'auto' })
    if (result.type !== 'map.updated') throw new Error('run failed')
    expect(result.snapshot.nodes.filter(node => node.kind === 'claim')).toHaveLength(2)
    expect(calls).toEqual(['route', 'a', 'b', 'merge'])
    await mapper.close()
  })
})
