// 验证四个核心库操作跨真实 HTTP 和公共客户端后的协议往返及畸形响应拒绝。
import { randomUUID } from 'node:crypto'

import type { Connection } from 'mongoose'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { EvidenceClaimRef, EvidenceCollectParams } from '../../contracts/evidence-library'

import { applicationCreateService } from '../../apps/graph-server/application'
import { apiCreateServer } from '../../backend/adapters/http/graph-http-server'
import { storeCreateConnection } from '../../backend/adapters/storage/mongo/connection'
import { clientCreateApi, type ClientApi } from '../../client/graph-client'

import { applicability } from './fixtures'

enum CoreHttpMessage {
  ADDRESS_MISSING = 'Core HTTP fixture did not bind a TCP port.',
  TYPE_MISSING = 'Core HTTP fixture could not find its registered Claim type.',
  NODE_MISSING = 'Core HTTP fixture did not save its source node.',
  RESPONSE_INVALID = 'Core HTTP fixture received an unexpected response envelope.',
  CLEANUP_FAILED = 'Core HTTP fixture cleanup failed.',
}

let mongo: MongoMemoryReplSet
let connection: Connection
let application: ReturnType<typeof applicationCreateService>
let server: ReturnType<typeof apiCreateServer>
let client: ClientApi
let baseUrl: string
let token: string
let workspaceId: string
let claim: EvidenceClaimRef
const content = '真实 HTTP 收录的原始陈述 httpcore。'

