// 在独立真实 Mongo 与 HTTP 中构造来源链，原图编辑沿用真实分支租约和版本证明。
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'

import type { Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'

import type { DataTypeDefinition, JsonValue } from '../../contracts/data-definition'
import type { EvidenceClaimRef, EvidenceCollectParams } from '../../contracts/evidence-library'
import type { GraphChanges, GraphEdge, GraphNode, GraphNodeInput, GraphPayload } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'

import { applicationCreateService } from '../../apps/graph-server/application'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { storeCreateConnection } from '../../backend/adapters/storage/mongo/connection'
import { clientCreateApi } from '../../client/graph-client'
import { applicability } from './fixtures'

enum RelationFixtureMessage {
  ADDRESS_MISSING = 'Relation fixture did not bind an HTTP port.',
  TYPE_MISSING = 'Relation fixture cannot find its registered data type.',
  NODE_MISSING = 'Relation fixture cannot find its saved node.',
  BRANCH_BUSY = 'Relation fixture did not obtain the real edit lease.',
  RESPONSE_INVALID = 'Relation fixture received an invalid relation response.',
  CLEANUP_FAILED = 'Relation fixture cleanup failed.',
}

// 测试独立声明外部协议，避免通过生产遍历逻辑反推预期关系。
export interface RelationTestNode {
  key: string
  ref: EvidenceClaimRef
  nodeSnapshot: GraphNode
  definitionDigest: string
  role: 'claim' | 'upstream' | 'downstream' | 'basis' | 'dependency'
}
export type RelationTestEdge =
  | { key: string; kind: 'graph'; from: string; to: string; mapId: string; edge: GraphEdge }
  | { key: string; kind: 'payload'; from: string; to: string; mapId: string; path: string }
  | { key: string; kind: 'basis'; from: string; to: string; basisIndex: number }
export interface RelationTestSnapshot {
  version: 1
  capturedAt: string
  rootKey: string
  nodes: RelationTestNode[]
  edges: RelationTestEdge[]
  truncated: boolean
}
export interface RelationTestView {
  workspaceId: string
  entryId: string
  contentDigest: string
  snapshot: RelationTestSnapshot | null
}

export async function evidenceCreateRelationFixture() {
  // 工厂只拥有临时 mongod、数据库和 HTTP；失败与正常结束都释放同一组资源。
  const mongo = new MongoMemoryReplSet({ instanceOpts: [{ launchTimeout: 30_000 }],
    replSet: { count: 1, storageEngine: 'wiredTiger' } })
  let connection: Connection | undefined
  let application: ReturnType<typeof applicationCreateService> | undefined
  let server: ReturnType<typeof apiCreateServer> | undefined
  let client: ReturnType<typeof clientCreateApi> | undefined
  let closing: Promise<void> | undefined

  function close(): Promise<void> {
    // 可重复调用的清理继续释放后续资源，并保留实际失败。
    return closing ??= (async () => {
      // 先终止 HTTP 请求，再关闭服务装配、数据库连接和本工厂的进程。
      const errors: unknown[] = []
      client?.close()
      if (server) {
        server.beginShutdown()
        server.closeAllConnections()
        try { await closeServer(server) } catch (error) { errors.push(error) }
      }
      try { await application?.closeMessaging() } catch (error) { errors.push(error) }
      try { await connection?.close(true) } catch (error) { errors.push(error) }
      try { await mongo.stop({ doCleanup: true, force: true }) } catch (error) { errors.push(error) }
      if (errors.length) throw new AggregateError(errors, RelationFixtureMessage.CLEANUP_FAILED)
    })()
  }

  try {
    await mongo.start()
    connection = await storeCreateConnection(mongo.getUri(`evidence_relations_${randomUUID().replaceAll('-', '')}`))
    application = applicationCreateService(connection)
    await application.initialize()
    await application.control.seed()
    await application.startMessaging()
    const owner = await application.auth.createUser({ id: randomUUID(), displayName: '关系验收 owner', hostAdmin: true })
    const viewer = await application.auth.createUser({ id: randomUUID(), displayName: '关系验收 viewer', hostAdmin: false })
    const outsider = await application.auth.createUser({ id: randomUUID(), displayName: '关系验收 outsider', hostAdmin: false })
    const ownerToken = (await application.auth.createToken(owner.userId)).token
    const viewerToken = (await application.auth.createToken(viewer.userId)).token
    const outsiderToken = (await application.auth.createToken(outsider.userId)).token
    server = apiCreateServer(application, { internalToken: randomUUID() })
    const baseUrl = await listenServer(server)
    client = clientCreateApi({ baseUrl, token: ownerToken })
    const connectedClient = client

    async function createWorkspace(): Promise<string> {
      // 用真实公共命令创建独立工作区并授予 viewer 只读权限。
      const workspaceId = randomUUID()
      const workspace = (await connectedClient.dispatch(randomUUID(), 'workspace.create', {
        id: workspaceId, name: '关系验收', description: '', agentSource: 'empty',
      })).data
      await connectedClient.dispatch(randomUUID(), 'member.set', { workspaceId, expectedRevision: workspace.revision,
        userId: viewer.userId, role: 'viewer' })
      return workspaceId
    }

    async function readType(
      /* 节点实际归属的工作区。 */ workspaceId: string,
      /* 测试要求的真实注册类型身份。 */ typeId: string,
    ): Promise<DataTypeDefinition> {
      // 使用实际工作区目录的精确不可变版本，测试不重写默认 schema。
      const definitions = await connectedClient.read('definition.get', { workspaceId })
      const type = definitions.catalog.dataTypes.find((/* 当前真实目录项。 */ item) => /* 找回明确指定类型。 */ item.id === typeId)
      if (!type) throw new Error(RelationFixtureMessage.TYPE_MISSING)
      return type
    }

    async function nodeInput(
      /* 节点实际归属的工作区。 */ workspaceId: string,
      /* 节点的真实注册类型。 */ typeId: string,
      /* 经生产 schema 校验的输入正文。 */ payload: GraphPayload,
      /* 可指定同名身份以验证跨 Map 隔离，否则新建身份。 */ id = randomUUID(),
    ): Promise<GraphNodeInput> {
      // 仅构造用户输入，类型与版本由真实目录给出。
      const type = await readType(workspaceId, typeId)
      return { id, typeId: type.id, typeVersion: type.version, payload }
    }

    async function opinionInput(
      /* 该意见实际归属的工作区。 */ workspaceId: string,
      /* 意见原始分数，默认保留中间值。 */ score = 0.5,
      /* 可指定多个真实意见的固定身份。 */ id = randomUUID(),
    ): Promise<GraphNodeInput> {
      // 使用当前工厂发布的精确 Opinion 类型与 evidenceClaimIds，不制造旧 Evidence 实例。
      const type = await readType(workspaceId, 'factcheck.opinion')
      return { id, typeId: type.id, typeVersion: type.version,
        payload: { score, reason: '该核查意见原分数为 0.5。', evidenceClaimIds: [] } }
    }

    async function createGraph(
      /* 新图实际归属的工作区。 */ workspaceId: string,
      /* 本次创建的真实节点输入。 */ nodes: GraphNodeInput[],
      /* 实际提交的 successor/reference 边。 */ edges: NonNullable<NonNullable<GraphChanges['edges']>['put']> = [],
    ): Promise<GraphSnapshot> {
      // 新图创建只使用尚不存在的根证明；其后的编辑必须取得真实租约。
      const workspace = await connectedClient.read('workspace.get', { workspaceId })
      const mapId = randomUUID()
      await connectedClient.dispatch(randomUUID(), 'map.create', { id: mapId, workspaceId,
        expectedRevision: workspace.revision, name: '关系来源图' })
      const rootIds = nodes.filter((/* 待保存节点。 */ node) =>
        /* successor 入边以外的独立根，不将 reference 当结构边。 */ !edges.some((/* 待保存实际边。 */ edge) =>
          /* 判断是否已有结构父节点。 */ edge.kind === 'successor' && edge.to === node.id)).map(
        (/* 已确定的独立根。 */ node) => /* 提交真实根身份。 */ node.id,
      )
      return (await connectedClient.dispatch(randomUUID(), 'graph.apply', { mapId,
        branch: { rootIds, expectedVersion: null }, changes: { nodes: { put: nodes }, edges: { put: edges } } })).data.snapshot
    }

    async function editGraph(
      /* 要编辑的真实 Map 身份。 */ mapId: string,
      /* 当前真实图的结构根，足以包含本次变更范围。 */ rootIds: string[],
      /* 经生产图规则验证的真实变更。 */ changes: GraphChanges,
    ): Promise<GraphSnapshot> {
      // 取得占有后使用 grant 中同次读取的版本证明，并在所有结果路径释放租约。
      const claimed = (await connectedClient.dispatch(randomUUID(), 'branch.claim', {
        mapId, rootIds, holderId: randomUUID(),
      })).data
      if (claimed.status !== 'claimed') throw new Error(RelationFixtureMessage.BRANCH_BUSY)
      const grant = claimed.grant
      const lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
      try {
        return (await connectedClient.dispatch(randomUUID(), 'graph.apply', { mapId, lease,
          branch: { rootIds: grant.branch.scope.rootIds, expectedVersion: grant.branch.version }, changes })).data.snapshot
      } finally {
        await connectedClient.dispatch(randomUUID(), 'branch.release', { mapId, lease })
      }
    }

    async function relationResponse(
      /* 真实公开查询参数，也允许构造非法外部输入。 */ params: unknown,
      /* 查询身份令牌，默认实际 owner。 */ token = ownerToken,
    ): Promise<{ status: number; body: unknown }> {
      // 新方法在契约实现之前仍通过真实 HTTP 发请求，不 stub 生产服务。
      const response = await fetch(`${baseUrl}/api/v1/query`, { method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ method: 'evidence.relations', params }) })
      const body: unknown = await response.json()
      return { status: response.status, body }
    }

    async function relations(
      /* 要读取其固定关系的工作区身份。 */ workspaceId: string,
      /* 已由真实收录保存的条目身份。 */ entryId: string,
      /* 可选真实只读或非成员令牌。 */ token = ownerToken,
    ): Promise<RelationTestView> {
      // 先验证真实 HTTP 成功信封，再逐字段解析外部关系 DTO。
      const response = await relationResponse({ workspaceId, entryId }, token)
      const body = readRecord(response.body)
      if (response.status !== 200 || body.ok !== true) throw new Error(RelationFixtureMessage.RESPONSE_INVALID)
      return parseRelationView(body.data)
    }

    return { baseUrl, ownerToken, viewerToken, outsiderToken, connection, client: connectedClient,
      createWorkspace, readType, nodeInput, opinionInput, createGraph, editGraph, relationResponse, relations, close }
  } catch (error) {
    try { await close() }
    catch (cleanupError) { throw new AggregateError([error, cleanupError], RelationFixtureMessage.CLEANUP_FAILED) }
    throw error
  }
}

