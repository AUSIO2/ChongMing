import mongoose from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createMapper } from '../../electron/mapper/service'
import type { AgentLoop, MapperSnapshot } from '../../electron/mapper/types'
import { clientSetIdForTest } from '../../electron/shared/client-identity'
import {
  dbCreate,
  dbDelete,
  MapModel,
  WorkspaceModel,
} from '../../electron/shared/database'

const WORKSPACE_ID = 'mapper-service-workspace'
const unusedLoop: AgentLoop = {
  async run() {
    throw new Error('not used by CRUD')
  },
  async close() {},
}

describe('Mapper service CRUD', () => {
  beforeAll(async () => {
    clientSetIdForTest('mapper-service-client')
    await dbCreate('memory')
    await WorkspaceModel.create({ _id: WORKSPACE_ID, name: 'Mapper' })
  })

  afterAll(async () => {
    await MapModel.deleteMany({ workspaceId: WORKSPACE_ID })
    await WorkspaceModel.deleteOne({ _id: WORKSPACE_ID })
    clientSetIdForTest(null)
    await dbDelete()
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect()
  })

  it('runs map and node CRUD through read/dispatch/watch', async () => {
    const mapper = createMapper(unusedLoop)
    const pushed: MapperSnapshot[] = []
    const unwatch = mapper.watch(event => pushed.push(event.snapshot))

    const created = await mapper.dispatch({
      type: 'map.create',
      workspaceId: WORKSPACE_ID,
      name: 'Map',
    })
    if (created.type !== 'map.updated') throw new Error('create failed')
    const mapId = created.snapshot.mapId

    const withSource = await mapper.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'source', uri: '/tmp/a.txt', sourceKind: 'file' },
    })
    if (withSource.type !== 'map.updated') throw new Error('source failed')
    const sourceId = withSource.snapshot.nodes.find(node => node.kind === 'source')!.id

    await mapper.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'news', sourceId, content: 'news' },
    })
    const read = await mapper.read({ type: 'map.snapshot', mapId })
    if (read.type !== 'map.snapshot' || !read.snapshot) throw new Error('read failed')
    const news = read.snapshot.nodes.find(node => node.kind === 'news')!

    await mapper.dispatch({
      type: 'node.create',
      mapId,
      node: {
        kind: 'route',
        parentId: news.id,
        agentName: 'data',
        priority: 'high',
      },
    })
    await mapper.dispatch({
      type: 'node.create',
      mapId,
      node: { kind: 'claim', newsId: news.id, content: 'claim' },
    })
    await mapper.dispatch({
      type: 'node.update',
      mapId,
      nodeId: news.id,
      patch: { kind: 'news', content: 'updated' },
    })

    const listed = await mapper.read({ type: 'map.list', workspaceId: WORKSPACE_ID })
    expect(listed).toMatchObject({
      type: 'map.list',
      maps: [expect.objectContaining({ id: mapId, newsCount: 1, claimCount: 1 })],
    })

    await mapper.dispatch({ type: 'node.delete', mapId, nodeId: sourceId })
    const empty = await mapper.read({ type: 'map.snapshot', mapId })
    if (empty.type !== 'map.snapshot' || !empty.snapshot) throw new Error('read failed')
    expect(empty.snapshot.nodes).toEqual([])
    expect(pushed.length).toBeGreaterThan(4)

    await mapper.dispatch({ type: 'map.delete', mapId })
    expect(await mapper.read({ type: 'map.snapshot', mapId })).toEqual({
      type: 'map.snapshot',
      snapshot: null,
    })
    unwatch()
    await mapper.close()
  })
})
