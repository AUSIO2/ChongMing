// 库画布布局回归：真实Mongo条目/关系/分页，只在网络边界暂扣成功回包。
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Locator, Page, Route } from '@playwright/test'
import type { ClientGateway } from '../../contracts/client'
import { test, expect, workspaceLogin } from './workspace-fixture'

const directory = path.resolve('test-results/115-canvas-layout-fixes/library')
type Bounds = Awaited<ReturnType<Locator['boundingBox']>>

async function prepareEntries(gateway: ClientGateway, workspaceId: string, count: number) {
  const workspace = await gateway.read('workspace.get', { workspaceId })
  const mapId = randomUUID(), ids = Array.from({ length: count }, () => randomUUID())
  await gateway.dispatch(randomUUID(), 'map.create', { workspaceId, expectedRevision: workspace.revision, id: mapId, name: '库画布布局回归' })
  const graph = (await gateway.dispatch(randomUUID(), 'graph.apply', { mapId,
    branch: { rootIds: ids, expectedVersion: null }, changes: { nodes: { put: ids.map((id, index) => ({
      id, typeId: 'factcheck.claim', typeVersion: 1, payload: { content: `固定库事实 ${index + 1}`, category: 'data' },
    })) } } })).data.snapshot
  for (const node of graph.nodes) await gateway.dispatch(randomUUID(), 'evidence.collect', { workspaceId,
    claim: { mapId, nodeId: node.id, revision: node.revision }, confidence: 1,
    applicability: { subject: null, event: null, time: null, place: null, conditions: [] }, reason: '布局回归', basisRefs: [] })
}

async function openLibrary(page: Page, webUrl: string, token: string) {
  await workspaceLogin(page, webUrl, token)
  await page.locator('.workspace-sidebar').getByRole('button', { name: /^证据库/ }).click()
  const library = page.getByRole('region', { name: '工作区证据库', exact: true })
  const scene = library.getByRole('group', { name: '证据库数据图，拖拽旋转、右键平移、滚轮缩放', exact: true })
  await expect(scene.locator('canvas')).toBeVisible()
  await expect(library.getByRole('button', { name: '检索', exact: true })).toBeEnabled()
  return { library, scene }
}

async function holdQuery(page: Page, baseUrl: string, method: string, cursorOnly = false) {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const handler = async (route: Route) => {
    const request = route.request().postDataJSON()
    if (request.method !== method || cursorOnly && !request.params.cursor) { await route.continue(); return }
    const response = await route.fetch({ url: new URL('/api/v1/query', baseUrl).href })
    await gate
    await route.fulfill({ response })
  }
  await page.route('**/api/v1/query', handler)
  return { release, async close() { release(); await page.unrouteAll({ behavior: 'wait' }) } }
}

async function record(name: string, values: unknown) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await writeFile(path.join(directory, name + '.json'), JSON.stringify(values, null, 2), { mode: 0o600 })
}

