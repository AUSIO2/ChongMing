// CS-05/06：真实提交、HTTP 读回和原始 SSE 的受控顺序，不替换业务响应或页面状态。
import { randomUUID } from 'node:crypto'
import type { APIResponse, Locator, Page, Response as PlaywrightResponse, Route } from '@playwright/test'
import type { ClientGateway } from '../../contracts/client'
import type { GraphNode } from '../../contracts/graph'
import type { GraphCommand, GraphSnapshot, GraphSuccess, GraphWriteResult } from '../../contracts/graph-api'
import type { GraphBranchGrant, GraphBranchLeaseProof, GraphBranchSnapshot } from '../../contracts/graph-branch'
import { expect, test, workspaceLogin, workspaceOpenMap } from './workspace-fixture'
import { grantCreateFrameRelay, grantObserveBrowserFrames } from './workspace-grant-relay'

enum EditingCaseError {
  NODE_MISSING = '连续编辑验收缺少原始节点。',
  BRANCH_MISSING = '连续编辑验收缺少真实分支读回。',
  COMMIT_PROOF_MISSING = '真实提交响应没有与快照配对的分支证明。',
  CLAIM_FAILED = '连续编辑验收未取得真实编辑授权。',
  COMMAND_MISMATCH = '连续编辑验收捕获的实际命令不匹配。',
  BOUNDARY_TIMEOUT = '连续编辑验收未在期限内到达真实运输或消费屏障。',
  GATE_CLOSED = '连续编辑验收的读回运输屏障已经关闭。',
  GATE_BUSY = '连续编辑验收尚有未释放的读回响应。',
  GATE_FAILED = '连续编辑验收的真实读回运输失败。',
  OBSERVER_CLOSED = '连续编辑验收的公开读取消费观测已经关闭。',
  TRANSPORT_DIAGNOSTIC_FAILED = '连续编辑验收的原传输元数据诊断未完成。',
}

interface EditingSignal { promise: Promise<void>; resolve(): void }
interface EditingHeld { branch: GraphBranchSnapshot; release: EditingSignal; finished: EditingSignal }

/** 只把真实请求到达、实际消费或显式放行变成信号，不产生业务数据。 */
function editingSignal(): EditingSignal {
  // 建立当前运输边界的可等待信号，不生成业务结果。
  let resolve = (): void => { /* 完成函数初始化前保持无副作用的占位。 */}
  const promise = new Promise<void>((/* 真实边界到达时使用的完成函数。 */ complete) => { /* 保留本轮 Promise 的真实完成入口。 */ resolve = complete })
  return { promise, resolve(): void { /* 只释放当前信号，不变更服务端事实。 */ resolve() } }
}

/** 期限仅用于报告边界缺失，不以固定延时选择网络顺序。 */
async function editingAwait<T>(/* 真实运输或消费的完成信号。 */ operation: Promise<T>): Promise<T> {
  // 等待真实运输或消费边界，并清理期限计时器。
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((/* 到期不产生替代结果。 */ _resolve, /* 缺失真实边界直接失败。 */ reject) => {
      // 真实边界缺失时只报告固定超时。
      timer = setTimeout(() => reject(new Error(EditingCaseError.BOUNDARY_TIMEOUT)), 10_000)
    })])
  } finally { clearTimeout(timer) }
}

