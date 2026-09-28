// 文件职责：将记录、事务、图存储与 GridFS 文件流接入统一持久化接口。
import { RuntimeMessage } from '../../../../contracts/messages'
import { mongo, type ClientSession, type Connection } from 'mongoose'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Persistence, StorageRecords, StorageSession, RecordFilter } from '../../../ports/persistence'
import { GraphError } from '../../../modules/shared/domain-error'
import { storeCreateGraphStore } from './graph-store'
export function persistenceCreateMongo(/* 由部署入口建立并负责关闭的 Mongo 连接，必须已经就绪。 */ connection: Connection): Persistence {
  // 绑定已就绪的 Mongo 连接，提供事务化记录访问和 GridFS 附件存储。
  if (!connection.db) throw new Error(RuntimeMessage.MONGO_CONNECTION_IS_NOT_READY)
  const bucket = new mongo.GridFSBucket(connection.db, { bucketName: 'asset_blobs' })
  function persistenceReadSession(/* 调用方传入的统一事务会话；未提供或为 null 时不附加事务。 */ session?: StorageSession | null) {
    // 将统一会话接口还原为本适配器创建的 Mongo 会话。
     return session as ClientSession | undefined }
  async function transaction<T>(/* 事务内业务操作，驱动可能重试回调，所有数据库动作应使用提供的会话。 */ callback: (/* 本次 Mongo 事务会话，仅在回调期间有效且不得由业务层结束。 */ session: StorageSession) => Promise<T>): Promise<T> {
    // 在快照隔离和多数派提交下执行回调，并在所有路径结束会话。
    const session = await connection.startSession()
    try { return await session.withTransaction(() => /* 让驱动在事务重试时重新执行同一业务回调。 */  callback(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', wtimeoutMS: 5000 }, readPreference: 'primary',
    }) } finally { await session.endSession() }
  }
  function records<T extends { _id: string }>(/* 由业务模块固定选择的记录集合名，不直接接受客户端表名。 */ name: string): StorageRecords<T> {
    // 为指定集合构造记录访问器，保持统一的 JSON 数据形状与会话传递。
    const collection = connection.collection<{ _id: string }>(name)
    const copy = (/* Mongo 返回的 BSON 记录，将经 JSON 转换复制给业务层。 */ value: unknown): T => /* 把 BSON 值转换为独立 JSON 副本，避免向业务层泄露驱动对象。 */  JSON.parse(JSON.stringify(value))
    function persistenceWriteRecord(/* 待写入业务记录，转换时建立新对象以保留调用方输入。 */ document: T) {
      // 把令牌日期与附件 ObjectId 转换为 Mongo 需要的存储类型。
      const value: Record<string, unknown> & { _id: string } = { ...document }
      if (name === 'control_tokens') {
        value.createdAt = new Date(String(value.createdAt))
        if (value.expiresAt !== null) value.expiresAt = new Date(String(value.expiresAt))
      }
      if (name === 'control_assets') value.blobId = new mongo.ObjectId(String(value.blobId))
      return value
    }
    const options = (/* 可选统一会话，转换为 Mongo 操作选项。 */ session?: StorageSession | null) => /* 将可选统一会话包装为 Mongo 操作选项。 */  ({ session: persistenceReadSession(session) })
    const filter = (/* 统一记录查询条件，数组表示该字段允许的值集合。 */ value: RecordFilter) => /* 把统一记录过滤器中的数组条件转换为 Mongo 的集合匹配。 */  Object.fromEntries(Object.entries(value).map((/* 查询条件中的字段名和值；数组值将转换为 Mongo $in 条件。 */ [key, value]) => /* 将单字段的数组值解释为允许值集合，其余值使用等值条件。 */  [key, Array.isArray(value) ? { $in: value } : value]))
    return {
      async get(/* 目标记录的字符串主键。 */ id, /* 可选调用方事务会话，控制本次读取的快照。 */ session) {
        // 按主键读取记录，不存在时返回 null。
         const row = await collection.findOne({ _id: id }, options(session)); return row ? copy(row) : null },
      async first(/* 用于寻找首条记录的统一过滤条件。 */ query, /* 可选读取会话，沿用调用方事务视图。 */ session) {
        // 读取首个满足过滤条件的记录，并返回独立副本。
         const row = await collection.findOne(filter(query), options(session)); return row ? copy(row) : null },
      count: (/* 计数过滤条件，默认空对象表示当前集合全部记录。 */ query = {}, /* 可选事务会话，计数使用其快照。 */ session) => /* 在指定会话中统计符合条件的记录数量。 */  collection.countDocuments(filter(query), options(session)),
      async list(/* 列表过滤条件，默认空对象表示不额外限制记录。 */ query = {}, /* 可选事务会话，列表读取沿用同一快照。 */ session) {
        // 读取所有匹配记录，并统一转换日期和 BSON 值。
         return (await collection.find(filter(query), options(session)).toArray()).map(copy) },
      async insert(/* 待插入的完整业务记录，含字符串 _id。 */ document, /* 可选写事务会话，插入与调用方其他业务写入一起提交。 */ session) {
        // 按集合规则转换记录后插入，唯一性冲突由 Mongo 报告。
         await collection.insertOne(persistenceWriteRecord(document), options(session)) },
      async replace(/* 待保存的完整替换记录，按其中 _id 定位旧文档。 */ document, /* 可选外部事务会话，控制替换操作的提交范围。 */ session) {
        // 按记录主键替换文档，沿用调用方事务。
         await collection.replaceOne({ _id: document._id }, persistenceWriteRecord(document), options(session)) },
      async change(/* 要读取并原子更新的记录主键。 */ id, /* 在事务内处理记录副本的更新器，返回空值表示放弃修改。 */ update, /* 可选现有事务；未提供时为完整读取修改流程创建新事务。 */ session) {
        // 在事务中读取并应用更新，更新器返回空值时不写入。
        if (!session) return transaction(/* 本适配器为本次更新建立的事务会话，递归调用必须沿用。 */ tx => /* 缺少外部会话时在新事务内重新执行本次记录更新。 */  records<T>(name).change(id, update, tx))
        const row = await records<T>(name).get(id, session)
        const next = row && update(row)
        if (next) await records<T>(name).replace(next, session)
        return next
      },
      async index(/* 索引字段名及其顺序，由业务初始化配置决定。 */ fields, /* 索引选项，可声明唯一约束等 Mongo 支持的设置。 */ settings) {
        // 按给定字段顺序建立索引，并沿用唯一性等配置。
         await collection.createIndex(Object.fromEntries(fields.map(/* 当前索引中的单个字段名，映射为升序键。 */ field => /* 为每个索引字段声明升序排列。 */  [field, 1])), settings) },
    }
  }
  return {
    records, transaction,
    async initialize() {
      // 检查部署支持事务，拒绝既非副本集也非分片路由的独立 Mongo。
      const hello = await connection.db!.admin().command({ hello: 1 })
      if (!hello.setName && hello.msg !== 'isdbgrid') throw new GraphError(503, 'TRANSACTIONS_REQUIRED', RuntimeMessage.USER_MANAGEMENT_REQUIRES_A_MONGO_REPLICA_SET)
    },
    async now() {
      // 读取数据库服务器时间，避免授权到期依赖客户端时钟。
       return (await connection.db!.admin().command({ hello: 1 })).localTime.getTime() },
    graph: /* 可选统一会话，创建的图存储沿用该事务而不自行结束。 */ session => /* 创建沿用当前会话的图存储适配器。 */  storeCreateGraphStore(connection, persistenceReadSession(session) ?? null),
    blobs: {
      async write(/* 调用方提供的附件字节流，交给 pipeline 消费并写入 GridFS。 */ source, /* 附件原始文件名，仅作为 GridFS 元数据保存。 */ filename) {
        // 将输入流写入 GridFS，成功返回文件身份，失败时中止未完成上传。
        const upload = bucket.openUploadStream(filename)
        try { await pipeline(Readable.from(source), upload); return upload.id.toHexString() }
        catch (error) { await upload.abort().catch(() => {
          // 中止上传失败时保留原始流错误，避免清理异常覆盖原因。
        }); throw error }
      },
      read: /* 附件存储身份的十六进制 ObjectId 文本，用于打开下载流。 */ id => /* 按 GridFS 文件身份打开下载流，由调用者消费和关闭。 */  bucket.openDownloadStream(new mongo.ObjectId(id)),
      async remove(/* 待删除 GridFS 附件的 ObjectId 文本，文件不存在时返回 false。 */ id) {
        // 删除 GridFS 文件，文件已不存在时返回 false，其余故障继续抛出。
        try { await bucket.delete(new mongo.ObjectId(id)); return true }
        catch (error) { if (error instanceof mongo.MongoRuntimeError && error.message.startsWith('File not found for id ')) return false; throw error }
      },
    },
  }
}
