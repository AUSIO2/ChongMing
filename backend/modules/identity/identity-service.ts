// 管理用户和令牌，并用事务写栅栏协调写入授权与并发撤权。
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto'

import { RuntimeMessage } from '../../../contracts/messages'
import type { Identity } from '../../../contracts/control'
import { AccountMessage, type AuthChangePasswordInput, type AuthEmailInput, type AuthLoginInput, type AuthLoginUsernameInput, type AuthMessage, type AuthRefreshInput,
  type AuthRegisterInput, type AuthRegisterUsernameInput, type AuthResetPasswordInput, type AuthSession, type AuthVerifyEmailInput } from '../../../contracts/auth'
import type { AccountMailer } from '../../ports/account-mailer'
import type { AccountPasswords } from '../../ports/account-passwords'
import type { Persistence, StorageSession } from '../../ports/persistence'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadObject, inputReadString } from '../shared/input-validation'

export interface RequestContext { actor: Identity; session: StorageSession | null; mutation: boolean }
export interface MutationContext extends RequestContext { session: StorageSession; mutation: true }
interface UserDocument { _id: string; displayName: string; hostAdmin: boolean; disabled: boolean; writeFence: number
  email?: string; emailNormalized?: string; usernameNormalized?: string; passwordHash?: string; emailVerifiedAt?: string | null; createdAt?: string }
interface TokenDocument { _id: string; userId: string; hash: string; revoked: boolean; expiresAt: string | null; createdAt: string; writeFence: number; sessionId?: string }
interface SessionDocument { _id: string; userId: string; refreshHash: string; expiresAt: string; createdAt: string; revokedAt: string | null; writeFence: number }
interface ChallengeDocument { _id: string; userId: string; kind: 'verify-email' | 'reset-password'; secretHash: string; expiresAt: string; attempts: number; consumed: boolean; createdAt: string; writeFence: number }
type ChallengeResult = { ok: true } | { ok: false; code: 'INVALID_CODE' | 'CODE_EXPIRED' | 'CODE_ATTEMPTS_EXHAUSTED' }
type VerificationResult = { ok: true; session: AuthSession } | Extract<ChallengeResult, { ok: false }>

export interface AuthServiceOptions {
  mailer?: AccountMailer
  passwords?: AccountPasswords
  challengeSecret?: string
  // 在注册或邮箱验证事务内创建默认私有工作区；异常回滚用户状态与会话，不执行外部I/O。
  createDefaultWorkspace?: (/* 已锁定用户并共享当前事务的认证上下文。 */ ctx: MutationContext, /* 注册用户的显示名。 */ displayName: string) => Promise<void>
}

function readEmail(/* 尚未验证的账户邮箱字段。 */ value: unknown): string {
  // 统一邮箱登录身份，拒绝无效格式及过长输入。
  const email = inputReadString(value, 'email').trim().toLowerCase()
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new GraphError(400, 'INVALID_EMAIL', AccountMessage.INVALID_EMAIL)
  return email
}

function readUsername(/* 公开注册或登录的用户名，不与邮箱身份混用。 */ value: unknown): string {
  // 大小写及首尾空白归一化；限制独立用户名格式，不构造虚拟邮箱。
  const username = inputReadString(value, 'username').trim().toLowerCase()
  if (!/^[a-z0-9_-]{3,32}$/.test(username)) throw new GraphError(400, 'INVALID_USERNAME', AccountMessage.INVALID_USERNAME)
  return username
}

function readPassword(/* 注册或更换时的新密码，不裁剪内容。 */ value: unknown): string {
  // 限定Argon2输入长度，登录旧密码的失败则统一使用凭据错误。
  const password = inputReadString(value, 'password')
  if (password.length < 15 || password.length > 128) throw new GraphError(400, 'WEAK_PASSWORD', AccountMessage.WEAK_PASSWORD)
  return password
}

function readRemember(/* 必须明确提供的记住我选项。 */ value: unknown): boolean {
  // 不把字符串或缺省值转换成更长的刷新会话。
  if (typeof value !== 'boolean') throw new GraphError(400, 'INVALID_ARGUMENT', AccountMessage.INVALID_REMEMBER)
  return value
}

