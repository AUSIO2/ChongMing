import type { Connection } from 'mongoose'
import type { ControlCommand, ControlQuery } from '../contracts/control'
import type { GraphCommand, GraphQuery } from '../contracts/graph'
import { assetsCreateService } from './assets'
import { authCreateService, type RequestContext } from './auth'
import { controlCreateService } from './control'
import { graphCreateService } from './graph'
import { GraphError } from './graph-error'
import { storeCreateGraphStore } from './store'

export function applicationCreateService(connection: Connection, options: { leaseMs?: number } = {}) {
  const store = storeCreateGraphStore(connection)
  const graph = graphCreateService(store, options)
  const auth = authCreateService(connection)
  const control = controlCreateService(connection)
  const assets = assetsCreateService(connection, auth, control)

  async function applicationReadMap(ctx: RequestContext, mapId: string, role: 'viewer' | 'editor') {
    const document = await storeCreateGraphStore(connection, ctx.session).read(mapId)
    if (!document) throw new GraphError(404, 'MAP_NOT_FOUND', 'Map not found')
    await control.requireRole(ctx, document.workspaceId, role)
    return document
  }

  return {
    store, graph, auth, control, assets,
    async initialize(): Promise<void> {
      await auth.initialize()
      await Promise.all([store.initialize(), control.initialize(), assets.initialize()])
    },

    async read(token: string, query: GraphQuery | ControlQuery) {
      const ctx = await auth.read(token)
      if (query.method === 'asset.get') return assets.read(ctx, query.params.assetId)
      if (query.method === 'map.list') {
        await control.requireRole(ctx, query.params.workspaceId, 'viewer')
        return graph.read(query)
      }
      if (query.method === 'map.get' || query.method === 'run.get') {
        await applicationReadMap(ctx, query.params.mapId, 'viewer')
        return graph.read(query)
      }
      return control.read(ctx, query)
    },

    async dispatch(token: string, command: GraphCommand | ControlCommand) {
      if (command.method === 'workspace.import') return assets.importWorkspace(token, command)
      return auth.transact(token, async ctx => {
        if (command.method === 'asset.delete') return assets.delete(ctx, command)
        if (!['map.create', 'map.delete', 'graph.apply', 'run.start', 'run.cancel', 'review.update', 'review.answer'].includes(command.method)) {
          return control.dispatch(ctx, command as ControlCommand)
        }
        const input = command as GraphCommand
        // Public idempotency belongs to the user, never a guessed requestId from another member.
        const scoped = { ...input, requestId: `${ctx.actor.userId}:${input.requestId}` } as GraphCommand
        const transactionalStore = storeCreateGraphStore(connection, ctx.session)
        const service = graphCreateService(transactionalStore, options)
        if (input.method === 'map.create') {
          const workspace = await control.requireRole(ctx, input.params.workspaceId, 'editor')
          const prior = await transactionalStore.read(input.params.id)
          if (prior && prior.workspaceId !== input.params.workspaceId) throw new GraphError(404, 'MAP_NOT_FOUND', 'Map not found')
          if (!prior?.receipts.some(receipt => receipt.requestId === scoped.requestId) && workspace.revision !== input.params.expectedRevision) {
            throw new GraphError(409, 'REVISION_CONFLICT', 'Workspace revision changed', workspace.revision)
          }
          return service.dispatch(scoped)
        }
        const document = await applicationReadMap(ctx, input.params.mapId, 'editor')
        const replay = document.receipts.some(receipt => receipt.requestId === scoped.requestId)
        if (input.method === 'graph.apply' && !replay) await assets.assertReferences(ctx, document.workspaceId, input.params.changes.nodes?.put ?? [])
        const configuration = input.method === 'run.start' && !replay ? await control.configuration(ctx, document.workspaceId) : undefined
        return service.dispatch(scoped, configuration)
      })
    },
  }
}

export type ApplicationService = ReturnType<typeof applicationCreateService>
