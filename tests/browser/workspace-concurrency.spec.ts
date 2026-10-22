// 并发与隔离验收：真实浏览器竞争、独立分支并发写、迟到 HTTP 和真实事件流恢复。
import { randomUUID } from 'node:crypto'
import { createServer, request as forwardRequest, type ClientRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { performance } from 'node:perf_hooks'
import type { Locator, Page, Route } from '@playwright/test'
import { clientCreateGateway } from '../../client/graph-client'
import type { ClientGateway } from '../../contracts/client'
import type { GraphNode } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphBranchLeaseProof } from '../../contracts/graph-branch'
import { test, expect, workspaceCreateActor, workspaceLogin, workspaceOpenMap } from './workspace-fixture'

enum ConcurrencyMessage {
  NODE_MISSING = '并发验收没有找到指定的已保存节点。',
  IDENTITY_MISSING = '并发验收未能生成独立节点身份。',
  OWNERSHIP_MISSING = '独立公共读取未找到当前浏览器持有的真实编辑授权。',
  CLAIM_BUSY = '独立写入需要的分支仍由其他客户端占用。',
  DEADLINE_EXCEEDED = '并发验收没有在限定时间内到达请求或提交屏障。',
  FORWARDED_WRITES_FAILED = '真实并发请求没有全部成功完成。',
  DUPLICATE_ARRIVAL = '同一浏览器在一轮保存屏障中重复提交。',
  DELAYED_RESPONSE_FAILED = '真实旧图响应的延迟交付失败，且请求没有被客户端取消。',
  RELAY_ADDRESS_MISSING = '事件流故障转发器没有绑定真实监听地址。',
}

interface Completion {
  readonly promise: Promise<void>
  resolve(): void
}

interface ForwardedWrite {
  readonly requestId: string
  readonly side: number
  readonly startedAt: number
  endedAt: number | null
}

interface StreamRelay {
  readonly origin: string
  cut(): number
  resume(): void
  close(): Promise<void>
}