export function relationClaimRef(
  /* 已通过真实图提交的节点快照。 */ graph: GraphSnapshot,
  /* 需要成为来源或显式依据的真实节点身份。 */ nodeId: string,
): EvidenceClaimRef {
  // 引用实际保存版本，避免夹具假定节点初始 revision。
  const node = graph.nodes.find((/* 真实保存节点。 */ item) => /* 找回指定身份。 */ item.id === nodeId)
  if (!node) throw new Error(RelationFixtureMessage.NODE_MISSING)
  return { mapId: graph.mapId, nodeId, revision: node.revision }
}

export function relationCollectParams(
  /* 显式收录目标工作区。 */ workspaceId: string,
  /* 实际保存的精确 Claim 版本。 */ claim: EvidenceClaimRef,
  /* 本次收录判断，保持数字 0 或 1。 */ confidence: 0 | 1 = 0,
): EvidenceCollectParams {
  // 人工依据仅表达用户判断，不制造来源关系。
  return { workspaceId, claim, confidence, applicability: applicability(), reason: '用户明确固定原陈述判断。',
    basisRefs: [{ kind: 'manual', text: '本用例显式收录理由。' }] }
}

export function relationRequireSnapshot(
  /* 从真实 HTTP 验证后的关系视图。 */ view: RelationTestView,
): RelationTestSnapshot {
  // 只在新收录场景要求快照存在；旧记录用例单独验证 null。
  if (view.snapshot === null) throw new Error(RelationFixtureMessage.RESPONSE_INVALID)
  return view.snapshot
}