/** 将公开请求信封收窄为普通记录，不复制其认证或正文。 */
function editingRecord(/* 待筛选的真实请求 JSON。 */ value: unknown): Record<string, unknown> | null {
  // 只接纳普通记录以筛选请求信封。
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** 仅扣住指定根、指定真实图版本的原 branch.get 回包，其他 HTTP 正常流转。 */
async function editingCreateProofGate(
  /* 用例独占的真实浏览器页面。 */ page: Page,
  /* 只允许观测当前图的真实查询。 */ mapId: string,
  /* 当前通过键盘选中的真实根。 */ rootId: string,
) {
  // 为本轮唯一图和根安装原响应运输屏障。
  let targetRevision: number | null = null, closed = false, failure: unknown
  let arrived = editingSignal()
  const held: EditingHeld[] = [], operations = new Set<Promise<void>>()
  /** 先完整取得真实回包，原响应保持不变直到运输屏障放行。 */
  async function forward(/* 浏览器发出的真实查询运输。 */ route: Route): Promise<void> {
    // 取得真实响应后按目标版本暂扣或原样交付。
    let response: APIResponse | undefined, pending: EditingHeld | undefined
    try {
      const envelope = editingRecord(route.request().postDataJSON()), params = editingRecord(envelope?.params)
      if (envelope?.method !== 'branch.get' || params?.mapId !== mapId || !Array.isArray(params.rootIds)
        || params.rootIds.length !== 1 || params.rootIds[0] !== rootId) { await route.continue(); return }
      response = await route.fetch()
      const reply = await response.json() as GraphSuccess<GraphBranchSnapshot>
      if (response.status() === 200 && reply.ok && reply.data.mapRevision === targetRevision) {
        pending = { branch: reply.data, release: editingSignal(), finished: editingSignal() }
        held.push(pending); arrived.resolve()
        await pending.release.promise
      }
      if (closed) await route.abort('aborted')
      else await route.fulfill({ response })
    } catch (cause) {
      if (!closed) { failure = cause; arrived.resolve() }
      await route.abort('aborted').catch(() => { /* 本轮关闭引起的运输取消没有业务成功含义。 */ })
    } finally { pending?.finished.resolve(); await response?.dispose() }
  }
  /** 追踪每个自有异步 handler，关闭时等待其真正结束。 */
  async function handler(/* 当前真实浏览器路由。 */ route: Route): Promise<void> {
    // 记录并等待每个自有运输 handler 的实际完成。
    const operation = forward(route)
    operations.add(operation)
    try { await operation } finally { operations.delete(operation) }
  }
  await page.route('**/api/v1/query', handler)
  return {
    /** 扣包条件来自预期的下一次真实提交版本，不改写读回内容。 */
    hold(/* 真实 mapRevision；同一版本所有重复读回均暂扣。 */ mapRevision: number): void {
      // 只设置本次要扣住的真实 mapRevision。
      if (closed) throw new Error(EditingCaseError.GATE_CLOSED)
      if (targetRevision !== null) throw new Error(EditingCaseError.GATE_BUSY)
      targetRevision = mapRevision; arrived = editingSignal()
    },
    /** 确认原服务器确实产生并返回了被扣住的新证明。 */
    async waitForHeld(): Promise<GraphBranchSnapshot> {
      // 等待服务器真实响应到达，缺失或运输失败直接报错。
      if (!held.length && failure === undefined) await editingAwait(arrived.promise)
      if (failure !== undefined) throw new Error(EditingCaseError.GATE_FAILED, { cause: failure })
      const item = held[0]
      if (!item) throw new Error(EditingCaseError.BRANCH_MISSING)
      return item.branch
    },
    /** 放行所有已取得的原响应，未来同版本查询也恢复正常运输。 */
    async release(): Promise<GraphBranchSnapshot[]> {
      // 解除扣包条件并等待原响应完成交付。
      targetRevision = null
      for (const item of held) item.release.resolve()
      await Promise.all(held.map((/* 等待真实 fulfill 或取消完成的响应。 */ item) => item.finished.promise))
      if (failure !== undefined) throw new Error(EditingCaseError.GATE_FAILED, { cause: failure })
      return held.map((/* 仅返回已经原样放行的真实证明元数据。 */ item) => item.branch)
    },
    /** 结束本轮拦截及所有等待运输，不触碰现有服务或共享 relay。 */
    async close(): Promise<void> {
      // 取消本轮屏障并等待所有自有 handler 结束。
      closed = true; targetRevision = null; arrived.resolve()
      for (const item of held) item.release.resolve()
      await page.unroute('**/api/v1/query', handler)
      await Promise.allSettled([...operations])
    },
  }
}

/** 观察公开 HTTP body reader 的结束；消息任务在该回包的 Promise 微任务链之后报告消费边界。 */
async function editingObserveProofs(
  /* 导航前安装只读运输观测的真实页面。 */ page: Page,
  /* 当前唯一允许观测的真实图。 */ mapId: string,
  /* 当前唯一允许观测的真实根。 */ rootId: string,
) {
  // 安装只读公开 body 消费观测，仅保留版本整数。
  const observed = new Set<string>(), changed = new Set<EditingSignal>()
  let disposed = false
  const bindingName = '__m00EditingProofConsumed'
  await page.exposeBinding(bindingName, (
    /* Playwright 持有的来源对象，不输出或读取页面私有状态。 */ _source,
    /* 浏览器只回传两个公开版本整数。 */ value: unknown,
  ) => {
    // 只接纳合法版本整数并唤醒消费等待者。
    const record = editingRecord(value)
    if (!record || !Number.isSafeInteger(record.mapRevision) || Number(record.mapRevision) < 0
      || !Number.isSafeInteger(record.rootRevision) || Number(record.rootRevision) < 0) return
    observed.add(`${record.mapRevision}:${record.rootRevision}`)
    for (const signal of changed) signal.resolve()
    changed.clear()
  })
  await page.addInitScript((/* 仅当前图、根及固定观测入口。 */ options: { mapId: string; rootId: string; bindingName: string }) => {
    // 在产品运行前安装目标查询的公开读取观测。
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (
      /* 原始请求地址与 Request 对象，保持原样。 */ input: RequestInfo | URL,
      /* 原始认证及请求正文，仅筛选 branch.get 而不改写。 */ init?: RequestInit,
    ): Promise<Response> => {
      // 原样执行真实 fetch，只为目标响应观察 reader。
      const response = await originalFetch(input, init)
      let selected = false
      try {
        const value = typeof init?.body === 'string' ? JSON.parse(init.body) as { method?: unknown; params?: { mapId?: unknown; rootIds?: unknown } } : null
        selected = value?.method === 'branch.get' && value.params?.mapId === options.mapId
          && Array.isArray(value.params.rootIds) && value.params.rootIds.length === 1 && value.params.rootIds[0] === options.rootId
      } catch { /* 非目标查询不会安装任何 body 观测。 */ }
      if (!selected || !response.body) return response
      const body = response.body, getReader = body.getReader.bind(body)
      Object.defineProperty(body, 'getReader', { configurable: true, value: (/* 其他 reader 模式交给原生实现。 */ mode?: ReadableStreamGetReaderOptions) => {
        // 保持原生 reader 模式，只包装目标默认读取流程。
        if (mode !== undefined) return Reflect.apply(getReader, body, [mode])
        const reader = getReader(), read = reader.read.bind(reader), decoder = new TextDecoder()
        let text = '', completed = false
        Object.defineProperty(reader, 'read', { configurable: true, value: async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
          // 返回原读取结果，结束后安排公开消费确认任务。
          const result = await read()
          if (!result.done) text += decoder.decode(result.value, { stream: true })
          else if (!completed) {
            completed = true
            try {
              const value = JSON.parse(text + decoder.decode()) as { ok?: unknown; data?: { mapRevision?: unknown; rootRevisions?: Record<string, unknown> } }
              const mapRevision = value.data?.mapRevision, rootRevision = value.data?.rootRevisions?.[options.rootId]
              if (value.ok === true && Number.isSafeInteger(mapRevision) && Number.isSafeInteger(rootRevision)) {
                const channel = new MessageChannel()
                channel.port1.onmessage = () => {
                  // 原 read(done) 返回后的同步解析和 Promise 消费链已运行，才交付这个任务。
                  channel.port1.close(); channel.port2.close()
                  const notify = Reflect.get(window, options.bindingName) as unknown
                  if (typeof notify === 'function') void (notify as (input: { mapRevision: unknown; rootRevision: unknown }) => Promise<void>)({ mapRevision, rootRevision }).catch(() => { /* 观测回传失败不改变真实响应或产品处理。 */})
                }
                channel.port2.postMessage(null)
              }
            } catch { /* 不合规原响应仍交给产品自己处理，不构造成功或替代内容。 */ }
          }
          return result
        } })
        return reader
      } })
      return response
    }
  }, { mapId, rootId, bindingName })
  return {
    /** 等待指定原读回真正经过浏览器公开读取流程。 */
    async waitFor(/* 已从真实服务器取得的目标分支证明。 */ proof: GraphBranchSnapshot): Promise<void> {
      // 等待目标原证明经过浏览器公开读取链。
      const key = `${proof.mapRevision}:${proof.rootRevisions[rootId]}`
      await editingAwait((async () => {
        // 逐个等待版本通知，结束观测后不创建新等待。
        while (!observed.has(key)) {
          if (disposed) throw new Error(EditingCaseError.OBSERVER_CLOSED)
          const signal = editingSignal(); changed.add(signal)
          try { await signal.promise } finally { changed.delete(signal) }
        }
      })())
    },
    /** 页面关闭时释放本轮等待信号，不保留观测资源。 */
    dispose(): void { /* 释放观测等待并标记结束，避免保留未完成信号。 */ disposed = true; for (const signal of changed) signal.resolve(); changed.clear() },
  }
}