/** 建立本例独占的真实 HTTP 转发边界，仅允许截断或恢复既有事件流。 */
async function concurrencyCreateStreamRelay(
  /* 当前用例真实 Vite origin，静态页面与 API 都原样转交它。 */ upstream: string,
  /* 本例唯一需要制造断流的真实图事件路径。 */ eventsPath: string,
): Promise<StreamRelay> {
  // 转发器不生成成功响应、快照或事件；记录自有连接以便异常路径也能全部关闭。
  const requests = new Set<ClientRequest>()
  const streams = new Map<ServerResponse, IncomingMessage>()
  let blocked = false
  const server = createServer((/* 浏览器发来的实际 HTTP 请求。 */ incoming, /* 接收真实上游字节的浏览器响应。 */ outgoing) => {
    // 对被切断的事件连接只制造运输失败，其他请求及其认证、参数和字节保持原样。
    const target = new URL(incoming.url ?? '/', upstream)
    const isEvents = target.pathname === eventsPath
    if (isEvents && blocked) { incoming.socket.destroy(); return }
    const forwarded = forwardRequest(target, { method: incoming.method, headers: { ...incoming.headers, host: target.host } },
      (/* 真实 Vite/后端返回的响应头及持续字节流。 */ response) => {
        // 只把真实响应交付浏览器，缺失状态时结束连接而不伪造业务结果。
        if (response.statusCode === undefined) { outgoing.destroy(); response.destroy(); return }
        outgoing.writeHead(response.statusCode, response.headers)
        if (isEvents) streams.set(outgoing, response)
        response.on('error', () => { /* 上游实际断流时同步结束浏览器运输连接。 */ outgoing.destroy() })
        outgoing.on('close', () => {
          // 浏览器退出或测试截断后释放对应上游流，不能留下真实后端订阅。
          streams.delete(outgoing)
          response.destroy()
        })
        response.pipe(outgoing)
      })
    requests.add(forwarded)
    forwarded.on('close', () => { /* 上游请求终止后移出本例资源集合。 */ requests.delete(forwarded) })
    forwarded.on('error', () => { /* 上游连接失败直接表现为运输失败，不构造替代 JSON。 */ outgoing.destroy() })
    incoming.on('aborted', () => { /* 浏览器取消请求时结束其真实上游请求。 */ forwarded.destroy() })
    incoming.pipe(forwarded)
  })
  await new Promise<void>((/* 服务绑定随机回环端口后释放初始化屏障。 */ resolve, /* 启动失败保留真实监听错误。 */ reject) => {
    // 监听完成和失败由真实 server 事件决定，不用端口探测重试猜测就绪。
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    server.closeAllConnections(); server.close()
    throw new Error(ConcurrencyMessage.RELAY_ADDRESS_MISSING)
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    cut(): number {
      // 先阻止自动重连，再截断已经实际建立的原始事件流。
      blocked = true
      const count = streams.size
      for (const [outgoing, response] of streams) { outgoing.destroy(); response.destroy() }
      return count
    },
    resume(): void {
      // 恢复真实转发，让现有客户端自动重连流程重新获得后端快照。
      blocked = false
    },
    async close(): Promise<void> {
      // 用例结束时结束自有连接并等待监听关闭，不影响既有 Vite 或后端生命周期。
      for (const forwarded of requests) forwarded.destroy()
      server.closeAllConnections()
      await new Promise<void>((/* 转发器真实关闭后完成清理。 */ resolve, /* 清理失败继续传播。 */ reject) => {
        // 只关闭本例自建的监听器。
        server.close((/* 实际监听关闭错误，成功时为空。 */ error) => { /* 保留原始清理失败。 */ error ? reject(error) : resolve() })
      })
    },
  }
}

/** 创建由本轮测试独占的到达信号；不生成业务结果或替代服务端响应。 */
function concurrencyCreateCompletion(): Completion {
  // 只把真实请求到达、真实响应完成或测试显式放行转为可等待信号。
  let resolveSignal: (() => void) | undefined
  const promise = new Promise<void>((/* 实际到达屏障时调用的 Promise 完成函数。 */ resolve) => {
    // 保存信号释放函数，调用方不读取或改写任何业务状态。
    resolveSignal = resolve
  })
  return {
    promise,
    resolve(): void {
      // 完成信号允许重复释放，便于失败路径有界收尾。
      resolveSignal?.()
    },
  }
}

/** 对真实屏障施加截止时间，结束后清理计时器，不用固定等待猜测竞态。 */
async function concurrencyAwait<T>(
  /* 等待真实网络、公开读取或测试释放的 Promise。 */ operation: Promise<T>,
  /* 此次观测最多等待的毫秒数，默认十秒。 */ timeoutMs = 10_000,
): Promise<T> {
  // 超时明确失败；不把未完成操作当作成功，也不自动重试业务写入。
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((/* 超时不产生业务值。 */ _resolve, /* 到期时报告有界屏障失败。 */ reject) => {
    // 计时器只作为期限，不能用于选择提交或响应的先后顺序。
    timer = setTimeout(() => {
      // 真实屏障没有按期到达时保留失败结果。
      reject(new Error(ConcurrencyMessage.DEADLINE_EXCEEDED))
    }, timeoutMs)
  })
  try {
    return await Promise.race([operation, expired])
  } finally {
    clearTimeout(timer)
  }
}

/** 读取公开命令或查询信封；只用于筛选真实请求，不创建替代响应。 */
function concurrencyReadRecord(
  /* 真实 HTTP 请求中尚未收窄的 JSON 值。 */ value: unknown,
): Record<string, unknown> | null {
  // 数组、空值和非对象不能被当作协议对象。
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 从公开图快照读取稳定节点身份，不用 DOM 顺序推断服务端写入结果。 */
function concurrencyReadNode(
  /* 独立授权公共查询取得的真实快照。 */ snapshot: GraphSnapshot,
  /* 当前图内已记录的节点身份。 */ nodeId: string,
): GraphNode {
  // 节点缺失必须明确失败，不能回退到另一节点。
  const node = snapshot.nodes.find((/* 当前快照中的候选节点。 */ item) => /* 按图内稳定身份匹配。 */ item.id === nodeId)
  if (!node) throw new Error(ConcurrencyMessage.NODE_MISSING)
  return node
}

/** 定位已选节点的真实详情区域。 */
function concurrencyInspector(
  /* 当前用例已登录的真实浏览器页面。 */ page: Page,
): Locator {
  // 将后续表单动作限定在公开中文命名的节点详情内。
  return page.getByRole('region', { name: '数据详情', exact: true })
}

/** 定位精确类型声明渲染的正文表单控件。 */
function concurrencyContent(
  /* 当前已经选中真实节点的页面。 */ page: Page,
): Locator {
  // 使用字段组语义而非 textarea 顺序，避免上下文控件混入。
  return concurrencyInspector(page).getByRole('group', { name: '正文', exact: true }).getByRole('textbox')
}

/** 使用公开画布键盘选择测试所需节点，预置节点的身份和创建时间顺序已固定。 */
async function concurrencySelectNode(
  /* 当前已打开目标图的页面。 */ page: Page,
  /* 从零开始的公开场景键盘顺序；本文件仅使用零和一。 */ index: number,
): Promise<void> {
  // 清理旧选择后逐次发送真实方向键，不直接注入业务选择状态。
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await scene.focus()
  await scene.press('Escape')
  for (let step = 0; step <= index; step++) await scene.press('ArrowRight')
}

/** 依真实服务策略从页面领取编辑权，本机直接等待可编辑控件。 */
async function concurrencyClaimEditor(
  /* 已选择待编辑分支的真实页面。 */ page: Page,
  /* 服务端 bootstrap 是否要求客户端编辑租约。 */ required: boolean,
): Promise<void> {
  // 通过实际按钮取得排他授权，保留服务端的忙碌和版本裁决。
  if (required) {
    await concurrencyInspector(page).getByRole('button', { name: /^(尝试)?领取分支编辑权$/ }).click()
    await expect(concurrencyInspector(page).getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
  }
  await expect(concurrencyContent(page)).toBeEditable()
}

/** 仅为并发/阅读场景准备真实图；每个节点都是独立合法根，不包含共享后继。 */
async function concurrencyPrepareMap(
  /* 已拥有目标工作区编辑权限的真实公共客户端。 */ gateway: ClientGateway,
  /* 当前真实工作区身份。 */ workspaceId: string,
  /* 之后通过真实侧栏打开的图名。 */ name: string,
  /* 同时创建的稳定根身份及其完整正文。 */ nodes: ReadonlyArray<{ id: string; content: string }>,
): Promise<GraphSnapshot> {
  // 使用公共 CAS 创建空图，再用合法 null-version 新根命令建立测试拓扑。
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const map = (await gateway.dispatch(randomUUID(), 'map.create', {
    workspaceId, expectedRevision: workspace.revision, id: randomUUID(), name,
  })).data.snapshot
  return (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId,
    branch: { rootIds: nodes.map((/* 独立新根的测试输入。 */ node) => /* 声明本次真实新根身份。 */ node.id), expectedVersion: null },
    changes: { nodes: { put: nodes.map((/* 独立事实的测试输入。 */ node) => /* 沿用生产注册的精确事实类型。 */ ({
      id: node.id, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: node.content, category: 'data' },
    })) } },
  })).data.snapshot
}

