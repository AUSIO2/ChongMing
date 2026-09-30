// 组装身份、工作区、资产和图服务，统一公共请求的授权与事务边界。
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

/**
 * 将鉴权、工作区、资产和图服务接入同一持久化入口，并暴露消息服务的生命周期。
 *
 * @param database 供所有业务服务共享、并负责授权事务的持久化入口。
 * @param outbox 负责图变更通知、工作投递和临时活动的消息服务。
 * @param options 租期、客户端协调策略、来源策略与默认 Agent 配置；客户端策略只能由服务装配决定。
 */
export function applicationBuildService(database: Persistence,
  outbox: MessagingService,
  options: { leaseMs?: number; clientLeases?: 'required' | 'none'; allowPrivateSources?: boolean; readUrl: SourceReader; seedConfiguration: GraphSeedConfiguration }) {
  const store = database.graph()
  const auth = authCreateService(database)
  const control = controlCreateService(database, options.seedConfiguration, options.clientLeases)
  const assets = assetsCreateService(database, auth, control, options)
  const graphBase = graphCreateService(store, { ...options, now: () => database.now(), readSource: assets.readSource })
  const graph = {
    ...graphBase,
    /**
     * Agent 产物与资产删除共用工作区写栅栏和数据库事务，避免同时通过引用检查形成写偏差。
     *
     * @param mapId 内部 Host 提交的图身份。
     * @param operationId 提案所属 Operation。
     * @param proposal 已解析的通用阶段提案。
     * @param proof 当前 Work 凭证。
     */
    async propose(mapId: string, operationId: string,
      proposal: Parameters<typeof graphBase.propose>[2], proof: GraphWorkProof) {
      return database.transaction(async session => {
        const transactionalStore = database.graph(session)
        const document = await transactionalStore.read(mapId)
        if (!document || document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
        await control.fenceExecutionWrite(session, document.workspaceId)
        const service = graphCreateService(transactionalStore, { ...options, now: () => database.now(), readSource: assets.readSource,
          assertOutputReferences: (workspaceId, nodes, definitions) => assets.assertInternalReferences(workspaceId, nodes, definitions, session) })
        return service.propose(mapId, operationId, proposal, proof)
      })
    },
  }

  /**
   * 沿用请求的存储会话读取图并检查工作区角色；写请求的权限检查还会更新授权栅栏，参与并发撤权仲裁。
   *
   * @param ctx 已经解析用户身份并携带可选事务的请求上下文。
   * @param mapId 需要读取并检查工作区权限的图身份。
   * @param role 此次调用要求的最低工作区角色。
   */
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
    /**
     * 验证活动仍属于当前有效租约和可执行工作，再向消息服务发布临时执行状态。
     *
     * @param mapId 临时活动所属的图身份。
     * @param proof 活动上报者的 work、holder 和 fence 证明。
     * @param status 当前执行阶段的活动状态。
     * @param sequence 同一 work 与 fence 授权内递增的活动序号；工作被重新领取后可从新序号开始。
     */
    async publishActivity(mapId: string, proof: GraphWorkProof, status: ActivityStatus, sequence: number) {
      const activity = await activityReadRecord(store, mapId, proof, status, sequence)
      await outbox.publishActivity(activity, proof.holderId)
    },
    /**
     * 验证查看权限，重新检查缓存活动的工作租约，并过滤已经失去租约的活动。
     *
     * @param token 读取活动的用户令牌。
     * @param mapId 需要列出有效临时活动的图身份。
     */
    async readActivities(token: string, mapId: string) {
      await applicationReadMap(await auth.read(token), mapId, 'viewer')
      const items = await Promise.all(outbox.readActivities(mapId).map(async change => {
        // 用当前工作信息重建活动，保留原发布时间；只忽略租约失效，其他读取错误继续抛出。
        const item = change.activity!
        try {
          const current = await activityReadRecord(store, mapId, { workId: item.workId, holderId: change.holderId!, fence: item.fence }, item.status, item.sequence)
          return { ...current, updatedAt: item.updatedAt }
        } catch (error) { if (error instanceof GraphError && error.code === 'LEASE_LOST') return null; throw error }
      }))
      return items.filter((item): item is NonNullable<typeof item> => /* 去掉租约失效时产生的空项。 */ item !== null)
    },
    /**
     * 校验用户的查看权限并拒绝已删除的图，再返回带节点产出来源的公开快照。
     *
     * @param token 读取图快照的用户令牌。
     * @param mapId 需要投影为公开快照的图身份。
     */
    async readSnapshot(token: string, mapId: string) {
      const document = await applicationReadMap(await auth.read(token), mapId, 'viewer')
      if (document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
      return graphReadSnapshot(document, await database.now(), options.clientLeases !== 'none')
    },
    /**
     * 确认用户可以查看仍存在的图，供事件订阅等不需要完整快照的入口鉴权。
     *
     * @param token 建立事件订阅前需要校验的用户令牌。
     * @param mapId 订阅目标图身份。
     */
    async authorizeMap(token: string, mapId: string) {
      const document = await applicationReadMap(await auth.read(token), mapId, 'viewer')
      if (document.deletedAt) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
    },
    async initialize(): Promise<void> {
      // 先初始化身份服务及底层存储，再并行准备图、工作区、资产和消息服务。
      await auth.initialize()
      await Promise.all([store.initialize(), control.initialize(), assets.initialize(), outbox.initialize()])
    },

    /**
     * 解析用户身份，将查询交给对应业务服务，并在读取图列表、图或 Run 前检查查看权限。
     *
     * @param token 发起只读查询的用户令牌。
     * @param query 待分派的图查询或管理查询。
     */
    async read(token: string, query: GraphQuery | ControlQuery) {
      const ctx = await auth.read(token)
      if (query.method === 'asset.get') return assets.read(ctx, query.params.assetId)
      if (query.method === 'asset.list') return assets.list(ctx, query.params)
      if (query.method === 'map.list') {
        await control.requireRole(ctx, query.params.workspaceId, 'viewer')
        return graph.read(query)
      }
      if (query.method === 'map.get' || query.method === 'branch.get' || query.method === 'run.get') {
        const document = await applicationReadMap(ctx, query.params.mapId, 'viewer')
        return graph.read(query, query.method === 'branch.get' ? await control.definitions(ctx, document.workspaceId) : undefined)
      }
      return control.read(ctx, query)
    },

    /**
     * 将普通写命令的身份、权限和业务更新放入同一事务；数据包导入由资产服务管理自己的事务。
     *
     * @param token 发起写命令的用户令牌。
     * @param command 待在授权事务或资产专用流程中执行的命令。
     */
    async dispatch(token: string, command: GraphCommand | ControlCommand) {
      if (command.method === 'workspace.import') return assets.importWorkspace(token, command)
      return auth.transact(token, async ctx => {
        // 在已锁定写入身份的事务中分派命令，并为图写入绑定当前用户的幂等请求标识。
        if (command.method === 'asset.delete') return assets.delete(ctx, command)
        if (!['map.create', 'map.delete', 'graph.apply', 'branch.claim', 'branch.renew', 'branch.release', 'run.control.claim', 'run.control.renew', 'run.control.release',
          'run.start', 'run.cancel', 'run.pause', 'run.resume', 'review.answer'].includes(command.method)) {
          return control.dispatch(ctx, command as ControlCommand)
        }
        const input = command as GraphCommand
        // 用用户 ID 隔离收据，避免其他成员猜中 requestId 后重放不属于自己的请求。
        const scoped = { ...input, requestId: `${ctx.actor.userId}:${input.requestId}` } as GraphCommand
        const transactionalStore = database.graph(ctx.session)
        const service = graphCreateService(transactionalStore, { ...options, now: () => database.now(), readSource: assets.readSource,
          assertOutputReferences: (workspaceId, nodes, definitions) => assets.assertInternalReferences(workspaceId, nodes, definitions, ctx.session) })
        if (input.method === 'map.create') {
          const workspace = await control.requireRole(ctx, input.params.workspaceId, 'editor')
          const prior = await transactionalStore.read(input.params.id)
          if (prior && prior.workspaceId !== input.params.workspaceId) throw new GraphError(404, 'MAP_NOT_FOUND', RuntimeMessage.MAP_NOT_FOUND)
          // 已成功的创建请求可重放；只有新请求需要匹配当前工作区版本。
          if (!prior?.receipts.some(receipt => /* 查找当前用户这次创建请求的收据。 */ receipt.requestId === scoped.requestId) && workspace.revision !== input.params.expectedRevision) {
            throw new GraphError(409, 'REVISION_CONFLICT', RuntimeMessage.WORKSPACE_REVISION_CHANGED, workspace.revision)
          }
          return service.dispatch(scoped)
        }
        const document = await applicationReadMap(ctx, input.params.mapId, 'editor')
        const replay = document.receipts.some(receipt => /* 判断当前用户的请求是否已经提交。 */ receipt.requestId === scoped.requestId)
        // 重放沿用既有提交，不重新要求资产或配置仍满足新写入条件；图服务会核对收据的输入摘要。
        if (input.method === 'graph.apply' && !replay) await assets.assertReferences(ctx, document.workspaceId, input.params.changes.nodes?.put ?? [])
        if (input.method === 'map.delete') return service.dispatch(scoped)
        const execution = !replay && input.method === 'run.start' ? await control.executionCatalog(ctx, document.workspaceId) : undefined
        const definitions = execution?.definitions ?? await control.definitions(ctx, document.workspaceId)
        return service.dispatch(scoped, { definitions, actorUserId: ctx.actor.userId, ...(execution ? { run: {
          definitions: execution.definitions, agents: execution.agents, tools: execution.tools, maxSlots: execution.maxSlots,
        } } : {}) })
      })
    },
  }
}

export type ApplicationService = ReturnType<typeof applicationBuildService>