test('M03-C07 库关系加载与清选择不挤动画布，失败重试仍可操作', async ({ environment, gateway, page, webUrl, storage }) => {
  test.skip(storage !== 'mongo', '证据库使用真实Mongo服务。')
  await prepareEntries(gateway, environment.workspaceId, 1)
  const { library, scene } = await openLibrary(page, webUrl, environment.token)
  await expect(library.locator('.loaded-status')).toContainText('已加载 1 条')
  const before = await scene.boundingBox(), originalCanvas = await scene.locator('canvas').elementHandle()
  const held = await holdQuery(page, environment.baseUrl, 'evidence.relations')
  try {
    await scene.focus()
    await scene.press('ArrowRight')
    await expect(library.locator('.relations-status')).toContainText('正在读取')
    await record('relations-loading', { before, during: await scene.boundingBox() })
    expect(await scene.boundingBox()).toEqual(before)
    held.release()
    await expect(library.locator('.relations-status')).toContainText('已保存')
    expect(await scene.boundingBox()).toEqual(before)
    await scene.focus()
    await scene.press('Escape')
    await expect(library.locator('.scene-selection')).toBeHidden()
    expect(await scene.boundingBox()).toEqual(before)
    expect(await originalCanvas?.evaluate(element => element.isConnected && element === document.querySelector('.evidence-library .scene-host canvas'))).toBe(true)
  } finally { await held.close(); await originalCanvas?.dispose() }

  let failOnce = true
  await page.route('**/api/v1/query', async route => {
    if (route.request().postDataJSON().method === 'evidence.relations' && failOnce) {
      failOnce = false
      await route.abort('connectionreset')
    } else await route.continue()
  })
  try {
    await scene.focus()
    await scene.press('ArrowRight')
    const retry = library.getByRole('button', { name: '重新读取关系', exact: true })
    await expect(retry).toBeVisible()
    expect(await scene.boundingBox()).toEqual(before)
    await retry.click()
    await expect(library.locator('.relations-status')).toContainText('已保存')
    expect(await scene.boundingBox()).toEqual(before)
    expect(environment.modelCalls).toHaveLength(0)
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})

test('M03-C07 库检索在临界宽度与短窄窗口中保持画布尺寸', async ({ environment, gateway, page, webUrl, storage }) => {
  test.skip(storage !== 'mongo', '证据库使用真实Mongo服务。')
  await prepareEntries(gateway, environment.workspaceId, 1)
  const { library, scene } = await openLibrary(page, webUrl, environment.token)
  await expect(library.locator('.loaded-status')).toContainText('已加载 1 条')
  const measurements: Array<{ viewport: { width: number; height: number }; before: Bounds; during: Bounds }> = []
  for (const viewport of [{ width: 1220, height: 700 }, { width: 1230, height: 700 }, { width: 650, height: 480 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(viewport)
    const before = await scene.boundingBox()
    expect(before?.height).toBeGreaterThan(0)
    const held = await holdQuery(page, environment.baseUrl, 'evidence.search')
    try {
      await library.getByRole('button', { name: '检索', exact: true }).click()
      await expect(library.getByRole('button', { name: '检索中…', exact: true })).toBeVisible()
      const during = await scene.boundingBox()
      measurements.push({ viewport, before, during })
      await record('search-measurements', measurements)
      expect(during).toEqual(before)
      held.release()
      await expect(library.getByRole('button', { name: '检索', exact: true })).toBeEnabled()
      expect(await scene.boundingBox()).toEqual(before)
    } finally { await held.close() }
  }
  let failOnce = true
  await page.route('**/api/v1/query', async route => {
    if (route.request().postDataJSON().method === 'evidence.search' && failOnce) { failOnce = false; await route.abort('connectionreset') }
    else await route.continue()
  })
  try {
    const before = await scene.boundingBox()
    await library.getByRole('button', { name: '检索', exact: true }).click()
    const retry = library.getByRole('button', { name: '重试同一操作', exact: true })
    await expect(retry).toBeVisible()
    expect(await scene.boundingBox()).toEqual(before)
    // 错误提示不能盖住筛选输入；仍可编辑草稿，重试继续使用原读取身份。
    const keyword = library.getByRole('searchbox', { name: '关键词', exact: true })
    await keyword.click({ timeout: 2000 })
    await keyword.fill('固定库事实')
    await retry.click()
    await expect(library.locator('.error-bar')).toBeHidden()
    expect(await scene.boundingBox()).toEqual(before)
    expect(environment.modelCalls).toHaveLength(0)
  } finally { await page.unrouteAll({ behavior: 'wait' }) }
})

test('M03-C07 库真实25加1分页在短窄窗口中不改变底栏与画布高度', async ({ environment, gateway, page, webUrl, storage }) => {
  test.skip(storage !== 'mongo', '证据库使用真实Mongo服务。')
  await prepareEntries(gateway, environment.workspaceId, 26)
  const { library, scene } = await openLibrary(page, webUrl, environment.token)
  const measurements: unknown[] = []
  for (const viewport of [{ width: 650, height: 480 }, { width: 390, height: 480 }]) {
    await page.setViewportSize(viewport)
    await library.getByRole('button', { name: '检索', exact: true }).click()
    await expect(library.locator('.loaded-status')).toContainText('已加载 25 条')
    const before = await scene.boundingBox(), footerBefore = await library.locator('.loaded-status').boundingBox()
    expect(before?.height).toBeGreaterThan(0)
    const held = await holdQuery(page, environment.baseUrl, 'evidence.search', true)
    try {
      await library.getByRole('button', { name: '加载更多', exact: true }).click()
      await expect(library.getByRole('button', { name: '读取中…', exact: true })).toBeVisible()
      expect(await scene.boundingBox()).toEqual(before)
      expect(await library.locator('.loaded-status').boundingBox()).toEqual(footerBefore)
      held.release()
      await expect(library.locator('.loaded-status')).toContainText('已加载 26 条')
      await expect(library.locator('.loaded-status')).toContainText('本次检索已加载完毕')
      const after = await scene.boundingBox(), footerAfter = await library.locator('.loaded-status').boundingBox()
      measurements.push({ viewport, before, after, footerBefore, footerAfter })
      await record('pagination-measurements', measurements)
      expect(after).toEqual(before)
      expect(footerAfter).toEqual(footerBefore)
      expect(await page.locator('html').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true)
    } finally { await held.close() }
  }
  const saved = await gateway.read('evidence.search', { workspaceId: environment.workspaceId, limit: 100 })
  expect(saved.items).toHaveLength(26)
  expect(environment.modelCalls).toHaveLength(0)
})