/** 独立公共写入遵守实际租约，供断流期间制造可核对的新服务端版本。 */
async function concurrencyWriteNode(
  /* 与浏览器分离的真实授权写入客户端。 */ gateway: ClientGateway,
  /* 本轮写入所属的真实图身份。 */ mapId: string,
  /* 本轮需要更新的稳定节点身份。 */ nodeId: string,
  /* 新版本的完整正文。 */ content: string,
  /* 实际服务是否要求客户端租约。 */ required: boolean,
): Promise<GraphSnapshot> {
  // 真实读取、领取、写入和释放；不能清理数据库占有或降低生产校验。
  const snapshot = await gateway.read('map.get', { mapId })
  const node = concurrencyReadNode(snapshot, nodeId)
  const branch = await gateway.read('branch.get', { mapId, rootIds: [nodeId] })
  let lease: GraphBranchLeaseProof | undefined
  if (required) {
    const claimed = await gateway.dispatch(randomUUID(), 'branch.claim', { mapId, rootIds: [nodeId], holderId: randomUUID() })
    if (claimed.data.status !== 'claimed') throw new Error(ConcurrencyMessage.CLAIM_BUSY)
    lease = { leaseId: claimed.data.grant.leaseId, holderId: claimed.data.grant.holderId, fence: claimed.data.grant.fence }
  }
  try {
    return (await gateway.dispatch(randomUUID(), 'graph.apply', {
      mapId, branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, ...(lease ? { lease } : {}),
      changes: { nodes: { put: [{ id: node.id, typeId: node.typeId, typeVersion: node.typeVersion, payload: { ...node.payload, content } }] } },
    })).data.snapshot
  } finally {
    if (lease) await gateway.dispatch(randomUUID(), 'branch.release', { mapId, lease })
  }
}

