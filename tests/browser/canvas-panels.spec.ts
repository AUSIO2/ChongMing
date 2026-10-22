// 115先行：真实AppShell、浏览器尺寸和鼠标验证侧栏预算，不读取Vue私有状态或用户数据。
import type { Locator, Page } from '@playwright/test'
import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test } from './workspace-fixture'

const widthsKey = 'chongming.panelWidths'

async function bounds(locator: Locator) {
  const value = await locator.boundingBox()
  if (!value) throw new Error('Expected visible panel bounds')
  return value
}
async function drag(page: Page, side: 'left' | 'right', delta: number) {
  const box = await bounds(page.locator(`.split.${side}`))
  const x = box.x + box.width / 2, y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + delta, y, { steps: 3 })
  await page.mouse.up()
}
async function panelGeometry(page: Page) {
  // 一次DOM任务采齐全部几何，避免多次RPC混合ResizeObserver更新前后的两帧。
  return page.locator('#shell-host').evaluate(host => {
    const rect = (element: Element) => {
      const b = element.getBoundingClientRect()
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    }
    const child = (selector: string) => {
      const element = host.querySelector(selector)
      if (!element) throw new Error('Panel geometry target is missing')
      return rect(element)
    }
    return { host: rect(host), center: child('.workspace-col-center'), right: child('.workspace-right-panel'), canvas: child('#panel-canvas') }
  })
}
async function expectContained(page: Page, phase = 'geometry') {
  const samples: Awaited<ReturnType<typeof panelGeometry>>[] = []
  try {
    await expect(async () => {
      const { host, center, right, canvas } = await panelGeometry(page)
      samples.push({ host, center, right, canvas })
      expect(center.width).toBeGreaterThanOrEqual(199)
      expect(center.x + center.width).toBeLessThanOrEqual(right.x + 1)
      expect(right.x + right.width).toBeLessThanOrEqual(host.x + host.width + 1)
      expect(canvas.x).toBeGreaterThanOrEqual(center.x - 1)
      expect(canvas.x + canvas.width).toBeLessThanOrEqual(center.x + center.width + 1)
    }).toPass({ timeout: 10_000, intervals: [20, 50, 100] })
  } finally {
    // 工件只记录公开bbox，不记录页面内容、网络请求或凭据。
    const directory = 'test-results/115-canvas-layout-fixes/panels/measurements'
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const variant = process.env.CANVAS_PANEL_BASELINE === '1' ? 'baseline' : 'current'
    await writeFile(`${directory}/${variant}-${test.info().project.name}-${phase}.json`, JSON.stringify(samples, null, 2) + '\n', { mode: 0o600 })
  }
}

test('L02 侧栏共同使用实际宿主预算，缩窄与单页不改写用户宽度偏好', async ({ page, webUrl }) => {
  await page.addInitScript(() => localStorage.setItem('chongming.panelWidths', JSON.stringify({ left: 400, right: 520 })))
  const variant = process.env.CANVAS_PANEL_BASELINE === '1' ? '?baseline=1' : ''
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-panels.html${variant}`)
  const left = page.locator('.workspace-col-left'), right = page.locator('.panel-right')
  await expect.poll(async () => (await bounds(left)).width).toBe(400)
  await expect.poll(async () => (await bounds(right)).width).toBe(520)
  const preferred = await page.evaluate(key => localStorage.getItem(key), widthsKey)
  await page.getByRole('button', { name: '宿主1000', exact: true }).click()
  await expect.poll(async () => (await bounds(page.locator('#shell-host'))).width).toBe(1000)
  await expectContained(page, 'host-1000')
  const withRight = await bounds(page.locator('#panel-canvas'))
  await page.getByRole('button', { name: '切换右栏', exact: true }).click()
  await expect(page.locator('.workspace-right-panel')).toBeHidden()
  expect((await bounds(page.locator('#panel-canvas'))).width).toBeGreaterThan(withRight.width)
  await page.getByRole('button', { name: '切换右栏', exact: true }).click()
  await expectContained(page, 'restored-right')
  await page.getByRole('button', { name: '宿主铺满', exact: true }).click()
  await expect.poll(async () => (await bounds(left)).width).toBe(400)
  await expect.poll(async () => (await bounds(right)).width).toBe(520)
  expect(await page.evaluate(key => localStorage.getItem(key), widthsKey)).toBe(preferred)
})

test('L03 800px窗口中的可见分隔条确实调整左右宽度', async ({ page, webUrl }) => {
  await page.setViewportSize({ width: 800, height: 720 })
  await page.addInitScript(() => localStorage.clear())
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-panels.html`)
  const left = page.locator('.workspace-col-left'), right = page.locator('.panel-right')
  const originalLeft = (await bounds(left)).width
  await drag(page, 'left', 30)
  await expect.poll(async () => (await bounds(left)).width).toBeCloseTo(originalLeft + 30, 0)
  const originalRight = (await bounds(right)).width
  await drag(page, 'right', 20)
  await expect.poll(async () => (await bounds(right)).width).toBeCloseTo(originalRight - 20, 0)
  await expectContained(page)
})

