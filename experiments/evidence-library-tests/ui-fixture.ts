// 为界面状态和浏览器验收启动临时真实 Mongo/HTTP，准备身份和 Claim 后统一清理。
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'

import type { Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

import type { EvidenceClaimRef } from '../../contracts/evidence-library'
import { applicationCreateService } from '../../apps/graph-server/application'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { storeCreateConnection } from '../../backend/adapters/storage/mongo/connection'
import { clientCreateGateway } from '../../client/graph-client'

enum UiFixtureMessage {
  ADDRESS_MISSING = 'Evidence UI fixture did not bind a port.',
  CLAIM_MISSING = 'Evidence UI fixture did not save its Claim.',
  TYPE_MISSING = 'Evidence UI fixture has no registered Claim type.',
  CLEANUP_FAILED = 'Evidence UI fixture cleanup failed.',
}

export async function evidenceCreateUiFixture() {
  // 每次创建独立数据库、HTTP、用户和两个工作区，不连接用户部署资源。
  const mongo = new MongoMemoryReplSet({ instanceOpts: [{ launchTimeout: 30_000 }],
    replSet: { count: 1, storageEngine: 'wiredTiger' } })
  let connection: Connection | undefined
  let application: ReturnType<typeof applicationCreateService> | undefined
  let server: ReturnType<typeof apiCreateServer> | undefined
  let gateway: ReturnType<typeof clientCreateGateway> | undefined
  let closing: Promise<void> | undefined

  function close(): Promise<void> {
    // 失败路径和正常结束共用一次资源清理，后续清理不被前一项错误截断。
    return closing ??= (async () => {
      // 先停止接收请求，再关闭应用、数据库和本工厂拥有的 mongod。
      const errors: unknown[] = []
      try { await gateway?.disconnect() } catch (error) { errors.push(error) }
      if (server) {
        server.beginShutdown()
        server.closeAllConnections()
        try { await closeServer(server) } catch (error) { errors.push(error) }
      }
      try { await application?.closeMessaging() } catch (error) { errors.push(error) }
      try { await connection?.close(true) } catch (error) { errors.push(error) }
      try { await mongo.stop({ doCleanup: true, force: true }) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, UiFixtureMessage.CLEANUP_FAILED)
    })()
  }

  try {
    await mongo.start()
    connection = await storeCreateConnection(mongo.getUri(`evidence_ui_${randomUUID().replaceAll('-', '')}`))
    application = applicationCreateService(connection)
    await application.initialize()
    await application.control.seed()
    await application.startMessaging()
    const owner = await application.auth.createUser({ id: randomUUID(), displayName: '证据库界面验收', hostAdmin: true })
    const viewer = await application.auth.createUser({ id: randomUUID(), displayName: '证据库只读验收', hostAdmin: false })
    const ownerToken = (await application.auth.createToken(owner.userId)).token
    const viewerToken = (await application.auth.createToken(viewer.userId)).token
    server = apiCreateServer(application, { internalToken: randomUUID() })
    const baseUrl = await listenServer(server)
    gateway = clientCreateGateway({ baseUrl })
    await gateway.connect({ baseUrl, token: ownerToken, remember: false })
    const workspaceId = randomUUID(), otherWorkspaceId = randomUUID()
    for (const id of [workspaceId, otherWorkspaceId]) {
      await gateway.dispatch(randomUUID(), 'workspace.create', { id,
        name: id === workspaceId ? '证据库验收' : '空白工作区', description: '临时界面验收数据', agentSource: 'empty' })
    }
    const workspace = await gateway.read('workspace.get', { workspaceId })
    await gateway.dispatch(randomUUID(), 'member.set', { workspaceId, expectedRevision: workspace.revision,
      userId: viewer.userId, role: 'viewer' })
    const connectedGateway = gateway

    async function createClaim(
      /* 通过真实图写入的 Claim 原文。 */ content: string,
      /* 来源归属的真实工作区，默认主验收工作区。 */ targetWorkspaceId = workspaceId,
    ): Promise<EvidenceClaimRef> {
      // 新建独立 Map 和 Claim，图版本与来源身份来自真实公共响应。
      const current = await connectedGateway.read('workspace.get', { workspaceId: targetWorkspaceId })
      const definitions = await connectedGateway.read('definition.get', { workspaceId: targetWorkspaceId })
      const type = definitions.catalog.dataTypes.find((/* 目录中的实际注册类型。 */ item) => /* 选取核查 Claim 精确版本。 */ item.id === 'factcheck.claim')
      if (!type) throw new Error(UiFixtureMessage.TYPE_MISSING)
      const mapId = randomUUID(), nodeId = randomUUID()
      await connectedGateway.dispatch(randomUUID(), 'map.create', { id: mapId, workspaceId: targetWorkspaceId,
        expectedRevision: current.revision, name: '陈述来源' })
      const written = await connectedGateway.dispatch(randomUUID(), 'graph.apply', { mapId,
        branch: { rootIds: [nodeId], expectedVersion: null },
        changes: { nodes: { put: [{ id: nodeId, typeId: type.id, typeVersion: type.version, payload: { content, category: null } }] } } })
      const node = written.data.snapshot.nodes.find((/* 图提交后实际保存的节点。 */ item) => /* 读取新 Claim 版本。 */ item.id === nodeId)
      if (!node) throw new Error(UiFixtureMessage.CLAIM_MISSING)
      return { mapId, nodeId, revision: node.revision }
    }

    return { baseUrl, ownerToken, viewerToken, ownerId: owner.userId, viewerId: viewer.userId,
      workspaceId, otherWorkspaceId, gateway: connectedGateway, createClaim, close }
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], UiFixtureMessage.CLEANUP_FAILED) }
    throw error
  }
}

function closeServer(
  /* 已开始关闭、仍由本工厂拥有的 HTTP 服务。 */ server: Server,
): Promise<void> {
  // 将 Server 关闭回调转为有终点的可等待清理。
  if (!server.listening) return Promise.resolve()
  return new Promise((/* 服务成功关闭时结束等待。 */ resolve, /* 服务关闭异常时保留失败。 */ reject) => {
    // 资源清理结果交还调用者，不忽略关闭错误。
    server.close((/* HTTP 关闭过程的实际错误。 */ error) => /* 按真实关闭结果完成 Promise。 */ error ? reject(error) : resolve())
  })
}

async function listenServer(
  /* 本工厂创建但尚未监听的 HTTP 服务。 */ server: Server,
): Promise<string> {
  // 等随机回环端口就绪后返回可用于真实 HTTP 的源地址。
  await new Promise<void>((/* 监听就绪时解除等待。 */ resolve, /* 保留端口绑定失败。 */ reject) => {
    // 在开始监听前安装启动错误监听，监听成功后移除。
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      // 后续服务运行错误不再归属启动 Promise。
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(UiFixtureMessage.ADDRESS_MISSING)
  return `http://127.0.0.1:${address.port}`
}
