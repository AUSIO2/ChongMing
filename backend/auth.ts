import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ClientSession, Connection } from 'mongoose'
import type { Identity } from '../contracts/control'
import { GraphError } from './graph-error'
import { inputReadId, inputReadString } from './input'

export interface RequestContext { actor: Identity; session: ClientSession | null; mutation: boolean }
interface UserDocument { _id: string; displayName: string; hostAdmin: boolean; disabled: boolean; writeFence: number }
interface TokenDocument { _id: string; userId: string; hash: string; revoked: boolean; expiresAt: Date | null; createdAt: Date; writeFence: number }

export function authCreateService(connection: Connection) {
  const users = connection.collection<UserDocument>('control_users')
  const tokens = connection.collection<TokenDocument>('control_tokens')
  const admin = connection.collection<{ _id: string; writeFence: number }>('control_admin')

  async function authReadIdentity(token: string, session: ClientSession | null) {
    const hash = createHash('sha256').update(token).digest('hex')
    const record = token ? await tokens.findOne({ hash, revoked: false,
      $or: [{ expiresAt: null }, { $expr: { $gt: ['$expiresAt', '$$NOW'] } }],
    }, { session: session ?? undefined }) : null
    const user = record ? await users.findOne({ _id: record.userId, disabled: false }, { session: session ?? undefined }) : null
    if (!record || !user) throw new GraphError(401, 'UNAUTHORIZED', 'A valid user token is required')
    const actor: Identity = { userId: user._id, displayName: user.displayName, hostAdmin: user.hostAdmin }
    return { record, actor }
  }

  async function authRunTransaction<T>(callback: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await connection.startSession()
    try {
      return await session.withTransaction(() => callback(session), {
        readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', wtimeoutMS: 5000 }, readPreference: 'primary',
      })
    } finally { await session.endSession() }
  }

  return {
    async initialize(): Promise<void> {
      const hello = await connection.db!.admin().command({ hello: 1 })
      if (!hello.setName && hello.msg !== 'isdbgrid') throw new GraphError(503, 'TRANSACTIONS_REQUIRED', 'User management requires a Mongo replica set')
      await Promise.all([
        tokens.createIndex({ hash: 1 }, { unique: true }),
        users.createIndex({ hostAdmin: 1, disabled: 1 }),
        admin.updateOne({ _id: 'root' }, { $setOnInsert: { writeFence: 0 } }, { upsert: true }),
      ])
    },

    async read(token: string): Promise<RequestContext> {
      const { actor } = await authReadIdentity(token, null)
      return { actor, session: null, mutation: false }
    },

    async transact<T>(token: string, callback: (ctx: RequestContext) => Promise<T>): Promise<T> {
      return authRunTransaction(async session => {
        const { record, actor } = await authReadIdentity(token, session)
        // Real writes make token revocation/user disabling conflict with an in-flight mutation.
        const current = await tokens.updateOne({ _id: record._id, revoked: false,
          $or: [{ expiresAt: null }, { $expr: { $gt: ['$expiresAt', '$$NOW'] } }],
        }, { $inc: { writeFence: 1 } }, { session })
        const user = await users.updateOne({ _id: actor.userId, disabled: false }, { $inc: { writeFence: 1 } }, { session })
        if (current.matchedCount !== 1 || user.matchedCount !== 1) throw new GraphError(401, 'UNAUTHORIZED', 'User authorization changed')
        return callback({ actor, session, mutation: true })
      })
    },

    async createUser(input: { id: string; displayName: string; hostAdmin: boolean }): Promise<Identity> {
      const id = inputReadId(input.id, 'id')
      const displayName = inputReadString(input.displayName, 'displayName').trim()
      if (typeof input.hostAdmin !== 'boolean') throw new GraphError(400, 'INVALID_ARGUMENT', 'hostAdmin must be boolean')
      return authRunTransaction(async session => {
        await admin.updateOne({ _id: 'root' }, { $inc: { writeFence: 1 } }, { session })
        if (await users.findOne({ _id: id }, { session })) throw new GraphError(409, 'USER_EXISTS', 'User already exists')
        await users.insertOne({ _id: id, displayName, hostAdmin: input.hostAdmin, disabled: false, writeFence: 0 }, { session })
        return { userId: id, displayName, hostAdmin: input.hostAdmin }
      })
    },

    async createToken(userId: string): Promise<{ tokenId: string; token: string }> {
      inputReadId(userId, 'userId')
      const token = randomBytes(32).toString('base64url')
      const tokenId = randomUUID()
      await authRunTransaction(async session => {
        const user = await users.updateOne({ _id: userId, disabled: false }, { $inc: { writeFence: 1 } }, { session })
        if (!user.matchedCount) throw new GraphError(404, 'USER_NOT_FOUND', 'Enabled user not found')
        await tokens.insertOne({ _id: tokenId, userId, hash: createHash('sha256').update(token).digest('hex'),
          revoked: false, expiresAt: null, createdAt: new Date(), writeFence: 0,
        }, { session })
      })
      return { tokenId, token }
    },

    async revokeToken(tokenId: string): Promise<void> {
      inputReadId(tokenId, 'tokenId')
      const result = await tokens.updateOne({ _id: tokenId }, { $set: { revoked: true }, $inc: { writeFence: 1 } })
      if (!result.matchedCount) throw new GraphError(404, 'TOKEN_NOT_FOUND', 'Token not found')
    },

    async disableUser(userId: string): Promise<void> {
      inputReadId(userId, 'userId')
      await authRunTransaction(async session => {
        await admin.updateOne({ _id: 'root' }, { $inc: { writeFence: 1 } }, { session })
        const user = await users.findOne({ _id: userId }, { session })
        if (!user) throw new GraphError(404, 'USER_NOT_FOUND', 'User not found')
        if (user.hostAdmin && !user.disabled && await users.countDocuments({ hostAdmin: true, disabled: false }, { session }) <= 1) {
          throw new GraphError(409, 'LAST_ADMIN', 'The last enabled HostAdmin cannot be disabled')
        }
        await users.updateOne({ _id: userId }, { $set: { disabled: true }, $inc: { writeFence: 1 } }, { session })
      })
    },

    async enableUser(userId: string): Promise<void> {
      inputReadId(userId, 'userId')
      const result = await users.updateOne({ _id: userId }, { $set: { disabled: false }, $inc: { writeFence: 1 } })
      if (!result.matchedCount) throw new GraphError(404, 'USER_NOT_FOUND', 'User not found')
    },
  }
}

export type AuthService = ReturnType<typeof authCreateService>