test('M00-R01 同分支十轮争用、合法交接及已知旧版本拒绝不会静默覆盖', async (
  /* 两个真实浏览器角色、公共准备客户端和当前隔离后端。 */ { page, browser, gateway, environment, webUrl },
) => {
  // 协作模式逐轮证明排他编辑权，本机则证明双方可编辑但旧分支版本必须冲突。
  test.setTimeout(180_000)
  const nodeId = randomUUID()
  const map = await concurrencyPrepareMap(gateway, environment.workspaceId, 'R01 同分支竞争', [{ id: nodeId, content: 'R01 初始正文。' }])
  const first = await workspaceCreateActor(environment, 'editor', environment.workspaceId)
  const second = await workspaceCreateActor(environment, 'editor', environment.workspaceId)
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const context = await browser.newContext()
  const verification = clientCreateGateway({ baseUrl: environment.baseUrl })
  try {
    await verification.connect({ baseUrl: environment.baseUrl, token: second.token, remember: false })
    const other = await context.newPage()
    await workspaceLogin(page, webUrl, first.token)
    await workspaceLogin(other, webUrl, second.token)
    await workspaceOpenMap(page, map.name)
    await workspaceOpenMap(other, map.name)
    await concurrencySelectNode(page, 0)
    await concurrencySelectNode(other, 0)

    for (let round = 0; round < 10; round++) {
      const before = await gateway.read('map.get', { mapId: map.mapId })
      const original = concurrencyReadNode(before, nodeId)
      const stale = await verification.read('branch.get', { mapId: map.mapId, rootIds: [nodeId] })
      await concurrencyClaimEditor(page, required)
      if (required) {
        await concurrencyInspector(other).getByRole('button', { name: /^(尝试)?领取分支编辑权$/ }).click()
        await expect(other.getByRole('alert')).toBeVisible()
        await expect(concurrencyContent(other)).toBeDisabled()
        const occupied = await gateway.read('map.get', { mapId: map.mapId })
        expect(occupied.ownerships.filter((/* 真实存储返回的分支占有。 */ item) => /* 只统计此根的人工编辑者。 */
          item.kind === 'editor' && item.scope.nodeIds.includes(nodeId))).toMatchObject([{ ownerUserId: first.userId }])
        await concurrencyInspector(page).getByRole('button', { name: '释放分支编辑权', exact: true }).click()
        await expect.poll(async () => {
          // 等待真实释放提交，而非凭按钮消失推断租约已交接。
          const released = await gateway.read('map.get', { mapId: map.mapId })
          return released.ownerships.filter((/* 真实图中的剩余占有。 */ item) => /* 查找甲仍持有的此分支。 */
            item.ownerUserId === first.userId && item.scope.nodeIds.includes(nodeId)).length
        }).toBe(0)
        await other.getByRole('button', { name: '关闭提示', exact: true }).click()
      } else {
        await expect(concurrencyInspector(page).getByRole('button', { name: /领取分支编辑权/ })).toHaveCount(0)
        await expect(concurrencyInspector(other).getByRole('button', { name: /领取分支编辑权/ })).toHaveCount(0)
        await expect(concurrencyContent(other)).toBeEditable()
        await concurrencyContent(page).fill(`R01 第 ${round + 1} 轮尚未提交的旧版本草稿。`)
      }

      await concurrencyClaimEditor(other, required)
      const content = `R01 第 ${round + 1} 轮由乙在真实页面保存。`
      await concurrencyContent(other).fill(content)
      if (required) {
        const authorized = await verification.read('map.get', { mapId: map.mapId })
        expect(authorized.ownerships.filter((/* 独立读取的真实分支占有。 */ item) => /* 确认乙的当前授权仍有效且独占。 */
          item.kind === 'editor' && item.ownerUserId === second.userId && item.scope.nodeIds.includes(nodeId))).toHaveLength(1)
        expect(concurrencyReadNode(authorized, nodeId).revision).toBe(original.revision)
        await expect(concurrencyInspector(other).getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
        await expect(concurrencyContent(other)).toBeEditable()
      }
      await expect(concurrencyInspector(other).getByRole('button', { name: '保存数据', exact: true })).toBeEnabled()
      await concurrencyInspector(other).getByRole('button', { name: '保存数据', exact: true }).click()
      await expect(concurrencyInspector(other).getByText('未保存', { exact: true })).toHaveCount(0)
      const committed = await verification.read('map.get', { mapId: map.mapId })
      const saved = concurrencyReadNode(committed, nodeId)
      expect(saved.revision).toBe(original.revision + 1)
      expect(saved.payload.content).toBe(content)
      let lease: GraphBranchLeaseProof | undefined
      if (required) {
        const held = committed.ownerships.find((/* 公共快照中的真实占有。 */ item) => /* 只复用乙浏览器已合法取得的同一授权。 */
          item.kind === 'editor' && item.ownerUserId === second.userId && item.scope.nodeIds.includes(nodeId))
        if (!held) throw new Error(ConcurrencyMessage.OWNERSHIP_MISSING)
        lease = { leaseId: held.leaseId, holderId: held.holderId, fence: held.fence }
      }
      await expect(verification.dispatch(randomUUID(), 'graph.apply', {
        mapId: map.mapId, branch: { rootIds: stale.scope.rootIds, expectedVersion: stale.version }, ...(lease ? { lease } : {}),
        changes: { nodes: { put: [{ id: nodeId, typeId: original.typeId, typeVersion: original.typeVersion,
          payload: { ...original.payload, content: `R01 第 ${round + 1} 轮不得覆盖的新值。` } }] } },
      })).rejects.toMatchObject({ status: 409, code: 'BRANCH_VERSION_CONFLICT' })
      const protectedSnapshot = await gateway.read('map.get', { mapId: map.mapId })
      expect(protectedSnapshot.nodes).toEqual(committed.nodes)
      expect(protectedSnapshot.revision).toBe(committed.revision)

      if (required) {
        await concurrencyInspector(other).getByRole('button', { name: '释放分支编辑权', exact: true }).click()
        await expect(concurrencyInspector(other).getByRole('button', { name: /^(尝试)?领取分支编辑权$/ })).toBeVisible()
        await expect.poll(async () => {
          // 下一轮不能抢在乙的真实释放提交之前领取，避免把夹具竞态当作业务冲突。
          const released = await gateway.read('map.get', { mapId: map.mapId })
          return released.ownerships.filter((/* 真实图中的剩余占有。 */ item) => /* 核对乙已释放此根。 */
            item.ownerUserId === second.userId && item.scope.nodeIds.includes(nodeId)).length
        }).toBe(0)
      } else {
        await expect(concurrencyInspector(page)).toContainText('服务器数据已变化，草稿已保留。')
        await expect(concurrencyInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeDisabled()
        await concurrencyInspector(page).getByRole('button', { name: '重新载入', exact: true }).click()
      }
      await expect(concurrencyContent(page)).toHaveValue(content)
    }
    expect(concurrencyReadNode(await gateway.read('map.get', { mapId: map.mapId }), nodeId).revision).toBe(10)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await Promise.all([context.close(), verification.disconnect()])
  }
})

test('M00-R02 两个独立分支十轮真实重叠保存，共二十次写入完整保留', async (
  /* 两个真实浏览器角色、独立公共客户端与真实存储环境。 */ { page, browser, gateway, environment, webUrl },
) => {
  // 双到达屏障同时放行真实 HTTP，不把 Promise 数量说成数据库并行。
  test.setTimeout(180_000)
  const [leftId, rightId] = [randomUUID(), randomUUID()].sort()
  if (!leftId || !rightId) throw new Error(ConcurrencyMessage.IDENTITY_MISSING)
  const map = await concurrencyPrepareMap(gateway, environment.workspaceId, 'R02 独立分支并发', [
    { id: leftId, content: 'R02 左分支初始正文。' }, { id: rightId, content: 'R02 右分支初始正文。' },
  ])
  const first = await workspaceCreateActor(environment, 'editor', environment.workspaceId)
  const second = await workspaceCreateActor(environment, 'editor', environment.workspaceId)
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const context = await browser.newContext()
  try {
    const other = await context.newPage()
    await workspaceLogin(page, webUrl, first.token)
    await workspaceLogin(other, webUrl, second.token)
    await workspaceOpenMap(page, map.name)
    await workspaceOpenMap(other, map.name)
    await concurrencySelectNode(page, 0)
    await concurrencySelectNode(other, 1)
    await expect(concurrencyContent(page)).toHaveValue('R02 左分支初始正文。')
    await expect(concurrencyContent(other)).toHaveValue('R02 右分支初始正文。')
    await concurrencyClaimEditor(page, required)
    await concurrencyClaimEditor(other, required)
    const allWrites: ForwardedWrite[] = []

    for (let round = 0; round < 10; round++) {
      const arrived = concurrencyCreateCompletion(), release = concurrencyCreateCompletion(), completed = concurrencyCreateCompletion()
      const arrivals = new Set<number>(), writes: ForwardedWrite[] = [], failures: unknown[] = []
      let finished = 0, active = 0, peak = 0
      const createHandler = (
        /* 当前真实浏览器角色的零基序号，仅用于屏障去重。 */ side: number,
      ) => {
        // 每个角色独立拦截自己的保存请求，其他命令立即原样转发。
        return async (/* 当前浏览器发出的真实公共命令请求。 */ route: Route): Promise<void> => {
          // 只延迟本图 graph.apply，随后调用真实上游并原样交付其响应。
          const command = concurrencyReadRecord(route.request().postDataJSON())
          const params = concurrencyReadRecord(command?.params)
          if (command?.method !== 'graph.apply' || params?.mapId !== map.mapId) { await route.continue(); return }
          try {
            if (arrivals.has(side)) throw new Error(ConcurrencyMessage.DUPLICATE_ARRIVAL)
            arrivals.add(side)
            if (arrivals.size === 2) arrived.resolve()
            await concurrencyAwait(release.promise)
            const attempt: ForwardedWrite = { requestId: typeof command.requestId === 'string' ? command.requestId : '',
              side, startedAt: performance.now(), endedAt: null }
            writes.push(attempt)
            active++; peak = Math.max(peak, active)
            try {
              const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10_000 })
              attempt.endedAt = performance.now()
              const reply: unknown = await response.json()
              expect(response.status()).toBe(200)
              expect(reply).toMatchObject({ ok: true, requestId: attempt.requestId, replayed: false })
              await route.fulfill({ response })
            } finally {
              active--
            }
          } catch (error) {
            failures.push(error)
            // 失败请求必须结束，不能悬挂到用例总超时才丢失原始结论。
            await route.abort('failed').catch(() => { /* 已交付或已取消的真实请求无需再次结束。 */ })
          } finally {
            finished++
            if (finished === 2) completed.resolve()
          }
        }
      }
      const leftHandler = createHandler(0), rightHandler = createHandler(1)
      await page.route('**/api/v1/command', leftHandler)
      await other.route('**/api/v1/command', rightHandler)
      const leftContent = `R02 左分支第 ${round + 1} 次完整正文。`
      const rightContent = `R02 右分支第 ${round + 1} 次完整正文。`
      try {
        await concurrencyContent(page).fill(leftContent)
        await concurrencyContent(other).fill(rightContent)
        await Promise.all([
          concurrencyInspector(page).getByRole('button', { name: '保存数据', exact: true }).click(),
          concurrencyInspector(other).getByRole('button', { name: '保存数据', exact: true }).click(),
        ])
        await concurrencyAwait(arrived.promise)
        expect(arrivals.size).toBe(2)
        release.resolve()
        await concurrencyAwait(completed.promise)
        if (failures.length) throw new AggregateError(failures, ConcurrencyMessage.FORWARDED_WRITES_FAILED)
        expect(writes).toHaveLength(2)
        expect(new Set(writes.map((/* 已真实发出的保存请求。 */ write) => /* 核对双方使用不同幂等请求身份。 */ write.requestId)).size).toBe(2)
        expect(peak).toBe(2)
        const starts = writes.map((/* 实际上游请求。 */ write) => /* 以单调时钟记录真实发送起点。 */ write.startedAt)
        const ends = writes.map((/* 已收到真实响应的请求。 */ write) => /* 未完成请求不允许冒充成功。 */ write.endedAt ?? Number.NEGATIVE_INFINITY)
        expect(Math.max(...starts)).toBeLessThan(Math.min(...ends))
        await expect(concurrencyInspector(page).getByText('未保存', { exact: true })).toHaveCount(0)
        await expect(concurrencyInspector(other).getByText('未保存', { exact: true })).toHaveCount(0)
        const committed = await gateway.read('map.get', { mapId: map.mapId })
        expect(concurrencyReadNode(committed, leftId)).toMatchObject({ revision: round + 1, payload: { content: leftContent } })
        expect(concurrencyReadNode(committed, rightId)).toMatchObject({ revision: round + 1, payload: { content: rightContent } })
        expect(committed.nodes).toHaveLength(2)
        expect(committed.edges).toHaveLength(0)
        allWrites.push(...writes)
      } finally {
        release.resolve()
        await Promise.all([page.unroute('**/api/v1/command', leftHandler), other.unroute('**/api/v1/command', rightHandler)])
      }
    }
    expect(allWrites).toHaveLength(20)
    expect(new Set(allWrites.map((/* 二十个实际完成的保存请求。 */ write) => /* 不允许重放或重复计数补足数量。 */ write.requestId)).size).toBe(20)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await context.close()
  }
})

