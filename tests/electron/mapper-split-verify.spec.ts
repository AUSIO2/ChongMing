import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMapper } from '../../electron/mapper/service'
import type { AgentLoop } from '../../electron/mapper/types'
import { clientSetIdForTest } from '../../electron/shared/client-identity'
import {
  dbCreate,
  dbDelete,
  MapModel,
  WorkspaceModel,
} from '../../electron/shared/database'

const WORKSPACE_ID = 'mapper-split-verify-workspace'

const loop: AgentLoop = {
  async run(call) {
    if (call.prompt.includes('SPLIT_ROUTE')) {
      return { text: '[{"agentName":"data","priority":"high"}]' }
    }
    if (call.prompt.includes('SPLIT_MERGE')) {
      return { text: '[{"draftIndex":0,"shouldSave":true}]' }
    }
    if (call.prompt.includes('VERIFY_ROUTE')) {
      return { text: '[{"agentName":"credibility","priority":"high"}]' }
    }
    if (call.prompt.includes('VERIFY_MERGE')) {
      return { text: '{"score":1,"reason":"confirmed"}' }
    }
    if (call.agent.name === 'data') {
      return { text: '[{"content":"atomic fact","category":"data"}]' }
    }
    if (call.agent.name === 'credibility') {
      return { text: '{"score":1,"reason":"credible source"}' }
    }
    throw new Error(`Unexpected call: ${call.agent.name}`)
  },
  async close() {},
}

describe('Mapper split and verify workflows', () => {
  beforeAll(async () => {
    clientSetIdForTest('mapper-split-verify-client')
    await dbCreate('memory')
    await WorkspaceModel.create({
      _id: WORKSPACE_ID,
      name: 'Mapper',
      agents: [{
        promptPath: 'fact-extractor/main-agent-route',
        agentType: 'coordinator',
        displayLabel: 'Split Route',
        content: 'SPLIT_ROUTE',
        promptVars: ['availableAgents', 'context', 'content'],
      }, {
        promptPath: 'fact-extractor/main-agent-merge',
        agentType: 'coordinator',
        displayLabel: 'Split Merge',
        content: 'SPLIT_MERGE',
        promptVars: ['content', 'subResults'],
      }, {
        promptPath: 'fact-extractor/sub-agents/data',
        agentType: 'split',
        agentName: 'data',
        displayLabel: 'Data',
        content: 'SPLIT_WORKER',
        promptVars: ['content'],
        claimCategory: 'data',
      }, {
        promptPath: 'fact-verifier/main-agent-route',
        agentType: 'coordinator',
        displayLabel: 'Verify Route',
        content: 'VERIFY_ROUTE',
        promptVars: ['availableAgents', 'claimContent', 'originalContent'],
      }, {
        promptPath: 'fact-verifier/main-agent-merge',
        agentType: 'coordinator',
        displayLabel: 'Verify Merge',
        content: 'VERIFY_MERGE',
        promptVars: ['claimContent', 'originalContent', 'opinions'],
      }, {
        promptPath: 'fact-verifier/sub-agents/credibility',
        agentType: 'verify',
        agentName: 'credibility',
        displayLabel: 'Credibility',
        content: 'VERIFY_WORKER',
        promptVars: ['claimContent'],
      }],
    })
  })

  afterAll(async () => {
    await MapModel.deleteMany({ workspaceId: WORKSPACE_ID })
    await WorkspaceModel.deleteOne({ _id: WORKSPACE_ID })
    clientSetIdForTest(null)
    await dbDelete()
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })

  it('runs split then verify through the same AgentLoop', async () => {
    const mapper = createMapper(loop)
    const created = await mapper.dispatch({
      type: 'map.create',
      workspaceId: WORKSPACE_ID,
    })
    if (created.type !== 'map.updated') throw new Error('create failed')
    const mapId = created.snapshot.mapId
    const newsResult = await mapper.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'news', content: 'source news' },
    })
    if (newsResult.type !== 'map.updated') throw new Error('news failed')
    const newsId = newsResult.snapshot.nodes.find(node => node.kind === 'news')!.id

    const result = await mapper.dispatch({
      type: 'run.start',
      mapId,
      mode: 'auto',
      selectedNodeId: newsId,
    })
    if (result.type !== 'map.updated') throw new Error('run failed')
    const claim = result.snapshot.nodes.find(node => node.kind === 'claim')
    expect(claim).toMatchObject({
      params: { content: 'atomic fact', category: 'data', sourceAgent: 'data' },
    })

    expect(result.snapshot.runPhase).toBe('idle')
    expect(result.snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'opinion',
        params: {
          content: 'credible source',
          confidence: 1,
          priority: 'high',
        },
      }),
    ]))

    await mapper.close()
  })
})
