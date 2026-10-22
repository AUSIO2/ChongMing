// 产品可靠性先行：真实提交后只改变响应交付或提交次序，从页面恢复并独立核对结果。
import { createHash, randomUUID } from 'node:crypto'
import type { Request, Route } from '@playwright/test'

import type { ClientGateway } from '../../contracts/client'
import type { DefinitionPackage } from '../../contracts/data-definition'
import type { GraphSnapshot } from '../../contracts/graph-api'

import { test, expect, workspaceLogin, workspaceOpenMap } from './workspace-fixture'

interface UploadAttempt {
  readonly requestId: string | null
  readonly declaredDigest: string | null
  readonly actualDigest: string
  readonly filename: string | null
}

enum PreferencesCaseMessage {
  PREPARED_NODE_MISSING = '偏好恢复验收未找到预置的事实节点。',
  REVIEW_BRANCH_BUSY = '审核原请求确认未能取得真实运行分支。',
  RESULT_REVIEW_MISSING = '审核原请求确认未取得结果审核身份。',
  DEFINITION_PACKAGE_MISSING = '定义发布确认未找到正式包摘要。',
}

async function preferencesPrepareMap(
  /* 通过公开协议准备与核对数据的独立授权客户端。 */ gateway: ClientGateway,
  /* 本例独占工作区，不写入页面私有会话。 */ workspaceId: string,
  /* 页面侧栏展示的唯一数据图名称。 */ name: string,
): Promise<GraphSnapshot> {
  // 建立一个真实事实图，供页面打开和键盘选中，不预写被测的用户偏好。
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const map = (await gateway.dispatch(randomUUID(), 'map.create', {
    workspaceId, expectedRevision: workspace.revision, id: randomUUID(), name,
  })).data.snapshot
  const nodeId = randomUUID()
  return (await gateway.dispatch(randomUUID(), 'graph.apply', {
    mapId: map.mapId, branch: { rootIds: [nodeId], expectedVersion: null },
    changes: { nodes: { put: [{ id: nodeId, typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: 'C03 偏好恢复期间仍能阅读的事实正文。', category: 'data' } }] } },
  })).data.snapshot
}

function preferencesIsSet(
  /* 浏览器真实发出的请求，只检查公开端点和方法，不读取认证头。 */ request: Request,
): boolean {
  // 将故障及响应观察限制为 preferences.set，其他图请求保持原样。
  if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/api/v1/command') return false
  const envelope: unknown = request.postDataJSON()
  return envelope !== null && typeof envelope === 'object' && 'method' in envelope && envelope.method === 'preferences.set'
}