function readCode(/* 用户从邮箱复制的验证码。 */ value: unknown): string {
  // 仅接受六位数字，不接受数字类型和缺失字段。
  const code = inputReadString(value, 'code').trim()
  if (!/^\d{6}$/.test(code)) throw new GraphError(400, 'INVALID_CODE', AccountMessage.INVALID_CODE)
  return code
}

function hashSecret(/* 仅本次需要比较或持久化摘要的原始会话凭据。 */ value: string): string {
  // 现有访问令牌和新增刷新令牌共用SHA256摘要，不持久化明文。
  return createHash('sha256').update(value).digest('hex')
}

function challengeFailure(/* 事务已提交的验证码拒绝结果。 */ result: Extract<ChallengeResult, { ok: false }>): GraphError {
  // 在提交后创建公开错误，不能因抛错回滚刚保存的失败次数。
  const message = result.code === 'CODE_ATTEMPTS_EXHAUSTED' ? AccountMessage.CODE_ATTEMPTS_EXHAUSTED : AccountMessage.INVALID_CODE
  return new GraphError(400, result.code, message)
}

/**
 * 组装用户与令牌管理，并通过同一存储事务协调身份验证、业务写入和并发撤权。
 *
 * @param database 提供用户、令牌、事务和存储时钟的持久化适配器。
 */
