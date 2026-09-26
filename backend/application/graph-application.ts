import { RuntimeMessage } from '../../contracts/messages'
import type { Persistence } from '../ports/persistence'
import type { MessagingService } from '../ports/messaging'
import type { SourceReader } from '../ports/source-reader'
import type { ActivityStatus } from '../../contracts/activity'
import type { GraphWorkProof, GraphCommand, GraphQuery } from '../../contracts/graph'
import type { ControlCommand, ControlQuery } from '../../contracts/control'
import type { GraphSeedConfiguration } from '../modules/workspace/agent-configuration'
import { activityReadRecord } from '../modules/graph/work-activity'
import { assetsCreateService } from '../modules/assets/asset-service'
import { authCreateService, type RequestContext } from '../modules/identity/identity-service'
import { controlCreateService } from '../modules/workspace/workspace-service'
import { graphCreateService, graphReadSnapshot } from '../modules/graph/graph-service'
import { GraphError } from '../modules/shared/domain-error'

// 用途：组装服务，供后续流程使用。
export function applicationBuildService(database: Persistence,
  outbox: MessagingService,
  options: { leaseMs?: number; allowPrivateSources?: boolean; readUrl: SourceReader; seedConfiguration: GraphSeedConfiguration }) {
  const store = database.graph()
  const auth = authCreateService(database)
  const control = controlCreateService(database, options.seedConfiguration)
  const assets = assetsCreateService(database, auth, control, options)
  const graph = graphCreateService(store, { ...options, readSource: assets.readSource })

    // 用途：读取数据图，并把结构化结果交给调用方。
    async function applicationReadMap(ctx: RequestContext, mapId: string, role: 'viewer' | 'editor') {
    const document = await database.graph(ctx.session).read(mapId)
    if (!document) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
    await control.requireRole(ctx, document.workspaceId, role)
    return document
  }

  return {
    store, graph, auth, control, assets,
    messaging: outbox.messaging, startMessaging: outbox.startMessaging, messagingFinished: outbox.finished,
    closeMessaging: outbox.closeMessaging, watchChanges: outbox.watchChanges,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async publishActivity(mapId: string, proof: GraphWorkProof, status: ActivityStatus, sequence: number) {
      const activity = await activityReadRecord(store, mapId, proof, status, sequence)
      await outbox.publishActivity(activity, proof.holderId)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readActivities(token: string, mapId: string) {
      await applicationReadMap(await auth.read(token), mapId, 'viewer')
      const items = await Promise.all(outbox.readActivities(mapId).map(async change => {
        const item = change.activity!
        try {
          const current = await activityReadRecord(store, mapId, { workId: item.workId, holderId: change.holderId!, fence: item.fence }, item.status, item.sequence)
          return { ...current, updatedAt: item.updatedAt }
        } catch (error) { if (error instanceof GraphError && error.code === 'LEASE_LOST') return null; throw error }
      }))
      return items.filter((item): item is NonNullable<typeof item> => item !== null)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async readSnapshot(token: string, mapId: string) {
      const document = await applicationReadMap(await auth.read(token), mapId, 'viewer')
      if (document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
      return graphReadSnapshot(document)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async authorizeMap(token: string, mapId: string) {
      const document = await applicationReadMap(await auth.read(token), mapId, 'viewer')
      if (document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize(): Promise<void> {
      await auth.initialize()
      await Promise.all([store.initialize(), control.initialize(), assets.initialize(), outbox.initialize()])
    },

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read(token: string, query: GraphQuery | ControlQuery) {
      const ctx = await auth.read(token)
      if (query.method === 'asset.get') return assets.read(ctx, query.params.assetId)
      if (query.method === 'asset.list') return assets.list(ctx, query.params)
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

    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async dispatch(token: string, command: GraphCommand | ControlCommand) {
      if (command.method === 'workspace.import') return assets.importWorkspace(token, command)
      return auth.transact(token, async ctx => {
        if (command.method === 'asset.delete') return assets.delete(ctx, command)
        if (!['map.create', 'map.delete', 'graph.apply', 'run.start', 'run.cancel', 'run.pause', 'run.resume', 'review.update', 'review.answer'].includes(command.method)) {
          return control.dispatch(ctx, command as ControlCommand)
        }
        const input = command as GraphCommand
        // Public idempotency belongs to the user, never a guessed requestId from another member.
        const scoped = { ...input, requestId: `${ctx.actor.userId}:${input.requestId}` } as GraphCommand
        const transactionalStore = database.graph(ctx.session)
        const service = graphCreateService(transactionalStore, options)
        if (input.method === 'map.create') {
          const workspace = await control.requireRole(ctx, input.params.workspaceId, 'editor')
          const prior = await transactionalStore.read(input.params.id)
          if (prior && prior.workspaceId !== input.params.workspaceId) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
          if (!prior?.receipts.some(receipt => receipt.requestId === scoped.requestId) && workspace.revision !== input.params.expectedRevision) {
            throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.WORKSPACE_REVISION_CHANGED, workspace.revision)
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

export type ApplicationService = ReturnType<typeof applicationBuildService>
