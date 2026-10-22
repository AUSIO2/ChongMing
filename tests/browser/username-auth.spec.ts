// 无邮件用户名账户旅程：使用真实HTTP和每例独立数据库，不装配邮件服务。
import { randomUUID } from 'node:crypto'
import { expect, test } from './workspace-fixture'

test.use({ accountMail: false })
const password = 'Username-paper-password-108'

test('108 无邮件注册直接进入私有工作区，确认密码不一致不提交，退出后可用用户名登录', async (
  /* 本例真实页面、API及明确关闭mailer的独立环境。 */ { page, webUrl, environment },
) => {
  // 不从浏览器抽取凭据或注入store；整个注册和再次登录走正常公开页面。
  const username = `Member_${randomUUID().slice(0, 12)}`
  let registrations = 0
  page.on('request', (/* 本页实际请求，仅记录固定路由计数。 */ request) => {
    // 密码和令牌不进入断言报告或日志。
    if (new URL(request.url()).pathname === '/api/v1/auth/register-username') registrations++
  })
  await page.goto(webUrl)
  await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '创建账户', exact: true }).click()
  await expect(page.getByLabel('邮箱', { exact: true })).not.toBeVisible()
  await expect(page.getByText('用户名账户不支持邮件找回，请妥善保存密码；登录后可以修改密码。', { exact: true })).toBeVisible()
  await page.getByLabel('用户名', { exact: true }).fill(username)
  await page.getByLabel('显示名称', { exact: true }).fill('用户名验收成员')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(`${password}-different`)
  await page.getByRole('button', { name: '注册并登录', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('两次输入的密码不一致。')
  expect(registrations).toBe(0)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '注册并登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  await expect(page.getByLabel('当前工作区', { exact: true }).locator('option:checked')).toHaveText('用户名验收成员的工作区')
  await expect(page.getByLabel('当前工作区', { exact: true }).locator('option')).toHaveCount(2)
  expect(environment.accountMailbox).toEqual([])
  const [logout] = await Promise.all([
    page.waitForResponse((/* 只确认服务端实际撤销成功，不读取认证正文。 */ response) =>
      /* 退出必须作用于原正式路由。 */ new URL(response.url()).pathname === '/api/v1/auth/logout' && response.request().method() === 'POST'),
    page.getByRole('button', { name: '退出登录', exact: true }).click(),
  ])
  expect(logout.status()).toBe(200)
  await expect(page.getByLabel('用户名', { exact: true })).toBeVisible()
  await page.getByLabel('用户名', { exact: true }).fill(username.toLowerCase())
  await page.getByLabel('密码', { exact: true }).fill(`${password}-wrong`)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('用户名或密码错误。')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  await expect(page.getByLabel('当前工作区', { exact: true }).locator('option:checked')).toHaveText('用户名验收成员的工作区')
  expect(registrations).toBe(1)
  expect(environment.accountMailbox).toEqual([])
})