/** 精确定位稳定身份，节点丢失直接失败。 */
function editingNode(/* 授权 API 的真实图快照。 */ snapshot: GraphSnapshot, /* 预先记住的原根身份。 */ rootId: string): GraphNode {
  // 按稳定身份读取节点，丢失时不回退到别的节点。
  const node = snapshot.nodes.find((/* 当前快照中的真实候选节点。 */ item) => item.id === rootId)
  if (!node) throw new Error(EditingCaseError.NODE_MISSING)
  return node
}

/** 将所有编辑动作限定在公开的节点详情面板。 */
function editingInspector(/* 当前真实页面。 */ page: Page): Locator { /* 将编辑动作限定在真实数据详情面板。 */ return page.getByRole('region', { name: '数据详情', exact: true }) }
/** 从中文字段名定位真实正文控件。 */
function editingContent(/* 当前已选中原节点的真实页面。 */ page: Page): Locator { /* 用公开中文字段组定位真实正文控件。 */ return editingInspector(page).getByRole('group', { name: '正文', exact: true }).getByRole('textbox') }
/** 用公开类型提示核对页面已接纳目标分支证明。 */
async function editingExpectProof(/* 当前真实页面。 */ page: Page, /* 已知精确类型的原节点。 */ node: GraphNode, /* 服务端实际返回的证明。 */ proof: GraphBranchSnapshot): Promise<void> {
  // 用公开类型提示确认真实证明已被采用。
  await expect(editingInspector(page).locator('.inspector-header small')).toHaveAttribute('title', `${node.typeId}@${node.typeVersion} · ${proof.version}`)
}

