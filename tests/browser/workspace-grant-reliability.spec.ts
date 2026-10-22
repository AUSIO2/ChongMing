// CS-04 真实授权回归：旧原始 SSE 帧不能撤销新确认，较新真实释放仍应停止编辑并保留草稿。
import { randomUUID } from 'node:crypto'
import type { Locator, Page, Response } from '@playwright/test'
import type { ClientGateway } from '../../contracts/client'
import type { GraphCommand, GraphSnapshot, GraphSuccess, GraphWriteResult } from '../../contracts/graph-api'
import type { GraphBranchClaimResult, GraphBranchGrant } from '../../contracts/graph-branch'
import { test, expect, workspaceLogin, workspaceOpenMap } from './workspace-fixture'
import { grantCreateFrameRelay, grantObserveBrowserFrames } from './workspace-grant-relay'

enum GrantCaseError {
  NODE_MISSING = '授权可靠性用例没有原始节点。',
  CLAIM_FAILED = '授权可靠性用例没有取得真实编辑授权。',
  WRONG_COMMAND = '授权可靠性用例没有捕获预期的真实页面命令。',
}

/** 只为授权时序准备一个采用现有精确类型的真实节点。 */
async function grantPrepareMap(
  /* 对本轮工作区有真实 owner 权限的独立公共网关。 */ gateway: ClientGateway,
  /* 当前隔离环境的真实工作区。 */ workspaceId: string,
): Promise<GraphSnapshot> {
  // 通过真实公共命令准备单节点图，实际编辑与保存仍全部留给页面。
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const created = await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision,
    id: randomUUID(), name: '授权快照可靠性' })
  const rootId = randomUUID()
  return (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: created.data.snapshot.mapId,
    branch: { rootIds: [rootId], expectedVersion: null }, changes: { nodes: { put: [{ id: rootId,
      typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '原始授权材料，等待真实界面编辑。', category: 'data' } }] } },
  })).data.snapshot
}

/** 将所有正文、草稿与按钮断言限定在实际数据详情面板。 */
function grantInspector(/* 当前正常登录的真实页面。 */ page: Page): Locator {
  // 将定位限制到用户可见的数据详情区域，避免其他场景中的同名控件。
  return page.getByRole('region', { name: '数据详情', exact: true })
}

/** 从公开中文字段组取得真实正文输入框。 */
function grantContent(/* 当前已选择唯一节点的真实页面。 */ page: Page): Locator {
  // 使用公开中文字段语义定位正文，不访问组件内部草稿。
  return grantInspector(page).getByRole('group', { name: '正文', exact: true }).getByRole('textbox')
}

/** 只匹配真实浏览器发出的指定公共命令响应，不输出原始请求。 */
function grantMatchesCommand(
  /* 真实浏览器已经收到的 HTTP 响应。 */ response: Response,
  /* 本例需要观察的固定公共命令名。 */ method: 'branch.claim' | 'graph.apply',
): boolean {
  // 只把指定命令端点与方法的真实响应作为本轮观察对象。
  if (new URL(response.url()).pathname !== '/api/v1/command') return false
  try { return (response.request().postDataJSON() as { method?: unknown }).method === method }
  catch { return false }
}

/** 以正常画布键盘选择该图唯一节点，不注入私有选择状态。 */
async function grantSelectNode(/* 已打开真实单节点图的浏览器页面。 */ page: Page): Promise<void> {
  // 用正常键盘交互选中唯一节点，并等待实际正文控件出现。
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await scene.focus(); await scene.press('Escape'); await scene.press('ArrowRight')
  await expect(grantContent(page)).toBeVisible()
}