export function authCreateService(
  /* 原令牌与账户流程共用的持久化及事务入口。 */ database: Persistence,
  /* 可选邮件和验证事务回调；不配置邮件时保留原令牌能力。 */ options: AuthServiceOptions = {},
) {
  // 在既有身份存储上增量提供账户会话，不替换图授权或原管理令牌。
  const users = database.records<UserDocument>('control_users')
  const tokens = database.records<TokenDocument>('control_tokens')
  const sessions = database.records<SessionDocument>('auth_sessions')
  const challenges = database.records<ChallengeDocument>('auth_challenges')
  const challengeSecret = options.challengeSecret ?? randomBytes(32).toString('base64url')
  const admin = database.records<{ _id: string; writeFence: number }>('control_admin')
  /**
   * 按令牌哈希查询未撤销凭据，并验证到期时间及用户启用状态后返回身份。
   *
   * @param token 公共请求携带的原始用户令牌；只计算摘要，不持久化明文。
   * @param session 用于在同一事务快照内读取身份的会话；只读请求传 null。
   */
  async function authReadIdentity(
    /* 仅用于摘要查询的原始访问凭据。 */ token: string,
    /* 写请求共享的活动事务；只读认证时为null。 */ session: StorageSession | null,
  ) {
    const hash = createHash('sha256').update(token).digest('hex')
    const record = token ? await tokens.first({ hash, revoked: false }, session) : null
    const user = record ? await users.get(record.userId, session) : null
    // null 表示不过期；其余时间必须晚于存储时钟，无效日期也会被拒绝。
    const expiresAt = record?.expiresAt === null ? Infinity : Date.parse(record?.expiresAt ?? '')
    if (!record || (record.expiresAt !== null && !(expiresAt > await database.now())) || !user || user.disabled) {
      throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.A_VALID_USER_TOKEN_IS_REQUIRED)
    }
    const actor: Identity = { userId: user._id, displayName: user.displayName, hostAdmin: user.hostAdmin }
    return { record, actor, user }
  }
  /**
   * @param session 管理员集合变更必须参与的活动存储事务。
   */
  const touchAdmin = (session: StorageSession) =>
    /* 写入共用管理员栅栏，使管理员增减在事务中互斥。 */
    admin.change('root', doc => /* 推进栅栏，让并发管理员变更发生写冲突。 */ ({ ...doc, writeFence: doc.writeFence + 1 }), session)

  function requireMailer(): AccountMailer {
    // 明确关闭无发信配置的账户入口，绝不退回验证码日志。
    if (!options.mailer) throw new GraphError(503, 'ACCOUNT_MAIL_UNAVAILABLE', AccountMessage.MAIL_UNAVAILABLE)
    return options.mailer
  }

  function requirePasswords(): AccountPasswords {
    // 未装配账户算法时明确关闭密码入口，原有令牌签发及认证仍独立工作。
    if (!options.passwords) throw new GraphError(503, 'ACCOUNT_AUTH_UNAVAILABLE', AccountMessage.AUTH_UNAVAILABLE)
    return options.passwords
  }

  function hashChallenge(/* 本次邮件验证码，不能出现在日志或公开回包。 */ code: string): string {
    // 使用服务密钥保护短码摘要，服务未配置密钥时仅用本实例的随机密钥。
    return createHmac('sha256', challengeSecret).update(code).digest('hex')
  }

  async function issueSession(
    /* 当前事务已读取且写过授权栅栏的启用用户。 */ user: UserDocument,
    /* 用户授权与会话签发必须共用的活动事务。 */ session: StorageSession,
    /* 是否允许30天刷新会话；否则仅一天。 */ remember: boolean,
    /* 轮换时保留原到期时间，不延长会话。 */ fixedExpiry?: string,
  ): Promise<AuthSession> {
    // 只保存随机凭据摘要，原有长期管理令牌不绑定此会话。
    const now = await database.now(), createdAt = new Date(now).toISOString(), sessionId = randomUUID()
    const accessToken = randomBytes(32).toString('base64url'), refreshToken = `${sessionId}.${randomBytes(32).toString('base64url')}`
    const accessExpiresAt = new Date(now + 15 * 60_000).toISOString()
    const refreshExpiresAt = fixedExpiry ?? new Date(now + (remember ? 30 : 1) * 24 * 60 * 60_000).toISOString()
    await sessions.insert({ _id: sessionId, userId: user._id, refreshHash: hashSecret(refreshToken), expiresAt: refreshExpiresAt, createdAt, revokedAt: null, writeFence: 0 }, session)
    await tokens.insert({ _id: randomUUID(), userId: user._id, hash: hashSecret(accessToken), revoked: false, expiresAt: accessExpiresAt, createdAt, sessionId, writeFence: 0 }, session)
    return { identity: { userId: user._id, displayName: user.displayName, hostAdmin: user.hostAdmin }, accessToken, accessExpiresAt, refreshToken, refreshExpiresAt }
  }

  async function createChallenge(
    /* 已解析的规范化邮箱。 */ email: string,
    /* 验证邮箱和密码重置各自独立的一次性流程。 */ kind: ChallengeDocument['kind'],
  ): Promise<{ user: UserDocument; code: string } | null> {
    // 在同一用户栅栏内使旧码失效并建立新码，避免并发重发留下两个有效挑战。
    return database.transaction(async (/* 本次验证码替换独占的事务。 */ session) => {
      // 验证用户状态后再发码；未知邮箱不制造账户，也不泄漏存在性。
      const user = await users.first({ emailNormalized: email }, session)
      if (!user || user.disabled || (kind === 'verify-email' ? Boolean(user.emailVerifiedAt) : !user.emailVerifiedAt)) return null
      await users.replace({ ...user, writeFence: user.writeFence + 1 }, session)
      for (const item of await challenges.list({ userId: user._id, kind, consumed: false }, session)) {
        await challenges.replace({ ...item, consumed: true, writeFence: item.writeFence + 1 }, session)
      }
      const code = randomInt(0, 1_000_000).toString().padStart(6, '0'), now = await database.now()
      await challenges.insert({ _id: randomUUID(), userId: user._id, kind, secretHash: hashChallenge(code), expiresAt: new Date(now + 10 * 60_000).toISOString(),
        attempts: 0, consumed: false, createdAt: new Date(now).toISOString(), writeFence: 0 }, session)
      return { user, code }
    })
  }

  async function consumeChallenge(
    /* 当前事务已经读取的用户。 */ user: UserDocument,
    /* 只在同类型流程里消费，不能用重置码验证邮箱。 */ kind: ChallengeDocument['kind'],
    /* 已确认六位格式的用户输入。 */ code: string,
    /* 保存失败次数或消费状态的活动事务。 */ session: StorageSession,
  ): Promise<ChallengeResult> {
    // 提交失败次数或消费状态，把拒绝结果交给事务外抛错，避免计数随拒绝回滚。
    const challenge = await challenges.first({ userId: user._id, kind, consumed: false }, session)
    if (!challenge || !(Date.parse(challenge.expiresAt) > await database.now())) return { ok: false, code: 'CODE_EXPIRED' }
    if (challenge.attempts >= 5) return { ok: false, code: 'CODE_ATTEMPTS_EXHAUSTED' }
    if (challenge.secretHash !== hashChallenge(code)) {
      await challenges.replace({ ...challenge, attempts: challenge.attempts + 1, writeFence: challenge.writeFence + 1 }, session)
      return { ok: false, code: 'INVALID_CODE' }
    }
    await challenges.replace({ ...challenge, consumed: true, writeFence: challenge.writeFence + 1 }, session)
    return { ok: true }
  }

  async function revokeAccountSessions(
    /* 当前密码变化的用户身份。 */ userId: string,
    /* 密码与所有账户凭据撤销共用的事务。 */ session: StorageSession,
  ): Promise<void> {
    // 撤销账户刷新会话和关联access，保留管理员明确签发的原长期令牌。
    const now = new Date(await database.now()).toISOString()
    for (const item of await sessions.list({ userId, revokedAt: null }, session)) await sessions.replace({ ...item, revokedAt: now, writeFence: item.writeFence + 1 }, session)
    for (const item of await tokens.list({ userId, revoked: false }, session)) {
      if (item.sessionId) await tokens.replace({ ...item, revoked: true, writeFence: item.writeFence + 1 }, session)
    }
  }

  async function sendChallenge(
    /* 规范化邮箱，对未知邮箱返回相同信息。 */ email: string,
    /* 这次邮件的用途，决定使用哪个邮件端口。 */ kind: ChallengeDocument['kind'],
  ): Promise<void> {
    // 邮件仅在数据库提交后发送，失败不记录验证码或SMTP凭据。
    const mailer = requireMailer(), challenge = await createChallenge(email, kind)
    if (!challenge) return
    const input = { email, displayName: challenge.user.displayName, code: challenge.code }
    try {
      if (kind === 'verify-email') await mailer.sendVerification(input)
      else await mailer.sendPasswordReset(input)
    } catch {
      throw new GraphError(503, 'ACCOUNT_MAIL_UNAVAILABLE', AccountMessage.MAIL_UNAVAILABLE)
    }
  }

  return {
    async initialize(): Promise<void> {
      // 初始化身份存储索引与管理员栅栏，供令牌查询和管理员变更使用。
      await database.initialize()
      await tokens.index(['hash'], { unique: true })
      await users.index(['hostAdmin', 'disabled'])
      await users.index(['emailNormalized'], { unique: true, sparse: true })
      await users.index(['usernameNormalized'], { unique: true, sparse: true })
      await sessions.index(['refreshHash'], { unique: true })
      await sessions.index(['userId', 'revokedAt'])
      await challenges.index(['userId', 'kind', 'consumed'])
      await database.transaction(async session => {
        // 仅在首次初始化时建立管理员共用栅栏。
        if (!await admin.get('root', session)) await admin.insert({ _id: 'root', writeFence: 0 }, session)
      })
    },
    async registerUsername(/* 无邮件注册资料及本设备的会话期限选项。 */ input: AuthRegisterUsernameInput): Promise<AuthSession> {
      // 用户、默认私有工作区和首个会话必须一起提交，不授予管理权限或邮箱验证状态。
      const fields = inputReadObject(input, ['username', 'displayName', 'password', 'remember'], 'registerUsername')
      const username = readUsername(fields.username), displayName = inputReadString(fields.displayName, 'displayName').trim()
      const password = readPassword(fields.password), remember = readRemember(fields.remember)
      if (displayName.length > 80) throw new GraphError(400, 'INVALID_DISPLAY_NAME', AccountMessage.INVALID_DISPLAY_NAME)
      const passwordHash = await requirePasswords().hash(password)
      return database.transaction(async (/* 注册、私有工作区与凭据共用的原子事务。 */ session) => {
        // 稀疏唯一索引同时保护并发注册，并兼容没有用户名的旧用户。
        if (await users.first({ usernameNormalized: username }, session)) throw new GraphError(409, 'USERNAME_EXISTS', AccountMessage.USERNAME_EXISTS)
        const user: UserDocument = { _id: randomUUID(), displayName, hostAdmin: false, disabled: false, writeFence: 0,
          usernameNormalized: username, passwordHash, createdAt: new Date(await database.now()).toISOString() }
        await users.insert(user, session)
        await options.createDefaultWorkspace?.({ actor: { userId: user._id, displayName: user.displayName, hostAdmin: false }, session, mutation: true }, displayName)
        return issueSession(user, session, remember)
      })
    },
    async register(/* HTTP或其他公开入口传入的注册字段。 */ input: AuthRegisterInput): Promise<AuthMessage> {
      // 创建未验证普通账户，再通过注入的邮件端口发码，不授予管理权限。
      requireMailer()
      const fields = inputReadObject(input, ['email', 'displayName', 'password'], 'register')
      const email = readEmail(fields.email), displayName = inputReadString(fields.displayName, 'displayName').trim(), password = readPassword(fields.password)
      if (displayName.length > 80) throw new GraphError(400, 'INVALID_DISPLAY_NAME', AccountMessage.INVALID_DISPLAY_NAME)
      const passwordHash = await requirePasswords().hash(password)
      await database.transaction(async (/* 用户创建与邮箱唯一身份共用的事务。 */ session) => {
        // 在事务中拒绝已有邮箱；唯一索引还约束并发注册。
        if (await users.first({ emailNormalized: email }, session)) throw new GraphError(409, 'ACCOUNT_EXISTS', AccountMessage.ACCOUNT_EXISTS)
        await users.insert({ _id: randomUUID(), displayName, hostAdmin: false, disabled: false, writeFence: 0,
          email, emailNormalized: email, passwordHash, emailVerifiedAt: null, createdAt: new Date(await database.now()).toISOString() }, session)
      })
      await sendChallenge(email, 'verify-email')
      return { message: AccountMessage.REGISTERED }
    },
    async verifyEmail(/* 邮箱、邮件短码与本设备会话期限选项。 */ input: AuthVerifyEmailInput): Promise<AuthSession> {
      // 将邮箱确认、默认工作区和凭据签发放入同一事务，挑战拒绝在提交后公开。
      requireMailer()
      const fields = inputReadObject(input, ['email', 'code', 'remember'], 'verifyEmail')
      const email = readEmail(fields.email), code = readCode(fields.code), remember = readRemember(fields.remember)
      const result = await database.transaction<VerificationResult>(async (/* 邮箱验证及首次工作区创建共用事务。 */ session) => {
        // 用户栅栏使同一邮箱的并发验证最多创建一次默认工作区。
        const user = await users.first({ emailNormalized: email }, session)
        if (!user || user.disabled) return { ok: false, code: 'INVALID_CODE' }
        if (user.emailVerifiedAt) throw new GraphError(409, 'EMAIL_ALREADY_VERIFIED', AccountMessage.EMAIL_ALREADY_VERIFIED)
        const challenge = await consumeChallenge(user, 'verify-email', code, session)
        if (!challenge.ok) return challenge
        const verified = { ...user, emailVerifiedAt: new Date(await database.now()).toISOString(), writeFence: user.writeFence + 1 }
        await users.replace(verified, session)
        await options.createDefaultWorkspace?.({ actor: { userId: user._id, displayName: user.displayName, hostAdmin: user.hostAdmin }, session, mutation: true }, user.displayName)
        return { ok: true, session: await issueSession(verified, session, remember) }
      })
      if (!result.ok) throw challengeFailure(result)
      return result.session
    },
    async resendVerification(/* 请求重新发送注册验证码的邮箱。 */ input: AuthEmailInput): Promise<AuthMessage> {
      // 使旧注册验证码失效，不公开账户存在性或任何验证码。
      requireMailer()
      const fields = inputReadObject(input, ['email'], 'resendVerification')
      await sendChallenge(readEmail(fields.email), 'verify-email')
      return { message: AccountMessage.VERIFICATION_SENT }
    },
    async login(/* 邮箱密码与明确的记住我选项。 */ input: AuthLoginInput): Promise<AuthSession> {
      // 验证密码并写入用户授权栅栏，防止并发停用或改密后继续签发旧身份会话。
      const fields = inputReadObject(input, ['email', 'password', 'remember'], 'login')
      const email = readEmail(fields.email), password = inputReadString(fields.password, 'password'), remember = readRemember(fields.remember)
      return database.transaction(async (/* 密码校验和凭据签发不可分离的事务。 */ session) => {
        // 重试事务时重新读取密码和启用状态，使用当前有效身份签发会话。
        const user = await users.first({ emailNormalized: email }, session)
        if (!user || user.disabled || !user.passwordHash || !await requirePasswords().verify(user.passwordHash, password)) {
          throw new GraphError(401, 'INVALID_CREDENTIALS', AccountMessage.INVALID_CREDENTIALS)
        }
        if (!user.emailVerifiedAt) throw new GraphError(403, 'EMAIL_NOT_VERIFIED', AccountMessage.EMAIL_NOT_VERIFIED)
        await users.replace({ ...user, writeFence: user.writeFence + 1 }, session)
        return issueSession(user, session, remember)
      })
    },
    async loginUsername(/* 用户名、原始密码和明确的记住我选项。 */ input: AuthLoginUsernameInput): Promise<AuthSession> {
      // 与邮箱登录使用相同用户栅栏和会话签发，用户名账户不要求邮件服务。
      const fields = inputReadObject(input, ['username', 'password', 'remember'], 'loginUsername')
      const username = readUsername(fields.username), password = inputReadString(fields.password, 'password'), remember = readRemember(fields.remember)
      return database.transaction(async (/* 密码校验和凭据签发不可分离的事务。 */ session) => {
        // 重试时重新验证启用状态和密码，不沿用撤权前的身份快照。
        const user = await users.first({ usernameNormalized: username }, session)
        if (!user || user.disabled || !user.passwordHash || !await requirePasswords().verify(user.passwordHash, password)) {
          throw new GraphError(401, 'INVALID_CREDENTIALS', AccountMessage.USERNAME_INVALID_CREDENTIALS)
        }
        await users.replace({ ...user, writeFence: user.writeFence + 1 }, session)
        return issueSession(user, session, remember)
      })
    },
    async refresh(/* 本设备当前持有的原始刷新凭据。 */ input: AuthRefreshInput): Promise<AuthSession> {
      // 在原会话到期时间内一次性轮换，拒绝重放并撤销上一代access。
      const fields = inputReadObject(input, ['refreshToken'], 'refresh'), raw = inputReadString(fields.refreshToken, 'refreshToken')
      const sessionId = raw.split('.')[0]
      return database.transaction(async (/* 刷新令牌消费与新会话签发共用的事务。 */ session) => {
        // 同时写用户和会话栅栏，使并发停用、改密与轮换有明确提交顺序。
        const current = await sessions.get(sessionId, session), user = current ? await users.get(current.userId, session) : null
        if (!current || current.refreshHash !== hashSecret(raw) || current.revokedAt || !(Date.parse(current.expiresAt) > await database.now()) || !user || user.disabled || !(user.emailVerifiedAt || user.usernameNormalized)) {
          throw new GraphError(401, 'INVALID_REFRESH_TOKEN', AccountMessage.INVALID_REFRESH_TOKEN)
        }
        await users.replace({ ...user, writeFence: user.writeFence + 1 }, session)
        await sessions.replace({ ...current, revokedAt: new Date(await database.now()).toISOString(), writeFence: current.writeFence + 1 }, session)
        for (const token of await tokens.list({ sessionId: current._id, revoked: false }, session)) await tokens.replace({ ...token, revoked: true, writeFence: token.writeFence + 1 }, session)
        return issueSession(user, session, false, current.expiresAt)
      })
    },
    async forgotPassword(/* 请求找回密码的邮箱，不透露其存在性。 */ input: AuthEmailInput): Promise<AuthMessage> {
      // 只向已验证启用账户发送重置邮件，公开回应始终一致。
      requireMailer()
      const fields = inputReadObject(input, ['email'], 'forgotPassword')
      await sendChallenge(readEmail(fields.email), 'reset-password')
      return { message: AccountMessage.RESET_SENT }
    },
    async resetPassword(/* 邮件重置码与已符合长度规则的新密码。 */ input: AuthResetPasswordInput): Promise<AuthMessage> {
      // 消费重置码后原子替换密码并撤销账户会话，错误短码次数也必须提交。
      requireMailer()
      const fields = inputReadObject(input, ['email', 'code', 'password'], 'resetPassword')
      const email = readEmail(fields.email), code = readCode(fields.code), passwordHash = await requirePasswords().hash(readPassword(fields.password))
      const result = await database.transaction<ChallengeResult>(async (/* 重置码消费、改密和撤销会话共用事务。 */ session) => {
        // 不允许重置未验证或已停用账户。
        const user = await users.first({ emailNormalized: email }, session)
        if (!user || user.disabled || !user.emailVerifiedAt) return { ok: false, code: 'INVALID_CODE' }
        const challenge = await consumeChallenge(user, 'reset-password', code, session)
        if (!challenge.ok) return challenge
        await revokeAccountSessions(user._id, session)
        await users.replace({ ...user, passwordHash, writeFence: user.writeFence + 1 }, session)
        return { ok: true }
      })
      if (!result.ok) throw challengeFailure(result)
      return { message: AccountMessage.PASSWORD_RESET }
    },
    async changePassword(
      /* 本次改密必须在事务内重新鉴权的访问令牌。 */ token: string,
      /* 原密码、新密码和新设备会话期限。 */ input: AuthChangePasswordInput,
    ): Promise<AuthSession> {
      // 用当前密码及有效访问授权改密，旧账户会话全部撤销后仅给当前设备新会话。
      const fields = inputReadObject(input, ['currentPassword', 'newPassword', 'remember'], 'changePassword')
      const currentPassword = inputReadString(fields.currentPassword, 'currentPassword'), remember = readRemember(fields.remember)
      const passwordHash = await requirePasswords().hash(readPassword(fields.newPassword))
      return database.transaction(async (/* 鉴权、密码校验、撤销与签发共用事务。 */ session) => {
        // 事务重试重新验证令牌和当前密码，不能沿用撤权前读到的身份。
        const { record, user } = await authReadIdentity(token, session)
        if (!user.passwordHash || !await requirePasswords().verify(user.passwordHash, currentPassword)) throw new GraphError(401, 'INVALID_CREDENTIALS', AccountMessage.INVALID_CURRENT_PASSWORD)
        await tokens.replace({ ...record, writeFence: record.writeFence + 1 }, session)
        await revokeAccountSessions(user._id, session)
        const updated = { ...user, passwordHash, writeFence: user.writeFence + 1 }
        await users.replace(updated, session)
        return issueSession(updated, session, remember)
      })
    },
    async logout(/* 当前设备需要撤销的有效访问令牌。 */ token: string): Promise<void> {
      // 撤销当前会话access及refresh；旧手工令牌退出仅撤销该令牌。
      await database.transaction(async (/* 退出凭据撤销共用事务。 */ session) => {
        // 与现有授权写入使用相同的令牌栅栏。
        const { record } = await authReadIdentity(token, session)
        await tokens.replace({ ...record, revoked: true, writeFence: record.writeFence + 1 }, session)
        if (record.sessionId) {
          const current = await sessions.get(record.sessionId, session)
          if (current && !current.revokedAt) await sessions.replace({ ...current, revokedAt: new Date(await database.now()).toISOString(), writeFence: current.writeFence + 1 }, session)
        }
      })
    },
    /**
     * 验证令牌并建立只读请求身份，不取得业务写入授权。
     *
     * @param token 需要验证并转换为只读请求身份的用户令牌。
     */
    async read(token: string): Promise<RequestContext> {
      const { actor } = await authReadIdentity(token, null)
      return { actor, session: null, mutation: false }
    },
    /**
     * 在同一事务中验证身份、锁定授权版本并执行写命令，防止并发撤权后仍提交。
     *
     * @param token 写请求携带、需要在事务内再次验证的用户令牌。
     * @param callback 在身份和授权栅栏已锁定后执行实际业务写入的回调。
     */
    async transact<T>(
      /* 在实际写事务内校验的用户令牌。 */ token: string,
      /* 取得身份写栅栏后、共享当前活动事务的业务写入。 */ callback: (
        /* 已认证且必定携带活动写事务的上下文。 */ ctx: MutationContext,
      ) => Promise<T>,
    ): Promise<T> {
      // 让业务回调的类型直接表达这里建立的活动写事务和已锁定写入身份。
      return database.transaction(async session => {
        // 将令牌、用户的授权栅栏写入与业务回调一起提交或回滚。
        const { record, actor } = await authReadIdentity(token, session)
        // 即使业务不修改身份，也必须写入两条记录，使撤销令牌或停用用户与本次写入冲突。
        await tokens.replace({ ...record, writeFence: record.writeFence + 1 }, session)
        await users.change(actor.userId, user => /* 取得本次事务使用的用户授权版本。 */ ({ ...user, writeFence: user.writeFence + 1 }), session)
        return callback({ actor, session, mutation: true })
      })
    },
    /**
     * 校验用户身份字段，并在管理员变更事务中建立未停用的账户。
     *
     * @param input 管理员提供的新用户身份、显示名及管理员标记。
     */
    async createUser(input: { id: string; displayName: string; hostAdmin: boolean }): Promise<Identity> {
      const id = inputReadId(input.id, 'id'), displayName = inputReadString(input.displayName, 'displayName').trim()
      if (typeof input.hostAdmin !== 'boolean') throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.HOSTADMIN_MUST_BE_BOOLEAN)
      return database.transaction(async session => {
        // 串行化管理员集合变更，并拒绝重复用户身份。
        await touchAdmin(session)
        if (await users.get(id, session)) throw new GraphError(409, 'USER_EXISTS', RuntimeMessage.USER_ALREADY_EXISTS)
        await users.insert({ _id: id, displayName, hostAdmin: input.hostAdmin, disabled: false, writeFence: 0 }, session)
        return { userId: id, displayName, hostAdmin: input.hostAdmin }
      })
    },
    /**
     * 为已启用用户生成随机令牌，只持久化哈希并向调用者返回原始令牌。
     *
     * @param userId 需要签发新令牌的现有用户身份。
     */
    async createToken(userId: string): Promise<{ tokenId: string; token: string }> {
      inputReadId(userId, 'userId')
      const token = randomBytes(32).toString('base64url'), tokenId = randomUUID()
      await database.transaction(async session => {
        // 将用户启用状态与令牌创建绑定，防止并发停用期间签发新令牌。
        const user = await users.change(userId, user => /* 仅为已启用用户推进签发令牌所需的授权栅栏。 */ user.disabled ? null : { ...user, writeFence: user.writeFence + 1 }, session)
        if (!user) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.ENABLED_USER_NOT_FOUND)
        await tokens.insert({ _id: tokenId, userId, hash: createHash('sha256').update(token).digest('hex'),
          revoked: false, expiresAt: null, createdAt: new Date().toISOString(), writeFence: 0 }, session)
      })
      return { tokenId, token }
    },
    /**
     * 标记令牌已撤销，并推进栅栏以阻止并发使用该凭据的写入。
     *
     * @param tokenId 需要撤销且以后不得通过认证的令牌记录身份。
     */
    async revokeToken(tokenId: string): Promise<void> {
      inputReadId(tokenId, 'tokenId')
      if (!await tokens.change(tokenId, doc => /* 撤销凭据并使旧授权事务发生写冲突。 */ ({ ...doc, revoked: true, writeFence: doc.writeFence + 1 }))) throw new GraphError(404, 'TOKEN_NOT_FOUND', RuntimeMessage.TOKEN_NOT_FOUND)
    },
    /**
     * 停用用户并推进授权栅栏，同时保证至少保留一名启用的 HostAdmin。
     *
     * @param userId 需要停用的用户身份。
     */
    async disableUser(userId: string): Promise<void> {
      inputReadId(userId, 'userId')
      await database.transaction(async session => {
        // 先取得管理员共用栅栏，再检查人数，避免并发请求各自停用最后剩余的管理员。
        await touchAdmin(session)
        const user = await users.get(userId, session)
        if (!user) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.USER_NOT_FOUND)
        if (user.hostAdmin && !user.disabled && (await users.list({ hostAdmin: true, disabled: false }, session)).length <= 1) throw new GraphError(409, 'LAST_ADMIN', RuntimeMessage.THE_LAST_ENABLED_HOSTADMIN_CANNOT_BE_DISABLED)
        await users.replace({ ...user, disabled: true, writeFence: user.writeFence + 1 }, session)
      })
    },
    /**
     * 恢复已有用户的启用状态并推进授权栅栏。
     *
     * @param userId 需要恢复启用状态的现有用户身份。
     */
    async enableUser(userId: string): Promise<void> {
      inputReadId(userId, 'userId')
      if (!await users.change(userId, user => /* 启用账户并使身份版本随状态变更推进。 */ ({ ...user, disabled: false, writeFence: user.writeFence + 1 }))) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.USER_NOT_FOUND)
    },
  }
}
export type AuthService = ReturnType<typeof authCreateService>