/** 仅通过公共 CAS 和现有事实类型准备两个独立合法根。 */
async function editingPrepare(/* 已授权的真实公共客户端。 */ gateway: ClientGateway, /* 本轮真实工作区。 */ workspaceId: string): Promise<{ snapshot: GraphSnapshot; rootId: string; otherId: string }> {
  // 通过公共 CAS 创建独占图和两个独立事实根。
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const map = (await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision, id: randomUUID(), name: '连续编辑版本验收' })).data.snapshot
  const ids = [randomUUID(), randomUUID()].sort(), rootId = ids[0], otherId = ids[1]
  if (!rootId || !otherId) throw new Error(EditingCaseError.NODE_MISSING)
  const snapshot = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: map.mapId,
    branch: { rootIds: [rootId, otherId], expectedVersion: null }, changes: { nodes: { put: [rootId, otherId].map((/* 两个互不相连的真实新根。 */ id) => ({ id, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: id === rootId ? '原正文，等待真实连续编辑。' : '独立分支的原正文。', category: 'data' } })) } },
  })).data.snapshot
  return { snapshot, rootId, otherId }
}

/** 公开画布键盘选择第一根；collab 从真实按钮取得授权，不伪造 lease。 */
async function editingOpen(
  /* 正常真实页面。 */ page: Page,
  /* 原样转发和扣住真实 SSE 的浏览器地址。 */ origin: string,
  /* 夹具给出的本轮真实账号凭据，仅用于原登录表单。 */ token: string,
  /* 本轮真实图和已知第一根。 */ prepared: Awaited<ReturnType<typeof editingPrepare>>,
  /* 实际 bootstrap 公布的客户端租约策略。 */ required: boolean,
): Promise<GraphBranchGrant | null> {
  // 通过真实登录、画布键盘和领取按钮进入编辑。
  await workspaceLogin(page, origin, token); await workspaceOpenMap(page, prepared.snapshot.name)
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await scene.focus(); await scene.press('Escape'); await scene.press('ArrowRight')
  await expect(editingContent(page)).toHaveValue(editingNode(prepared.snapshot, prepared.rootId).payload.content as string)
  if (!required) { await expect(editingContent(page)).toBeEditable(); return null }
  const returned = page.waitForResponse((/* 只观察实际领取响应。 */ response) => editingMatches(response, 'branch.claim'))
  await editingInspector(page).getByRole('button', { name: /^(?:尝试)?领取分支编辑权$/ }).click()
  const reply = await (await returned).json() as GraphSuccess<{ status: 'claimed'; grant: GraphBranchGrant } | { status: 'busy' }>
  if (!reply.ok || reply.data.status !== 'claimed') throw new Error(EditingCaseError.CLAIM_FAILED)
  await expect(editingInspector(page).getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
  await expect(editingContent(page)).toBeEditable()
  return reply.data.grant
}

/** 真实命令响应按方法筛选，不记录或改写请求正文。 */
function editingMatches(/* 真实浏览器 HTTP 响应。 */ response: PlaywrightResponse, /* 此处只观测两种固定写命令。 */ method: 'graph.apply' | 'branch.claim'): boolean {
  // 只匹配指定真实写命令响应，不记录正文。
  if (new URL(response.url()).pathname !== '/api/v1/command') return false
  try { return editingRecord(response.request().postDataJSON())?.method === method } catch { return false }
}

/** 真实 UI 提交后核对 wire proof、同次提交证明和独立 API 事实。 */
async function editingSave(
  /* 已填好本轮草稿的真实页面。 */ page: Page,
  /* 与页面分离的真实公共读取客户端。 */ gateway: ClientGateway,
  /* 保存前的原快照和节点身份。 */ current: { snapshot: GraphSnapshot; rootId: string },
  /* 草稿所依据的真实分支版本。 */ proof: GraphBranchSnapshot,
  /* 经 UI 取得的真实授权；none 模式明确为 null。 */ grant: GraphBranchGrant | null,
  /* 本轮预期完整正文，仅在内存核对。 */ content: string,
): Promise<GraphWriteResult & { branch: GraphBranchSnapshot }> {
  // 执行 UI 保存并核对 wire、提交证明和独立 API。
  await expect(editingInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeEnabled()
  const returned = page.waitForResponse((/* 只等待本轮真实保存命令。 */ response) => editingMatches(response, 'graph.apply'))
  await editingInspector(page).getByRole('button', { name: '保存数据', exact: true }).click()
  const response = await returned, command = response.request().postDataJSON() as GraphCommand
  if (command.method !== 'graph.apply') throw new Error(EditingCaseError.COMMAND_MISMATCH)
  expect(command.params.mapId).toBe(current.snapshot.mapId)
  expect(command.params.branch).toEqual({ rootIds: proof.scope.rootIds, expectedVersion: proof.version })
  expect(command.params.changes.nodes?.put?.[0]?.payload.content).toBe(content)
  if (grant) expect(command.params.lease).toEqual({ leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence })
  else expect(command.params.lease).toBeUndefined()
  const reply = await response.json() as GraphSuccess<GraphWriteResult>
  expect(response.status()).toBe(200); expect(reply.ok).toBe(true)
  const branch = reply.data.branch
  if (!branch || branch.mapRevision !== reply.data.snapshot.revision) throw new Error(EditingCaseError.COMMIT_PROOF_MISSING)
  expect(branch.rootRevisions[current.rootId]).toBe(editingNode(reply.data.snapshot, current.rootId).revision)
  expect(branch.scope.rootIds).toEqual([current.rootId])
  const observed = await gateway.read('map.get', { mapId: current.snapshot.mapId })
  expect(editingNode(observed, current.rootId).payload.content).toBe(content)
  expect(editingNode(observed, current.rootId).revision).toBe(editingNode(current.snapshot, current.rootId).revision + 1)
  await expect(editingInspector(page).getByText('未保存', { exact: true })).toHaveCount(0)
  return { ...reply.data, branch }
}

/** 独立 API 提交真实外部变化；同根使用实际 UI grant，独立根领取自己的真实 lease。 */
async function editingExternalWrite(
  /* 与页面分离但真实授权的公共客户端。 */ gateway: ClientGateway,
  /* 本轮真实图。 */ mapId: string,
  /* 原根或完全独立的另一根。 */ rootId: string,
  /* 真实外部新正文。 */ content: string,
  /* 实际 bootstrap 租约策略。 */ required: boolean,
  /* 同账号已持有的真实授权；独立根不传此值。 */ existing: GraphBranchGrant | null = null,
): Promise<GraphWriteResult> {
  // 真实授权执行外部写入，只释放本次取得的租约。
  let lease: GraphBranchLeaseProof | undefined, release = false
  if (required) {
    let grant = existing
    if (!grant) {
      const claimed = await gateway.dispatch(randomUUID(), 'branch.claim', { mapId, rootIds: [rootId], holderId: randomUUID() })
      if (claimed.data.status !== 'claimed') throw new Error(EditingCaseError.CLAIM_FAILED)
      grant = claimed.data.grant; release = true
    }
    lease = { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence }
  }
  try {
    const snapshot = await gateway.read('map.get', { mapId }), node = editingNode(snapshot, rootId)
    const proof = await gateway.read('branch.get', { mapId, rootIds: [rootId] })
    return (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: [rootId], expectedVersion: proof.version }, ...(lease ? { lease } : {}),
      changes: { nodes: { put: [{ id: rootId, typeId: node.typeId, typeVersion: node.typeVersion, payload: { ...node.payload, content } }] } },
    })).data
  } finally { if (release && lease) await gateway.dispatch(randomUUID(), 'branch.release', { mapId, lease }) }
}

