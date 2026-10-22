// 在既有 Vite 和服务生命周期内验证真实递归表单与场景的恢复边界。
import { expect, test } from './workspace-fixture'

test('U01：合法空值不会被表单默认字符串覆盖', async (
  /* 当前测试独占的真实浏览器及既有 Vite origin。 */ { page, webUrl },
) => {
  // 已保存 null 与尚未提供字段有不同含义，页面必须显示已选择空值。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=nullable`)
  await expect(page.getByLabel('空值')).toBeChecked()
  await expect(page.getByRole('textbox')).toHaveCount(0)
})

test('U02：缺少 WebGL 时保留可选择的 SVG 场景', async (
  /* 当前测试独占的浏览器及既有 Vite origin。 */ { page, webUrl },
) => {
  // 仅在本次页面禁用图形上下文，验证真实环境差异仍进入既有降级路径。
  await page.addInitScript(() => {
    // 无可用绘图上下文时 WebGLRenderer 会在资源建立阶段失败。
    HTMLCanvasElement.prototype.getContext = () => /* 模拟浏览器没有可用图形上下文。 */ null
  })
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=scene`)
  await expect(page.locator('.scene-fallback')).toBeVisible()
  await expect(page.locator('.scene-fallback').getByText('真实节点')).toBeVisible()
  await expect(page.locator('#global-error')).toHaveCount(0)
})

test('U03：WebGL 建立后的场景初始化异常进入全局错误界面', async (
  /* 当前测试独占的浏览器及既有 Vite origin。 */ { page, webUrl },
) => {
  // 真实 WebGL 先成功，再令场景尺寸观察失败，避免把程序异常解释成缺少 WebGL。
  await page.addInitScript(() => {
    // 只注入目标场景的观察错误，不影响其他元素或浏览器全局生命周期。
    const BrowserResizeObserver = window.ResizeObserver
    window.ResizeObserver = class extends BrowserResizeObserver {
      observe(
        /* 真实组件希望观察的容器。 */ target: Element,
        /* 保留正常浏览器支持的观察选项。 */ options?: ResizeObserverOptions,
      ): void {
        // WebGLRenderer 已建立之后才会观察 scene-host。
        if (target.classList.contains('scene-host')) throw new Error('Injected scene observer failure')
        super.observe(target, options)
      }
    }
  })
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=scene`)
  await expect(page.locator('#global-error')).toBeVisible()
  await expect(page.locator('.scene-fallback')).toHaveCount(0)
})

test('U11：同图发布更多后继自动取景，选择活动和正文更新保留视角', async (
  /* 当前真实WebGL浏览器与既有Vite，夹具不访问用户运行实例。 */ { page, webUrl },
) => {
  // 先以两个已发布节点建立旧视角，再发布后继，观察公开标签而不访问Three对象。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=scene-growth`)
  const scene = page.locator('.graph-3d')
  const labels = scene.locator('.scene-label')
  const readProjection = async (): Promise<Array<{ left: number; top: number }>> => {
    // 只读取真实标签屏幕投影，活动文字和选中样式不参与相机比较。
    return labels.evaluateAll((/* 当前实际绘制且处于视野内的DOM标签。 */ elements) => elements.map((/* 一个节点的公开标签。 */ element) => {
      // 舍去亚像素差异，保留画布缩放和平移的可观察结果。
      const bounds = element.getBoundingClientRect()
      return { left: Math.round(bounds.left), top: Math.round(bounds.top) }
    }))
  }
  await expect(scene.locator('.graph-3d-canvas')).toBeVisible()
  await expect(labels).toHaveCount(2)
  const initial = await readProjection()
  await scene.getByRole('button', { name: '放大三维关系图', exact: true }).click()
  await expect.poll(readProjection).not.toEqual(initial)
  const zoomed = await readProjection()

  await page.getByRole('button', { name: '选择事实', exact: true }).click()
  await expect(scene.locator('.scene-label.selected')).toHaveCount(1)
  expect(await readProjection()).toEqual(zoomed)
  await page.getByRole('button', { name: '更新执行状态', exact: true }).click()
  await expect(scene.locator('.scene-label.selected .node-activity')).toContainText('处理中')
  expect(await readProjection()).toEqual(zoomed)
  await page.getByRole('button', { name: '更新事实正文', exact: true }).click()
  await expect(scene.locator('.scene-selection strong')).toHaveText('事实正文已更新')
  expect(await readProjection()).toEqual(zoomed)

  await page.getByRole('button', { name: '发布更多后继', exact: true }).click()
  await expect(scene.locator('.scene-topline')).toContainText('4 节点 · 3 连线')
  await expect(labels).toHaveCount(4)
  await expect.poll(async () => /* 新增意见、结论与原节点的标签都必须处于画布可见边界内。 */ labels.evaluateAll((
    /* 生产场景投影出的全部标签，不读内部相机状态。 */ elements,
  ) => elements.every((/* 待检查的一个真实节点标签。 */ element) => {
    // DOM存在仍可能落在overflow之外，因此核对实际屏幕边界。
    const container = element.closest('.graph-3d')?.getBoundingClientRect()
    const bounds = element.getBoundingClientRect()
    return !!container && bounds.left >= container.left && bounds.top >= container.top
      && bounds.right <= container.right && bounds.bottom <= container.bottom
  }))).toBe(true)
  await expect(page.locator('#global-error')).toHaveCount(0)
})

