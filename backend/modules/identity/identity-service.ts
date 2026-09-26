import { RuntimeMessage } from '../../../contracts/messages'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { Identity } from '../../../contracts/control'
import type { Persistence, StorageSession } from '../../ports/persistence'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadString } from '../shared/input-validation'

export interface RequestContext { actor: Identity; session: StorageSession | null; mutation: boolean }
interface UserDocument { _id: string; displayName: string; hostAdmin: boolean; disabled: boolean; writeFence: number }
interface TokenDocument { _id: string; userId: string; hash: string; revoked: boolean; expiresAt: string | null; createdAt: string; writeFence: number }

// 用途：创建服务，供后续流程使用。
export function authCreateService(database: Persistence) {
  const users = database.records<UserDocument>('control_users')
  const tokens = database.records<TokenDocument>('control_tokens')
  const admin = database.records<{ _id: string; writeFence: number }>('control_admin')
  // 用途：读取身份，并把结构化结果交给调用方。
  async function authReadIdentity(token: string, session: StorageSession | null) {
    const hash = createHash('sha256').update(token).digest('hex')
    const record = token ? await tokens.first({ hash, revoked: false }, session) : null
    const user = record ? await users.get(record.userId, session) : null
    const expiresAt = record?.expiresAt === null ? Infinity : Date.parse(record?.expiresAt ?? '')
    if (!record || (record.expiresAt !== null && !(expiresAt > await database.now())) || !user || user.disabled) {
      throw new GraphError(401, 'UNAUTHORIZED', RuntimeMessage.A_VALID_USER_TOKEN_IS_REQUIRED)
    }
    const actor: Identity = { userId: user._id, displayName: user.displayName, hostAdmin: user.hostAdmin }
    return { record, actor }
  }
  const touchAdmin = (session: StorageSession) => admin.change('root', doc => ({ ...doc, writeFence: doc.writeFence + 1 }), session)
  return {
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize(): Promise<void> {
      await database.initialize()
      await tokens.index(['hash'], { unique: true })
      await users.index(['hostAdmin', 'disabled'])
      await database.transaction(async session => { if (!await admin.get('root', session)) await admin.insert({ _id: 'root', writeFence: 0 }, session) })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async read(token: string): Promise<RequestContext> {
      const { actor } = await authReadIdentity(token, null)
      return { actor, session: null, mutation: false }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async transact<T>(token: string, callback: (ctx: RequestContext) => Promise<T>): Promise<T> {
      return database.transaction(async session => {
        const { record, actor } = await authReadIdentity(token, session)
        await tokens.replace({ ...record, writeFence: record.writeFence + 1 }, session)
        await users.change(actor.userId, user => ({ ...user, writeFence: user.writeFence + 1 }), session)
        return callback({ actor, session, mutation: true })
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async createUser(input: { id: string; displayName: string; hostAdmin: boolean }): Promise<Identity> {
      const id = inputReadId(input.id, 'id'), displayName = inputReadString(input.displayName, 'displayName').trim()
      if (typeof input.hostAdmin !== 'boolean') throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.HOSTADMIN_MUST_BE_BOOLEAN)
      return database.transaction(async session => {
        await touchAdmin(session)
        if (await users.get(id, session)) throw new GraphError(409, 'USER_EXISTS', RuntimeMessage.USER_ALREADY_EXISTS)
        await users.insert({ _id: id, displayName, hostAdmin: input.hostAdmin, disabled: false, writeFence: 0 }, session)
        return { userId: id, displayName, hostAdmin: input.hostAdmin }
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async createToken(userId: string): Promise<{ tokenId: string; token: string }> {
      inputReadId(userId, 'userId')
      const token = randomBytes(32).toString('base64url'), tokenId = randomUUID()
      await database.transaction(async session => {
        const user = await users.change(userId, user => user.disabled ? null : { ...user, writeFence: user.writeFence + 1 }, session)
        if (!user) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.ENABLED_USER_NOT_FOUND)
        await tokens.insert({ _id: tokenId, userId, hash: createHash('sha256').update(token).digest('hex'),
          revoked: false, expiresAt: null, createdAt: new Date().toISOString(), writeFence: 0 }, session)
      })
      return { tokenId, token }
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async revokeToken(tokenId: string): Promise<void> {
      inputReadId(tokenId, 'tokenId')
      if (!await tokens.change(tokenId, doc => ({ ...doc, revoked: true, writeFence: doc.writeFence + 1 }))) throw new GraphError(404, 'TOKEN_NOT_FOUND', RuntimeMessage.TOKEN_NOT_FOUND)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async disableUser(userId: string): Promise<void> {
      inputReadId(userId, 'userId')
      await database.transaction(async session => {
        await touchAdmin(session)
        const user = await users.get(userId, session)
        if (!user) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.USER_NOT_FOUND)
        if (user.hostAdmin && !user.disabled && (await users.list({ hostAdmin: true, disabled: false }, session)).length <= 1) throw new GraphError(409, 'LAST_ADMIN', RuntimeMessage.THE_LAST_ENABLED_HOSTADMIN_CANNOT_BE_DISABLED)
        await users.replace({ ...user, disabled: true, writeFence: user.writeFence + 1 }, session)
      })
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async enableUser(userId: string): Promise<void> {
      inputReadId(userId, 'userId')
      if (!await users.change(userId, user => ({ ...user, disabled: false, writeFence: user.writeFence + 1 }))) throw new GraphError(404, 'USER_NOT_FOUND', RuntimeMessage.USER_NOT_FOUND)
    },
  }
}
export type AuthService = ReturnType<typeof authCreateService>