function parseRelationView(
  /* 真实 HTTP 信封内尚未确认关系类型的值。 */ value: unknown,
): RelationTestView {
  // 验证完整公开关系身份，不从当前 Map 查询或补足缺失快照。
  const view = readRecord(value)
  return { workspaceId: readText(view.workspaceId), entryId: readText(view.entryId),
    contentDigest: readDigest(view.contentDigest), snapshot: view.snapshot === null ? null : parseSnapshot(view.snapshot) }
}

function parseSnapshot(
  /* 真实返回但尚未建立关系端点和固定节点形状的快照。 */ value: unknown,
): RelationTestSnapshot {
  // 解析实际保存节点和三种关系，不将 payload/basis 强行当 GraphEdge。
  const snapshot = readRecord(value)
  if (snapshot.version !== 1 || typeof snapshot.truncated !== 'boolean') invalidResponse()
  const nodes = readArray(snapshot.nodes).map((/* 固定节点外部值。 */ value): RelationTestNode => {
    // 节点角色与精确来源身份必须同时可解释。
    const node = readRecord(value), ref = readRecord(node.ref)
    const role = node.role
    if (role !== 'claim' && role !== 'upstream' && role !== 'downstream' && role !== 'basis' && role !== 'dependency') invalidResponse()
    return { key: readText(node.key), ref: { mapId: readText(ref.mapId), nodeId: readText(ref.nodeId), revision: readRevision(ref.revision) },
      nodeSnapshot: parseNode(node.nodeSnapshot), definitionDigest: readDigest(node.definitionDigest), role }
  })
  const edges = readArray(snapshot.edges).map((/* 固定关系外部值。 */ value): RelationTestEdge => {
    // 每种关系保留自身协议要求的完整信息。
    const edge = readRecord(value)
    const key = readText(edge.key), from = readText(edge.from), to = readText(edge.to)
    if (edge.kind === 'graph') return { key, from, to, kind: edge.kind, mapId: readText(edge.mapId), edge: parseEdge(edge.edge) }
    if (edge.kind === 'payload') return { key, from, to, kind: edge.kind, mapId: readText(edge.mapId), path: readText(edge.path) }
    if (edge.kind === 'basis') return { key, from, to, kind: edge.kind, basisIndex: readRevision(edge.basisIndex) }
    return invalidResponse()
  })
  return { version: 1, capturedAt: readTimestamp(snapshot.capturedAt), rootKey: readText(snapshot.rootKey),
    nodes, edges, truncated: snapshot.truncated }
}