test('L02 650px侧栏覆盖画布，开关与隐藏右栏不改变画布边界', async ({ page, webUrl }) => {
  await page.setViewportSize({ width: 650, height: 720 })
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-panels.html`)
  const canvas = page.locator('#panel-canvas')
  await expect(page.getByRole('navigation', { name: '展开侧栏', exact: true })).toBeVisible()
  const original = await bounds(canvas)
  await page.getByRole('button', { name: '工作区', exact: true }).click()
  await expect(page.locator('.workspace-col-left')).toBeVisible()
  expect(await bounds(canvas)).toEqual(original)
  await page.getByRole('button', { name: '关闭侧栏', exact: true }).click({ position: { x: 600, y: 200 } })
  await page.getByRole('button', { name: '节点详情', exact: true }).click()
  await expect(page.locator('.workspace-right-panel')).toBeVisible()
  expect(await bounds(canvas)).toEqual(original)
  await page.getByRole('button', { name: '切换右栏', exact: true }).click()
  await expect(page.locator('.workspace-right-panel')).toBeHidden()
  expect(await bounds(canvas)).toEqual(original)
})

test('R01 窗口失焦取消拖动，返回后普通移动不再调整宽度', async ({ page, webUrl }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-panels.html`)
  try {
    const split = await bounds(page.locator('.split.left'))
    await page.mouse.move(split.x + 2, split.y + split.height / 2)
    await page.mouse.down()
    await page.mouse.move(split.x + 22, split.y + split.height / 2)
    const stopped = await bounds(page.locator('.workspace-col-left'))
    // Headless标签页不保证原生失焦；在浏览器事件边界交付OS失焦信号，不读写组件状态。
    await page.evaluate(() => window.dispatchEvent(new Event('blur')))
    await expect.poll(() => page.locator('body').evaluate(body => body.style.userSelect)).toBe('')
    await page.mouse.up()
    await page.mouse.move(split.x + 120, split.y + split.height / 2)
    expect(await bounds(page.locator('.workspace-col-left'))).toEqual(stopped)
    expect(await page.evaluate(key => localStorage.getItem(key), widthsKey)).toBeNull()
  } finally {
    await page.mouse.up()
  }
})

test('R01 遗漏mouseup后收到主键已释放的移动，也结束拖动且不保存', async ({ page, webUrl }) => {
  await page.addInitScript(() => localStorage.clear())
  await page.goto(`${webUrl}/tests/browser/fixtures/canvas-panels.html`)
  const split = await bounds(page.locator('.split.left'))
  try {
    await page.mouse.move(split.x + 2, split.y + split.height / 2)
    await page.mouse.down()
    const original = await bounds(page.locator('.workspace-col-left'))
    // 模拟鼠标在窗口外松开，回到页面时浏览器只交付buttons=0的普通移动。
    await page.evaluate(x => window.dispatchEvent(new MouseEvent('mousemove', { clientX: x, buttons: 0 })), split.x + 120)
    expect(await bounds(page.locator('.workspace-col-left'))).toEqual(original)
    expect(await page.locator('body').evaluate(body => body.style.userSelect)).toBe('')
    expect(await page.evaluate(key => localStorage.getItem(key), widthsKey)).toBeNull()
  } finally { await page.mouse.up() }
})