test('M00-R03 已提交上传丢失响应后，界面原请求重试不重复创建资产', async (
  /* 独立真实环境、公共核对客户端、正常浏览器页面及同源代理地址。 */
  { environment, gateway, page, webUrl },
) => {
  // 三轮均实际上传字节；故障只作用于收到真实成功响应之后的客户端交付。
  await workspaceLogin(page, webUrl, environment.token)
  await page.getByRole('button', { name: '管理工作台', exact: true }).click()
  const management = page.getByRole('dialog', { name: '工作台管理' })
  await management.getByRole('button', { name: '资产与导入导出', exact: true }).click()

  for (let round = 0; round < 3; round++) {
    const filename = `M00-R03-${round}-${randomUUID()}.txt`
    const bytes = Buffer.from(`真实提交后的第 ${round + 1} 轮资产；重试必须沿用同一请求和字节。`, 'utf8')
    const digest = createHash('sha256').update(bytes).digest('hex')
    const attempts: UploadAttempt[] = []
    const uploadUrl = (
      /* 浏览器实际请求地址，只拦截本轮资产 POST 所用端点。 */ url: URL,
    ): boolean => {
      // 查询参数含本轮唯一文件名，其他 API 及下一轮请求不受影响。
      return url.pathname === '/api/v1/assets' && url.searchParams.get('filename') === filename
    }
    const loseFirstCommittedReply = async (
      /* Playwright 真实网络边界；fetch 会把原请求提交给当前隔离后端。 */ route: Route,
    ): Promise<void> => {
      // 记录可比较的请求身份与字节摘要，认证 header 和原始 payload 不进入报告。
      const request = route.request()
      const body = request.postDataBuffer() ?? Buffer.alloc(0)
      attempts.push({
        requestId: await request.headerValue('idempotency-key'),
        declaredDigest: await request.headerValue('x-content-sha256'),
        actualDigest: createHash('sha256').update(body).digest('hex'),
        filename: new URL(request.url()).searchParams.get('filename'),
      })
      const response = await route.fetch()
      const reply: unknown = await response.json()
      expect(response.ok()).toBe(true)
      expect(reply).toMatchObject({
        ok: true,
        replayed: attempts.length > 1,
        data: { filename, workspaceId: environment.workspaceId, sha256: digest },
      })
      if (attempts.length === 1) {
        const committed = await gateway.read('asset.list', { workspaceId: environment.workspaceId, limit: 100 })
        expect(committed.items.filter(
          /* 通过独立授权 API 查到的资产，不使用页面的乐观状态作为提交证据。 */ asset => {
            // 只核对本轮唯一名称的正式持久化记录。
            return asset.filename === filename
          },
        )).toHaveLength(1)
        await route.abort('connectionreset')
      } else {
        await route.fulfill({ response })
      }
    }

    await page.route(uploadUrl, loseFirstCommittedReply)
    try {
      await management.getByLabel('上传资产文件', { exact: true }).setInputFiles({ name: filename, mimeType: 'text/plain', buffer: bytes })
      await management.getByRole('button', { name: '上传资产', exact: true }).click()
      const retry = management.getByRole('button', { name: '重试同一操作', exact: true })
      await expect(retry).toBeVisible()
      await retry.click()
      await expect(management.getByText(`已上传：${filename}`, { exact: true })).toBeVisible()

      expect(attempts).toHaveLength(2)
      expect(attempts[0].requestId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(attempts[1]).toEqual(attempts[0])
      expect(attempts[0].actualDigest).toBe(digest)
      expect(attempts[0].declaredDigest).toBe(digest)
      const result = await gateway.read('asset.list', { workspaceId: environment.workspaceId, limit: 100 })
      const saved = result.items.filter(
        /* 后端读取返回的正式资产集合。 */ asset => {
          // 重试后同一轮仍只能有一份匹配资产。
          return asset.filename === filename
        },
      )
      expect(saved).toHaveLength(1)
      const downloaded = await gateway.download({ kind: 'asset', id: saved[0].id })
      expect(Buffer.from(downloaded.bytes).equals(bytes)).toBe(true)
      expect(environment.modelCalls).toHaveLength(0)
    } finally {
      await page.unroute(uploadUrl, loseFirstCommittedReply)
    }
  }
})

test('M01-C03 视图设置自动保存前中后画布位置尺寸保持不变', async ({ environment, gateway, page, webUrl }) => {
  // 暂扣真实保存回包，稳定观察saving，直接验证用户可见几何而非提示文案的实现位置。
  const map = await preferencesPrepareMap(gateway, environment.workspaceId, '自动保存不挤动画布')
  const node = map.nodes[0]
  if (!node) throw new Error(PreferencesCaseMessage.PREPARED_NODE_MISSING)
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  await expect.poll(async () => (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences.currentMapId).toBe(map.mapId)
  const sync = page.getByRole('status', { name: '视图设置同步', exact: true })
  await expect(sync).toBeHidden()
  const before = (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await expect(scene.locator('canvas')).toBeVisible()
  const originalCanvas = await scene.locator('canvas').elementHandle()
  const bounds = await scene.boundingBox()
  expect(bounds?.height).toBeGreaterThan(0)
  const center = await page.locator('.panel-center').boundingBox()
  let release!: () => void
  const responseGate = new Promise<void>(resolve => { release = resolve })
  const holdReply = async (route: Route) => {
    if (!preferencesIsSet(route.request())) { await route.continue(); return }
    const response = await route.fetch({ url: new URL('/api/v1/command', environment.baseUrl).href })
    await responseGate
    await route.fulfill({ response })
  }
  await page.route('**/api/v1/command', holdReply)
  try {
    await scene.focus()
    await scene.press('ArrowRight')
    await expect(sync).toContainText('正在保存视图设置')
    await expect(page.getByRole('region', { name: '数据详情', exact: true })
      .getByRole('group', { name: '正文', exact: true }).getByRole('textbox'))
      .toHaveValue('C03 偏好恢复期间仍能阅读的事实正文。')
    expect(await scene.boundingBox()).toEqual(bounds)
    expect(await page.locator('.panel-center').boundingBox()).toEqual(center)
    expect(await originalCanvas?.evaluate(element => element.isConnected && element === document.querySelector('.workspace-views .scene-host canvas'))).toBe(true)
    release()
    await expect(sync).toBeHidden()
    expect(await scene.boundingBox()).toEqual(bounds)
    expect(await page.locator('.panel-center').boundingBox()).toEqual(center)
    expect(await originalCanvas?.evaluate(element => element.isConnected && element === document.querySelector('.workspace-views .scene-host canvas'))).toBe(true)
    const saved = (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences
    expect(saved.revision).toBe(before.revision + 1)
    expect(saved.nodeSelection[map.mapId]).toBe(node.id)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    release()
    await page.unrouteAll({ behavior: 'wait' })
    await originalCanvas?.dispose()
  }
})

test('M01-C03 偏好实际提交后丢失响应，页面重放原请求且继续保存新选择', async (
  /* 真实工作区、独立核对客户端及经正常连接表单登录的页面。 */
  { environment, gateway, page, webUrl },
) => {
  // 只丢弃一次真实成功响应，随后从页面恢复，核对去重和等待期间的新选择。
  const map = await preferencesPrepareMap(gateway, environment.workspaceId, 'C03 丢失响应后的图')
  const node = map.nodes[0]
  if (!node) throw new Error(PreferencesCaseMessage.PREPARED_NODE_MISSING)
  const before = (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences
  const attempts: unknown[] = [], replies: unknown[] = []
  await workspaceLogin(page, webUrl, environment.token)

  const loseFirstReply = async (
    /* 原始浏览器命令；实际提交给同一隔离后端，只改变第一次成功回包的交付。 */ route: Route,
  ): Promise<void> => {
    // 保留原 POST 请求和认证，避免代理的额外传输成为本例故障来源。
    if (!preferencesIsSet(route.request())) { await route.continue(); return }
    attempts.push(route.request().postDataJSON())
    const response = await route.fetch({ url: new URL('/api/v1/command', environment.baseUrl).href })
    const reply: unknown = await response.json()
    replies.push(reply)
    expect(response.ok()).toBe(true)
    expect(reply).toMatchObject({ ok: true, replayed: attempts.length === 2 })
    if (attempts.length === 1) {
      const committed = (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences
      expect(committed).toMatchObject({ revision: before.revision + 1, currentMapId: map.mapId })
      await route.abort('connectionreset')
    } else {
      await route.fulfill({ response })
    }
  }

  await page.route('**/api/v1/command', loseFirstReply)
  try {
    await workspaceOpenMap(page, map.name)
    const sync = page.getByRole('status', { name: '视图设置同步', exact: true })
    await expect(sync).toContainText('视图设置尚未确认保存')
    const retry = sync.getByRole('button', { name: '重试同步', exact: true })
    await expect(retry).toBeEnabled()

    const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
    await scene.focus()
    await scene.press('ArrowRight')
    await expect(page.getByRole('region', { name: '数据详情', exact: true })
      .getByRole('group', { name: '正文', exact: true }).getByRole('textbox'))
      .toHaveValue('C03 偏好恢复期间仍能阅读的事实正文。')
    await retry.click()

    await expect.poll(async () => {
      // 独立读取正式偏好，页面乐观选择不作为保存成功的证据。
      return (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences
    }).toEqual({ workspaceId: environment.workspaceId, revision: before.revision + 2,
      openMapIds: [map.mapId], currentMapId: map.mapId, nodeSelection: { [map.mapId]: node.id } })
    await expect(retry).toBeHidden()
    expect(attempts).toHaveLength(3)
    expect(attempts[0]).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) })
    expect(attempts[1]).toEqual(attempts[0])
    expect(replies[1]).toMatchObject({ replayed: true, data: { revision: before.revision + 1 } })
    expect(replies[2]).toMatchObject({ replayed: false, data: { revision: before.revision + 2 } })
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await page.unroute('**/api/v1/command', loseFirstReply)
  }
})

test('M01-C03 另一客户端先保存偏好，页面真实冲突后保留本窗口选择', async (
  /* 独立真实环境、与页面同身份的核对客户端及正常工作台页面。 */
  { environment, gateway, page, webUrl },
) => {
  // 用同身份的独立客户端推进正式版本，再从页面选择保留当前窗口，整个过程不伪造响应。
  const serverMap = await preferencesPrepareMap(gateway, environment.workspaceId, 'C03 另一窗口的图')
  const localMap = await preferencesPrepareMap(gateway, environment.workspaceId, 'C03 本窗口的图')
  const before = (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences
  await workspaceLogin(page, webUrl, environment.token)
  let competingWrites = 0
  const commitOtherWindowFirst = async (
    /* 页面已经固定参数的真实偏好命令，仅在转发前安排另一个客户端提交。 */ route: Route,
  ): Promise<void> => {
    // 请求形成后才制造真实并发，避免订阅先刷新偏好而让本例没有冲突。
    if (!preferencesIsSet(route.request()) || competingWrites > 0) { await route.continue(); return }
    competingWrites++
    expect(route.request().postDataJSON()).toMatchObject({ params: { expectedRevision: before.revision } })
    await gateway.dispatch(randomUUID(), 'preferences.set', { workspaceId: environment.workspaceId,
      expectedRevision: before.revision, openMapIds: [serverMap.mapId], currentMapId: serverMap.mapId,
      nodeSelection: { [serverMap.mapId]: null } })
    const response = await route.fetch({ url: new URL('/api/v1/command', environment.baseUrl).href })
    expect(response.status()).toBe(409)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'REVISION_CONFLICT' } })
    await route.fulfill({ response })
  }

  await page.route('**/api/v1/command', commitOtherWindowFirst)
  try {
    await workspaceOpenMap(page, localMap.name)
    const sync = page.getByRole('status', { name: '视图设置同步', exact: true })
    await expect(sync).toContainText('视图设置已在其他窗口更新')
    const keepLocal = sync.getByRole('button', { name: '保留本窗口选择', exact: true })
    await expect(keepLocal).toBeEnabled()
    await keepLocal.click()

    await expect.poll(async () => {
      // 从真实服务核对最终版本和选择，确认没有采用另一个窗口的图。
      return (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences
    }).toEqual({ workspaceId: environment.workspaceId, revision: before.revision + 2,
      openMapIds: [localMap.mapId], currentMapId: localMap.mapId, nodeSelection: { [localMap.mapId]: null } })
    await expect(keepLocal).toBeHidden()
    await expect(page.locator('.view-label strong')).toHaveText(localMap.name)
    expect(competingWrites).toBe(1)
    expect((await gateway.read('map.get', { mapId: localMap.mapId })).nodes).toEqual(localMap.nodes)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    await page.unroute('**/api/v1/command', commitOtherWindowFirst)
  }
})

test('M04-C10 协作结果批准已提交但回包丢失，原请求确认不重复发布', async (
  /* 真实Host与协作后端，仅丢弃一次已提交成功回包，页面沿原意图恢复。 */ { environment, gateway, page, webUrl, storage },
) => {
  // 原请求确认必须沿用已展示预览版本和控制证明，不能在审核终态重新批准。
  test.skip(storage !== 'mongo', '协作审核原请求确认使用真实运行控制租约。')
  const map = await preferencesPrepareMap(gateway, environment.workspaceId, 'C10 批准丢失回包')
  const input = map.nodes[0]
  if (!input) throw new Error(PreferencesCaseMessage.PREPARED_NODE_MISSING)
  const branch = await gateway.read('branch.get', { mapId: map.mapId, rootIds: [input.id] })
  const claimed = await gateway.dispatch(randomUUID(), 'branch.claim', { mapId: map.mapId,
    rootIds: branch.scope.rootIds, holderId: randomUUID() })
  if (claimed.data.status !== 'claimed') throw new Error(PreferencesCaseMessage.REVIEW_BRANCH_BUSY)
  const runId = randomUUID()
  const started = await gateway.dispatch(randomUUID(), 'run.start', { mapId: map.mapId, id: runId,
    branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    lease: { leaseId: claimed.data.grant.leaseId, holderId: claimed.data.grant.holderId, fence: claimed.data.grant.fence },
    scope: { nodeIds: [input.id] }, mode: 'human-in-loop',
    plan: { steps: [{ id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [{ port: 'news', source: { kind: 'scope', nodeIds: [] } }], grouping: { mode: 'each' }, onEmpty: 'fail' }] },
  })
  if (started.data.runControl) await gateway.dispatch(randomUUID(), 'run.control.release', {
    mapId: map.mapId, runId, control: { leaseId: started.data.runControl.leaseId,
      holderId: started.data.runControl.holderId, fence: started.data.runControl.fence },
  })
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, map.name)
  const panel = page.getByRole('region', { name: '运行进度与审核', exact: true })
  await panel.getByRole('button', { name: '领取运行控制权', exact: true }).click()
  await panel.getByRole('button', { name: '批准执行计划', exact: true }).click()
  const approve = panel.getByRole('button', { name: '批准并发布结果', exact: true })
  await expect(approve).toBeEnabled()
  await expect(panel.getByRole('region', { name: '本次将发布', exact: true })).toContainText('4 项')
  const pending = await gateway.read('run.get', { mapId: map.mapId, runId })
  const operation = pending.operations.find(
    /* 当前真实Run中的步骤。 */ item => /* 仅取待批准的结果审核。 */ item.review?.kind === 'result' && item.review.state === 'pending',
  )
  if (!operation?.review) throw new Error(PreferencesCaseMessage.RESULT_REVIEW_MISSING)
  const preview = await gateway.read('run.publication.preview', { mapId: map.mapId, runId,
    operationId: operation.id, reviewId: operation.review.id, expectedReviewRevision: operation.review.revision })
  const attempts: unknown[] = []
  const loseCommittedApproval = async (
    /* 浏览器实际发出的公共命令，认证头与POST正文保持原样。 */ route: Route,
  ): Promise<void> => {
    // 只在真实review.answer已成功持久化后丢第一次交付；重试交付原收据。
    const request = route.request()
    const envelope: unknown = request.method() === 'POST' ? request.postDataJSON() : null
    if (envelope === null || typeof envelope !== 'object' || !('method' in envelope) || envelope.method !== 'review.answer') {
      await route.continue()
      return
    }
    attempts.push(envelope)
    expect(envelope).toMatchObject({ method: 'review.answer', params: { mapId: map.mapId, runId,
      operationId: operation.id, reviewId: operation.review?.id, expectedReviewRevision: operation.review?.revision,
      decision: 'approve', expectedPublicationVersion: preview.publicationVersion,
      control: { leaseId: expect.any(String), holderId: expect.any(String), fence: expect.any(Number) } } })
    const response = await route.fetch({ url: new URL('/api/v1/command', environment.baseUrl).href })
    expect(response.ok()).toBe(true)
    expect(await response.json()).toMatchObject({ ok: true, replayed: attempts.length === 2 })
    expect((await gateway.read('run.get', { mapId: map.mapId, runId })).status).toBe('completed')
    if (attempts.length === 1) await route.abort('connectionreset')
    else await route.fulfill({ response })
  }
  await page.route('**/api/v1/command', loseCommittedApproval)
  try {
    await approve.click()
    const retry = page.getByRole('button', { name: '重试同一操作', exact: true })
    await expect(retry).toBeEnabled()
    const confirmation = page.waitForResponse((
      /* 浏览器最终收到的真实公共命令响应，不把直接后端读取冒充页面确认。 */ response,
    ) => {
      // 重试开始就会隐藏按钮，必须等原请求成功收据实际送达页面后再结束测试。
      const request = response.request()
      if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/v1/command') return false
      const body: unknown = request.postDataJSON()
      return body !== null && typeof body === 'object' && 'method' in body && body.method === 'review.answer' && response.ok()
    })
    await retry.click()
    expect(await (await confirmation).json()).toMatchObject({ ok: true, replayed: true })
    await expect(retry).toBeHidden()
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i) })
    expect(attempts[1]).toEqual(attempts[0])
    const saved = await gateway.read('run.get', { mapId: map.mapId, runId })
    const outputs = saved.operations.find(
      /* 原请求已批准的真实步骤。 */ item => /* 与预览原审核精确对应。 */ item.id === operation.id,
    )?.outputRefs
    expect(outputs?.map(
      /* 后端只发布一次的正式候选引用。 */ ref => /* 忽略节点版本，只比较权威候选身份。 */ ({ workId: ref.workId, key: ref.key, port: ref.port }),
    )).toEqual(preview.items.map(
      /* 批准前独立读取的发布条目。 */ item => /* 使用相同稳定键独立核对完整集合。 */ ({ workId: item.workId, key: item.key, port: item.port }),
    ))
    expect((await gateway.read('map.get', { mapId: map.mapId })).nodes).toHaveLength(5)
    expect(environment.errors).toEqual([])
  } finally {
    await page.unroute('**/api/v1/command', loseCommittedApproval)
  }
})