function parseNode(
  /* 真实 HTTP 固定节点，尚未验证必要 GraphNode 字段。 */ value: unknown,
): GraphNode {
  // 保留完整快照原字段，并明确校验图身份、版本和 JSON payload。
  const node = readRecord(value), payload = readRecord(node.payload)
  assertJson(payload)
  return { ...node, id: readText(node.id), revision: readRevision(node.revision), typeId: readText(node.typeId),
    typeVersion: readRevision(node.typeVersion), payload,
    createdAt: readTimestamp(node.createdAt), updatedAt: readTimestamp(node.updatedAt) }
}

function parseEdge(
  /* 真实 HTTP 保存的完整 GraphEdge 外部值。 */ value: unknown,
): GraphEdge {
  // 逐字段建立实际边和可选精确来源锚点，不忽略坏锚点。
  const edge = readRecord(value)
  if (edge.kind !== 'successor' && edge.kind !== 'reference') invalidResponse()
  const result: GraphEdge = { ...edge, id: readText(edge.id), kind: edge.kind, from: readText(edge.from), to: readText(edge.to),
    revision: readRevision(edge.revision), createdAt: readTimestamp(edge.createdAt), updatedAt: readTimestamp(edge.updatedAt) }
  if (edge.label !== undefined) result.label = readText(edge.label)
  if (edge.sourceAnchors !== undefined) result.sourceAnchors = readArray(edge.sourceAnchors).map((/* 原文锚点外部值。 */ value) => {
    // 保留硬换行、精确来源版本及原文内容。
    const anchor = readRecord(value)
    return { path: readText(anchor.path), sourceRevision: readRevision(anchor.sourceRevision),
      startLine: readRevision(anchor.startLine), endLine: readRevision(anchor.endLine), quote: readText(anchor.quote) }
  })
  return result
}