test('M00-R02 CS-05 连续保存采用同次提交证明，迟到读回不把第二稿误报冲突', async (
  /* 本轮独占的页面、真实公共服务与两个存储项目配置。 */ { page, gateway, environment, webUrl },
) => {
  // 固定连续保存窗口，验证第二稿合法提交。
  const prepared = await editingPrepare(gateway, environment.workspaceId), original = prepared.snapshot
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const relay = await grantCreateFrameRelay(webUrl, original.mapId)
  const frames = await grantObserveBrowserFrames(page, relay.eventsPath)
  const proofs = await editingObserveProofs(page, original.mapId, prepared.rootId)
  const gate = await editingCreateProofGate(page, original.mapId, prepared.rootId)
  try {
    const grant = await editingOpen(page, relay.origin, environment.token, prepared, required)
    const initial = await relay.waitForSnapshot((/* 真正的初始原帧。 */ frame) => frame.revision === original.revision)
    await relay.releaseThrough(initial); await frames.waitForProcessed(initial)
    const base = await gateway.read('branch.get', { mapId: original.mapId, rootIds: [prepared.rootId] })
    await editingExpectProof(page, editingNode(original, prepared.rootId), base)
    gate.hold(original.revision + 1)
    const firstDraft = '第一稿已经真实提交，第二稿不应沿用旧证明。'
    await editingContent(page).fill(firstDraft)
    const first = await editingSave(page, gateway, { snapshot: original, rootId: prepared.rootId }, base, grant, firstDraft)
    // 原命令已有同次提交证明；背景查询与 SSE 仍被屏障扣住，不能靠后到刷新掩盖窗口。
    const currentTitle = await editingInspector(page).locator('.inspector-header small').getAttribute('title')
    if (currentTitle !== `${editingNode(original, prepared.rootId).typeId}@1 · ${first.branch.version}`) {
      const held = await gate.waitForHeld()
      expect(held.version).toBe(first.branch.version)
      expect(held.mapRevision).toBe(first.snapshot.revision)
    }
    const secondDraft = '第二稿在读回到达以前已输入，仍应完整保留并合法保存。'
    await expect(editingContent(page)).toBeEditable()
    await editingContent(page).fill(secondDraft)
    await expect(editingInspector(page).getByText('未保存', { exact: true })).toBeVisible()
    const released = await gate.release()
    await editingExpectProof(page, editingNode(original, prepared.rootId), first.branch)
    if (released.length) await proofs.waitFor(first.branch)
    await expect(editingContent(page)).toHaveValue(secondDraft)
    await expect(editingInspector(page).getByText('服务器数据已变化，草稿已保留。', { exact: true })).toHaveCount(0)
    await editingSave(page, gateway, { snapshot: first.snapshot, rootId: prepared.rootId }, first.branch, grant, secondDraft)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    frames.dispose(); proofs.dispose()
    try { await gate.close() } finally { try { await page.close() } finally { await relay.close() } }
  }
})

