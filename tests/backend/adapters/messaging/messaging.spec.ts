// 文件职责：验证 Mongo Outbox、RabbitMQ 多 API 广播与认证 SSE 在并发和断线下的一致行为。
import { randomUUID } from 'node:crypto'
import { connect, createServer as createTcpServer, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { apiCreateServer } from '../../../../backend/adapters/http/graph-http-server'
import { applicationCreateService } from '../../../../apps/graph-server/application'
import { type ApplicationService } from '../../../../backend/application/graph-application'
import { queueOpen } from '../../../../backend/adapters/messaging/rabbitmq'
import { type QueueLink } from '../../../../backend/ports/messaging'
import { GRAPH_COLLECTION, type GraphDocument } from '../../../../backend/modules/graph/graph-record'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import type { GraphClaimResult, GraphStreamEvent, QueueChange, QueueWork } from '../../../../contracts/events'
import { createGraphApi, type TestGraphApi } from '../../fixtures/graph-api'

let api: TestGraphApi
const cleanup: Array<() => Promise<unknown>> = []

beforeAll(async () => {
  // 启动带短工作租约的真实图 API 与消息测试环境。
   api = await createGraphApi(1500) }, 90_000)
afterEach(async () => {
  // 逆序执行全部清理，即使某项失败也继续释放资源，最后报告首个异常。
  const failures: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) {
    try { await close() } catch (error) { failures.push(error) }
  }
  if (failures.length) throw failures[0]
})
afterAll(async () => {
  // 关闭整组用例共用的 API 和基础服务。
   await api?.close() }, 30_000)

async function messagingOpenLink(/* 目标应用服务，默认主 API 夹具；队列连接采用其持久部署命名空间。 */ application = api.application): Promise<QueueLink> {
  // 按目标应用的部署命名空间打开真实队列连接，并注册清理。
  const link = await queueOpen({ ...api.queue, namespace: application.messaging().namespace })
  cleanup.push(() => /* 关闭测试打开的队列观察连接。 */  link.close())
  return link
}

async function messagingCreatePeer(/* 是否创建独立数据库，默认 false 与主 API 共用数据库。 */ separateDatabase = false, /* 同伴使用的消息配置，默认主夹具队列；断线用例可覆盖为代理地址。 */ messaging = api.queue) {
  // 创建共用或隔离数据库的 API 同伴，供跨进程广播和部署身份测试。
  const connection = await storeCreateConnection(separateDatabase
    ? api.mongo.getUri('messaging_' + randomUUID().replaceAll('-', '')) : api.uri)
  const application = applicationCreateService(connection, { messaging, leaseMs: 1500 })
  cleanup.push(async () => {
    // 关闭同伴消息服务和 Mongo 连接，隔离数据库还要清理其队列空间。
    await application.closeMessaging(); await connection.close()
    if (separateDatabase) await api.deleteNamespace(application.messaging().namespace)
  })
  await application.initialize()
  return { application, connection }
}

