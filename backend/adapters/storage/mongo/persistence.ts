import { RuntimeMessage } from '../../../../contracts/messages'
import { mongo, type ClientSession, type Connection } from 'mongoose'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Persistence, StorageRecords, StorageSession, RecordFilter } from '../../../ports/persistence'
import { GraphError } from '../../../modules/shared/domain-error'
import { storeCreateGraphStore } from './graph-store'

// 用途：创建当前模块，供后续流程使用。
export function persistenceCreateMongo(connection: Connection): Persistence {
  if (!connection.db) throw new Error(RuntimeMessage.MONGO_CONNECTION_IS_NOT_READY)
  const bucket = new mongo.GridFSBucket(connection.db, { bucketName: 'asset_blobs' })
  // 用途：读取会话，并把结构化结果交给调用方。
  function persistenceReadSession(session?: StorageSession | null) { return session as ClientSession | undefined }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  async function transaction<T>(callback: (session: StorageSession) => Promise<T>): Promise<T> {
    const session = await connection.startSession()
    try { return await session.withTransaction(() => callback(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', wtimeoutMS: 5000 }, readPreference: 'primary',
    }) } finally { await session.endSession() }
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  function records<T extends { _id: string }>(name: string): StorageRecords<T> {
    const collection = connection.collection<{ _id: string }>(name)
    const copy = (value: unknown): T => JSON.parse(JSON.stringify(value))
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    function persistenceWriteRecord(document: T) {
      const value: Record<string, unknown> & { _id: string } = { ...document }
      if (name === 'control_tokens') {
        value.createdAt = new Date(String(value.createdAt))
        if (value.expiresAt !== null) value.expiresAt = new Date(String(value.expiresAt))
      }
      if (name === 'control_assets') value.blobId = new mongo.ObjectId(String(value.blobId))
      return value
    }
    const options = (session?: StorageSession | null) => ({ session: persistenceReadSession(session) })
    const filter = (value: RecordFilter) => Object.fromEntries(Object.entries(value).map(([key, value]) => [key, Array.isArray(value) ? { $in: value } : value]))
    return {
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async get(id, session) { const row = await collection.findOne({ _id: id }, options(session)); return row ? copy(row) : null },
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async first(query, session) { const row = await collection.findOne(filter(query), options(session)); return row ? copy(row) : null },
      count: (query = {}, session) => collection.countDocuments(filter(query), options(session)),
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async list(query = {}, session) { return (await collection.find(filter(query), options(session)).toArray()).map(copy) },
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async insert(document, session) { await collection.insertOne(persistenceWriteRecord(document), options(session)) },
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async replace(document, session) { await collection.replaceOne({ _id: document._id }, persistenceWriteRecord(document), options(session)) },
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async change(id, update, session) {
        if (!session) return transaction(tx => records<T>(name).change(id, update, tx))
        const row = await records<T>(name).get(id, session)
        const next = row && update(row)
        if (next) await records<T>(name).replace(next, session)
        return next
      },
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async index(fields, settings) { await collection.createIndex(Object.fromEntries(fields.map(field => [field, 1])), settings) },
    }
  }
  return {
    records, transaction,
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async initialize() {
      const hello = await connection.db!.admin().command({ hello: 1 })
      if (!hello.setName && hello.msg !== 'isdbgrid') throw new GraphError(503, 'TRANSACTIONS_REQUIRED', RuntimeMessage.USER_MANAGEMENT_REQUIRES_A_MONGO_REPLICA_SET)
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async now() { return (await connection.db!.admin().command({ hello: 1 })).localTime.getTime() },
    graph: session => storeCreateGraphStore(connection, persistenceReadSession(session) ?? null),
    blobs: {
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async write(source, filename) {
        const upload = bucket.openUploadStream(filename)
        try { await pipeline(Readable.from(source), upload); return upload.id.toHexString() }
        catch (error) { await upload.abort().catch(() => {}); throw error }
      },
      read: id => bucket.openDownloadStream(new mongo.ObjectId(id)),
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async remove(id) {
        try { await bucket.delete(new mongo.ObjectId(id)); return true }
        catch (error) { if (error instanceof mongo.MongoRuntimeError && error.message.startsWith('File not found for id ')) return false; throw error }
      },
    },
  }
}