export function relationReadRecord(
  /* 存储 seam 返回的未知测试条目，不预设其公开和内部字段。 */ value: unknown,
): Record<string, unknown> {
  // 允许测试安全读取已保存内部记录；只用于构造旧格式和单字段损坏场景。
  return readRecord(value)
}

function readRecord(
  /* 尚未确认普通对象形状的外部 JSON 或 Mongo 值。 */ value: unknown,
): Record<string, unknown> {
  // 阻止空值和数组被当作字段对象读取。
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalidResponse()
  return value as Record<string, unknown>
}

function readArray(
  /* 尚未确认数组形状的外部关系集合。 */ value: unknown,
): unknown[] {
  // 只接受实际数组，逐项解析由调用者完成。
  if (!Array.isArray(value)) invalidResponse()
  return value
}

function readText(
  /* 必须有内容的外部身份、路径或原文。 */ value: unknown,
): string {
  // 保留固定字符串原值，拒绝缺失和空字符串。
  if (typeof value !== 'string' || !value.length) invalidResponse()
  return value
}

function readDigest(
  /* 外部固定内容或定义的完整 SHA-256 摘要。 */ value: unknown,
): string {
  // 摘要必须是完整小写十六进制串。
  const digest = readText(value)
  if (!/^[a-f0-9]{64}$/.test(digest)) invalidResponse()
  return digest
}

function readRevision(
  /* 外部节点版本、锚点行号或依据位置。 */ value: unknown,
): number {
  // 只接受可精确表示的非负整数。
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidResponse()
  return value
}

function readTimestamp(
  /* 外部捕获、节点或边的保存时间。 */ value: unknown,
): string {
  // 校验时间可解释但不改动保存值。
  const timestamp = readText(value)
  if (!Number.isFinite(Date.parse(timestamp))) invalidResponse()
  return timestamp
}

function assertJson(
  /* 尚未确认有限 JSON 内容的固定 payload。 */ value: unknown,
): asserts value is JsonValue {
  // 验证 JSON 形状，仅用于外部 DTO 的 payload 入口。
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value)) invalidResponse(); return }
  if (Array.isArray(value)) { for (const item of value) assertJson(item); return }
  const record = readRecord(value)
  for (const item of Object.values(record)) assertJson(item)
}

function invalidResponse(): never {
  // 夹具拒绝未验证响应，不通过类型断言把它伪装成合法关系。
  throw new Error(RelationFixtureMessage.RESPONSE_INVALID)
}

async function listenServer(
  /* 工厂拥有且尚未监听的真实 HTTP 服务。 */ server: Server,
): Promise<string> {
  // 监听回环随机端口，启动错误有明确等待终点。
  await new Promise<void>((/* 监听就绪时解除等待。 */ resolve, /* 实际监听失败时拒绝。 */ reject) => {
    // 启动阶段单独处理监听错误。
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      // 已就绪之后移除启动阶段处理器。
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(RelationFixtureMessage.ADDRESS_MISSING)
  return `http://127.0.0.1:${address.port}`
}

function closeServer(
  /* 工厂拥有、已经停止接收新请求的服务。 */ server: Server,
): Promise<void> {
  // 等待真实 HTTP 资源关闭，重复清理可以直接结束。
  if (!server.listening) return Promise.resolve()
  return new Promise((/* 成功关闭时解除等待。 */ resolve, /* 实际关闭失败时拒绝。 */ reject) => {
    // 关闭回调的结果直接决定清理是否成功。
    server.close((/* Server 返回的实际关闭错误。 */ error) => /* 返回真实关闭结果。 */ error ? reject(error) : resolve())
  })
}