test('M00-R06 五轮跨工作区切图释放真实迟到响应，不串用同名节点的旧内容', async (
  /* 同一页面实例、真实公共准备客户端与隔离后端。 */ { page, gateway, environment, webUrl },
) => {
  // 两个工作区故意使用相同 nodeId，以用户可见正文和完整图身份核对迟到隔离。
  test.setTimeout(120_000)
  const nodeId = randomUUID()
  const oldMap = await concurrencyPrepareMap(gateway, environment.workspaceId, 'R06 旧工作区资料', [{ id: nodeId, content: 'R06 旧工作区专属正文。' }])
  const newWorkspaceId = randomUUID()
  await gateway.dispatch(randomUUID(), 'workspace.create', { id: newWorkspaceId, name: 'R06 新工作区', description: '跨工作区迟到响应隔离。', agentSource: 'library' })
  const newMap = await concurrencyPrepareMap(gateway, newWorkspaceId, 'R06 新工作区资料', [{ id: nodeId, content: 'R06 新工作区正确全文。' }])
  await workspaceLogin(page, webUrl, environment.token)
  let completedRounds = 0

  for (let round = 0; round < 5; round++) {
    await page.getByRole('combobox', { name: '当前工作区', exact: true }).selectOption(environment.workspaceId)
    await workspaceOpenMap(page, oldMap.name)
    await concurrencySelectNode(page, 0)
    await expect(concurrencyContent(page)).toHaveValue('R06 旧工作区专属正文。')
    const held = concurrencyCreateCompletion(), release = concurrencyCreateCompletion(), delivered = concurrencyCreateCompletion()
    const failures: unknown[] = []
    let captured = 0
    const outcomes: Array<'delivered' | 'cancelled'> = []
    const delayOldSnapshot = async (/* 旧图真实查询的网络边界。 */ route: Route): Promise<void> => {
      // 先取得真实上游快照，再等待切换完成；不构造或改写业务响应。
      const query = concurrencyReadRecord(route.request().postDataJSON())
      const params = concurrencyReadRecord(query?.params)
      if (query?.method !== 'map.get' || params?.mapId !== oldMap.mapId || captured > 0) { await route.continue(); return }
      captured++
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10_000 })
        expect(response.status()).toBe(200)
        const reply: unknown = await response.json()
        expect(reply).toMatchObject({ ok: true, data: { mapId: oldMap.mapId, workspaceId: environment.workspaceId } })
        held.resolve()
        await concurrencyAwait(release.promise)
        try {
          await route.fulfill({ response })
          outcomes.push('delivered')
        } catch (error) {
          // 切图主动取消旧请求也是合法隔离行为；其余交付错误必须保留失败。
          if (route.request().failure() !== null) outcomes.push('cancelled')
          else failures.push(new Error(ConcurrencyMessage.DELAYED_RESPONSE_FAILED, { cause: error }))
        }
      } catch (error) {
        failures.push(error)
        held.resolve()
      } finally {
        delivered.resolve()
      }
    }
    await page.route('**/api/v1/query', delayOldSnapshot)
    try {
      await page.getByRole('button', { name: '刷新', exact: true }).click()
      await concurrencyAwait(held.promise)
      if (failures.length) throw new AggregateError(failures, ConcurrencyMessage.DELAYED_RESPONSE_FAILED)
      await page.getByRole('combobox', { name: '当前工作区', exact: true }).selectOption(newWorkspaceId)
      await workspaceOpenMap(page, newMap.name)
      await concurrencySelectNode(page, 0)
      await expect(concurrencyContent(page)).toHaveValue('R06 新工作区正确全文。')
      release.resolve()
      await concurrencyAwait(delivered.promise)
      if (failures.length) throw new AggregateError(failures, ConcurrencyMessage.DELAYED_RESPONSE_FAILED)
      expect(captured).toBe(1)
      expect(outcomes).toHaveLength(1)
      expect(['delivered', 'cancelled']).toContain(outcomes[0])
      await expect(page.getByRole('combobox', { name: '当前工作区', exact: true })).toHaveValue(newWorkspaceId)
      await expect(page.locator('.view-label strong')).toHaveText(newMap.name)
      await expect(concurrencyContent(page)).toHaveValue('R06 新工作区正确全文。')
      await page.getByRole('button', { name: '单页', exact: true }).click()
      const article = page.getByRole('region', { name: '节点完整内容', exact: true })
      await expect(article.getByText('R06 新工作区正确全文。', { exact: true })).toBeVisible()
      await expect(article).not.toContainText('R06 旧工作区专属正文。')
      await page.getByRole('button', { name: '返回关系图', exact: true }).click()
      const confirmed = await gateway.read('map.get', { mapId: newMap.mapId })
      expect(confirmed.workspaceId).toBe(newWorkspaceId)
      expect(confirmed.nodes).toEqual(newMap.nodes)
      completedRounds++
    } finally {
      release.resolve()
      await page.unroute('**/api/v1/query', delayOldSnapshot)
    }
  }
  expect(completedRounds).toBe(5)
  expect(environment.modelCalls).toHaveLength(0)
})

