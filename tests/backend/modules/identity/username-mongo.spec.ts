// 用真实Mongo副本集验证新增稀疏用户名索引兼容旧用户，保留唯一约束。
import { randomUUID } from 'node:crypto'
import { MongoMemoryReplSet } from 'mongodb-memory-server'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { persistenceCreateMongo } from '../../../../backend/adapters/storage/mongo/persistence'
import { accountCreatePasswords } from '../../../../backend/adapters/identity/argon2-passwords'
import { authCreateService } from '../../../../backend/modules/identity/identity-service'

let mongo: MongoMemoryReplSet
let connection: Awaited<ReturnType<typeof storeCreateConnection>>
beforeAll(async () => {
  // 本文件只取得自己的副本集和数据库，不依赖消息代理或开发服务。
  mongo = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  connection = await storeCreateConnection(mongo.getUri('username_index_test'))
})
afterAll(async () => {
  // 连接先关闭，再停止本文件创建的Mongo。
  await connection?.close()
  await mongo?.stop()
})

it('adds a sparse unique username index over legacy users and keeps email, username and manual-token identities distinct', async () => {
  const database = persistenceCreateMongo(connection), users = database.records<{ _id: string; displayName: string; hostAdmin: boolean; disabled: boolean; writeFence: number; emailNormalized?: string; usernameNormalized?: string }>('control_users')
  const oldIds = [randomUUID(), randomUUID()]
  for (const id of oldIds) await users.insert({ _id: id, displayName: '原用户', hostAdmin: false, disabled: false, writeFence: 0 })
  for (const emailNormalized of ['first@example.test', 'second@example.test']) {
    await users.insert({ _id: randomUUID(), displayName: '邮箱用户', hostAdmin: false, disabled: false, writeFence: 0, emailNormalized })
  }
  const auth = authCreateService(database, { passwords: accountCreatePasswords() })
  await auth.initialize()
  const created = await auth.registerUsername({ username: ' Mixed-Reader ', displayName: '用户名用户', password: 'mongo-username-password-2026', remember: false })
  expect(created.identity.hostAdmin).toBe(false)
  await expect(auth.registerUsername({ username: 'mixed-reader', displayName: '重复', password: 'mongo-username-password-2026', remember: false }))
    .rejects.toMatchObject({ code: 'USERNAME_EXISTS' })
  const index = (await connection.collection('control_users').indexes()).find((/* 实际Mongo索引元数据。 */ item) => item.name === 'usernameNormalized_1')
  expect(index).toMatchObject({ unique: true, sparse: true })
  await expect(users.insert({ _id: randomUUID(), displayName: '绕过服务的重复用户名', hostAdmin: false, disabled: false, writeFence: 0, usernameNormalized: 'mixed-reader' }))
    .rejects.toMatchObject({ code: 11000 })
  expect(await users.count()).toBe(5)
  for (const id of oldIds) {
    const manual = await auth.createToken(id)
    await expect(auth.read(manual.token)).resolves.toHaveProperty('actor.userId', id)
  }
})
