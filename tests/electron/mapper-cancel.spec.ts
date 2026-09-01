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

const WORKSPACE_ID = 'mapper-cancel-workspace'

describe('Mapper cancellation', () => {
  beforeAll(async () => {
    clientSetIdForTest('mapper-cancel-client')
    await dbCreate('memory')
    await WorkspaceModel.create({
      _id: WORKSPACE_ID,
      name: 'Mapper',
      agents: [{
        promptPath: 'fact-extractor/main-agent-route',
        agentType: 'coordinator',
        displayLabel: 'Route',
        content: 'route',
        promptVars: ['availableAgents', 'content'],
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

  it('aborts an active AgentLoop without waiting for it to finish', async () => {
    let started!: () => void
    const didStart = new Promise<void>(resolve => { started = resolve })
    const loop: AgentLoop = {
      run(_call, { signal }) {
        started()
        return new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
      async close() {},
    }
    const mapper = createMapper(loop)
    const created = await mapper.dispatch({
      type: 'map.create',
      workspaceId: WORKSPACE_ID,
    })
    if (created.type !== 'map.updated') throw new Error('create failed')
    const mapId = created.snapshot.mapId
    await mapper.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'news', content: 'news' },
    })

    const running = mapper.dispatch({
      type: 'run.start',
      mapId,
      mode: 'auto',
    })
    await didStart
    await mapper.dispatch({ type: 'run.cancel', mapId })
    const result = await running

    expect(result).toMatchObject({
      type: 'map.updated',
      snapshot: { runPhase: 'error', error: 'Run cancelled' },
    })
    await mapper.close()
  })
})