beforeAll(async () => {
  // 装配真实 Mongo 图服务器；不配置 broker，四个核心库操作不依赖 Run 工作投递。
  mongo = new MongoMemoryReplSet({ instanceOpts: [{ launchTimeout: 30_000 }],
    replSet: { count: 1, storageEngine: 'wiredTiger' } })
  await mongo.start()
  connection = await storeCreateConnection(mongo.getUri(`evidence_http_${randomUUID().replaceAll('-', '')}`))
  application = applicationCreateService(connection)
  await application.initialize()
  await application.control.seed()
  await application.startMessaging()
  const owner = await application.auth.createUser({ id: randomUUID(), displayName: 'Core HTTP owner', hostAdmin: true })
  token = (await application.auth.createToken(owner.userId)).token
  server = apiCreateServer(application, { internalToken: randomUUID() })
  await new Promise<void>((
    /* 临时 TCP 服务开始监听时解除等待。 */ resolve,
    /* 保留实际端口绑定失败，交给 Vitest hook 报告。 */ reject,
  ) => {
    // 在监听前建立错误处理，避免端口绑定失败成为未处理的事件。
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      // 监听完成后移除仅属于启动阶段的错误监听。
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error(CoreHttpMessage.ADDRESS_MISSING)
  baseUrl = `http://127.0.0.1:${address.port}`
  client = clientCreateApi({ baseUrl, token })
})

beforeEach(async () => {
  // 每条适配器用例拥有新工作区和来源图，准备也走真实公共客户端请求。
  workspaceId = randomUUID()
  await client.dispatch(randomUUID(), 'workspace.create', {
    id: workspaceId, name: 'Core HTTP workspace', description: '', agentSource: 'empty',
  })
  claim = await createSourceClaim(content)
})

// 在当前用例工作区的新 Map 中保存指定原文，返回实际来源身份及版本。
async function createSourceClaim(
  /* 该来源 Claim 必须实际保存、随后由真实收录服务冻结的原文。 */ text: string,
): Promise<EvidenceClaimRef> {
  const workspace = await client.read('workspace.get', { workspaceId })
  const definitions = await client.read('definition.get', { workspaceId })
  const definition = definitions.catalog.dataTypes.find(
    (/* 当前工作区保存的真实不可变类型。 */ item) =>
      /* 选择此测试明确要求的 Claim，沿用其实际精确版本。 */ item.id === 'factcheck.claim',
  )
  if (!definition) throw new Error(CoreHttpMessage.TYPE_MISSING)
  const mapId = randomUUID()
  const nodeId = randomUUID()
  await client.dispatch(randomUUID(), 'map.create', {
    id: mapId, workspaceId, expectedRevision: workspace.revision, name: 'Core HTTP source',
  })
  const written = await client.dispatch(randomUUID(), 'graph.apply', {
    mapId, branch: { rootIds: [nodeId], expectedVersion: null },
    changes: { nodes: { put: [{ id: nodeId, typeId: definition.id, typeVersion: definition.version,
      payload: { content: text, category: null } }] } },
  })
  const node = written.data.snapshot.nodes.find(
    (/* 本次真实图写入结果中的节点。 */ item) => /* 返回实际保存的来源节点版本。 */ item.id === nodeId,
  )
  if (!node) throw new Error(CoreHttpMessage.NODE_MISSING)
  return { mapId, nodeId, revision: node.revision }
}

afterAll(async () => {
  // 用例或启动 hook 失败也依次关闭客户端、HTTP、消息服务、Mongo 连接和自有 mongod。
  const errors: unknown[] = []
  client?.close()
  if (server) {
    server.beginShutdown()
    server.closeAllConnections()
    if (server.listening) {
      try {
        await new Promise<void>((
          /* 真实 HTTP 服务关闭完成时解除等待。 */ resolve,
          /* 保留 HTTP 资源关闭失败。 */ reject,
        ) => {
          // 把 Server 的关闭回调转换为可等待的测试清理。
          server.close((/* Server 关闭过程的实际错误。 */ error) => {
            // 成功和失败都结束清理等待，后续 Mongo 清理仍会执行。
            if (error) reject(error)
            else resolve()
          })
        })
      } catch (error) { errors.push(error) }
    }
  }
  try {
    await application?.closeMessaging()
  } catch (error) { errors.push(error) }
  try {
    await connection?.close(true)
  } catch (error) { errors.push(error) }
  try {
    await mongo?.stop({ doCleanup: true, force: true })
  } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, CoreHttpMessage.CLEANUP_FAILED)
})

// 只构造四个核心操作的外部输入；验证、去重和业务摘要均由生产服务处理。
function collectParams(
  /* 显式判断或故意非法的外部输入，不在夹具中归一化。 */ confidence: unknown,
  /* 当前用例明确选择的真实来源 Claim，省略时使用默认原文。 */ origin: EvidenceClaimRef = claim,
): EvidenceCollectParams {
  return { workspaceId, claim: origin, confidence, applicability: applicability(),
    reason: '本次 HTTP 集成测试明确记录原陈述的固定判断。',
    basisRefs: [{ kind: 'manual', text: '本用例的独立测试依据。' }] }
}

// 在网络传输 seam 定位响应信封，篡改只用于验证公共客户端拒绝非法判断。
function isRecord(
  /* 真实 HTTP 响应中尚未确认形状的 JSON 值。 */ value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

describe('evidence core HTTP and public client', () => {
  // 这里证明跨 HTTP 的方法白名单、信封映射、数值零、撤回结果和响应校验。
  it.each([0, 1] as const)('confidence %s crosses collect/get/search/withdraw without changing the source', async (
    /* 当前完整 HTTP 往返明确保存的固定数字判断。 */ confidence,
  ) => {
    // 同一范围还保存相反判断，保证 confidence=0 的筛选实际排除其他值。
    const requestId = randomUUID()
    const params = collectParams(confidence)
    const collected = await client.dispatch(requestId, 'evidence.collect', params)
    const entry = collected.data.entry
    const opposite = (await client.dispatch(randomUUID(), 'evidence.collect',
      collectParams(confidence === 0 ? 1 : 0))).data.entry
    expect(collected).toMatchObject({ ok: true, requestId, replayed: false, data: {
      replayed: false, existing: false, entry: { confidence, claim: { origin: claim, nodeSnapshot: { payload: { content } } } },
    } })
    expect(await client.read('evidence.get', { workspaceId, entryId: entry.id })).toEqual(entry)
    expect(await client.dispatch(requestId, 'evidence.collect', params)).toMatchObject({
      replayed: true, data: { replayed: true, entry: { id: entry.id, confidence } },
    })
    const selected = await client.read('evidence.search', { workspaceId, query: 'httpcore', confidence, limit: 1 })
    expect(selected.items).toEqual([{ id: entry.id, content, confidence,
      contentDigest: entry.contentDigest, status: 'active' }])
    expect(selected.nextCursor).toBeNull()
    const withdrawn = (await client.dispatch(randomUUID(), 'evidence.withdraw', {
      workspaceId, entryId: entry.id, expectedRevision: entry.revision, reason: 'HTTP 明确撤回当前条目。',
    })).data
    expect(withdrawn).toMatchObject({ id: entry.id, confidence, claim: entry.claim,
      contentDigest: entry.contentDigest, status: 'withdrawn', statusReason: 'HTTP 明确撤回当前条目。' })
    const active = await client.read('evidence.search', { workspaceId })
    expect(active.items.map(
      (/* 撤回之后默认搜索返回的真实轻量条目。 */ item) => /* 对照仅仍活跃的相反判断条目。 */ item.id,
    )).toEqual([opposite.id])
    expect(await client.read('evidence.get', { workspaceId, entryId: entry.id })).toEqual(withdrawn)
  })

  it('rejects an invalid confidence through the real HTTP error envelope without publishing records', async () => {
    // 该输入须经过 HTTP 信封及真实业务验证，公共客户端保留服务端状态和错误码。
    const beforeEntries = await connection.collection('evidence_entries').countDocuments({ workspaceId })
    const beforeReceipts = await connection.collection('evidence_receipts').countDocuments({ workspaceId })
    await expect(client.dispatch(randomUUID(), 'evidence.collect', collectParams(0.5)))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_CONFIDENCE_INVALID', retryable: false,
        errorId: expect.any(String) })
    expect(await connection.collection('evidence_entries').countDocuments({ workspaceId })).toBe(beforeEntries)
    expect(await connection.collection('evidence_receipts').countDocuments({ workspaceId })).toBe(beforeReceipts)
  })

  it('rejects a malformed confidence response at the fetch seam while the real stored judgement remains zero', async () => {
    // 先取得真实条目，再只在客户端 transport seam 改坏响应字段，数据库不参与篡改。
    const entry = (await client.dispatch(randomUUID(), 'evidence.collect', collectParams(0))).data.entry
    const malformedClient = clientCreateApi({ baseUrl, token, fetch: async (
      /* 公共客户端构造的真实 HTTP 请求地址。 */ input,
      /* 带认证和取消信号的真实请求配置，原样转交网络。 */ init,
    ) => {
      // 访问真实图服务器并消费真实返回，再在响应 seam 注入单一非法字段。
      const response = await fetch(input, init)
      const body: unknown = await response.json()
      if (!isRecord(body) || !isRecord(body.data)) throw new Error(CoreHttpMessage.RESPONSE_INVALID)
      return new Response(JSON.stringify({ ...body, data: { ...body.data, confidence: 0.5 } }), {
        status: response.status, headers: { 'content-type': 'application/json' },
      })
    } })
    try {
      await expect(malformedClient.read('evidence.get', { workspaceId, entryId: entry.id }))
        .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
    } finally {
      malformedClient.close()
    }
    expect(await client.read('evidence.get', { workspaceId, entryId: entry.id })).toEqual(entry)
    expect(entry.confidence).toBe(0)
  })

  it.each([
    { name: 'confidence', path: 'confidence', value: 0.5,
      status: 500, code: 'EVIDENCE_RECORD_INVALID', retryable: true },
    { name: 'fixed content with the original digest', path: 'claim.nodeSnapshot.payload.content',
      value: 'Mongo 中损坏的固定正文；digest 保持原值。',
      status: 500, code: 'EVIDENCE_RECORD_INVALID', retryable: true },
  ])('blocks a damaged $name storage record before HTTP or the client can return it', async (
    /* 要在真实存储 seam 修改的单一字段，以及生产解析器明确规定的受控错误。 */ corruption,
  ) => {
    // 先经 HTTP 保存合法条目，再直接修改本用例工作区的一份 Mongo 记录；不改业务服务。
    const entry = (await client.dispatch(randomUUID(), 'evidence.collect', collectParams(0))).data.entry
    const changed = await connection.collection<{ _id: string }>('evidence_entries').updateOne(
      { _id: entry.id }, { $set: { [corruption.path]: corruption.value } },
    )
    expect(changed.modifiedCount).toBe(1)
    const response = await fetch(`${baseUrl}/api/v1/query`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ method: 'evidence.get', params: { workspaceId, entryId: entry.id } }),
    })
    const body: unknown = await response.json()
    expect(response.status).toBe(corruption.status)
    expect(body).toMatchObject({ ok: false, error: {
      code: corruption.code, retryable: corruption.retryable, errorId: expect.any(String),
    } })
    expect(body).not.toHaveProperty('data')
    expect(JSON.stringify(body)).not.toContain(content)
    await expect(client.read('evidence.get', { workspaceId, entryId: entry.id }))
      .rejects.toMatchObject({ status: corruption.status, code: corruption.code,
        retryable: corruption.retryable, errorId: expect.any(String) })
  })

  it('searches accented Latin and Cyrillic words through HTTP without mixing unrelated entries', async () => {
    // café 与 caf 是不同词项；Москва 也必须成为真实查询条件，不回落到整库。
    const origin = await createSourceClaim('独立档案记载 café Москва。')
    const entry = (await client.dispatch(randomUUID(), 'evidence.collect', collectParams(1, origin))).data.entry
    const unrelated = await createSourceClaim('另一份档案只记载 caf 和其他地点。')
    await client.dispatch(randomUUID(), 'evidence.collect', collectParams(0, unrelated))
    for (const query of ['café', 'Москва']) {
      const page = await client.read('evidence.search', { workspaceId, query })
      expect(page.items.map(
        (/* 真实 Unicode 词项查询返回的摘要。 */ item) => /* 只接受已知输入对应的相关条目身份。 */ item.id,
      )).toEqual([entry.id])
      expect(page.nextCursor).toBeNull()
    }
  })

  it('returns an empty page for a punctuation-only query instead of returning the workspace library', async () => {
    // 工作区必须有已收录条目，才能观察非空标点查询是否被错误当成空查询。
    await client.dispatch(randomUUID(), 'evidence.collect', collectParams(0))
    const page = await client.read('evidence.search', { workspaceId, query: '！！！' })
    expect(page).toMatchObject({ items: [], nextCursor: null })
  })
})
