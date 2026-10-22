// 用真实SQLite事务验证账户会话和一次性验证码，不使用模型或真实邮件服务。
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthSession } from '../../../../contracts/auth'
import type { AccountMailer } from '../../../../backend/ports/account-mailer'
import { authCreateService, type AuthService } from '../../../../backend/modules/identity/identity-service'
import { sqliteCreatePersistence, type SqlitePersistence } from '../../../../backend/adapters/storage/sqlite/persistence'
import { accountCreatePasswords } from '../../../../backend/adapters/identity/argon2-passwords'

vi.mock('node:crypto', async (/* 只替换验证码随机数，保留真正的令牌与UUID生成。 */ original) => {
  // 固定递增验证码，使重发必定不同，测试不依赖百万分之一的随机碰撞。
  const actual = await original<typeof import('node:crypto')>()
  let code = 100000
  return { ...actual, randomInt: () => /* 每次产生不同的合法六位验证码。 */ code++ }
})

const password = 'initial-password-2026', nextPassword = 'replacement-password-2026'
const cleanup: Array<() => Promise<unknown>> = []
type TestMail = { kind: 'verify-email' | 'reset-password'; email: string; displayName: string; code: string }
interface AccountFixture { auth: AuthService; database: SqlitePersistence; mails: TestMail[]; now: () => number; advance: (/* 前进的存储时钟毫秒数。 */ ms: number) => void }

afterEach(async () => {
  // 关闭用例独占连接，再删除测试目录，不影响预览数据库。
  for (const close of cleanup.splice(0).reverse()) await close()
})

async function createFixture(
  /* false用于证明不配置邮件时账户和旧令牌能力仍工作。 */ withMailer = true,
  /* 默认工作区写入后故意失败，用真实事务证明注册整体回滚。 */ failWorkspace = false,
): Promise<AccountFixture> {
  // 创建真实事务存储，并仅把验证码交给内存邮件夹具。
  const directory = await mkdtemp(path.join(tmpdir(), 'chongming-account-'))
  cleanup.push(() => /* 删除本例的临时数据库和附件目录。 */ rm(directory, { recursive: true, force: true }))
  const database = sqliteCreatePersistence(directory)
  cleanup.push(() => /* 等待本例SQLite连接完全关闭。 */ database.close())
  let now = Date.parse('2026-10-21T00:00:00.000Z')
  database.now = async () => /* 服务时钟由测试推进，密码哈希仍使用真实异步执行。 */ now
  const mails: TestMail[] = []
  const mailer: AccountMailer = {
    async sendVerification(/* 服务生成后只交付邮件的短期凭据。 */ input) {
      // 捕获发信内容，不输出日志或调用SMTP。
      mails.push({ ...input, kind: 'verify-email' })
    },
    async sendPasswordReset(/* 服务生成后只交付邮件的重置凭据。 */ input) {
      // 与注册邮件分开记录，防止两个挑战类型互相消费。
      mails.push({ ...input, kind: 'reset-password' })
    },
  }
  const auth = authCreateService(database, { ...(withMailer ? { mailer } : {}), passwords: accountCreatePasswords(), challengeSecret: 'account-test-key-2026-fixed-only',
    async createDefaultWorkspace(/* 已锁定用户且共享当前事务的创建上下文。 */ ctx, /* 用户确认的工作区显示名。 */ displayName) {
      // 验证回调和邮箱验证共用提交，只有成功验证才建立一次默认工作区。
      await database.records<{ _id: string; displayName: string }>('account_test_workspaces').insert({ _id: ctx.actor.userId, displayName }, ctx.session)
      if (failWorkspace) throw new Error('Default workspace could not be created')
    },
  })
  await auth.initialize()
  return { auth, database, mails, now: () => /* 读取本例持久化时钟。 */ now,
    advance: (/* 要前进的毫秒数，不影响真实计时器。 */ ms) => { /* 推进凭据过期判定的存储时钟。 */ now += ms } }
}

function lastCode(/* 已捕获的账户邮件，调用方已经触发相应发信。 */ fixture: AccountFixture): string {
  // 获取最近邮件中的验证码，不从数据库反推或公开返回验证码。
  const mail = fixture.mails.at(-1)
  if (!mail) throw new Error('Expected a captured account email')
  return mail.code
}

