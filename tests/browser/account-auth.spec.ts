// 106账户页面验收：真实HTTP与环境独占的内存邮件，不向外发送邮件或启动模型。
import { randomUUID } from 'node:crypto'
import type { Page } from '@playwright/test'

import { expect, test } from './workspace-fixture'

const password = 'Account-paper-password-106'

async function accountEmailLogin(/* 已打开正常账户页面的真实浏览器。 */ page: Page): Promise<void> {
  // 邮箱旅程明确选取原入口，不把用户名登录当作邮箱格式的兼容入口。
  await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()
  if (!await page.getByLabel('邮箱', { exact: true }).isVisible()) await page.getByRole('button', { name: '邮箱登录', exact: true }).click()
  await expect(page.getByLabel('邮箱', { exact: true })).toBeVisible()
}

async function accountRegister(
  /* 当前用例独占的真实账户页面。 */ page: Page,
  /* 仅用于本轮测试的独立邮箱身份。 */ email: string,
): Promise<void> {
  // 使用正常注册表单发起验证，邮件由真实后端交给测试内存收件箱。
  await accountEmailLogin(page)
  await page.getByRole('button', { name: '邮箱注册', exact: true }).click()
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('显示名称', { exact: true }).fill('账户验收成员')
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByLabel('确认密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '注册并发送验证码', exact: true }).click()
  await expect(page.getByRole('heading', { name: '验证邮箱', exact: true })).toBeVisible()
}

test('106 账户注册验证并登录，错误验证码次数耗尽明确提示且保留令牌入口', async (
  /* 本例真实页面、独立API与内存邮件，邮件不经过外网。 */ { page, webUrl, environment },
) => {
  // 第一个身份检查次数耗尽；第二个身份验证正常注册，不以重发绕过次数合同。
  await page.goto(webUrl)
  await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()
  await expect(page.getByLabel('服务地址', { exact: true })).toHaveValue(webUrl)
  await page.getByText('使用访问令牌', { exact: true }).click()
  await expect(page.getByLabel('用户访问令牌', { exact: true })).toBeVisible()
  await page.getByText('使用访问令牌', { exact: true }).click()
  const exhaustedEmail = `exhausted-${randomUUID()}@example.test`
  await accountRegister(page, exhaustedEmail)
  await expect.poll(() => /* 等待后端实际发出本次邮箱验证消息。 */ environment.accountMailbox.filter(
    /* 环境自有的邮件记录。 */ mail => /* 按原邮箱和用途匹配，不读取其它身份验证码。 */ mail.email === exhaustedEmail && mail.kind === 'verify-email',
  ).length).toBe(1)
  const exhaustedMail = environment.accountMailbox.find((/* 环境自有的邮件。 */ mail) => /* 只取本次已确认送达的邮件。 */ mail.email === exhaustedEmail && mail.kind === 'verify-email')
  if (!exhaustedMail) throw new Error('Expected private fixture verification mail')
  const wrongCode = exhaustedMail.code === '000000' ? '111111' : '000000'
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.getByLabel('六位验证码', { exact: true }).fill(wrongCode)
    await page.getByRole('button', { name: '验证并登录', exact: true }).click()
    await expect(page.getByRole('alert')).toBeVisible()
    await expect(page.getByRole('button', { name: '验证并登录', exact: true })).toBeEnabled()
  }
  await page.getByLabel('六位验证码', { exact: true }).fill(exhaustedMail.code)
  await page.getByRole('button', { name: '验证并登录', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('次数已用尽')
  await expect(page.getByRole('button', { name: /重新发送验证码/ })).toBeDisabled()

  await page.getByRole('button', { name: '返回登录', exact: true }).click()
  const email = `member-${randomUUID()}@example.test`
  await accountRegister(page, email)
  const mail = environment.accountMailbox.find((/* 当前环境中的邮件。 */ item) => /* 验证新身份的实际验证码。 */ item.email === email && item.kind === 'verify-email')
  if (!mail) throw new Error('Expected registered account mail')
  await page.getByLabel('六位验证码', { exact: true }).fill(mail.code)
  await page.getByRole('button', { name: '验证并登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  const [logoutResponse] = await Promise.all([
    page.waitForResponse((/* 本次实际HTTP退出响应，不读取凭据或正文。 */ response) =>
      /* 页面返回登录不能代替服务端接受撤销；只匹配原退出路由。 */
      new URL(response.url()).pathname === '/api/v1/auth/logout' && response.request().method() === 'POST'),
    page.getByRole('button', { name: '退出登录', exact: true }).click(),
  ])
  expect(logoutResponse.status()).toBe(200)
  await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()
  await accountEmailLogin(page)
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(password)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
})

test('106 账户找回并重置密码，登录后改密再以新密码登录', async (
  /* 真实账户API与本例独占的内存收件箱。 */ { page, webUrl, environment },
) => {
  // 每次密码变化都走页面与正式HTTP，不能把测试令牌当成账户登录。
  await page.goto(webUrl)
  await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()
  const email = `reset-${randomUUID()}@example.test`
  await accountRegister(page, email)
  const verification = environment.accountMailbox.find((/* 当前环境已投递的消息。 */ mail) => /* 只取本次注册验证码。 */ mail.email === email && mail.kind === 'verify-email')
  if (!verification) throw new Error('Expected verification mail')
  await page.getByLabel('六位验证码', { exact: true }).fill(verification.code)
  await page.getByRole('button', { name: '验证并登录', exact: true }).click()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await accountEmailLogin(page)
  await page.getByRole('button', { name: '忘记密码', exact: true }).click()
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByRole('button', { name: '发送重置验证码', exact: true }).click()
  await expect(page.getByRole('heading', { name: '设置新密码', exact: true })).toBeVisible()
  const reset = environment.accountMailbox.find((/* 当前环境已投递的消息。 */ mail) => /* 只取当前身份的密码重置码。 */ mail.email === email && mail.kind === 'reset-password')
  if (!reset) throw new Error('Expected password reset mail')
  const resetPassword = 'Reset-paper-password-106', changedPassword = 'Changed-paper-password-106'
  await page.getByLabel('六位验证码', { exact: true }).fill(reset.code)
  await page.getByLabel('新密码', { exact: true }).fill(resetPassword)
  await page.getByLabel('确认新密码', { exact: true }).fill(resetPassword)
  await page.getByRole('button', { name: '重置密码', exact: true }).click()
  await expect(page.getByRole('heading', { name: '登录账户', exact: true })).toBeVisible()
  await page.getByLabel('密码', { exact: true }).fill(resetPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await page.getByRole('button', { name: '账户设置', exact: true }).click()
  await page.getByRole('button', { name: '修改密码', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '修改密码', exact: true })
  await dialog.getByLabel('当前密码', { exact: true }).fill(resetPassword)
  await dialog.getByLabel('新密码', { exact: true }).fill(changedPassword)
  await dialog.getByLabel('确认新密码', { exact: true }).fill(changedPassword)
  await dialog.getByRole('button', { name: '保存新密码', exact: true }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '退出登录', exact: true }).click()
  await accountEmailLogin(page)
  await page.getByLabel('邮箱', { exact: true }).fill(email)
  await page.getByLabel('密码', { exact: true }).fill(changedPassword)
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByRole('button', { name: '退出登录', exact: true })).toBeVisible()
})