test('M00-R06 五轮真实断流期间独立写入，恢复后页面与公共读取一致', async (
  /* 当前真实页面、独立授权写入客户端和隔离后端。 */ { page, gateway, environment, webUrl },
) => {
  // 截断真实事件流，独立客户端照常提交；恢复必须靠现有事件流重连。
  test.setTimeout(120_000)
  const nodeId = randomUUID()
  const map = await concurrencyPrepareMap(gateway, environment.workspaceId, 'R06 事件流恢复', [{ id: nodeId, content: 'R06 断流前正文。' }])
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const eventsPath = `/api/v1/maps/${map.mapId}/events`
  const relay = await concurrencyCreateStreamRelay(webUrl, eventsPath)
  let priorContent = 'R06 断流前正文。'
  let recovered = 0
  try {
    await workspaceLogin(page, relay.origin, environment.token)
    await workspaceOpenMap(page, map.name)
    await concurrencySelectNode(page, 0)
    await expect(page.locator('.client-footer')).toContainText('实时同步')
    for (let round = 0; round < 5; round++) {
      const failed = page.waitForEvent('requestfailed', {
        predicate: (/* 浏览器真实失败的请求，不检查错误消息文本。 */ request) => /* 只观测当前图的事件流中断。 */
          new URL(request.url()).pathname === eventsPath,
        timeout: 10_000,
      })
      expect(relay.cut()).toBeGreaterThan(0)
      await failed
      await expect(page.locator('.client-footer')).toContainText('自动重连')
      const content = `R06 第 ${round + 1} 轮断流期间真实提交的完整正文。`
      const committed = await concurrencyWriteNode(gateway, map.mapId, nodeId, content, required)
      expect(concurrencyReadNode(committed, nodeId)).toMatchObject({ revision: round + 1, payload: { content } })
      await expect(concurrencyContent(page)).toHaveValue(priorContent)
      const response = page.waitForResponse((/* 浏览器重连收到的真实 HTTP 响应。 */ reply) => /* 只接受当前图事件流的成功握手。 */
        new URL(reply.url()).pathname === eventsPath && reply.status() === 200, { timeout: 15_000 })
      relay.resume()
      await response
      await expect(page.locator('.client-footer')).toContainText('实时同步')
      await expect(concurrencyContent(page)).toHaveValue(content)
      await expect(concurrencyInspector(page)).toContainText(`内容版本 ${round + 1}`)
      const confirmed = await gateway.read('map.get', { mapId: map.mapId })
      expect(confirmed.nodes).toEqual(committed.nodes)
      priorContent = content
      recovered++
    }
    expect(recovered).toBe(5)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    relay.resume()
    await relay.close()
  }
})
