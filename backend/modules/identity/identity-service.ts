// 管理用户和令牌，并用事务写栅栏协调写入授权与并发撤权。
import { RuntimeMessage } from '../../../contracts/messages'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Identity } from '../../../contracts/control'
import type { Persistence, StorageSession } from '../../ports/persistence'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadString } from '../shared/input-validation'

export interface RequestContext { actor: Identity; session: StorageSession | null; mutation: boolean }
interface UserDocument { _id: string; displayName: string; hostAdmin: boolean; disabled: boolean; writeFence: number }
interface TokenDocument { _id: string; userId: string; hash: string; revoked: boolean; expiresAt: string | null; createdAt: string; writeFence: number }

/**
 * 组装用户与令牌管理，并通过同一存储事务协调身份验证、业务写入和并发撤权。
 *
 * @param database 提供用户、令牌、事务和存储时钟的持久化适配器。
 */
export function authCreateService(database: Persistence) {
  const users = database.records<UserDocument>('control_users')
  const tokens = database.records<TokenDocument>('control_tokens')
  const admin = database.records<{ _id: string; writeFence: number }>('control_admin')
  /**
   * 按令牌哈希查询未撤销凭据，并验证到期时间及用户启用状态后返回身份。
   *
   * @param token 公共请求携带的原始用户令牌；只计算摘要，不持久化明文。
   * @param session 用于在同一事务快照内读取身份的会话；只读请求传 null。
   */
  async function authReadIdentity(token: string, session: StorageSession | null) {
    const hash = createHash('sha256').update(token).digest('hex')
    const record = token ? await tokens.first({ hash, revoked: false }, session) : null
    const user = record ? await users.get(record.userId, session) : null
    // null 表示不过期；其余时间必须晚于存储时钟，无效日期也会被拒绝。
    const expiresAt = record?.expiresAt === null ? Infinity : Date.parse(record?.expiresAt ?? '')
    if (!record || (record.expiresAt !== null && !(expiresAt > await database.now())) || !user || user.disabled) {
      throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.A_VALID_USER_TOKEN_IS_REQUIRED)
    }
    const actor: Identity = { userId: user._id, displayName: user.displayName, hostAdmin: user.hostAdmin }
    return { record, actor }
  }
  /**
   * @param session 管理员集合变更必须参与的活动存储事务。
   */
  const touchAdmin = (session: StorageSession) =>
    /* 写入共用管理员栅栏，使管理员增减在事务中互斥。 */
    admin.change('root', doc => /* 推进栅栏，让并发管理员变更发生写冲突。 */ ({ ...doc, writeFence: doc.writeFence + 1 }), session)
  return {
    async initialize(): Promise<void> {
      // 初始化身份存储索引与管理员栅栏，供令牌查询和管理员变更使用。
      await database.initialize()
      await tokens.index(['hash'], { unique: true })
      await users.index(['hostAdmin', 'disabled'])
      await database.transaction(async session => {
        // 仅在首次初始化时建立管理员共用栅栏。
        if (!await admin.get('root', session)) await admin.insert({ _id: 'root', writeFence: 0 }, session)
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
    async transact<T>(token: string, callback: (ctx: RequestContext) => Promise<T>): Promise<T> {
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