/** 协作项目通过真实按钮领取；本机 none 明确验证没有编辑租约入口。 */
async function grantClaimFromPage(
  /* 已选中真实节点的正常页面。 */ page: Page,
  /* bootstrap 声明的实际客户端租约策略。 */ required: boolean,
): Promise<GraphBranchGrant | null> {
  // 按服务声明的策略从界面取得编辑权，本机策略保持无租约命令。
  if (!required) {
    await expect(grantInspector(page).getByRole('button', { name: /领取分支编辑权/ })).toHaveCount(0)
    await expect(grantContent(page)).toBeEditable()
    return null
  }
  const returned = page.waitForResponse((/* 只等本轮真实 claim 响应。 */ response) => grantMatchesCommand(response, 'branch.claim'))
  await grantInspector(page).getByRole('button', { name: /^(?:尝试)?领取分支编辑权$/ }).click()
  const response = await returned
  const result = await response.json() as GraphSuccess<GraphBranchClaimResult>
  expect(response.status()).toBe(200); expect(result.ok).toBe(true)
  if (result.data.status !== 'claimed') throw new Error(GrantCaseError.CLAIM_FAILED)
  await expect(grantInspector(page).getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
  await expect(grantContent(page)).toBeEditable()
  return result.data.grant
}

/** 实际 UI 保存，核对真实 wire 参数与独立服务端事实，不把“未保存”消失当作提交证明。 */
async function grantSaveFromPage(
  /* 持有本轮草稿和合法授权的正常页面。 */ page: Page,
  /* 独立公共核对客户端，不借用页面 store。 */ gateway: ClientGateway,
  /* 准备时记录的真实原图与节点版本。 */ original: GraphSnapshot,
  /* 已经由真实表单填入的完整草稿。 */ content: string,
  /* 协作项目真实 claim 响应；本机 none 为 null。 */ grant: GraphBranchGrant | null,
): Promise<GraphWriteResult> {
  // 捕获本次真实写入并核对 wire 参数和独立后端读取，避免乐观界面假通过。
  const node = original.nodes[0]
  if (!node) throw new Error(GrantCaseError.NODE_MISSING)
  await expect(grantInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeEnabled()
  const returned = page.waitForResponse((/* 只等本轮真实 graph.apply 响应。 */ response) => grantMatchesCommand(response, 'graph.apply'))
  await grantInspector(page).getByRole('button', { name: '保存数据', exact: true }).click()
  const response = await returned
  const command = response.request().postDataJSON() as GraphCommand
  if (command.method !== 'graph.apply') throw new Error(GrantCaseError.WRONG_COMMAND)
  expect(command.params.mapId).toBe(original.mapId)
  if (grant) expect(command.params.lease).toEqual({ leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence })
  else expect(command.params.lease).toBeUndefined()
  const result = await response.json() as GraphSuccess<GraphWriteResult>
  expect(response.status()).toBe(200); expect(result.ok).toBe(true)
  await expect(grantInspector(page).getByText('未保存', { exact: true })).toHaveCount(0)
  const confirmed = await gateway.read('map.get', { mapId: original.mapId })
  expect(confirmed.nodes).toHaveLength(1)
  expect(confirmed.nodes[0]).toMatchObject({ id: node.id, revision: node.revision + 1, typeId: node.typeId,
    typeVersion: node.typeVersion, payload: { ...node.payload, content } })
  return result.data
}

test('M00-R01 CS-04 真实旧占用原帧不能清掉新授权，原草稿仍可经界面保存', async (
  /* 正常页面、真实公共网关和独立后端，两个存储项目均不跳过。 */ { page, gateway, environment, webUrl },
) => {
  // 同一 R 的旧 O0 帧先生成、后交付；claim 新帧始终扣住，不靠新快照掩盖授权丢失。
  const original = await grantPrepareMap(gateway, environment.workspaceId)
  const node = original.nodes[0]
  if (!node) throw new Error(GrantCaseError.NODE_MISSING)
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const relay = await grantCreateFrameRelay(webUrl, original.mapId)
  const observer = await grantObserveBrowserFrames(page, relay.eventsPath)
  try {
    await workspaceLogin(page, relay.origin, environment.token)
    await workspaceOpenMap(page, original.name)
    const old = await relay.waitForSnapshot((/* 必须是领取之前产生的原始完整快照。 */ frame) => frame.revision === original.revision && frame.ownershipRevision === original.ownershipRevision)
    await grantSelectNode(page)
    const grant = await grantClaimFromPage(page, required)
    const draft = 'CS-04 原始草稿：旧帧交付以后仍应完整保存。'
    await grantContent(page).fill(draft)
    await expect(grantContent(page)).toHaveValue(draft)
    await expect(grantInspector(page).getByText('未保存', { exact: true })).toBeVisible()
    const authoritative = await gateway.read('map.get', { mapId: original.mapId })
    expect(authoritative.revision).toBe(original.revision)
    if (grant) {
      expect(grant.ownershipRevision).toBeGreaterThan(old.ownershipRevision)
      expect(authoritative.ownerships.some((/* 独立 API 中的真实有效占用。 */ ownership) => ownership.leaseId === grant.leaseId && ownership.fence === grant.fence)).toBe(true)
    } else expect(authoritative.ownerships).toHaveLength(0)
    await relay.releaseThrough(old)
    await observer.waitForProcessed(old)
    await expect(grantContent(page)).toHaveValue(draft)
    await expect(grantContent(page)).toBeEditable()
    if (grant) await expect(grantInspector(page).getByRole('button', { name: '释放分支编辑权', exact: true })).toBeVisible()
    await grantSaveFromPage(page, gateway, original, draft, grant)
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    observer.dispose()
    try { await page.close() } finally { await relay.close() }
  }
})

test('M00-R01 CS-04 较新真实释放帧仍撤销授权并保留草稿，本机正常新帧不撤编辑', async (
  /* 每例独立的真实页面、公共授权服务和两个实际存储项目。 */ { page, gateway, environment, webUrl },
) => {
  // 反例另建 fresh 单节点图，避免旧帧失败或保存后证明刷新窗口掩盖真实撤权断言。
  const original = await grantPrepareMap(gateway, environment.workspaceId)
  const node = original.nodes[0]
  if (!node) throw new Error(GrantCaseError.NODE_MISSING)
  const required = (await gateway.read('app.bootstrap', {})).metadata.clientLeases !== 'none'
  const relay = await grantCreateFrameRelay(webUrl, original.mapId)
  const observer = await grantObserveBrowserFrames(page, relay.eventsPath)
  let renewalRejected = 0
  const observeRenewal = (/* 只观察真实续租响应是否在撤权帧前构成了其他失权原因。 */ response: Response): void => {
    // 只计数先于目标帧的续租拒绝，不读取或输出响应正文。
    try {
      if (new URL(response.url()).pathname === '/api/v1/command'
        && (response.request().postDataJSON() as { method?: unknown }).method === 'branch.renew' && !response.ok()) renewalRejected++
    } catch { /* 非命令响应没有续租语义，不读取正文。 */ }
  }
  page.on('response', observeRenewal)
  try {
    await workspaceLogin(page, relay.origin, environment.token)
    await workspaceOpenMap(page, original.name)
    const initial = await relay.waitForSnapshot((/* 领取之前真实产生的初始快照。 */ frame) => frame.revision === original.revision && frame.ownershipRevision === original.ownershipRevision)
    await relay.releaseThrough(initial); await observer.waitForProcessed(initial)
    await grantSelectNode(page)
    const grant = await grantClaimFromPage(page, required)
    if (grant) {
      const granted = await relay.waitForSnapshot((/* 真实后端已公布该 claim 的占用版本。 */ frame) => frame.connection === initial.connection && frame.ownershipRevision >= grant.ownershipRevision)
      await relay.releaseThrough(granted); await observer.waitForProcessed(granted)
      await expect(grantContent(page)).toBeEditable()
    }
    const draft = 'CS-04 尚未保存草稿：真实失权后必须保留。'
    await grantContent(page).fill(draft)
    await expect(grantInspector(page).getByText('未保存', { exact: true })).toBeVisible()
    if (grant) {
      const release = await gateway.dispatch(randomUUID(), 'branch.release', { mapId: original.mapId,
        lease: { leaseId: grant.leaseId, holderId: grant.holderId, fence: grant.fence } })
      expect(release.data.released).toBe(true)
      const revoked = await relay.waitForSnapshot((/* 必须来自同一真实连接且达到实际释放提交版本。 */ frame) => frame.connection === initial.connection && frame.ownershipRevision >= release.data.ownershipRevision)
      await expect(grantContent(page)).toBeEditable()
      await relay.releaseThrough(revoked); await observer.waitForProcessed(revoked)
      await expect(grantContent(page)).toBeDisabled()
      await expect(grantInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeDisabled()
      expect(renewalRejected).toBe(0)
      const confirmed = await gateway.read('map.get', { mapId: original.mapId })
      expect(confirmed.ownerships.some((/* 独立读取中已被合法释放的原租约。 */ ownership) => ownership.leaseId === grant.leaseId)).toBe(false)
      expect(confirmed.nodes).toEqual(original.nodes)
    } else {
      const branch = await gateway.read('branch.get', { mapId: original.mapId, rootIds: [node.id] })
      const renamed = await gateway.dispatch(randomUUID(), 'graph.apply', { mapId: original.mapId,
        branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version }, changes: { name: '本机新快照对照' } })
      const fresh = await relay.waitForSnapshot((/* 本机 none 下来自后端的真实新内容快照。 */ frame) => frame.connection === initial.connection && frame.revision === renamed.data.snapshot.revision)
      await relay.releaseThrough(fresh); await observer.waitForProcessed(fresh)
      await expect(grantContent(page)).toBeEditable()
      await expect(grantInspector(page).getByRole('button', { name: '保存数据', exact: true })).toBeEnabled()
      await expect(grantInspector(page).getByRole('button', { name: /领取分支编辑权/ })).toHaveCount(0)
      expect(renamed.data.snapshot.nodes).toEqual(original.nodes)
    }
    await expect(grantContent(page)).toHaveValue(draft)
    await expect(grantInspector(page).getByText('未保存', { exact: true })).toBeVisible()
    expect(environment.modelCalls).toHaveLength(0)
  } finally {
    page.off('response', observeRenewal); observer.dispose()
    try { await page.close() } finally { await relay.close() }
  }
})