test('M00-R02 CS-06 独立分支不误冲突，真实同分支变更保留草稿且旧读回不能覆盖新证明', async (
  /* 两种真实存储均运行，collab 保留完整租约校验。 */ { page, gateway, environment, webUrl },
) => {
  // 验证独立分支对照、同根真冲突和迟到旧读回。
  const prepared = await editingPrepare(gateway, environment.workspaceId), original = prepared.snapshot
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const relay = await grantCreateFrameRelay(webUrl, original.mapId)
  const frames = await grantObserveBrowserFrames(page, relay.eventsPath)
  const proofs = await editingObserveProofs(page, original.mapId, prepared.rootId)
  const gate = await editingCreateProofGate(page, original.mapId, prepared.rootId)
  try {
    const grant = await editingOpen(page, relay.origin, environment.token, prepared, required)
    const initial = await relay.waitForSnapshot((/* 初始快照由原服务产生。 */ frame) => frame.revision === original.revision)
    await relay.releaseThrough(initial); await frames.waitForProcessed(initial)
    let consumedThrough = initial
    if (grant) {
      // 先消费真实 claim 已确认的 O 帧；随后公开刷新是同 R/O，避免把合法的新 O 复用误当读回缺失。
      const grantedFrame = await relay.waitForSnapshot((/* 原连接上对应真实 grant 的同内容版本原帧。 */ frame) =>
        frame.connection === initial.connection && frame.revision === original.revision && frame.ownershipRevision === grant.ownershipRevision)
      await relay.releaseThrough(grantedFrame); await frames.waitForProcessed(grantedFrame)
      consumedThrough = grantedFrame
    }
    const base = await gateway.read('branch.get', { mapId: original.mapId, rootIds: [prepared.rootId] })
    await editingExpectProof(page, editingNode(original, prepared.rootId), base)
    const draft = '本地未提交稿；外部真正冲突时必须完整保留。'
    await editingContent(page).fill(draft)
    // 用户主动刷新同一图，扣住尚未发生外部写入时的真实旧证明；不依赖无关分支触发背景查询。
    gate.hold(original.revision)
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    const stale = await test.step('editing-stage:old-proof-held', async () => {
      // 只为既有真实读回等待登记固定阶段，不改变正常运输顺序。
      try { return await gate.waitForHeld() } catch (cause) {
        try {
          // 失败后仅读取原帧元数据；消费上界只来自前置真实 release 和 reader 确认。
          const claimed = grant ? await relay.waitForSnapshot((/* 必须是实际 claim 已确认的占用版本原帧。 */ frame) =>
            frame.connection === initial.connection && frame.ownershipRevision === grant.ownershipRevision) : null
          await test.info().attach('m00-editing-transport-observation', { contentType: 'application/json', body: Buffer.from(JSON.stringify({
            schemaVersion: 1, stage: 'old-proof-held', initialProcessed: true,
            initialOwnershipZero: initial.ownershipRevision === 0, grantPresent: grant !== null,
            grantNewerThanInitial: grant !== null && grant.ownershipRevision > initial.ownershipRevision,
            claimFrameObserved: claimed !== null, claimFrameSameConnection: claimed !== null && claimed.connection === initial.connection,
            claimFrameSameRevision: claimed !== null && claimed.revision === initial.revision,
            claimFrameFollowsInitial: claimed !== null && claimed.sequence > initial.sequence,
            claimFrameStillBuffered: claimed !== null && claimed.connection === consumedThrough.connection && claimed.sequence > consumedThrough.sequence,
          })) })
        } catch (diagnostic) {
          throw new AggregateError([cause, diagnostic], EditingCaseError.TRANSPORT_DIAGNOSTIC_FAILED, { cause })
        }
        throw cause
      }
    })
    expect(stale.version).toBe(base.version)
    expect(stale.mapRevision).toBe(original.revision)
    const unrelated = await editingExternalWrite(gateway, original.mapId, prepared.otherId, '独立分支第一次真实更新。', required)
    const unrelatedFrame = await relay.waitForSnapshot((/* 精确对应第一次独立分支提交的原帧。 */ frame) => frame.revision === unrelated.snapshot.revision)
    await relay.releaseThrough(unrelatedFrame); await frames.waitForProcessed(unrelatedFrame)
    await expect(editingContent(page)).toBeEditable()
    await expect(editingContent(page)).toHaveValue(draft)
    await expect(editingInspector(page).getByText('服务器数据已变化，草稿已保留。', { exact: true })).toHaveCount(0)
    await expect(editingInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeEnabled()
    // 再来一份独立分支快照仍只核对编辑就绪；原 proof 的 mapRevision 不需要追随全图版本改写。
    const independent = await editingExternalWrite(gateway, original.mapId, prepared.otherId, '独立分支第二次真实更新。', required)
    const independentFrame = await relay.waitForSnapshot((/* 对应更新后更高真实图版本。 */ frame) => frame.revision === independent.snapshot.revision)
    await relay.releaseThrough(independentFrame); await frames.waitForProcessed(independentFrame)
    const independentProof = await gateway.read('branch.get', { mapId: original.mapId, rootIds: [prepared.rootId] })
    expect(independentProof.version).toBe(base.version)
    expect(independentProof.mapRevision).toBeGreaterThan(stale.mapRevision)
    await expect(editingContent(page)).toBeEditable()
    await expect(editingContent(page)).toHaveValue(draft)
    await expect(editingInspector(page).getByText('服务器数据已变化，草稿已保留。', { exact: true })).toHaveCount(0)
    await expect(editingInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeEnabled()
    const external = await editingExternalWrite(gateway, original.mapId, prepared.rootId, '同分支外部真实新正文；不得被旧草稿覆盖。', required, grant)
    const externalProof = await gateway.read('branch.get', { mapId: original.mapId, rootIds: [prepared.rootId] })
    expect(externalProof.version).not.toBe(base.version)
    const externalFrame = await relay.waitForSnapshot((/* 精确对应真正同分支外部提交的原帧。 */ frame) => frame.revision === external.snapshot.revision)
    await relay.releaseThrough(externalFrame); await frames.waitForProcessed(externalFrame)
    await test.step('editing-stage:external-proof-consumed', async () => {
      // 只定位真实同根新读回的公开消费边界。
      await proofs.waitFor(externalProof)
    })
    await editingExpectProof(page, editingNode(original, prepared.rootId), externalProof)
    await expect(editingContent(page)).toHaveValue(draft)
    await expect(editingInspector(page).getByText('服务器数据已变化，草稿已保留。', { exact: true })).toBeVisible()
    await expect(editingInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeDisabled()
    await gate.release()
    await test.step('editing-stage:stale-proof-consumed', async () => {
      // 只定位迟到旧读回的公开消费边界，不改写证明或页面状态。
      await proofs.waitFor(stale)
    })
    await editingExpectProof(page, editingNode(original, prepared.rootId), externalProof)
    await expect(editingContent(page)).toHaveValue(draft)
    await expect(editingInspector(page).getByText('服务器数据已变化，草稿已保留。', { exact: true })).toBeVisible()
    await expect(editingInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeDisabled()
    const confirmed = await gateway.read('map.get', { mapId: original.mapId })
    expect(editingNode(confirmed, prepared.rootId)).toEqual(editingNode(external.snapshot, prepared.rootId))
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    frames.dispose(); proofs.dispose()
    try { await gate.close() } finally { try { await page.close() } finally { await relay.close() } }
  }
})

test('M00-R02 CS-05D 脏稿节点被真实外部删除后保留孤立草稿，仅手动重新载入才清空', async (
  /* 本轮独占页面和真实服务，collab 删除必须使用浏览器真实有效授权。 */ { page, gateway, environment, webUrl },
) => {
  // 验证真实删除后孤立稿保留，直到用户重新载入。
  const prepared = await editingPrepare(gateway, environment.workspaceId), original = prepared.snapshot
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const relay = await grantCreateFrameRelay(webUrl, original.mapId)
  const frames = await grantObserveBrowserFrames(page, relay.eventsPath)
  try {
    const grant = await editingOpen(page, relay.origin, environment.token, prepared, required)
    const initial = await relay.waitForSnapshot((/* 原服务实际产生的初始快照。 */ frame) => frame.revision === original.revision)
    await relay.releaseThrough(initial); await frames.waitForProcessed(initial)
    const base = await gateway.read('branch.get', { mapId: original.mapId, rootIds: [prepared.rootId] })
    await editingExpectProof(page, editingNode(original, prepared.rootId), base)
    const draft = '这个节点的本地未提交正文必须在外部删除之后完整保留。'
    await editingContent(page).fill(draft)
    await expect(editingInspector(page).getByText('未保存', { exact: true })).toBeVisible()
    if (required && !grant) throw new Error(EditingCaseError.CLAIM_FAILED)
    const lease = grant ? { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } : undefined
    const deleted = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: original.mapId,
      branch: { rootIds: base.scope.rootIds, expectedVersion: base.version }, ...(lease ? { lease } : {}),
      changes: { nodes: { remove: [prepared.rootId] } },
    })).data.snapshot
    expect(deleted.nodes.some((/* 原根删除必须是真实服务端事实，不能改选其他节点冒充。 */ node) => node.id === prepared.rootId)).toBe(false)
    expect(editingNode(deleted, prepared.otherId)).toEqual(editingNode(original, prepared.otherId))
    const removedFrame = await relay.waitForSnapshot((/* 只放行合法删除之后的真实原帧。 */ frame) => frame.revision === deleted.revision)
    await relay.releaseThrough(removedFrame); await frames.waitForProcessed(removedFrame)
    const inspector = editingInspector(page)
    await expect(inspector.getByText('这个节点已不在当前图中，草稿已保留。', { exact: true })).toBeVisible()
    await expect(inspector.getByText('未保存', { exact: true })).toBeVisible()
    const orphan = inspector.locator('.payload-json')
    await expect(orphan).toBeVisible()
    const orphanPayload: unknown = JSON.parse(await orphan.innerText())
    expect(editingRecord(orphanPayload)?.content).toBe(draft)
    expect(await inspector.getByRole('button', { name: '保存数据', exact: true }).evaluateAll((
      /* 控件缺失或全部禁用均不能发送孤立草稿；不要求产品保留一个无效按钮。 */ buttons,
    ) => buttons.every((/* 当前面板真正渲染的保存按钮。 */ button) => button instanceof HTMLButtonElement && button.disabled))).toBe(true)
    await inspector.getByRole('button', { name: '重新载入', exact: true }).click()
    await expect(inspector.getByText('这个节点已不在当前图中，草稿已保留。', { exact: true })).toHaveCount(0)
    await expect(inspector.getByText('未保存', { exact: true })).toHaveCount(0)
    await expect(orphan).toHaveCount(0)
    await expect(inspector.getByText('选择一个数据节点查看内容、关系和可用转换。', { exact: true })).toBeVisible()
    const confirmed = await gateway.read('map.get', { mapId: original.mapId })
    expect(confirmed.nodes.some((/* 清空本地孤立稿不能重新创建已删除的原根。 */ node) => node.id === prepared.rootId)).toBe(false)
    expect(editingNode(confirmed, prepared.otherId)).toEqual(editingNode(original, prepared.otherId))
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    frames.dispose()
    try { await page.close() } finally { await relay.close() }
  }
})
