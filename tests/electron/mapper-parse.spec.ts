import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMapper } from '../../electron/mapper/service'
import type { AgentCall, AgentLoop } from '../../electron/mapper/types'
import { clientSetIdForTest } from '../../electron/shared/client-identity'
import {
  dbCreate,
  dbDelete,
  MapModel,
  WorkspaceModel,
} from '../../electron/shared/database'

const WORKSPACE_ID = 'mapper-parse-workspace'
const tmpDir = path.join(os.tmpdir(), `mapper-parse-${Date.now()}`)

describe('Mapper parse workflow', () => {
  beforeAll(async () => {
    mkdirSync(tmpDir, { recursive: true })
    clientSetIdForTest('mapper-parse-client')
    await dbCreate('memory')
    await WorkspaceModel.create({
      _id: WORKSPACE_ID,
      name: 'Mapper',
      agents: [{
        promptPath: 'fact-parser/extract',
        agentType: 'parse',
        displayLabel: 'Parse',
        content: 'Parse this source',
        promptVars: ['rawContent'],
      }],
    })
  })

  afterAll(async () => {
    await MapModel.deleteMany({ workspaceId: WORKSPACE_ID })
    await WorkspaceModel.deleteOne({ _id: WORKSPACE_ID })
    clientSetIdForTest(null)
    await dbDelete()
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('persists each HITL gate and saves the edited output', async () => {
    const calls: AgentCall[] = []
    const loop: AgentLoop = {
      async run(call) {
        calls.push(call)
        return { text: 'parsed by agent' }
      },
      async close() {},
    }
    const mapper = createMapper(loop)
    const sourcePath = path.join(tmpDir, 'source.txt')
    writeFileSync(sourcePath, 'raw source', 'utf-8')

    const created = await mapper.dispatch({
      type: 'map.create',
      workspaceId: WORKSPACE_ID,
    })
    if (created.type !== 'map.updated') throw new Error('create failed')
    const mapId = created.snapshot.mapId
    const source = await mapper.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'source', uri: sourcePath, sourceKind: 'file' },
    })
    if (source.type !== 'map.updated') throw new Error('source failed')
    const sourceId = source.snapshot.nodes.find(node => node.kind === 'source')!.id

    const routeGate = await mapper.dispatch({
      type: 'run.start',
      mapId,
      mode: 'human-in-loop',
      selectedNodeId: sourceId,
    })
    expect(routeGate).toMatchObject({
      type: 'map.updated',
      snapshot: { runPhase: 'interrupted', pendingAction: 'confirm-route' },
    })

    const validateGate = await mapper.dispatch({ type: 'run.continue', mapId })
    expect(validateGate).toMatchObject({
      type: 'map.updated',
      snapshot: { runPhase: 'interrupted', pendingAction: 'validate' },
    })
    expect(calls).toHaveLength(1)

    const saveGate = await mapper.dispatch({
      type: 'run.continue',
      mapId,
      decision: { output: 'edited by human' },
    })
    expect(saveGate).toMatchObject({
      type: 'map.updated',
      snapshot: { runPhase: 'interrupted', pendingAction: 'save' },
    })

    const done = await mapper.dispatch({ type: 'run.continue', mapId })
    expect(done).toMatchObject({
      type: 'map.updated',
      snapshot: { runPhase: 'idle' },
    })
    if (done.type !== 'map.updated') throw new Error('run failed')
    expect(done.snapshot.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'news',
        params: { content: 'edited by human' },
      }),
    ]))

    await mapper.close()
  })
})