test('U04：枚举选择保留数字字符串和不同对象的原JSON类型', async (
  /* 当前测试独占的浏览器与既有Vite页面。 */ { page, webUrl },
) => {
  // 选项身份采用位置，不将数字0与字符串0、两个对象都压成同一字符串。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=enum`)
  const select = page.getByRole('combobox')
  await expect(select).toHaveValue('0')
  await select.selectOption('1')
  await expect(page.locator('#payload-result')).toHaveText('"0"')
  await select.selectOption('2')
  await expect(page.locator('#payload-result')).toHaveText('{"label":"甲"}')
  await select.selectOption('3')
  await expect(page.locator('#payload-result')).toHaveText('{"label":"乙"}')
  await select.selectOption('0')
  await expect(page.locator('#payload-result')).toHaveText('0')
})

test('U05：原型同名动态字段可编辑并可重命名为自有__proto__字段', async (
  /* 当前真实组件页面。 */ { page, webUrl },
) => {
  // properties为空时constructor/toString仍是正文自有字段，不应被误判成固定声明。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=dynamic`)
  await expect(page.locator('.dynamic-field')).toHaveCount(2)
  await expect(page.locator('.dynamic-field').first().locator('textarea')).toHaveValue('动态正文')
  await page.getByRole('textbox', { name: '字段名称', exact: true }).first().fill('__proto__')
  await page.getByRole('textbox', { name: '字段名称', exact: true }).first().press('Tab')
  await expect(page.locator('#payload-result')).toHaveText('{"toString":"动态表达","__proto__":"动态正文"}')
  await expect(page.locator('#global-error')).toHaveCount(0)
})

test('U10：对象枚举忽略键顺序但保留嵌套数组类型和顺序', async (
  /* 初始正文与枚举具有不同键顺序的真实表单。 */ { page, webUrl },
) => {
  // JSON Schema对象枚举按值相等，不依赖序列化时的字段插入次序。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=enum-object`)
  const select = page.getByRole('combobox')
  await expect(select).toHaveValue('4')
  await select.selectOption('2')
  await expect(page.locator('#payload-result')).toHaveText('{"label":"甲"}')
  await select.selectOption('4')
  await expect(page.locator('#payload-result')).toHaveText('{"first":1,"second":[false,"尾"]}')
})

test('U06：缺少的constructor固定字段从发布默认值建立控件', async (
  /* 当前真实递归表单页面。 */ { page, webUrl },
) => {
  // 缺自有值时不得把继承的Object构造函数传给子表单。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=declared`)
  await expect(page.getByRole('textbox')).toHaveValue('合法初值')
})

test('U07：来源创建在自有__proto__容器保存附件和媒体元数据', async (
  /* 使用固定已解析目录的真实资产管理组件。 */ { page, webUrl },
) => {
  // 按钮执行实际来源创建，验证未知自有容器会被创建而不修改Object.prototype。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=asset`)
  await page.getByRole('button', { name: '添加来源 原始.txt', exact: true }).click()
  await expect(page.locator('#payload-result')).toHaveText('{"__proto__":{"assetId":"asset","mediaType":"text/plain"},"constructor":"原始.txt"}')
  await expect(page.locator('#prototype-clean')).toHaveText('true')
})

test('U08：原型同名自定义Agent种类保留真实选项', async (
  /* 使用固定Agent目录的真实管理组件。 */ { page, webUrl },
) => {
  // 当前选项已禁用编辑但仍必须显示其实际种类，不能误取kinds的继承函数。
  await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=agent`)
  const select = page.locator('.agent-form select').first()
  await expect(select).toHaveValue('toString')
  await expect(select.locator('option[value="toString"]')).toHaveText('toString')
})

for (const side of ['left', 'right', 'bottom'] as const) {
  test(`U09：${side}拖动正常保存，卸载撤销活动拖动`, async (
    /* 当前真实AppShell页面与鼠标。 */ { page, webUrl },
  ) => {
    // 先完成一次拖动建立正常保存对照，再在下一次拖动中卸载，旧mouseup不得写入新尺寸。
    await page.addInitScript(() => { /* 当前上下文从无布局偏好开始。 */ localStorage.clear() })
    await page.goto(`${webUrl}/tests/browser/fixtures/ui-boundaries.html?mode=resize`)
    const split = page.locator(side === 'bottom' ? '.row-split' : `.split.${side}`)
    const box = await split.boundingBox()
    if (!box) throw new Error('Expected mounted resize split')
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    const delta = side === 'right' ? -20 : 20
    await page.mouse.move(start.x, start.y)
    await page.mouse.down()
    await page.mouse.move(start.x + (side === 'bottom' ? 0 : delta), start.y - (side === 'bottom' ? 20 : 0))
    await page.mouse.up()
    const key = side === 'bottom' ? 'chongming.bottomDockHeight' : 'chongming.panelWidths'
    const saved = await page.evaluate((/* 本方向实际保存的布局键。 */ storageKey) => /* 读取正常结束后的真实持久化值。 */ localStorage.getItem(storageKey), key)
    expect(saved).not.toBeNull()
    const nextBox = await split.boundingBox()
    if (!nextBox) throw new Error('Expected split after completed resize')
    await page.mouse.move(nextBox.x + nextBox.width / 2, nextBox.y + nextBox.height / 2)
    await page.mouse.down()
    await page.getByRole('button', { name: '卸载工作台', exact: true }).evaluate((/* 鼠标仍按下时模拟401切换视图。 */ button) => { /* 直接触发真实组件卸载，保持活动拖动在途。 */ button.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await expect(page.locator('.app-shell')).toHaveCount(0)
    await page.mouse.move(start.x + 100, start.y - 100)
    await page.mouse.up()
    expect(await page.evaluate((/* 原布局键。 */ storageKey) => /* 卸载后的鼠标事件不得覆盖最后完成的布局。 */ localStorage.getItem(storageKey), key)).toBe(saved)
    expect(await page.locator('body').evaluate((/* 文本选择状态的真实所有者。 */ body) => /* 卸载归还拖动期间的文本选择。 */ body.style.userSelect)).toBe('')
  })
}