async function messagingServe(/* 需要暴露独立 HTTP 入口的同伴应用服务。 */ application: ApplicationService) {
  // 将指定应用暴露为独立本地 HTTP API，并登记监听清理。
  const server = apiCreateServer(application, { internalToken: api.token })
  await new Promise<void>(/* 同伴 API 成功绑定端口后兑现启动等待的回调。 */ resolve => /* 等待同伴 API 绑定临时端口。 */  server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Messaging API did not bind')
  cleanup.push(async () => {
    // 仅在服务器仍监听时关闭，避免重复关闭产生误报。
    if (!server.listening) return
    await new Promise<void>((/* 同伴服务器关闭成功后的清理完成回调。 */ resolve, /* 同伴服务器关闭失败后的清理拒绝回调。 */ reject) => /* 把同伴 HTTP 服务关闭转为可等待结果。 */  server.close(/* Node HTTP 关闭返回的可选错误，存在时转为清理失败。 */ error => /* 传递 HTTP 关闭的成功或失败。 */  error ? reject(error) : resolve()))
  })
  return { server, url: `http://127.0.0.1:${address.port}` }
}

async function messagingCreateMap() {
  // 创建独立工作区和空图，作为消息与 SSE 用例的业务起点。
  const workspace = await api.createWorkspace()
  const mapId = randomUUID()
  expect(await api.command('map.create', {
    workspaceId: workspace.id, expectedRevision: workspace.revision, id: mapId, name: 'Messaging fixture',
  })).toMatchObject({ status: 201 })
  return { mapId, workspace }
}

async function messagingWatch(/* 当前测试希望订阅的图身份。 */ mapId: string, /* 目标 API 的基础地址，默认主夹具地址，也可传入独立同伴地址。 */ baseUrl = api.url, /* 用于 SSE 请求头的用户令牌，默认工作区拥有者令牌。 */ token = api.userToken) {
  // 使用请求头令牌打开图 SSE，后台解析事件并提供有界等待与取消能力。
  const stop = new AbortController()
  const response = await fetch(`${baseUrl}/api/v1/maps/${mapId}/events`, {
    headers: { authorization: `Bearer ${token}` }, signal: stop.signal,
  })
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/event-stream')
  if (!response.body) throw new Error('Missing SSE response body')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const state = { events: [] as GraphStreamEvent[], ended: false, failure: undefined as unknown }
  const done = (async () => {
    // 持续解码 SSE 字节和帧边界，校验事件名并记录流结束状态。
    let pending = ''
    try {
      while (true) {
        const item = await reader.read()
        if (item.done) break
        pending = (pending + decoder.decode(item.value, { stream: true })).replaceAll('\r\n', '\n')
        let boundary: number
        while ((boundary = pending.indexOf('\n\n')) >= 0) {
          const lines = pending.slice(0, boundary).split('\n')
          pending = pending.slice(boundary + 2)
          const data = lines.filter(/* 已拆开的 SSE 帧文本行，筛选 data 字段。 */ line => /* 筛选 SSE 帧中的数据行。 */  line.startsWith('data:')).map(/* 已经确认以 data 开头的 SSE 文本行，移除前缀读取载荷。 */ line => /* 移除 data 前缀及可选空格以拼接 JSON 载荷。 */  line.slice(5).trimStart()).join('\n')
          if (!data) continue
          const event = JSON.parse(data) as GraphStreamEvent
          const eventName = lines.find(/* SSE 帧的一行文本，查找声明事件类型的 event 字段。 */ line => /* 查找 SSE 帧声明的事件类型。 */  line.startsWith('event:'))?.slice(6).trim()
          expect(eventName).toBe(event.type)
          state.events.push(event)
        }
      }
    } catch (error) { if (!stop.signal.aborted) state.failure = error }
    finally { state.ended = true; reader.releaseLock() }
  })()
  cleanup.push(async () => {
    // 取消测试订阅并等待后台读取结束。
     stop.abort(); await done })
  async function event(/* 匹配目标业务事件的判断函数，轮询缓存时反复调用。 */ predicate: (/* 从 SSE 缓存取得的一条公共图事件，判断是否满足当前等待条件。 */ value: GraphStreamEvent) => boolean) {
    // 等待缓存中出现匹配事件，流读取失败时直接报告原因。
    await expect.poll(() => {
      // 查找目标事件，并在尚未命中时传播已记录的流错误。
      const found = state.events.find(predicate)
      if (!found && state.failure) throw state.failure
      return found
    }, { timeout: 8000 }).toBeDefined()
    return state.events.find(predicate)!
  }
  return { state, done, stop, event }
}

async function messagingClearBaseline(/* 已经建立的测试订阅句柄，清空前先等待完整初始事件到达。 */ stream: Awaited<ReturnType<typeof messagingWatch>>) {
  // 等初始快照与两类管理刷新全部到达后清空事件缓存。
  await stream.event(/* 订阅收到的一条事件，识别首次图快照。 */ event => /* 识别初始图快照。 */  event.type === 'snapshot')
  await stream.event(/* 订阅收到的一条事件，识别初始工作区刷新。 */ event => /* 识别初始工作区刷新提示。 */  event.type === 'refresh' && event.scope === 'workspace')
  await stream.event(/* 订阅收到的一条事件，识别初始共享设置刷新。 */ event => /* 识别初始共享设置刷新提示。 */  event.type === 'refresh' && event.scope === 'settings')
  stream.state.events.length = 0
}

describe('RabbitMQ outbox and authenticated graph streams', () => {
  // 覆盖持久分发、部署隔离、多 API 实时同步及权限失效。
  it('projects fenced activity across API peers without changing the graph and clears it on pause', async () => {
    // 验证活动跨 API 传播但不推进图版本，过时序号不覆盖缓存，暂停后活动清空。
    const { mapId } = await api.createRun()
    const peer = await messagingCreatePeer()
    await peer.application.startMessaging()
    const served = await messagingServe(peer.application)
    const stream = await messagingWatch(mapId, served.url)
    await messagingClearBaseline(stream)
    const document = (await api.store.read(mapId))!
    const work = workReadItems(document)[0]
    const holderId = randomUUID()
    const claim = await api.work('claim', { mapId, workId: work.workId, holderId, hostId: 'activity',
      deploymentId: api.application.messaging().deploymentId })
    const grant = claim.body.data.grant
    const proof = { workId: grant.workId, holderId, fence: grant.fence }
    const publish = (/* 测试构造的活动请求载荷，可故意包含非法状态或额外字段。 */ body: unknown, /* 要放入请求头的 fence，默认当前授权值，可覆盖以测试旧授权拒绝。 */ fence = grant.fence, /* 发送活动使用的令牌，默认内部 Host 令牌，可替换为用户令牌测试鉴权。 */ token = api.token) => /* 携带可调整的令牌与 fence 发送活动请求，用于验证身份及序号边界。 */  fetch(api.url + '/internal/v1/activity', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
        'x-work-id': grant.workId, 'x-work-holder': holderId, 'x-work-fence': String(fence) }, body: JSON.stringify(body),
    })
    expect((await publish({ mapId, status: 'tool', sequence: 2 })).status).toBe(200)
    const event = await stream.event(/* 实时事件候选，查找包含工具执行阶段的活动批次。 */ event => /* 等待包含工具执行状态的活动事件。 */  event.type === 'activity' && event.items.some(/* 活动事件中的单条摘要，检查是否处于 tool 阶段。 */ item => /* 识别工具执行中的活动项。 */  item.status === 'tool'))
    expect(event.type).toBe('activity')
    expect(JSON.stringify(event)).not.toContain(holderId)
    expect(JSON.stringify(event)).not.toContain(api.token)
    expect((await api.store.read(mapId))!.revision).toBe(document.revision)
    expect((await publish({ mapId, status: 'model', sequence: 1 })).status).toBe(200)
    expect((await publish({ mapId, status: 'tool', sequence: 3, parameters: 'secret' })).status).toBe(400)
    expect((await publish({ mapId, status: 'secret', sequence: 3 })).status).toBe(400)
    expect((await publish({ mapId, status: 'tool', sequence: 3 }, grant.fence + 1)).status).toBe(409)
    expect((await publish({ mapId, status: 'tool', sequence: 3 }, grant.fence, api.userToken)).status).toBe(401)
    const cached = await peer.application.readActivities(api.userToken, mapId)
    expect(cached).toHaveLength(1)
    expect(cached[0]).toMatchObject({ status: 'tool', sequence: 2, nodeId: document.runs[0].operations[0].group.inputRefs[0].id,
      stageId: work.stageId, slotId: work.slotId })
    const reconnect = await messagingWatch(mapId, served.url)
    await reconnect.event(/* 重连订阅收到的事件，检查是否补齐唯一缓存活动。 */ event => /* 确认重新订阅时收到已有活动缓存。 */  event.type === 'activity' && event.items.length === 1)
    stream.state.events.length = 0
    expect(await api.command('run.pause', { mapId, runId: document.runs[0].id })).toMatchObject({ status: 200 })
    await stream.event(/* 暂停后推送的事件，检查持久快照中的 paused 标志。 */ event => /* 等待暂停状态的持久化快照。 */  event.type === 'snapshot' && event.snapshot.runs[0]?.paused === true)
    await stream.event(/* 暂停后推送的事件，检查活动集合已经清空。 */ event => /* 等待暂停后的空活动集合。 */  event.type === 'activity' && event.items.length === 0)
    expect((await publish({ mapId, status: 'model', sequence: 4 })).status).toBe(409)
    expect(await peer.application.readActivities(api.userToken, mapId)).toEqual([])
    await expect(peer.application.publishActivity(mapId, proof, 'model', 5)).rejects.toMatchObject({ code: 'LEASE_LOST' })
  })

  it('refreshes the Workspace list when another Map is created, renamed or deleted', async () => {
    // 验证同工作区其他图的创建、改名和删除都触发列表刷新，而不推送错误图快照。
    const { mapId, workspace } = await messagingCreateMap()
    const stream = await messagingWatch(mapId)
    await messagingClearBaseline(stream)
    const otherId = randomUUID()
    expect(await api.command('map.create', { workspaceId: workspace.id, expectedRevision: workspace.revision, id: otherId, name: 'Peer Map' })).toMatchObject({ status: 201 })
    await stream.event(/* 其他图创建后收到的事件，等待工作区列表刷新。 */ event => /* 等待其他图创建导致的工作区刷新。 */  event.type === 'refresh' && event.scope === 'workspace')
    stream.state.events.length = 0
    const rootId = randomUUID()
    expect(await api.command('graph.apply', { mapId: otherId, branch: { rootIds: [rootId], expectedVersion: null }, changes: { nodes: { put: [{
      id: rootId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Peer root', category: null },
    }] } } })).toMatchObject({ status: 200 })
    await stream.event(event => event.type === 'refresh' && event.scope === 'workspace')
    stream.state.events.length = 0
    expect(await api.apply(otherId, [rootId], { name: 'Peer renamed' })).toMatchObject({ status: 200 })
    await stream.event(/* 其他图改名后收到的事件，等待工作区列表刷新。 */ event => /* 等待其他图改名导致的工作区刷新。 */  event.type === 'refresh' && event.scope === 'workspace')
    stream.state.events.length = 0
    expect(await api.command('map.delete', { mapId: otherId, expectedRevision: 2 })).toMatchObject({ status: 200 })
    await stream.event(/* 其他图删除后收到的事件，等待工作区列表刷新。 */ event => /* 等待其他图删除导致的工作区刷新。 */  event.type === 'refresh' && event.scope === 'workspace')
    expect(stream.state.events.some(/* 当前订阅事件，检测是否混入其他图的快照。 */ event => /* 检测是否错误接收了不属于当前订阅图的快照。 */  event.type === 'snapshot' && event.snapshot.mapId !== mapId)).toBe(false)
  })
  it('persists deployment identity per database and refuses claims for another deployment', async () => {
    // 验证部署身份按数据库持久化，拒绝跨部署领取和缺少领取字段。
    const same = await messagingCreatePeer(), other = await messagingCreatePeer(true)
    const identity = api.application.messaging()
    expect(identity).toEqual({ version: 1, enabled: true, deploymentId: expect.any(String),
      namespace: api.queue.namespace + '.' + identity.deploymentId })
    expect(same.application.messaging()).toEqual(identity)
    expect(other.application.messaging().deploymentId).not.toBe(identity.deploymentId)
    expect(other.application.messaging().namespace).not.toBe(identity.namespace)
    const { mapId } = await api.createRun()
    const work = workReadItems((await api.store.read(mapId))!)[0]
    const result = await api.work('claim', { mapId, workId: work.workId,
      deploymentId: other.application.messaging().deploymentId, hostId: 'wrong-deployment', holderId: randomUUID() })
    expect(result.status).toBeGreaterThanOrEqual(400)
    expect(result.status).toBeLessThan(500)
    expect(result.body).toMatchObject({ ok: false, error: { code: 'DEPLOYMENT_MISMATCH' } })
    expect((await api.store.read(mapId))!.leases).toEqual({})
    for (const missing of ['workId', 'mapId', 'deploymentId']) {
      const input: Record<string, string> = { mapId, workId: work.workId, deploymentId: identity.deploymentId,
        hostId: 'missing-field', holderId: randomUUID() }
      delete input[missing]
      expect((await api.work('claim', input)).status).toBe(400)
    }
  })

  it('keeps a newer pending version when an older publish is confirmed and recovers tombstones on startup', async () => {
    // 验证旧分发版本不能清除新提交标记，已删除图的通知在启动时仍会补发。
    const { application, connection } = await messagingCreatePeer(true)
    const now = new Date().toISOString(), mapId = randomUUID()
    const document: GraphDocument = { id: mapId, workspaceId: randomUUID(), revision: 0, name: 'Before publish',
      nodes: [], edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    expect(await application.store.create(document)).toBe(true)
    const pending = []
    for await (const item of application.store.readDispatch()) pending.push(item)
    expect(pending).toMatchObject([{ id: mapId, revision: 0, dispatchVersion: 0 }])
    expect(await application.store.commit({ ...document, name: 'Committed during publish' }, 0,
      { requestId: randomUUID(), method: 'fixture.commit', inputHash: 'hash', createdNodeIds: [], createdEdgeIds: [], createdAt: now })).toBe(true)
    expect(await application.store.clearDispatch(mapId, pending[0].dispatchVersion)).toBe(false)
    const graphs = connection.collection(GRAPH_COLLECTION)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: 1,
      name: 'Committed during publish', dispatch: { version: 1, pending: true } })
    expect(await application.store.clearDispatch(mapId, 1)).toBe(true)
    expect(await application.store.read(mapId)).toMatchObject({ revision: 1, leases: {} })
    await application.graph.dispatch({ requestId: randomUUID(), method: 'map.delete', params: { mapId, expectedRevision: 1 } })
    expect(await application.store.clearDispatch(mapId, 1)).toBe(false)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: 2, deletedAt: expect.any(Date),
      dispatch: { version: 2, pending: true } })
    const observer = await messagingOpenLink(application), changes: QueueChange[] = []
    await observer.subscribeChanges(/* 启动恢复时 broker 广播的变更提示，记录以验证删除图也能补发。 */ message => /* 记录启动恢复发出的变更提示。 */  changes.push(message))
    await application.startMessaging()
    await expect.poll(() => /* 轮询目标图是否已有补发通知。 */  changes.find(/* 已收到的变更消息，按图身份定位本次恢复通知。 */ message => /* 定位目标图的变更广播。 */  message.kind === 'graph' && message.mapId === mapId), { timeout: 8000 })
      .toMatchObject({ version: 1, deploymentId: application.messaging().deploymentId, kind: 'graph', mapId })
    await expect.poll(async () => /* 读取持久分发标记，等待删除版本补发后被清除。 */  (await graphs.findOne({ _id: mapId } as never))?.dispatch, { timeout: 8000 })
      .toEqual({ version: 2, pending: false })
    expect(await application.store.read(mapId)).toMatchObject({ revision: 2, leases: {} })
  })

  it('publishes real work notices and returns claimed, busy, obsolete, then reissues resumed work', async () => {
    // 验证真实工作通知对应 claimed、busy、obsolete，并在恢复 Run 后再次发布同一工作。
    const observer = await messagingOpenLink(), notices: QueueWork[] = [], stop = new AbortController()
    const consume = observer.consumeWork(async /* 实际投递的工作通知，存入缓存后正常确认。 */ message => {
      // 记录接收到的工作通知并确认消息。
       notices.push(message); return 'ack' }, stop.signal)
    cleanup.push(async () => {
      // 取消工作观察者并等待消费循环结束。
       stop.abort(); await consume })
    const { mapId, runId } = await api.createRun()
    await expect.poll(() => /* 等待目标图的首次工作通知。 */  notices.find(/* 通知缓存中的条目，按目标 mapId 等待首次发布。 */ message => /* 从通知缓存中筛选目标图。 */  message.mapId === mapId), { timeout: 8000 }).toBeDefined()
    const notice = notices.find(/* 已接收通知候选，取出目标图第一次发布的工作身份。 */ message => /* 取得目标图首次发布的工作身份。 */  message.mapId === mapId)!
    expect(Object.keys(notice).sort()).toEqual(['deploymentId', 'mapId', 'version', 'workId'])
    expect(notice).toMatchObject({ version: 1, deploymentId: api.application.messaging().deploymentId, mapId })
    const input = { mapId, workId: notice.workId, deploymentId: notice.deploymentId, hostId: 'claim-owner', holderId: randomUUID() }
    const claimed = (await api.work('claim', input)).body.data as GraphClaimResult
    expect(claimed.status).toBe('claimed')
    if (claimed.status !== 'claimed') throw new Error('Expected claim grant')
    const busy = (await api.work('claim', { ...input, hostId: 'contender', holderId: randomUUID() })).body.data as GraphClaimResult
    expect(busy).toMatchObject({ status: 'busy', retryAfterMs: expect.any(Number) })
    if (busy.status === 'busy') expect(busy.retryAfterMs).toBeGreaterThan(0)
    expect((await api.work('claim', input)).body.data).toEqual(claimed)
    expect((await api.work('claim', { ...input, workId: randomUUID() })).body.data).toEqual({ status: 'obsolete' })
    expect(await api.command('run.pause', { mapId, runId })).toMatchObject({ status: 200 })
    expect((await api.work('claim', { ...input, holderId: randomUUID() })).body.data).toEqual({ status: 'obsolete' })
    const beforeResume = notices.filter(/* 恢复前收到的通知，筛选目标图以建立重发数量基线。 */ message => /* 统计恢复前目标图已经发布的通知数量。 */  message.mapId === mapId).length
    expect(await api.command('run.resume', { mapId, runId })).toMatchObject({ status: 200 })
    await expect.poll(() => /* 轮询目标图通知数量以确认恢复触发新发布。 */  notices.filter(/* 恢复后收到的通知，筛选目标图并与恢复前数量比较。 */ message => /* 只统计目标图的恢复通知。 */  message.mapId === mapId).length, { timeout: 8000 }).toBeGreaterThan(beforeResume)
    expect(notices.filter(/* 目标图通知候选，用于检查最后一条仍指向同一工作。 */ message => /* 筛选目标图通知以检查最后重发工作的身份。 */  message.mapId === mapId).at(-1)?.workId).toBe(notice.workId)
    const resumed = (await api.work('claim', { ...input, holderId: randomUUID() })).body.data as GraphClaimResult
    expect(resumed.status).toBe('claimed')
    if (resumed.status === 'claimed') expect(resumed.grant.fence).toBeGreaterThan(claimed.grant.fence)
  })

  it('broadcasts complete baselines and subsequent graph changes to two API instances', async () => {
    // 验证两个 API 提供相同初始快照和后续更新，重连直接得到最新状态。
    const { application } = await messagingCreatePeer()
    await application.startMessaging()
    const peer = await messagingServe(application), { mapId } = await messagingCreateMap()
    const [first, second] = await Promise.all([messagingWatch(mapId), messagingWatch(mapId, peer.url)])
    const baseline = await api.snapshot(mapId)
    for (const stream of [first, second]) {
      expect(await stream.event(/* 任一 API 连接收到的事件，选择完整初始快照。 */ event => /* 取得每个连接的初始快照。 */  event.type === 'snapshot')).toEqual({ type: 'snapshot', snapshot: baseline })
    }
    const updateId = randomUUID()
    const updated = await api.command('graph.apply', { mapId, branch: { rootIds: [updateId], expectedVersion: null },
      changes: { nodes: { put: [{ id: updateId, typeId: 'factcheck.claim', typeVersion: 1,
        payload: { content: '广播更新', category: 'data' } }] } } })
    expect(updated.status).toBe(200)
    for (const stream of [first, second]) {
      expect(await stream.event(/* 业务修改后收到的事件，要求快照版本比基线增加一。 */ event => /* 等待提交后递增版本的快照。 */  event.type === 'snapshot' && event.snapshot.revision === baseline.revision + 1))
        .toEqual({ type: 'snapshot', snapshot: updated.body.data.snapshot })
    }
    first.stop.abort()
    await first.done
    const reconnected = await messagingWatch(mapId)
    expect(await reconnected.event(/* 重新建立订阅后的事件，选择作为当前基线的快照。 */ event => /* 取得重新连接后发送的最新基线快照。 */  event.type === 'snapshot')).toEqual({ type: 'snapshot', snapshot: updated.body.data.snapshot })
  })

  it('retains a broker change that arrives while the first snapshot is being read', async () => {
    // 暂停首个快照读取，验证期间到达的 broker 变更不会丢失且版本按顺序推送。
    const { application } = await messagingCreatePeer()
    await application.startMessaging()
    const peer = await messagingServe(application), { mapId } = await messagingCreateMap()
    const changes: QueueChange[] = []
    const unsubscribe = application.watchChanges(/* 应用层观察到的 broker 提示，null 关闭通知不加入变更列表。 */ message => {
      // 记录实际进入应用的非空消息提示。
       if (message) changes.push(message) })
    cleanup.push(async () => {
      // 解除用例额外注册的消息观察监听。
       unsubscribe() })
    let release!: () => void, captured!: () => void, held = false
    const gate = new Promise<void>(/* 释放被暂停的首次快照返回过程的同步回调。 */ resolve => {
      // 保存允许初始快照读取继续的释放回调。
       release = resolve })
    const reading = new Promise<void>(/* 告知测试首次快照已捕获旧版本的同步回调。 */ resolve => {
      // 保存初始快照已读到旧状态的同步点回调。
       captured = resolve })
    const readSnapshot = application.readSnapshot.bind(application)
    application.readSnapshot = async (/* 原 readSnapshot 的全部实参，原样转发并用第二项 mapId 确定阻塞目标。 */ ...args) => {
      // 只阻塞目标图第一次快照返回，制造基线读取与更新竞争。
      const snapshot = await readSnapshot(...args)
      if (args[1] === mapId && !held) { held = true; captured(); await gate }
      return snapshot
    }
    const pending = messagingWatch(mapId, peer.url)
    cleanup.push(async () => {
      // 解除阻塞并取消最终建立的订阅，确保失败路径也能清理。
       release(); const stream = await pending; stream.stop.abort(); await stream.done })
    await reading
    changes.length = 0
    const updateId = randomUUID()
    const updated = await api.command('graph.apply', { mapId, branch: { rootIds: [updateId], expectedVersion: null }, changes: { nodes: { put: [{
      id: updateId, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: 'Changed during baseline', category: null },
    }] } } })
    expect(updated.status).toBe(200)
    await expect.poll(() => /* 等待基线被阻塞期间的新图消息已抵达应用。 */  changes.some(/* 阻塞基线期间收到的变更提示，检查是否属于目标图。 */ message => /* 识别该竞争用例目标图的变更通知。 */  message.kind === 'graph' && message.mapId === mapId), { timeout: 8000 }).toBe(true)
    release()
    const stream = await pending
    expect(await stream.event(/* 竞争场景中收到的事件，选择尚未更新的零版本快照。 */ event => /* 等待最先捕获的零版本快照。 */  event.type === 'snapshot' && event.snapshot.revision === 0))
      .toMatchObject({ type: 'snapshot', snapshot: { mapId, revision: 0 } })
    expect(await stream.event(/* 竞争场景中收到的事件，选择期间提交后的一版本快照。 */ event => /* 等待基线期间提交的一版本快照。 */  event.type === 'snapshot' && event.snapshot.revision === 1))
      .toEqual({ type: 'snapshot', snapshot: updated.body.data.snapshot })
    const revisions = stream.state.events.flatMap(/* 已接收事件序列中的一项，只提取 snapshot 的 revision。 */ event => /* 按接收顺序提取所有快照版本。 */  event.type === 'snapshot' ? [event.snapshot.revision] : [])
    expect(revisions).toEqual([...revisions].sort((/* 数值排序比较左侧的图快照版本。 */ a, /* 数值排序比较右侧的图快照版本，用于构建递增期望。 */ b) => /* 将版本按数值递增排列，作为有序推送的期望。 */  a - b))
  })

  it('sends management refresh hints and terminates access immediately after membership removal', async () => {
    // 验证管理更新发送刷新提示，成员移除后已有流及时拒绝访问并结束。
    const { mapId, workspace } = await messagingCreateMap()
    const viewer = await api.auth.createUser({ id: randomUUID(), displayName: 'Stream viewer', hostAdmin: false })
    const { token } = await api.auth.createToken(viewer.userId)
    expect(await api.command('member.set', { workspaceId: workspace.id, expectedRevision: workspace.revision,
      userId: viewer.userId, role: 'viewer' })).toMatchObject({ status: 200 })
    const stream = await messagingWatch(mapId, api.url, token)
    await messagingClearBaseline(stream)
    expect(await api.command('workspace.update', { workspaceId: workspace.id, expectedRevision: workspace.revision + 1,
      name: 'Visible rename', description: '' })).toMatchObject({ status: 200 })
    expect(await stream.event(/* 成员用例收到的事件，选择工作区改名引起的管理刷新。 */ event => /* 等待工作区改名触发管理刷新。 */  event.type === 'refresh' && event.scope === 'workspace')).toEqual({ type: 'refresh', scope: 'workspace' })
    expect(await api.command('member.set', { workspaceId: workspace.id, expectedRevision: workspace.revision + 2,
      userId: viewer.userId, role: null })).toMatchObject({ status: 200 })
    expect(await stream.event(/* 成员被移除后收到的事件，等待访问错误。 */ event => /* 等待成员访问被撤销后的错误事件。 */  event.type === 'error')).toMatchObject({ type: 'error', error: { status: 404, retryable: false } })
    await expect.poll(() => /* 轮询被撤权的 SSE 是否已结束。 */  stream.state.ended).toBe(true)
    const denied = await fetch(`${api.url}/api/v1/maps/${mapId}/events`, { headers: { authorization: `Bearer ${token}` } })
    expect(denied.status).toBe(404)
    await denied.body?.cancel()
  })

  it('broadcasts independent control writes and direct settings revisions without application dispatch', async () => {
    // 验证绕过应用 dispatch 的授权写入与直接设置版本修改也能通过变更流广播。
    const { application, connection } = await messagingCreatePeer()
    const { mapId, workspace } = await messagingCreateMap()
    const stream = await messagingWatch(mapId)
    await messagingClearBaseline(stream)
    await application.auth.transact(api.userToken, /* 由独立应用完成身份验证的事务上下文，控制写入沿用其会话。 */ ctx => /* 在独立同伴的授权事务中直接执行工作区更新。 */  application.control.dispatch(ctx, {
      requestId: randomUUID(), method: 'workspace.update', params: {
        workspaceId: workspace.id, expectedRevision: workspace.revision, name: 'Independent writer', description: '',
      },
    }))
    expect(await stream.event(/* 独立控制写入后收到的事件，等待工作区刷新。 */ event => /* 等待独立业务写入触发工作区刷新。 */  event.type === 'refresh' && event.scope === 'workspace'))
      .toEqual({ type: 'refresh', scope: 'workspace' })
    stream.state.events.length = 0
    const settings = connection.collection('control_settings')
    const before = (await settings.findOne({ _id: 'global' } as never))!
    expect((await settings.updateOne({ _id: 'global' } as never, { $inc: { revision: 1 },
      $set: { 'llm.model': 'external-model-' + randomUUID() } })).modifiedCount).toBe(1)
    expect(await stream.event(/* 直接修改设置文档后收到的事件，等待 settings 刷新。 */ event => /* 等待直接修改设置版本触发共享设置刷新。 */  event.type === 'refresh' && event.scope === 'settings'))
      .toEqual({ type: 'refresh', scope: 'settings' })
    const bootstrap = await api.application.read(api.userToken, { method: 'app.bootstrap', params: {} }) as { settings: { revision: number } }
    expect(bootstrap.settings.revision).toBe(before.revision + 1)
    expect(stream.state.ended).toBe(false)
  })

  it('rejects query-string tokens, revoked credentials and deleted maps on existing streams', async () => {
    // 验证 URL 查询令牌被拒绝，撤销凭据和删除图都会终止已有订阅。
    const { mapId } = await messagingCreateMap()
    const insecure = await fetch(`${api.url}/api/v1/maps/${mapId}/events?token=${encodeURIComponent(api.userToken)}`)
    expect(insecure.status).toBeGreaterThanOrEqual(400)
    expect(insecure.status).toBeLessThan(500)
    await insecure.body?.cancel()
    const credential = await api.auth.createToken(api.owner.userId)
    const revoked = await messagingWatch(mapId, api.url, credential.token)
    await messagingClearBaseline(revoked)
    await api.auth.revokeToken(credential.tokenId)
    expect(await revoked.event(/* 令牌撤销后收到的事件，选择认证失败通知。 */ event => /* 等待令牌撤销后的认证错误。 */  event.type === 'error')).toMatchObject({ type: 'error', error: { status: 401, retryable: false } })
    await expect.poll(() => /* 轮询被撤销令牌对应的流是否结束。 */  revoked.state.ended).toBe(true)
    const deleted = await messagingWatch(mapId)
    await deleted.event(/* 即将被删除图的事件流条目，确认初始快照已建立。 */ event => /* 等待即将被删除图的订阅基线建立。 */  event.type === 'snapshot')
    expect(await api.command('map.delete', { mapId, expectedRevision: 0 })).toMatchObject({ status: 200 })
    expect(await deleted.event(/* 图删除后收到的事件，选择不可访问错误。 */ event => /* 等待图删除后的不可访问错误。 */  event.type === 'error')).toMatchObject({ type: 'error', error: { status: 404, retryable: false } })
    await expect.poll(() => /* 轮询已删除图的 SSE 是否结束。 */  deleted.state.ended).toBe(true)
  })

  it('does not leave active SSE responses hanging when an API service closes', async () => {
    // 关闭 API 服务，验证仍活跃的 SSE 会被主动销毁而不阻塞停机。
    const { application } = await messagingCreatePeer()
    await application.startMessaging()
    const peer = await messagingServe(application), { mapId } = await messagingCreateMap()
    const stream = await messagingWatch(mapId, peer.url)
    await stream.event(/* 关闭服务器前收到的事件，确认 SSE 已进入正常推送状态。 */ event => /* 确认测试流已收到快照并处于活动状态。 */  event.type === 'snapshot')
    const closed = new Promise<void>((/* API 服务器完成关闭后兑现等待的回调。 */ resolve, /* API 服务器关闭失败时拒绝等待的回调。 */ reject) => /* 等待关闭持有 SSE 响应的 API 服务器。 */  peer.server.close(/* HTTP 关闭回调中的可选异常，需传递给清理 Promise。 */ error => /* 传递 API 关闭的结果。 */  error ? reject(error) : resolve()))
    await expect.poll(() => /* 轮询 API 停止后 SSE 是否及时结束。 */  stream.state.ended, { timeout: 3000 }).toBe(true)
    await closed
  })

  it('disconnects SSE and republishes confirmed active work after a real AMQP connection failure', async () => {
    // 切断真实 AMQP 连接，验证 SSE 断开、恢复时重新发布活动工作并补齐管理刷新。
    const sockets = new Set<Socket>(), address = new URL(api.queue.url)
    const brokerPort = Number(address.port || 5672), brokerHost = address.hostname
    let disconnected = false
    // Drop only this application's transport; AMQP and all queue operations still use the real broker.
    const tunnel = createTcpServer(/* 目标应用连入断线代理的客户端套接字，故障期开关可立即拒绝它。 */ socket => {
      // 建立可拒绝重连的 TCP 代理，只隔离目标应用的 broker 传输。
      if (disconnected) { socket.destroy(); return }
      const upstream = connect(brokerPort, brokerHost)
      sockets.add(socket); sockets.add(upstream)
      for (const current of [socket, upstream]) {
        current.on('error', () => {
          // 代理任一端出错时关闭双向套接字。
           socket.destroy(); upstream.destroy() })
        current.on('close', () => {
          // 移除关闭连接并销毁其配对端，防止残留半开代理。
           sockets.delete(current); socket.destroy(); upstream.destroy() })
      }
      socket.pipe(upstream); upstream.pipe(socket)
    })
    await new Promise<void>(/* AMQP 故障代理成功监听后的启动完成回调。 */ resolve => /* 等待断线测试代理监听本地端口。 */  tunnel.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => {
      // 清理所有代理套接字并关闭监听。
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((/* AMQP 代理正常停止后的清理完成回调。 */ resolve, /* AMQP 代理关闭失败时的清理拒绝回调。 */ reject) => /* 将代理关闭转换为可等待操作。 */  tunnel.close(/* 代理关闭返回的可选错误，决定完成还是拒绝清理。 */ error => /* 报告代理监听关闭是否成功。 */  error ? reject(error) : resolve()))
    })
    const binding = tunnel.address()
    if (!binding || typeof binding === 'string') throw new Error('AMQP transport did not bind')
    address.hostname = '127.0.0.1'; address.port = String(binding.port)
    const { application, connection } = await messagingCreatePeer(true, { ...api.queue, url: address.toString() })
    await application.control.seed()
    const owner = await application.auth.createUser({ id: randomUUID(), displayName: 'Reconnect owner', hostAdmin: true })
    const { token } = await application.auth.createToken(owner.userId)
    const workspace = await application.auth.transact(token, /* 隔离部署用户的已认证事务上下文，用来创建测试工作区。 */ ctx => /* 在隔离部署内建立恢复用例工作区。 */  application.control.createWorkspace(ctx, {
      id: randomUUID(), name: 'Reconnect workspace', description: '', agentSource: 'library',
    }))
    const { mapId } = await api.createRun()
    const source = (await api.store.read(mapId))!
    expect(await application.store.create({ ...source, workspaceId: workspace.id })).toBe(true)
    const workId = workReadItems(source)[0].workId
    const observer = await messagingOpenLink(application), notices: QueueWork[] = [], stop = new AbortController()
    let barrier = false
    const consume = observer.consumeWork(async /* 真实队列投递的工作通知，特殊屏障身份只用于证明此前通知已处理。 */ message => {
      // 消费真实工作通知，以 FIFO 标记确定启动补发已全部处理。
      if (message.workId === 'test-barrier') barrier = true
      else notices.push(message)
      return 'ack'
    }, stop.signal)
    cleanup.push(async () => {
      // 取消观察消费并等待其处理完成。
       stop.abort(); await consume })
    await application.startMessaging()
    const peer = await messagingServe(application), stream = await messagingWatch(mapId, peer.url, token)
    await messagingClearBaseline(stream)
    const replica = applicationCreateService(connection, { messaging: api.queue })
    cleanup.push(() => /* 关闭同库正常副本的消息服务。 */  replica.closeMessaging())
    await replica.initialize()
    await replica.startMessaging()
    const replicaServer = await messagingServe(replica), existing = await messagingWatch(mapId, replicaServer.url, token)
    await messagingClearBaseline(existing)
    const graphs = connection.collection(GRAPH_COLLECTION)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: source.revision,
      dispatch: { version: source.revision, pending: false } })
    // A FIFO marker proves every startup notification was consumed before the connection is cut.
    await observer.publishWork({ version: 1, deploymentId: application.messaging().deploymentId, mapId, workId: 'test-barrier' })
    await expect.poll(() => /* 等待 FIFO 屏障消息被消费。 */  barrier, { timeout: 8000 }).toBe(true)
    expect(notices.some(/* 断线前已收到的工作通知，核对目标图与工作身份。 */ message => /* 确认断线前确实已经发布过目标工作。 */  message.mapId === mapId && message.workId === workId)).toBe(true)
    notices.length = 0
    expect(sockets.size).toBeGreaterThan(0)
    disconnected = true
    for (const socket of sockets) socket.destroy()
    await expect.poll(() => /* 等待受影响 API 的 SSE 因 AMQP 断线结束。 */  stream.state.ended, { timeout: 3000 }).toBe(true)
    expect((await connection.collection('control_settings').updateOne({ _id: 'global' } as never, { $inc: { revision: 1 } })).modifiedCount).toBe(1)
    await existing.event(/* 正常 API 副本收到的事件，确认故障期间设置刷新仍可传播。 */ event => /* 确认正常副本仍能收到断线期间的设置修改提示。 */  event.type === 'refresh' && event.scope === 'settings')
    existing.state.events.length = 0
    disconnected = false
    await expect.poll(() => /* 轮询重连后目标工作是否再次发布。 */  notices.some(/* 恢复后收到的工作通知，核对仍是原图的原工作。 */ message => /* 匹配恢复后同一图、同一工作的补发通知。 */  message.mapId === mapId && message.workId === workId), { timeout: 8000 }).toBe(true)
    expect(await existing.event(/* 恢复广播后收到的事件，选择工作区刷新提示。 */ event => /* 等待恢复广播补齐工作区刷新。 */  event.type === 'refresh' && event.scope === 'workspace')).toEqual({ type: 'refresh', scope: 'workspace' })
    expect(await existing.event(/* 恢复广播后收到的事件，选择共享设置刷新提示。 */ event => /* 等待恢复广播补齐共享设置刷新。 */  event.type === 'refresh' && event.scope === 'settings')).toEqual({ type: 'refresh', scope: 'settings' })
    expect(existing.state.ended).toBe(false)
    expect(await graphs.findOne({ _id: mapId } as never)).toMatchObject({ revision: source.revision,
      dispatch: { version: source.revision, pending: false } })
    const restored = await messagingWatch(mapId, peer.url, token)
    expect(await restored.event(/* 重新连接故障 API 后的事件，取得与授权读取一致的最新快照。 */ event => /* 取得重连 API 的最新初始快照，与授权读取结果比较。 */  event.type === 'snapshot')).toEqual({ type: 'snapshot', snapshot: await application.readSnapshot(token, mapId) })
  }, 15_000)
})
