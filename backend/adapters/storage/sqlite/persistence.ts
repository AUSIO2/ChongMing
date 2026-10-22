// 文件职责：以本机 SQLite 和独立附件文件实现串行事务、记录查询与提交后通知。
import { RuntimeMessage } from '../../../../contracts/messages'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, mkdirSync, chmodSync, existsSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { Persistence, RecordFilter, StorageRecords, StorageSession, StorageChange, PersistenceEvents } from '../../../ports/persistence'
import { GraphError } from '../../../modules/shared/domain-error'
import { sqliteCreateGraphStore } from './graph-store'

export interface SqlitePersistence extends Persistence, PersistenceEvents {
  // 拒绝后续操作并等待在途数据库访问结束；重复关闭复用同一 Promise。
  close(): Promise<void>
}
/**
 * 打开受限权限的本机数据库，建立串行访问队列并管理事务、附件和提交监听。
 *
 * @param directory 本机持久化目录，函数在其中创建受限权限数据库与附件子目录。
 */
export function sqliteCreatePersistence(directory: string): SqlitePersistence {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const filename = path.join(directory, 'chongming.sqlite')
  const sqlite = new DatabaseSync(filename)
  try {
    // OS-managed exclusive locking survives process crashes without stale pid/lock files.
    sqlite.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;")
    const version = Number(sqlite.prepare('PRAGMA user_version').get()!.user_version)
    if (version !== 0 && version !== 1) throw new GraphError(409, 'DATABASE_SCHEMA_UNSUPPORTED', RuntimeMessage.SQLITE_SCHEMA_VERSION_IS_UNSUPPORTED)
    sqlite.exec("CREATE TABLE IF NOT EXISTS records (space TEXT NOT NULL, id TEXT NOT NULL, workspace TEXT, value TEXT NOT NULL, PRIMARY KEY(space,id)); CREATE INDEX IF NOT EXISTS record_workspace ON records(space,workspace); PRAGMA user_version=1;")
  } catch (error) { sqlite.close(); throw error }
  for (const file of [filename, filename + '-wal', filename + '-shm']) if (existsSync(file)) chmodSync(file, 0o600)
  const blobDirectory = path.join(directory, 'assets')
  mkdirSync(blobDirectory, { recursive: true, mode: 0o700 })
  let tail = Promise.resolve(), closed = false, closing = false, closeTask: Promise<void> | undefined
  const listeners = new Set<(changes: StorageChange[]) => void>()
  const sessions = new Set<StorageSession>()
  const dirty = new Map<StorageSession, Map<string, StorageChange>>()
  /**
   * 等待前次操作释放访问权，拒绝关闭后的请求，并确保失败也解除排队。
   *
   * @param callback 取得串行数据库访问权后执行的操作，结束或抛错都会释放后续等待。
   */
  async function sqliteRunGate<T>(callback: () => Promise<T> | T): Promise<T> {
    const previous = tail
    let unlock!: () => void
    tail = new Promise<void>(resolve => {
      // 保存本次串行访问的释放回调。
       unlock = resolve })
    await previous
    try { if (closed || closing) throw new Error(RuntimeMessage.SQLITE_DATABASE_IS_CLOSED); return await callback() }
    finally { unlock() }
  }
  /**
   * 拒绝其他数据库或已经结束的事务会话。
   *
   * @param session 待验证的本数据库事务会话，必须仍在活动会话集合中。
   */
  function sqliteReadSession(session: StorageSession) {
    if (!sessions.has(session) || !session.inTransaction()) throw new Error(RuntimeMessage.INVALID_OR_ENDED_SQLITE_TRANSACTION)
  }
  /**
   * 已有会话时直接在该事务读取，否则通过串行队列取得数据库访问权。
   *
   * @param session 可选调用方事务会话；缺省或 null 时从串行入口取得访问权。
   * @param read 已经组织好的同步读取操作，复用会话时直接执行。
   */
  async function sqliteRunRead<T>(session: StorageSession | null | undefined, read: () => T): Promise<T> {
    if (session) { sqliteReadSession(session); return read() }
    return sqliteRunGate(read)
  }
  /**
   * 在独占访问期间执行立即事务，仅在提交后发送合并的记录变更。
   *
   * @param callback 事务业务回调，写入必须使用提供会话，成功提交后才发通知。
   */
  async function transaction<T>(callback: (session: StorageSession) => Promise<T>): Promise<T> {
    return sqliteRunGate(async () => {
      // 创建仅本次有效的会话，提交或回滚业务回调，并清理会话所有权。
      let active = true
      const session: StorageSession = { inTransaction: () => /* 报告本次事务是否仍有效，供记录操作验证调用顺序。 */  active }
      sessions.add(session); dirty.set(session, new Map())
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const result = await callback(session)
        sqlite.exec('COMMIT')
        const changes = [...dirty.get(session)!.values()]
        if (changes.length) queueMicrotask(() => {
          // 在提交后的微任务中通知监听者，关闭期间不再分发变更。
           if (!closing && !closed) for (const listener of listeners) listener(changes) })
        return result
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
      finally { active = false; sessions.delete(session); dirty.delete(session) }
    })
  }
  /**
   * 沿点分字段路径读取值，遇到数组时展开每个元素参与匹配。
   *
   * @param value 沿查询字段路径递归访问的 JSON 值，可能是对象、数组或缺失值。
   * @param parts 尚未消耗的点分路径片段，空数组表示已到目标字段。
   */
  function sqliteReadValues(value: unknown, parts: string[]): unknown[] {
    if (Array.isArray(value)) return value.flatMap(item => /* 继续在数组元素中解析剩余字段路径。 */  sqliteReadValues(item, parts))
    if (!parts.length) return [value]
    if (!value || typeof value !== 'object') return [undefined]
    return sqliteReadValues((value as Record<string, unknown>)[parts[0]], parts.slice(1))
  }
  /**
   * 要求每项过滤条件在对应字段路径的候选值中至少命中一次。
   *
   * @param document 待过滤的解码记录，读取匹配不会修改它。
   * @param query 统一查询条件，支持点分路径、数组允许值以及 null 匹配缺失。
   */
  function sqliteMatchRecord(document: unknown, query: RecordFilter) {
    return Object.entries(query).every(([key, expected]) => /* 解析该条件的嵌套字段值并逐个尝试匹配。 */  sqliteReadValues(document, key.split('.')).some(value => /* 支持集合包含、等值及 null 同时匹配缺失值的记录条件。 */
      Array.isArray(expected) ? expected.includes(value as string) : expected === null ? value == null : value === expected))
  }
  /**
   * 为命名空间提供事务化 JSON 记录访问，并记录外部可见的修改。
   *
   * @param space 业务模块固定选择的记录命名空间，同一物理表中按此隔离。
   */
  function records<T extends { _id: string }>(space: string): StorageRecords<T> {
    /**
     * 从当前命名空间按主键读取 JSON 文档。
     *
     * @param id 当前命名空间内的记录字符串主键。
     */
    function read(id: string): T | null {
      const row = sqlite.prepare('SELECT value FROM records WHERE space=? AND id=?').get(space, id)
      return row ? JSON.parse(String(row.value)) : null
    }
    /**
     * 插入或替换记录，并在业务可见内容变化时登记事务待通知项。
     *
     * @param document 待插入或替换的业务记录，序列化后写入 JSON 列。
     * @param insert true 表示新增并要求主键唯一，false 表示替换已有记录。
     * @param session 当前有效事务，用来登记本次写入产生的提交后通知。
     */
    function write(document: T, insert: boolean, session: StorageSession) {
      const previous = read(document._id)
      const workspace = (document as T & { workspaceId?: string }).workspaceId ?? null
      const value = JSON.stringify(document)
      if (insert) sqlite.prepare('INSERT INTO records(space,id,workspace,value) VALUES(?,?,?,?)').run(space, document._id, workspace, value)
      else {
        const result = sqlite.prepare('UPDATE records SET workspace=?,value=? WHERE space=? AND id=?').run(workspace, value, space, document._id)
        if (!result.changes) throw new Error(RuntimeMessage.CANNOT_REPLACE_A_MISSING_RECORD)
      }
      /**
       * 投影决定是否刷新客户端的字段，忽略单独的授权栅栏变化。
       *
       * @param value 旧或新业务记录，null 表示不存在；只投影对外可见部分。
       */
      const visible = (value: T | null) => {
        if (!value) return null
        if (space === 'graphv3') return { revision: (value as T & { revision: number }).revision }
        const { writeFence: _fence, ...rest } = value as T & { writeFence?: number }
        return rest
      }
      if (JSON.stringify(visible(previous)) !== JSON.stringify(visible(document))) dirty.get(session)!.set(space + ':' + document._id, { table: space, id: document._id })
    }
    /**
     * 沿用经过验证的事务会话，缺少会话时为写入建立新事务。
     *
     * @param session 可选外部会话，没有会话时为写入创建新事务。
     * @param action 需要在事务内完成的写操作，接收经过验证的会话。
     */
    async function mutate<R>(session: StorageSession | null | undefined, action: (tx: StorageSession) => Promise<R>): Promise<R> {
      if (session) { sqliteReadSession(session); return action(session) }
      return transaction(action)
    }
    return {
      /**
       * @param id 待读取记录的主键，限定在当前命名空间。
       * @param session 可选读取会话，没有会话则排队等待其他事务结束。
       */
      get: (id, session) => /* 通过有效会话或串行队列读取指定记录。 */  sqliteRunRead(session, () => /* 在已取得的数据库访问权内读取该主键。 */  read(id)),
      /**
       * @param query 用于寻找首个匹配记录的统一过滤条件。
       * @param session 可选外部读取会话，决定查询所见事务状态。
       */
      first: async (query, session) => /* 返回查询结果的第一条记录，未匹配时返回 null。 */  (await records<T>(space).list(query, session))[0] ?? null,
      /**
       * 简单标量条件使用 SQL 计数，复杂路径或集合条件回退到统一过滤。
       *
       * @param query 计数条件，默认空对象；复杂路径或集合值走通用筛选。
       * @param session 可选读取会话，简单 SQL 计数也须沿用该事务。
       */
      async count(query = {}, session) {
        if (Object.keys(query).some(key => /* 识别不能直接拼入简单 JSON 路径的过滤字段。 */  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) || Object.values(query).some(Array.isArray)) return (await records<T>(space).list(query, session)).length
        return sqliteRunRead(session, () => {
          // 把标量条件转换为参数化 SQL，并读取匹配数量。
          const clauses = ['space=?'], values: Array<string | number | null> = [space]
          for (const [key, value] of Object.entries(query)) {
            clauses.push((key === '_id' ? 'id' : key === 'workspaceId' ? 'workspace' : "json_extract(value,'$." + key + "')") + ' IS ?')
            values.push(typeof value === 'boolean' ? Number(value) : value as string | number | null)
          }
          return Number(sqlite.prepare('SELECT count(*) amount FROM records WHERE ' + clauses.join(' AND ')).get(...values)!.amount)
        })
      },
      /**
       * @param query 列表过滤条件，默认空对象返回当前空间所有记录。
       * @param session 可选事务会话，未提供时通过串行访问入口读取。
       */
      list: (query = {}, session) => /* 在指定事务或串行访问内列出匹配记录。 */  sqliteRunRead(session, () => {
        // 优先用工作区或主键缩小查询，再应用统一过滤语义。
        const rows = typeof query.workspaceId === 'string'
          ? sqlite.prepare('SELECT value FROM records WHERE space=? AND workspace=?').all(space, query.workspaceId)
          : typeof query._id === 'string' ? sqlite.prepare('SELECT value FROM records WHERE space=? AND id=?').all(space, query._id)
          : sqlite.prepare('SELECT value FROM records WHERE space=?').all(space)
        return rows.map(row => /* 把存储 JSON 解码为业务记录副本。 */  JSON.parse(String(row.value)) as T).filter(row => /* 保留满足全部记录过滤条件的文档。 */  sqliteMatchRecord(row, query))
      }),
      /**
       * @param document 待新增的完整业务文档，必须包含 _id。
       * @param session 可选写事务会话，未提供时自动建立事务。
       */
      insert: (document, session) => /* 在已有或新事务中插入记录。 */  mutate(session, async tx => {
        // 执行插入并登记本事务的可见变化。
         write(document, true, tx) }),
      /**
       * @param document 待替换的完整业务文档，以其 _id 定位记录。
       * @param session 可选外部事务会话，替换与调用方其他更新一起提交。
       */
      replace: (document, session) => /* 在已有或新事务中替换记录。 */  mutate(session, async tx => {
        // 执行替换并登记本事务的可见变化。
         write(document, false, tx) }),
      /**
       * @param id 待读取并更新的记录主键。
       * @param update 同步记录更新器，收到 JSON 副本，返回空值则放弃修改。
       * @param session 可选外部会话，缺省时为读取与写回建立完整事务。
       */
      change: (id, update, session) => /* 在同一事务中读取记录、运行更新器并有条件保存。 */  mutate(session, async tx => {
        // 只有记录存在且更新器返回新值时才替换原记录。
        const row = read(id), next = row && update(row)
        if (next) write(next, false, tx)
        return next
      }),
      /**
       * 为需要唯一约束的简单字段建立命名空间专属 SQL 索引。
       *
       * @param fields 要求建立索引的字段名序列，仅唯一标量索引会执行 SQL。
       * @param options 可选索引设置；未要求 unique 时沿用既有物理索引即可。
       */
      async index(fields, options) {
        if (!options?.unique) return // Workspace queries use the physical workspace index.
        if (fields.some(field => /* 拒绝不能安全用于标量 JSON 索引路径的字段名。 */  !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))) throw new Error(RuntimeMessage.UNIQUE_INDEXES_REQUIRE_SCALAR_FIELDS)
        const name = 'record_' + createHash('sha256').update(space + fields.join(',')).digest('hex').slice(0, 16)
        if (!/^[A-Za-z0-9_]+$/.test(space)) throw new Error(RuntimeMessage.INVALID_RECORD_SPACE)
        const expressions = fields.map(field => /* 将经过验证的字段转换为 JSON 提取索引表达式。 */  "json_extract(value,'$." + field + "')").join(',')
        await sqliteRunRead(null, () => /* 在串行数据库访问中创建尚不存在的唯一索引。 */  sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS " + name + " ON records(" + expressions + ") WHERE space='" + space + "'"))
      },
    }
  }
  /**
   * 校验附件身份再拼接本机存储路径，阻止任意路径访问。
   *
   * @param id 本机附件的 UUID 形状存储身份，校验后才能拼接文件路径。
   */
  function sqliteReadBlobPath(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(RuntimeMessage.INVALID_LOCAL_BLOB_IDENTITY)
    return path.join(blobDirectory, id)
  }
  const database: SqlitePersistence = {
    records, transaction, initialize: async () => {
      // 数据库结构已在创建时初始化，无需再次执行操作。
    }, now: async () => /* 以本机时钟提供本适配器统一的当前时间。 */  Date.now(),
    /**
     * @param session 可选外部事务会话，新建图存储必须沿用而不自行关闭。
     */
    graph: session => /* 为当前数据库与会话建立图存储访问器。 */  sqliteCreateGraphStore(database, session),
    blobs: {
      /**
       * 流式写临时附件并同步文件和目录，再原子改名为最终身份。
       *
       * @param source 待消费的附件字节流，先写临时文件再同步并改名。
       * @param _filename 接口兼容的附件原名，本机存储按生成身份命名，因此不使用它。
       */
      async write(source, _filename) {
        const id = randomUUID(), target = sqliteReadBlobPath(id), temporary = target + '.tmp'
        try {
          await pipeline(Readable.from(source), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }))
          const handle = await open(temporary, 'r')
          try { await handle.sync() } finally { await handle.close() }
          await rename(temporary, target)
          const directory = await open(blobDirectory, 'r')
          try { await directory.sync() } finally { await directory.close() }
          return id
        } catch (error) { await unlink(temporary).catch(() => {
          // 临时附件清理失败时保留原始写入错误。
        }); throw error }
      },
      /**
       * @param id 需打开读取流的附件存储身份，先校验防止任意路径访问。
       */
      read: id => /* 打开经身份校验的本机附件读取流。 */  createReadStream(sqliteReadBlobPath(id)),
      /**
       * 删除指定附件，已不存在时返回 false，其余文件系统错误继续抛出。
       *
       * @param id 待删除的附件存储身份，不存在时作为幂等结果返回 false。
       */
      async remove(id) {
         try { await unlink(sqliteReadBlobPath(id)); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } },
    },
    /**
     * 登记事务提交监听，并返回解除订阅操作。
     *
     * @param listener 事务成功后接收合并变更的同步监听函数，可通过返回操作解除。
     */
    subscribe(listener) {
       listeners.add(listener); return () => {
      // 从提交监听集合中移除该订阅者。
       listeners.delete(listener) } },
    close() {
      // 合并重复关闭请求，等待在途数据库访问后释放连接。
       return closeTask ??= (async () => {
      // 先阻止新请求，再等待队列、清空监听并关闭 SQLite。
       closing = true; await tail; listeners.clear(); sqlite.close(); closed = true })() },
  }
  return database
}