async function createVerified(/* 由当前用例独占的真实账户服务。 */ fixture: AccountFixture): Promise<AuthSession> {
  // 经注册和验证码入口建立用户，供会话及改密流程复用。
  await fixture.auth.register({ email: 'reader@example.test', displayName: 'Reader', password })
  return fixture.auth.verifyEmail({ email: 'reader@example.test', code: lastCode(fixture), remember: true })
}

describe('account authentication over real SQLite transactions', () => {
  // 账户功能与旧令牌授权共用数据库，保持原有图权限身份。
  it('registers normalized email, stores hashes and creates the default workspace only after verification', async () => {
    // 注册不签发凭据；验证后提供15分钟access及记住我会话，密码和验证码均不明文存储。
    const fixture = await createFixture(), { auth, database } = fixture
    await auth.register({ email: ' Reader@Example.Test ', displayName: ' Reader ', password })
    expect(await database.records('account_test_workspaces').list()).toEqual([])
    await expect(auth.login({ email: 'reader@example.test', password, remember: false })).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED' })
    const session = await auth.verifyEmail({ email: 'reader@example.test', code: lastCode(fixture), remember: true })
    expect(session.identity).toMatchObject({ displayName: 'Reader', hostAdmin: false })
    expect(Date.parse(session.accessExpiresAt) - fixture.now()).toBe(15 * 60_000)
    expect(Date.parse(session.refreshExpiresAt) - fixture.now()).toBe(30 * 24 * 60 * 60_000)
    expect(await database.records('account_test_workspaces').list()).toEqual([{ _id: session.identity.userId, displayName: 'Reader' }])
    const users = await database.records<{ _id: string; passwordHash: string; emailNormalized: string }>('control_users').list()
    expect(users[0]?.emailNormalized).toBe('reader@example.test')
    expect(users[0]?.passwordHash).toMatch(/^\$argon2id\$/)
    expect(JSON.stringify(users)).not.toContain(password)
    const challenge = await database.records<{ _id: string; secretHash: string }>('auth_challenges').first({ kind: 'verify-email' })
    expect(challenge?.secretHash).toMatch(/^[0-9a-f]{64}$/)
    expect(challenge?.secretHash).not.toBe(lastCode(fixture))
    expect(challenge).not.toHaveProperty('code')
    expect((await auth.read(session.accessToken)).actor).toEqual(session.identity)
    const short = await auth.login({ email: 'READER@example.test', password, remember: false })
    expect(Date.parse(short.refreshExpiresAt) - fixture.now()).toBe(24 * 60 * 60_000)
    await expect(auth.verifyEmail({ email: 'reader@example.test', code: lastCode(fixture), remember: false })).rejects.toMatchObject({ code: 'EMAIL_ALREADY_VERIFIED' })
  })

  it.each(['verify-email', 'reset-password'] as const)('commits every wrong %s attempt and locks the fifth before a correct code; resend restores only the new code', async (/* 要验证失败提交和重发隔离的挑战类型。 */ kind) => {
    // 针对原算法在事务内throw导致attempts回滚的缺陷，直接读取真实持久化记录核对五次计数。
    const fixture = await createFixture(), { auth, database } = fixture
    await auth.register({ email: 'reader@example.test', displayName: 'Reader', password })
    if (kind === 'reset-password') {
      await auth.verifyEmail({ email: 'reader@example.test', code: lastCode(fixture), remember: false })
      await auth.forgotPassword({ email: 'reader@example.test' })
    }
    const oldCode = lastCode(fixture)
    async function answer(/* 要提交到同一挑战的六位验证码。 */ code: string): Promise<unknown> {
      // 沿各自公开服务方法执行挑战，不能只测试独立计数器。
      if (kind === 'verify-email') return auth.verifyEmail({ email: 'reader@example.test', code, remember: false })
      return auth.resetPassword({ email: 'reader@example.test', code, password: nextPassword })
    }
    for (let attempt = 1; attempt <= 5; attempt++) {
      await expect(answer('999999')).rejects.toMatchObject({ code: 'INVALID_CODE' })
      expect(await database.records('auth_challenges').first({ kind, consumed: false })).toMatchObject({ attempts: attempt })
    }
    await expect(answer(oldCode)).rejects.toMatchObject({ code: 'CODE_ATTEMPTS_EXHAUSTED' })
    if (kind === 'verify-email') await auth.resendVerification({ email: 'reader@example.test' })
    else await auth.forgotPassword({ email: 'reader@example.test' })
    const newCode = lastCode(fixture)
    expect(newCode).not.toBe(oldCode)
    await expect(answer(oldCode)).rejects.toMatchObject({ code: 'INVALID_CODE' })
    await answer(newCode)
    expect(await database.records('auth_challenges').first({ kind, consumed: false })).toBeNull()
    if (kind === 'reset-password') await expect(auth.login({ email: 'reader@example.test', password: nextPassword, remember: false })).resolves.toHaveProperty('accessToken')
  })

  it('expires challenges and access credentials, rotates refresh tokens once and revokes logout without touching manual tokens', async () => {
    // 使用存储时钟验证过期、轮换和退出；手工长期令牌沿原接口继续工作。
    const fixture = await createFixture(), { auth } = fixture
    await auth.register({ email: 'reader@example.test', displayName: 'Reader', password })
    fixture.advance(10 * 60_000)
    await expect(auth.verifyEmail({ email: 'reader@example.test', code: lastCode(fixture), remember: false })).rejects.toMatchObject({ code: 'CODE_EXPIRED' })
    await auth.resendVerification({ email: 'reader@example.test' })
    const initial = await auth.verifyEmail({ email: 'reader@example.test', code: lastCode(fixture), remember: true })
    const manual = await auth.createToken(initial.identity.userId)
    fixture.advance(15 * 60_000)
    await expect(auth.read(initial.accessToken)).rejects.toMatchObject({ status: 401 })
    const next = await auth.refresh({ refreshToken: initial.refreshToken })
    expect(next.refreshToken).not.toBe(initial.refreshToken)
    expect(next.refreshExpiresAt).toBe(initial.refreshExpiresAt)
    await expect(auth.refresh({ refreshToken: initial.refreshToken })).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' })
    await auth.logout(next.accessToken)
    await expect(auth.read(next.accessToken)).rejects.toMatchObject({ status: 401 })
    await expect(auth.refresh({ refreshToken: next.refreshToken })).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' })
    await expect(auth.read(manual.token)).resolves.toHaveProperty('actor.userId', initial.identity.userId)
  })

  it('resets and changes passwords while revoking account sessions and preserving the existing manual admin token', async () => {
    // 密码变化撤销所有账户会话；原管理令牌保留，无邮箱的旧管理员也仍可认证。
    const fixture = await createFixture(), { auth } = fixture, first = await createVerified(fixture)
    const manual = await auth.createToken(first.identity.userId)
    const admin = await auth.createUser({ id: randomUUID(), displayName: 'Legacy admin', hostAdmin: true }), adminToken = await auth.createToken(admin.userId)
    const second = await auth.login({ email: 'reader@example.test', password, remember: false })
    await auth.forgotPassword({ email: 'reader@example.test' })
    await auth.resetPassword({ email: 'reader@example.test', code: lastCode(fixture), password: nextPassword })
    for (const session of [first, second]) {
      await expect(auth.read(session.accessToken)).rejects.toMatchObject({ status: 401 })
      await expect(auth.refresh({ refreshToken: session.refreshToken })).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' })
    }
    await expect(auth.login({ email: 'reader@example.test', password, remember: false })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    const current = await auth.login({ email: 'reader@example.test', password: nextPassword, remember: false })
    const changed = await auth.changePassword(current.accessToken, { currentPassword: nextPassword, newPassword: password, remember: true })
    await expect(auth.read(current.accessToken)).rejects.toMatchObject({ status: 401 })
    await expect(auth.refresh({ refreshToken: current.refreshToken })).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' })
    await expect(auth.changePassword(current.accessToken, { currentPassword: password, newPassword: nextPassword, remember: false })).rejects.toMatchObject({ status: 401 })
    await expect(auth.read(changed.accessToken)).resolves.toHaveProperty('actor.userId', first.identity.userId)
    await expect(auth.read(manual.token)).resolves.toHaveProperty('actor.userId', first.identity.userId)
    await expect(auth.read(adminToken.token)).resolves.toHaveProperty('actor.hostAdmin', true)
  })

  it('rejects invalid account fields and hides unknown password reset accounts', async () => {
    // 服务入口自身校验业务字段，不依赖HTTP做类型承诺；未知邮箱不触发邮件且返回相同提示。
    const fixture = await createFixture(), { auth } = fixture
    await expect(auth.register({ email: 'invalid', displayName: 'Reader', password })).rejects.toMatchObject({ code: 'INVALID_EMAIL' })
    await expect(auth.register({ email: 'reader@example.test', displayName: 'Reader', password: 'short' })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' })
    await createVerified(fixture)
    await expect(auth.login({ email: 'reader@example.test', password: 'wrong', remember: false })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    await expect(Reflect.apply(auth.login, auth, [{ email: 'reader@example.test', password, remember: 'yes' }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    const known = await auth.forgotPassword({ email: 'reader@example.test' }), count = fixture.mails.length
    expect(await auth.forgotPassword({ email: 'unknown@example.test' })).toEqual(known)
    expect(fixture.mails).toHaveLength(count)
  })

  it('leaves token authentication usable and rejects email flows uniformly when no mailer is configured', async () => {
    // 无邮件依赖不能意外启用验证码日志或创建半账户，旧管理令牌的生命周期不变。
    const { auth, database } = await createFixture(false)
    const legacy = await auth.createUser({ id: randomUUID(), displayName: 'Legacy owner', hostAdmin: true }), token = await auth.createToken(legacy.userId)
    const calls = [auth.register({ email: 'reader@example.test', displayName: 'Reader', password }),
      auth.verifyEmail({ email: 'reader@example.test', code: '100000', remember: false }), auth.resendVerification({ email: 'reader@example.test' }),
      auth.forgotPassword({ email: 'reader@example.test' }), auth.resetPassword({ email: 'reader@example.test', code: '100000', password })]
    for (const call of calls) await expect(call).rejects.toMatchObject({ status: 503, code: 'ACCOUNT_MAIL_UNAVAILABLE' })
    expect(await database.records('control_users').count()).toBe(1)
    await expect(auth.read(token.token)).resolves.toHaveProperty('actor.userId', legacy.userId)
  })
})

describe('username accounts without a mailer', () => {
  // 用户名账户沿用原身份与会话，不伪造邮箱确认状态。
  it('registers and signs in atomically with a private workspace, hashed password and no email records', async () => {
    const { auth, database, mails, now } = await createFixture(false)
    const admin = await auth.createUser({ id: randomUUID(), displayName: '原管理员', hostAdmin: true }), manual = await auth.createToken(admin.userId)
    const session = await auth.registerUsername({ username: ' Reader_01 ', displayName: ' 中文名称 ', password, remember: false })
    expect(session.identity).toMatchObject({ displayName: '中文名称', hostAdmin: false })
    expect(Date.parse(session.refreshExpiresAt) - now()).toBe(24 * 60 * 60_000)
    expect((await auth.read(session.accessToken)).actor).toEqual(session.identity)
    expect(await database.records('account_test_workspaces').list()).toEqual([{ _id: session.identity.userId, displayName: '中文名称' }])
    const user = await database.records<{ _id: string; usernameNormalized: string; passwordHash: string }>('control_users').get(session.identity.userId)
    expect(user).toMatchObject({ usernameNormalized: 'reader_01' })
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/)
    expect(user).not.toHaveProperty('email')
    expect(user).not.toHaveProperty('emailNormalized')
    expect(user).not.toHaveProperty('emailVerifiedAt')
    expect(JSON.stringify(user)).not.toContain(password)
    expect(await database.records('auth_challenges').count()).toBe(0)
    expect(mails).toHaveLength(0)
    await expect(auth.read(manual.token)).resolves.toHaveProperty('actor.hostAdmin', true)
  })

  it('normalizes unique usernames and rejects invalid registration fields without creating extra accounts', async () => {
    const { auth, database } = await createFixture(false)
    const input = { username: 'Reader-01', displayName: '读者', password, remember: false }
    await auth.registerUsername(input)
    await expect(auth.registerUsername({ ...input, username: ' READER-01 ' })).rejects.toMatchObject({ status: 409, code: 'USERNAME_EXISTS' })
    for (const username of ['ab', 'a'.repeat(33), 'reader@example.test', 'read er', '读者']) {
      await expect(auth.registerUsername({ ...input, username })).rejects.toMatchObject({ status: 400, code: 'INVALID_USERNAME' })
    }
    await expect(auth.registerUsername({ ...input, username: 'new-user', password: 'short' })).rejects.toMatchObject({ code: 'WEAK_PASSWORD' })
    await expect(auth.registerUsername({ ...input, username: 'new-user', displayName: 'x'.repeat(81) })).rejects.toMatchObject({ code: 'INVALID_DISPLAY_NAME' })
    await expect(Reflect.apply(auth.registerUsername, auth, [{ ...input, username: 'new-user', hostAdmin: true }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    await expect(Reflect.apply(auth.registerUsername, auth, [{ ...input, username: 'new-user', remember: 'yes' }])).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(await database.records('control_users').count()).toBe(1)
    expect(await database.records('account_test_workspaces').count()).toBe(1)
  })

  it('logs in normalized usernames, rejects wrong credentials and disabled users without mail', async () => {
    const { auth, database, now } = await createFixture(false)
    const created = await auth.registerUsername({ username: 'reader', displayName: '读者', password, remember: false })
    const session = await auth.loginUsername({ username: ' READER ', password, remember: true })
    expect(session.identity).toEqual(created.identity)
    expect(Date.parse(session.refreshExpiresAt) - now()).toBe(30 * 24 * 60 * 60_000)
    expect(await database.records('account_test_workspaces').count()).toBe(1)
    await expect(auth.loginUsername({ username: 'reader', password: 'wrong', remember: false })).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' })
    await expect(auth.loginUsername({ username: 'unknown', password, remember: false })).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' })
    await auth.disableUser(created.identity.userId)
    await expect(auth.loginUsername({ username: 'reader', password, remember: false })).rejects.toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS' })
  })

  it('uses existing refresh, password change and logout revocation for username sessions', async () => {
    const { auth } = await createFixture(false)
    const created = await auth.registerUsername({ username: 'reader', displayName: '读者', password, remember: true })
    const manual = await auth.createToken(created.identity.userId)
    const refreshed = await auth.refresh({ refreshToken: created.refreshToken })
    await expect(auth.read(created.accessToken)).rejects.toMatchObject({ status: 401 })
    const changed = await auth.changePassword(refreshed.accessToken, { currentPassword: password, newPassword: nextPassword, remember: false })
    await expect(auth.refresh({ refreshToken: refreshed.refreshToken })).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' })
    await expect(auth.loginUsername({ username: 'reader', password, remember: false })).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' })
    const current = await auth.loginUsername({ username: 'reader', password: nextPassword, remember: false })
    await auth.logout(current.accessToken)
    await expect(auth.refresh({ refreshToken: current.refreshToken })).rejects.toMatchObject({ code: 'INVALID_REFRESH_TOKEN' })
    await expect(auth.read(current.accessToken)).rejects.toMatchObject({ status: 401 })
    await expect(auth.read(changed.accessToken)).resolves.toHaveProperty('actor.userId', created.identity.userId)
    await expect(auth.read(manual.token)).resolves.toHaveProperty('actor.userId', created.identity.userId)
  })

  it('rolls back the user, workspace and all credentials when the workspace callback fails', async () => {
    const { auth, database } = await createFixture(false, true)
    await expect(auth.registerUsername({ username: 'reader', displayName: '读者', password, remember: false })).rejects.toThrow('Default workspace could not be created')
    for (const collection of ['control_users', 'account_test_workspaces', 'control_tokens', 'auth_sessions']) {
      expect(await database.records(collection).count()).toBe(0)
    }
  })
})
