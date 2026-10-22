// 115几何先行：真实组件与浏览器投影，不访问Three私有对象，不使用真实供应商。
import type { Locator } from '@playwright/test'
import { expect, test } from './workspace-fixture'

async function projection(scene: Locator): Promise<Array<{ left: string; top: string }>> {
  return scene.locator('.scene-label').evaluateAll(elements => elements.map(element => ({
    left: (element as HTMLElement).style.left, top: (element as HTMLElement).style.top,
  })))
}
async function labelsFit(scene: Locator, count: number): Promise<void> {
  const labels = scene.locator('.scene-label')
  await expect(labels).toHaveCount(count)
  await expect.poll(() => labels.evaluateAll(elements => elements.every(element => {
    const container = element.closest('.graph-3d')!.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    return bounds.left >= container.left && bounds.top >= container.top
      && bounds.right <= container.right && bounds.bottom <= container.bottom
  }))).toBe(true)
}

test('L06 窄画布适应全部节点，选择活动与往返resize保持用户视角', async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-geometry.html`)
  const scene = page.locator('.graph-3d')
  await expect(scene.locator('canvas')).toBeVisible()
  await labelsFit(scene, 2)
  await page.getByRole('button', { name: '发布后继', exact: true }).click()
  await labelsFit(scene, 4)
  await scene.getByRole('button', { name: '缩小三维关系图', exact: true }).click()
  const adjusted = await projection(scene)
  await page.getByRole('button', { name: '选择节点', exact: true }).click()
  await expect(scene.locator('.scene-label.selected')).toHaveCount(1)
  expect(await projection(scene)).toEqual(adjusted)
  await page.getByRole('button', { name: '更新执行状态', exact: true }).click()
  await expect(scene.getByLabel('节点活动', { exact: true })).toHaveText('处理中')
  expect(await projection(scene)).toEqual(adjusted)
  await page.getByRole('button', { name: '宽画布', exact: true }).click()
  await expect(scene).toHaveCSS('width', '900px')
  await expect.poll(() => projection(scene)).not.toEqual(adjusted)
  await page.getByRole('button', { name: '窄画布', exact: true }).click()
  await expect.poll(() => projection(scene)).toEqual(adjusted)
})

test('L06 首次隐藏的画布显示时按实际尺寸取景', async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-geometry.html?hidden=1`)
  const scene = page.locator('.graph-3d')
  await expect(scene).toBeHidden()
  await page.getByRole('button', { name: '发布后继', exact: true }).click()
  await page.getByRole('button', { name: '显示画布', exact: true }).click()
  await labelsFit(scene, 4)
  const before = await projection(scene)
  await page.getByRole('button', { name: '隐藏画布', exact: true }).click()
  await page.getByRole('button', { name: '显示画布', exact: true }).click()
  await expect.poll(() => projection(scene)).toEqual(before)
})

test('L06 大坐标跨度能完整取景且仍可继续缩小', async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-geometry.html?large=1`)
  const scene = page.locator('.graph-3d')
  await expect(scene.locator('canvas')).toBeVisible()
  await labelsFit(scene, 2)
  const before = await projection(scene)
  await scene.getByRole('button', { name: '缩小三维关系图', exact: true }).click()
  await expect.poll(() => projection(scene)).not.toEqual(before)
  await labelsFit(scene, 2)
})

for (const method of ['滚轮', '按钮'] as const) test(`L07 SVG平移后${method}缩放保留锚点`, async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-geometry.html?mode=svg`)
  const canvas = page.locator('.graph-canvas')
  const card = canvas.locator('[data-node-id="node-0"] .node-card')
  const bounds = await canvas.boundingBox(), initial = await card.boundingBox()
  if (!bounds || !initial) throw new Error('Expected measurable SVG canvas and node')
  // 真实拖动把第一个节点中心移到容器中心，随后两种缩放都围绕同一可观察锚点。
  const dx = bounds.x + bounds.width / 2 - initial.x - initial.width / 2
  const dy = bounds.y + bounds.height / 2 - initial.y - initial.height / 2
  await page.mouse.move(bounds.x + 30, bounds.y + bounds.height - 35)
  await page.mouse.down()
  await page.mouse.move(bounds.x + 30 + dx, bounds.y + bounds.height - 35 + dy)
  await page.mouse.up()
  const panned = await card.boundingBox()
  if (!panned) throw new Error('Expected panned SVG node')
  const anchor = { x: panned.x + panned.width / 2, y: panned.y + panned.height / 2 }
  if (method === '滚轮') {
    await page.mouse.move(anchor.x, anchor.y)
    await page.keyboard.down('Control')
    await page.mouse.wheel(0, -120)
    await page.keyboard.up('Control')
  } else await canvas.getByRole('button', { name: '放大图画布', exact: true }).click()
  await expect(canvas.getByRole('button', { name: '重置缩放', exact: true })).not.toHaveText('100%')
  const zoomed = await card.boundingBox()
  if (!zoomed) throw new Error('Expected zoomed SVG node')
  expect(Math.abs(zoomed.x + zoomed.width / 2 - anchor.x)).toBeLessThan(1)
  expect(Math.abs(zoomed.y + zoomed.height / 2 - anchor.y)).toBeLessThan(1)
})

test('R02 SVG键盘移向远处节点只用自有平移，不滚动容器或工具栏', async ({ page, webUrl }) => {
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-geometry.html?mode=svg`)
  const canvas = page.locator('.graph-canvas')
  const toolbar = canvas.locator('.graph-toolbar')
  const before = await toolbar.boundingBox()
  await canvas.locator('[data-node-id="node-0"]').focus()
  for (let index = 1; index <= 4; index++) {
    await page.keyboard.press('ArrowRight')
    const target = canvas.locator(`[data-node-id="node-${index}"]`)
    await expect(target).toBeFocused()
    await expect(target).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(() => canvas.evaluate(element => ({ left: element.scrollLeft, top: element.scrollTop })))
      .toEqual({ left: 0, top: 0 })
    expect(await toolbar.boundingBox()).toEqual(before)
  }
  const target = canvas.locator('[data-node-id="node-4"]')
  const frame = await canvas.boundingBox(), selected = await target.boundingBox()
  if (!frame || !selected) throw new Error('Expected visible keyboard target')
  expect(selected.x).toBeGreaterThanOrEqual(frame.x)
  expect(selected.x + selected.width).toBeLessThanOrEqual(frame.x + frame.width)
})