test('M06-C13 定义包真实发布丢失响应后，页面以原内容和原编号确认且不重复写入', async (
  /* 实际提交的独立后端、页面以及仅改变成功回包交付的原网络拦截。 */ { environment, gateway, page, webUrl },
) => {
  // 管理发布在两种存储中均无租约差异，不把可复现的原请求恢复限定为协作模式。
  const before = await gateway.read('workspace.get', { workspaceId: environment.workspaceId })
  const packageItem: DefinitionPackage = { id: 'c13.confirmed-notes', version: 1, title: 'C13 原请求确认定义包',
    schemaDialect: 'http://json-schema.org/draft-07/schema#',
    dataTypes: [{ id: 'c13.confirmed-note', version: 1, title: 'C13 原请求确认笔记',
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      successorTypes: [], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] } }],
    transitions: [], dependencies: { packages: [], agents: [] } }
  await workspaceLogin(page, webUrl, environment.token)
  await page.getByRole('button', { name: '管理工作台', exact: true }).click()
  const management = page.getByRole('dialog', { name: '工作台管理', exact: true })
  await management.getByRole('button', { name: '定义中心', exact: true }).click()
  const center = management.getByRole('region', { name: '定义中心', exact: true })
  await center.getByRole('button', { name: '新建 JSON 草稿', exact: true }).click()
  const draft = center.getByRole('textbox', { name: '定义包 JSON', exact: true })
  await draft.fill(JSON.stringify(packageItem, null, 2))
  await center.getByRole('button', { name: '检查发布内容', exact: true }).click()
  const attempts: unknown[] = []
  const losePublishedReply = async (
    /* 浏览器原始发布命令，不改认证或正文，仅改变第一次交付。 */ route: Route,
  ): Promise<void> => {
    // 先把原请求交给真实服务，独立确认已提交，再丢一次响应。
    const request = route.request()
    const envelope: unknown = request.method() === 'POST' ? request.postDataJSON() : null
    if (envelope === null || typeof envelope !== 'object' || !('method' in envelope) || envelope.method !== 'definition.publish') {
      await route.continue()
      return
    }
    attempts.push(envelope)
    const response = await route.fetch({ url: new URL('/api/v1/command', environment.baseUrl).href })
    const reply: unknown = await response.json()
    expect(response.ok()).toBe(true)
    expect(reply).toMatchObject({ ok: true, replayed: attempts.length === 2, data: {
      workspaceId: environment.workspaceId, package: { ref: { id: packageItem.id, version: packageItem.version } },
    } })
    const committed = await gateway.read('definition.get', { workspaceId: environment.workspaceId,
      packageId: packageItem.id, packageVersion: packageItem.version })
    expect(committed.package).toEqual(packageItem)
    expect(committed.catalog.packages.filter(
      /* 独立读取的正式包目录。 */ item => /* 实际提交及原请求重放后都只有一条精确包身份。 */
        item.ref.id === packageItem.id && item.ref.version === packageItem.version,
    )).toHaveLength(1)
    if (attempts.length === 1) await route.abort('connectionreset')
    else await route.fulfill({ response })
  }
  await page.route('**/api/v1/command', losePublishedReply)
  try {
    const publish = center.getByRole('button', { name: '发布新版本', exact: true })
    await publish.click()
    const retry = center.getByRole('button', { name: '重试同一操作', exact: true })
    await expect(retry).toBeEnabled()
    await expect(draft).not.toBeEditable()
    await expect(publish).toBeDisabled()
    const confirmed = page.waitForResponse((
      /* 页面收到的真实公共命令响应，不以独立API读取代替交付。 */ response,
    ) => {
      // 只等待同一发布命令的成功收据，不要求其它工作区写入后的revision与首次回包相等。
      const request = response.request()
      if (request.method() !== 'POST' || new URL(response.url()).pathname !== '/api/v1/command') return false
      const envelope: unknown = request.postDataJSON()
      return envelope !== null && typeof envelope === 'object' && 'method' in envelope
        && envelope.method === 'definition.publish' && response.ok()
    })
    await retry.click()
    expect(await (await confirmed).json()).toMatchObject({ ok: true, replayed: true })
    const success = center.getByRole('status').filter({ hasText: '定义包已发布' })
    await expect(success).toBeVisible()
    await expect(retry).toBeHidden()
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i), method: 'definition.publish',
      params: { workspaceId: environment.workspaceId, expectedRevision: before.revision, package: packageItem } })
    expect(attempts[1]).toEqual(attempts[0])
    const saved = await gateway.read('definition.get', { workspaceId: environment.workspaceId,
      packageId: packageItem.id, packageVersion: packageItem.version })
    expect(saved.package).toEqual(packageItem)
    const savedPackage = saved.catalog.packages.find(
      /* 正式提交的精确包摘要。 */ item => /* 使用服务器目录摘要核对页面结果，不在浏览器重算。 */
        item.ref.id === packageItem.id && item.ref.version === packageItem.version,
    )
    if (!savedPackage) throw new Error(PreferencesCaseMessage.DEFINITION_PACKAGE_MISSING)
    expect(savedPackage.digest).toMatch(/^[0-9a-f]{64}$/)
    await expect(success).toContainText(savedPackage.digest)
    expect((await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).revision).toBe(before.revision + 1)
    expect(environment.modelCalls).toHaveLength(0)
    expect(environment.errors).toEqual([])
  } finally {
    await page.unroute('**/api/v1/command', losePublishedReply)
  }
})
