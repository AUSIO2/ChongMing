// 普通选择和状态反馈不能增减画布空间；真实后端与可观察页面几何共同验收。
import { randomUUID } from 'node:crypto'
import type { ClientGateway } from '../../contracts/client'
import { test, expect, workspaceLogin, workspaceOpenMap } from './workspace-fixture'

async function prepare(gateway: ClientGateway, workspaceId: string) {
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const mapId = randomUUID(), nodeIds = [randomUUID(), randomUUID(), randomUUID()]
  await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision, id: mapId, name: '工作区稳定布局' })
  await gateway.dispatch(randomUUID(), 'graph.apply', { mapId, branch: { rootIds: nodeIds, expectedVersion: null }, changes: { nodes: { put: [
    { id: nodeIds[0], typeId: 'factcheck.news', typeVersion: 1, payload: { content: '新闻正文', context: {} } },
    { id: nodeIds[1], typeId: 'factcheck.claim', typeVersion: 1, payload: { content: '事实正文', category: 'data' } },
    { id: nodeIds[2], typeId: 'factcheck.opinion', typeVersion: 1, payload: { score: 1, reason: '人工意见', evidenceClaimIds: [] } },
  ] } } })
  return mapId
}

test('M01-C03 工具栏在节点类型和窗口宽度变化后保持单行且操作可达', async ({ environment, gateway, page, webUrl }) => {
  await prepare(gateway, environment.workspaceId)
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, '工作区稳定布局')
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await expect(scene.locator('canvas')).toBeVisible()
  const toolbar = page.locator('.view-toolbar')
  for (const width of [1280, 1000, 390]) {
    await page.setViewportSize({ width, height: 900 })
    // 先让窗口resize与宿主ResizeObserver完成布局，随后才比较普通选点产生的变化。
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const before = await scene.boundingBox(), toolbarBefore = await toolbar.boundingBox()
    const selectedTypes: string[] = []
    for (let selection = 0; selection < 3; selection++) {
      await scene.focus()
      await scene.press('ArrowRight')
      selectedTypes.push(await page.locator('.workspace-views .scene-selection small').innerText())
      expect(await scene.boundingBox()).toEqual(before)
      expect(await toolbar.boundingBox()).toEqual(toolbarBefore)
    }
    expect(selectedTypes.some(value => value.includes('事实'))).toBe(true)
    const refresh = page.getByRole('button', { name: '刷新', exact: true })
    await refresh.focus()
    const bounds = await refresh.boundingBox(), container = await toolbar.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(container!.x)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(container!.x + container!.width + 1)
    expect(bounds!.height).toBeLessThanOrEqual(36)
    await refresh.press('Enter')
    await expect(refresh).toBeEnabled()
    await expect(scene.locator('canvas')).toBeVisible()
    expect(await scene.boundingBox()).toEqual(before)
  }
  expect(environment.modelCalls).toHaveLength(0)
})

test('M01-C03 未确认偏好提示和重试不改变画布，提示操作仍可见', async ({ environment, gateway, page, webUrl }) => {
  const mapId = await prepare(gateway, environment.workspaceId)
  await workspaceLogin(page, webUrl, environment.token)
  await workspaceOpenMap(page, '工作区稳定布局')
  await expect.poll(async () => (await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences.currentMapId).toBe(mapId)
  const sync = page.getByRole('status', { name: '视图设置同步', exact: true })
  await expect(sync).toBeHidden()
  const scene = page.getByRole('group', { name: '三维关系图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await expect(scene.locator('canvas')).toBeVisible()
  const before = await scene.boundingBox()
  let dropped = false
  await page.route('**/api/v1/command', async route => {
    if (route.request().postDataJSON().method !== 'preferences.set' || dropped) { await route.continue(); return }
    dropped = true
    const response = await route.fetch({ url: new URL('/api/v1/command', environment.baseUrl).href })
    expect(response.ok()).toBe(true)
    await route.abort('connectionreset')
  })
  try {
    await scene.focus()
    await scene.press('ArrowRight')
    await expect(sync).toContainText('视图设置尚未确认保存')
    expect(await scene.boundingBox()).toEqual(before)
    const retry = sync.getByRole('button', { name: '重试同步', exact: true })
    await expect(retry).toBeInViewport()
    await page.getByRole('navigation', { name: '打开的数据图', exact: true }).getByRole('button', { name: '工作区稳定布局', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 900 })
    await expect(page.getByRole('navigation', { name: '展开侧栏', exact: true })).toBeVisible()
    const workspaceToggle = page.getByRole('navigation', { name: '展开侧栏', exact: true }).getByRole('button', { name: '工作区', exact: true })
    await workspaceToggle.click()
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'true')
    await workspaceToggle.click()
    await expect(workspaceToggle).toHaveAttribute('aria-expanded', 'false')
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    await retry.click()
    await expect(sync).toBeHidden()
    expect(await scene.boundingBox()).toEqual(before)
    expect((await gateway.read('workspace.get', { workspaceId: environment.workspaceId })).preferences.nodeSelection[mapId]).not.toBeNull()
    expect(environment.modelCalls).toHaveLength(0)
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})
