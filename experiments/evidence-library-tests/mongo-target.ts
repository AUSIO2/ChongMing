// 把独立测试协议接到真实 Mongo、身份、工作区和图应用；库规则全部交给应用层。
import { createHash, randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

import type { Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

import type { Asset, DefinitionView, Identity, WorkspaceView } from '../../contracts/control'
import { EvidenceMessage } from '../../contracts/evidence-library'
import type { GraphNodeInput } from '../../contracts/graph'
import type { GraphSnapshot, GraphWriteResult } from '../../contracts/graph-api'
import type { GraphBranchSnapshot } from '../../contracts/graph-branch'

import { DEFAULT_WORKSPACE_SEED } from '../../apps/config/default-prompts'
import { outboxCreateService } from '../../backend/adapters/messaging/mongo-outbox'
import { sourceReadUrl } from '../../backend/adapters/sources/http-source'
import { storeCreateConnection } from '../../backend/adapters/storage/mongo/connection'
import { createMongoEvidenceQuery } from '../../backend/adapters/storage/mongo/evidence-query'
import { persistenceCreateMongo } from '../../backend/adapters/storage/mongo/persistence'
import { applicationBuildService, type ApplicationService } from '../../backend/application/graph-application'
import { GraphError } from '../../backend/modules/shared/domain-error'
import { evidenceReadQuery } from '../../backend/modules/evidence-library/evidence-input'
import type { Persistence } from '../../backend/ports/persistence'

import { collectInput, libraryRef, PRESSURE_QUERY, seedItem } from './fixtures'
import type {
  Actor, CallOptions, ClaimRef, Entry, EvidenceTestTarget, Method, MethodInputs, MethodResults,
  QueryObservation, SeedResult, TargetOptions,
} from './test-contract'

enum MongoTargetMessage {
  CLOSED = 'Isolated Mongo target is closed.',
  CLEANUP_FAILED = 'Isolated Mongo target cleanup failed.',
  CANCEL_CLEANUP_FAILED = 'Cancelled Mongo operation cleanup failed.',
  INITIALIZE_CLEANUP_FAILED = 'Isolated Mongo initialization cleanup failed.',
  TYPE_MISSING = 'Graph fixture type was not present in the workspace catalog.',
  NODE_MISSING = 'Graph fixture command did not return its saved node.',
  SOURCE_MISSING = 'Graph fixture source node was not present in its map.',
}

// 为超出本轮核心范围的真实测试操作返回明确未实现错误，不生成替代业务结果。
function notImplemented(): never {
  throw new GraphError(501, 'NOT_IMPLEMENTED', EvidenceMessage.NOT_IMPLEMENTED)
}

/** 每次工厂调用都拥有独立副本集、数据库、用户和工作区；不连接任何部署资源。 */
export async function createEvidenceTestTarget(
  /* 加载器创建的隔离目录、后端选择和初始化取消信号。 */ options: TargetOptions,
): Promise<EvidenceTestTarget> {
  if (options.backend !== 'mongo') notImplemented()
  options.signal?.throwIfAborted()
  const dbPath = path.join(options.directory, 'mongo')
  await mkdir(dbPath, { recursive: true })
  const mongo = new MongoMemoryReplSet({ instanceOpts: [{ dbPath, launchTimeout: 30_000 }],
    replSet: { count: 1, storageEngine: 'wiredTiger' } })
  let connection: Connection | undefined
  let app: ApplicationService | undefined
  let isClosed = false
  let closePromise: Promise<void> | undefined
  let shouldFailCommit = false
  let queryObservation: QueryObservation | null = null

  /** 清理不依赖测试结果；关闭连接失败仍会停止本工厂拥有的 mongod。 */
  function close(): Promise<void> {
    isClosed = true
    return closePromise ??= (async () => {
      // 顺序停止消息服务、连接和本工厂的副本集，并汇总所有清理失败。
      const errors: unknown[] = []
      try {
        await app?.closeMessaging()
      } catch (error) { errors.push(error) }
      try {
        await connection?.close(true)
      } catch (error) { errors.push(error) }
      try {
        await mongo.stop({ doCleanup: true, force: true })
      } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, MongoTargetMessage.CLEANUP_FAILED)
    })()
  }

  /** 取消调用同时终止真实连接与副本集，使在途数据库操作不会继续占用隔离环境。 */
  async function call<T>(
    /* 要执行的真实业务或资源操作；取消时关闭它依赖的真实 Mongo 连接。 */ action: () => Promise<T>,
    /* 本次测试操作的取消信号。 */ callOptions?: CallOptions,
  ): Promise<T> {
    const signal = callOptions?.signal
    if (signal?.aborted) {
      await close()
      signal.throwIfAborted()
    }
    if (isClosed) throw new Error(MongoTargetMessage.CLOSED)
    if (!signal) return action()
    let abort!: () => void
    const cancelled = new Promise<never>((
      /* 取消通知永远不成功完成，保留 Promise 构造器的位置参数。 */ _resolve,
      /* 真实资源关闭后交还原取消原因或清理失败。 */ reject,
    ) => {
      // 在操作开始前注册一次性取消监听，取消路径拥有完整资源关闭。
      abort = () => {
        // 请求取消后等待真实资源清理，再结束取消 Promise。
        void close().then(
          () => /* 清理成功后返回原取消原因。 */ reject(signal.reason),
          (/* 连接或副本集清理失败。 */ error) => /* 同时保留取消和清理原因。 */ reject(new AggregateError(
            [signal.reason, error], MongoTargetMessage.CANCEL_CLEANUP_FAILED)),
        )
      }
      signal.addEventListener('abort', abort, { once: true })
    })
    try {
      const result = await Promise.race([action(), cancelled])
      if (signal.aborted) await close()
      signal.throwIfAborted()
      return result
    } catch (error) {
      // 驱动也可能因连接关闭先抛错；取消路径仍须等 mongod 完成清理再交还调用方。
      if (signal.aborted) {
        try {
          await close()
        } catch (cleanupError) {
          throw new AggregateError([signal.reason, cleanupError], MongoTargetMessage.CANCEL_CLEANUP_FAILED)
        }
        signal.throwIfAborted()
      }
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  try {
    // 启动过程由 memory-server 的 launchTimeout 约束；任何初始化取消均在工厂返回前清理。
    await mongo.start()
    options.signal?.throwIfAborted()
    connection = await storeCreateConnection(mongo.getUri(`evidence_${randomUUID().replaceAll('-', '')}`))
    options.signal?.throwIfAborted()
    const persisted = persistenceCreateMongo(connection)
    const database: Persistence = { ...persisted,
      transaction: (/* 同一真实会话中执行授权和库写入的业务回调。 */ callback) =>
        /* 只包装提交 seam，所有记录和图操作仍来自 Mongo persistence。 */ persisted.transaction(async (
          /* Mongo 驱动拥有的当前活动事务会话。 */ session,
        ) => {
          // 标记只属于下一次真实事务，在完成其全部回调写入后才触发失败。
          const failThisTransaction = shouldFailCommit
          shouldFailCommit = false
          const result = await callback(session)
          // 在真实事务回调完成全部写入后、Mongo 提交前抛错，驱动会撤销条目、收据和目录写入。
          if (failThisTransaction) throw new GraphError(503, 'EVIDENCE_COMMIT_FAILED', EvidenceMessage.COMMIT_FAILED)
          return result
        }),
    }
    // 核心收录不执行 Run；现有 outbox 的无 broker 配置保留真实部署身份初始化。
    app = applicationBuildService(database, outboxCreateService(connection, database.graph()), {
      clientLeases: 'none', readUrl: sourceReadUrl, seedConfiguration: DEFAULT_WORKSPACE_SEED,
      evidenceQuery: createMongoEvidenceQuery(connection, (
        /* 生产 adapter 从真实查询、投影和 explain 得到的执行观测。 */ observation,
      ) => {
        // 保存最近一次真实搜索的独立观测副本供测试检查。
        queryObservation = structuredClone(observation)
      }),
    })
    const application = app
    await call(() => /* 初始化真实身份、图、资产、库和 outbox 索引。 */ application.initialize(), options)
    await call(() => /* 将默认配置写入本工厂隔离数据库，供工作区保存精确类型。 */ application.control.seed(), options)
    await call(() => /* 启动现有无 broker outbox 生命周期。 */ application.startMessaging(), options)
    const actors = {} as Record<Actor, { identity: Identity; token: string }>
    for (const actor of ['owner', 'editor', 'viewer', 'outsider'] as const) {
      const identity = await call(
        () => /* 创建该测试角色对应的真实系统用户。 */ application.auth.createUser({
          id: randomUUID(), displayName: `Evidence ${actor}`, hostAdmin: actor === 'owner',
        }), options,
      )
      const { token } = await call(
        () => /* 给真实用户创建持久化认证令牌。 */ application.auth.createToken(identity.userId), options,
      )
      actors[actor] = { identity, token }
    }
    const ownerToken = actors.owner.token
    const workspaceId = randomUUID()
    const otherWorkspaceId = randomUUID()
    for (const id of [workspaceId, otherWorkspaceId]) {
      await call(() => /* 由真实 owner 命令创建成员隔离的工作区。 */ application.dispatch(ownerToken, {
        requestId: randomUUID(), method: 'workspace.create', params: {
          id, name: 'Isolated evidence fixture', description: '', agentSource: 'empty',
        },
      }), options)
    }

    // 读取真实工作区版本，供夹具管理命令使用其并发前置条件。
    async function workspace(/* 要读取当前版本的隔离工作区身份。 */ id: string): Promise<WorkspaceView> {
      return await application.read(ownerToken, { method: 'workspace.get', params: { workspaceId: id } }) as WorkspaceView
    }
    for (const actor of ['editor', 'viewer'] as const) {
      const current = await call(() => /* 读取添加该成员前的工作区版本。 */ workspace(workspaceId), options)
      await call(() => /* 按真实成员命令授予 editor 或 viewer 权限。 */ application.dispatch(ownerToken, {
        requestId: randomUUID(), method: 'member.set', params: {
          workspaceId, expectedRevision: current.revision, userId: actors[actor].identity.userId, role: actor,
        },
      }), options)
    }

    /** 方法映射保留外部输入的额外字段，真实公共输入解析负责拒绝固定字段覆盖。 */
    async function request<M extends Method>(
      /* 当前操作使用的真实系统身份对应的测试角色。 */ actor: Actor,
      /* 测试协议动作，将映射为生产公共方法。 */ method: M,
      /* 原样交给生产服务解析的外部输入，包含故意非法值和额外字段。 */ input: MethodInputs[M],
      /* 当前业务操作的取消信号。 */ callOptions?: CallOptions,
    ): Promise<MethodResults[M]> {
      return call(async () => {
        // 生产方法会验证输入并返回其真实 DTO；单次关系断言仅消除 app 方法的宽联合类型。
        const token = actors[actor].token
        switch (method) {
          case 'collect': {
            const { requestId, ...params } = input as MethodInputs['collect']
            const result = await application.dispatch(token, { requestId, method: 'evidence.collect', params })
            return result.data as MethodResults[M]
          }
          case 'get':
            return await application.read(token, evidenceReadQuery({
              method: 'evidence.get', params: input as MethodInputs['get'],
            })) as MethodResults[M]
          case 'search':
            return await application.read(token, evidenceReadQuery({
              method: 'evidence.search', params: input as MethodInputs['search'],
            })) as MethodResults[M]
          case 'withdraw': {
            const { requestId, ...params } = input as MethodInputs['withdraw']
            const result = await application.dispatch(token, { requestId, method: 'evidence.withdraw', params })
            return result.data as MethodResults[M]
          }
          default: return notImplemented()
        }
      }, callOptions)
    }

    // 经真实资产上传接口保存夹具字节，不为证据条目计算业务摘要。
    async function createAsset(
      /* 夹具附件所属的隔离工作区。 */ id: string,
      /* 要实际上传并由资产服务校验的原始正文。 */ text: string,
    ): Promise<{ id: string; sha256: string }> {
      const bytes = Buffer.from(text)
      // 此 SHA-256 仅是实际上传字节的输入声明；返回资产身份和摘要均取真实 upload 结果。
      const result = await application.assets.upload(ownerToken, { workspaceId: id, requestId: randomUUID(),
        filename: 'fixture.txt', mediaType: 'text/plain', size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') }, Readable.from([bytes]))
      return { id: result.data.id, sha256: result.data.sha256 }
    }

    // 取得真实节点所在分支的当前证明，供修改或删除夹具节点。
    async function branch(/* 测试已创建的来源节点身份。 */ ref: ClaimRef): Promise<GraphBranchSnapshot> {
      return await application.read(ownerToken, {
        method: 'branch.get', params: { mapId: ref.mapId, rootIds: [ref.nodeId] },
      }) as GraphBranchSnapshot
    }

    const target: EvidenceTestTarget = {
      info: { name: 'Real Mongo evidence core application', backend: 'mongo', executionModel: 'pooled', isolated: true },
      workspaceId, otherWorkspaceId, request,
      fixtures: {
        // 在新 Map 中经真实图命令保存当前注册类型的节点，并返回服务端节点版本。
        async createNode(
          /* 来源 Map 所属的隔离工作区。 */ id,
          /* 本用例要求的实际数据类型。 */ type,
          /* 要写入该类型 payload 或来源附件的原文。 */ content,
          /* 可选节点身份及取消信号，每次调用仍创建独立 Map。 */ fixtureOptions,
        ) {
          return call(async () => {
            // 先取得当前配置和已保存类型，再按真实图创建规则写入节点。
            const current = await workspace(id)
            const mapId = randomUUID()
            const nodeId = fixtureOptions?.nodeId ?? randomUUID()
            const definitions = await application.read(ownerToken, {
              method: 'definition.get', params: { workspaceId: id },
            }) as DefinitionView
            const definition = definitions.catalog.dataTypes.find(
              (/* 真实工作区目录内的一份已注册不可变类型。 */ item) =>
                /* 选择夹具明确要求的业务类型，不自行构造类型定义。 */ item.id === `factcheck.${type}`,
            )
            if (!definition) throw new Error(MongoTargetMessage.TYPE_MISSING)
            await application.dispatch(ownerToken, { requestId: randomUUID(), method: 'map.create', params: {
              id: mapId, workspaceId: id, expectedRevision: current.revision, name: 'Evidence source fixture',
            } })
            let payload: GraphNodeInput['payload']
            if (type === 'claim') payload = { content, category: null }
            else if (type === 'news') payload = { content, context: {} }
            else {
              const asset = await createAsset(id, content)
              payload = { locator: { kind: 'asset', assetId: asset.id, mediaType: 'text/plain' }, label: content }
            }
            const node: GraphNodeInput = { id: nodeId, typeId: definition.id, typeVersion: definition.version, payload }
            const result = await application.dispatch(ownerToken, { requestId: randomUUID(), method: 'graph.apply', params: {
              mapId, branch: { rootIds: [nodeId], expectedVersion: null }, changes: { nodes: { put: [node] } },
            } }) as { data: GraphWriteResult }
            const stored = result.data.snapshot.nodes.find(
              (/* 真实图写入结果中的一个节点。 */ item) => /* 提取本次创建节点的服务端版本。 */ item.id === nodeId,
            )
            if (!stored) throw new Error(MongoTargetMessage.NODE_MISSING)
            return { mapId, nodeId, revision: stored.revision }
          }, fixtureOptions)
        },
        // 经真实分支证明更新来源 Claim；保留其已保存精确类型和其他 payload 字段。
        async updateClaim(
          /* 本用例已创建的来源 Claim 身份。 */ ref,
          /* 要交给真实图服务保存的新原文。 */ content,
        ) {
          return call(async () => {
            // 从真实 Map 取得原节点类型，再用当前分支证明更新正文。
            const current = await branch(ref)
            const snapshot = await application.read(ownerToken, {
              method: 'map.get', params: { mapId: ref.mapId },
            }) as GraphSnapshot
            const source = snapshot.nodes.find(
              (/* 当前真实来源图中的节点。 */ item) => /* 定位待更新的来源节点。 */ item.id === ref.nodeId,
            )
            if (!source) throw new Error(MongoTargetMessage.SOURCE_MISSING)
            const result = await application.dispatch(ownerToken, { requestId: randomUUID(), method: 'graph.apply', params: {
              mapId: ref.mapId, branch: { rootIds: current.scope.rootIds, expectedVersion: current.version },
              changes: { nodes: { put: [{ id: ref.nodeId, typeId: source.typeId, typeVersion: source.typeVersion,
                payload: { ...source.payload, content } }] } },
            } }) as { data: GraphWriteResult }
            const stored = result.data.snapshot.nodes.find(
              (/* 真实图写入结果中的节点。 */ item) => /* 提取更新后的服务端版本。 */ item.id === ref.nodeId,
            )
            if (!stored) throw new Error(MongoTargetMessage.NODE_MISSING)
            return { mapId: ref.mapId, nodeId: ref.nodeId, revision: stored.revision }
          })
        },
        // 经真实图删除命令移除来源节点，保留库条目是否仍可读取的业务断言。
        async deleteClaim(/* 要通过真实分支证明删除的节点身份。 */ ref) {
          await call(async () => {
            // 使用当前分支版本删除来源节点，不直接更改 Mongo 文档。
            const current = await branch(ref)
            await application.dispatch(ownerToken, { requestId: randomUUID(), method: 'graph.apply', params: {
              mapId: ref.mapId, branch: { rootIds: current.scope.rootIds, expectedVersion: current.version },
              changes: { nodes: { remove: [ref.nodeId] } },
            } })
          })
        },
        // 使用当前真实 Map 版本删除整张来源图。
        async deleteMap(/* 要删除的来源 Map 身份。 */ mapId) {
          await call(async () => {
            // 当前图版本由真实 map.get 读取，再交给真实 map.delete 仲裁。
            const current = await application.read(ownerToken, { method: 'map.get', params: { mapId } }) as GraphSnapshot
            await application.dispatch(ownerToken, { requestId: randomUUID(), method: 'map.delete', params: {
              mapId, expectedRevision: current.revision,
            } })
          })
        },
        // 将附件夹具写入真实 GridFS 和资产元数据，由资产服务完成完整性校验。
        createAsset: (
          /* 附件所属的隔离工作区。 */ id,
          /* 要保存的原始正文。 */ text,
        ) => /* 纳入目标的资源取消与生命周期管理。 */ call(
          () => /* 调用真实资产上传准备该附件。 */ createAsset(id, text),
        ),
        // 经真实资产删除命令验证图和库冻结引用的保护规则。
        async deleteAsset(/* 要删除的真实资产身份。 */ assetId) {
          await call(async () => {
            // 取得真实资产摘要，用公共删除命令触发生产引用检查。
            const asset = await application.read(ownerToken, { method: 'asset.get', params: { assetId } }) as Asset
            await application.dispatch(ownerToken, { requestId: randomUUID(), method: 'asset.delete', params: {
              assetId, expectedSha256: asset.sha256,
            } })
          })
        },
        // 通过真实成员管理命令撤销主工作区权限，同时保留有效系统身份。
        async revoke(/* 要从主工作区移除成员资格的测试角色。 */ actor) {
          await call(async () => {
            // 成员变更使用当前工作区 revision，真实授权事务负责撤权仲裁。
            const current = await workspace(workspaceId)
            await application.dispatch(ownerToken, { requestId: randomUUID(), method: 'member.set', params: {
              workspaceId, expectedRevision: current.revision, userId: actors[actor].identity.userId, role: null,
            } })
          })
        },
        // 标记下一次真实事务在完成写入后、Mongo 提交前抛错。
        async failNextCommit() {
          await call(async () => {
            // 故障注入仅设置事务 seam 的一次性开关，不伪造库响应。
            shouldFailCommit = true
          })
        },
        // 用确定性输入语料和真实收录命令预置核心搜索数据；使用关系留到后续阶段。
        async seed(
          /* 测试约定的确定性语料、条目规模和使用关系规模。 */ plan,
          /* 预置准备阶段的取消信号。 */ callOptions,
        ): Promise<SeedResult> {
          return call(async () => {
            // 预期命中身份只取输入标记和实际收录身份，绝不查询目标搜索结果。
            if (plan.usages !== 0) notImplemented()
            const entryRefs: SeedResult['entryRefs'] = []
            const sampleEntries: Entry[] = []
            const expectedQueryIds: string[] = []
            for (let index = 0; index < plan.entries; index += 1) {
              const item = seedItem(index, plan)
              const ref = await target.fixtures.createNode(workspaceId, 'claim', item.content, callOptions)
              const result = await request('editor', 'collect', collectInput(target, ref, item.confidence), callOptions)
              entryRefs.push(libraryRef(result.entry))
              if (item.matchesQuery) expectedQueryIds.push(result.entry.id)
              if (sampleEntries.length < 16) sampleEntries.push(result.entry)
            }
            return { entryRefs, sampleEntries, query: PRESSURE_QUERY, expectedQueryIds, entries: plan.entries, usages: 0 }
          }, callOptions)
        },
      },
      inspect: {
        // 从真实集合计数，拒绝输入或失败事务的原子性由测试比较前后状态。
        counts: (
          /* 要观察持久化状态的隔离工作区身份。 */ id,
          /* 本次计数查询的取消信号。 */ callOptions,
        ) => /* 将真实集合读取纳入目标取消管理。 */ call(async () => {
          // 未实现集合也直接向 Mongo 计数，不在适配层生成假记录。
          const [entries, receipts, usages, snapshots, assets] = await Promise.all([
            database.records('evidence_entries').count({ workspaceId: id }),
            database.records('evidence_receipts').count({ workspaceId: id }),
            database.records('evidence_usages').count({ workspaceId: id }),
            database.records('evidence_snapshots').count({ workspaceId: id }),
            database.records('control_assets').count({ workspaceId: id, state: 'ready' }),
          ])
          return { entries, receipts, usages, snapshots, assets }
        }, callOptions),
        // 返回真实 Mongo 存储统计、本进程 RSS 和生产搜索 adapter 的最近执行观测。
        telemetry: (/* 本次统计查询的取消信号。 */ callOptions) =>
          /* 查询真实存储而非估算业务数据规模。 */ call(async () => {
            // 初始化已完成并拥有 ready 连接，统计命令沿用该连接。
            const readyConnection = connection
            if (!readyConnection?.db) throw new Error(MongoTargetMessage.CLOSED)
            const stats = await readyConnection.db.command({ dbStats: 1 }) as { storageSize: number }
            return { storageBytes: stats.storageSize, targetRssBytes: process.memoryUsage().rss,
              queryObservation: structuredClone(queryObservation) }
          }, callOptions),
      },
      // 无论测试成功、失败或关闭信号取消，均先结束本目标拥有的真实资源。
      async close(/* 关闭阶段独立取消期限，只在资源清理后返回其取消状态。 */ callOptions) {
        await close()
        callOptions?.signal?.throwIfAborted()
      },
    }
    options.signal?.throwIfAborted()
    return target
  } catch (error) {
    try {
      await close()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], MongoTargetMessage.INITIALIZE_CLEANUP_FAILED)
    }
    throw error
  }
}
