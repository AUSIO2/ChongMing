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
  close(): Promise<void>
}
// 用途：创建SQLite 数据，供后续流程使用。
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
  // 用途：执行SQLite 数据流程，并返回执行结果。
  async function sqliteRunGate<T>(callback: () => Promise<T> | T): Promise<T> {
    const previous = tail
    let unlock!: () => void
    tail = new Promise<void>(resolve => { unlock = resolve })
    await previous
    try { if (closed || closing) throw new Error(RuntimeMessage.SQLITE_DATABASE_IS_CLOSED); return await callback() }
    finally { unlock() }
  }
  // 用途：读取会话，并把结构化结果交给调用方。
  function sqliteReadSession(session: StorageSession) {
    if (!sessions.has(session) || !session.inTransaction()) throw new Error(RuntimeMessage.INVALID_OR_ENDED_SQLITE_TRANSACTION)
  }
  // 用途：执行SQLite 数据流程，并返回执行结果。
  async function sqliteRunRead<T>(session: StorageSession | null | undefined, read: () => T): Promise<T> {
    if (session) { sqliteReadSession(session); return read() }
    return sqliteRunGate(read)
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  async function transaction<T>(callback: (session: StorageSession) => Promise<T>): Promise<T> {
    return sqliteRunGate(async () => {
      let active = true
      const session: StorageSession = { inTransaction: () => active }
      sessions.add(session); dirty.set(session, new Map())
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        const result = await callback(session)
        sqlite.exec('COMMIT')
        const changes = [...dirty.get(session)!.values()]
        if (changes.length) queueMicrotask(() => { if (!closing && !closed) for (const listener of listeners) listener(changes) })
        return result
      } catch (error) { sqlite.exec('ROLLBACK'); throw error }
      finally { active = false; sessions.delete(session); dirty.delete(session) }
    })
  }
  // 用途：读取SQLite 数据，并把结构化结果交给调用方。
  function sqliteReadValues(value: unknown, parts: string[]): unknown[] {
    if (Array.isArray(value)) return value.flatMap(item => sqliteReadValues(item, parts))
    if (!parts.length) return [value]
    if (!value || typeof value !== 'object') return [undefined]
    return sqliteReadValues((value as Record<string, unknown>)[parts[0]], parts.slice(1))
  }
  // 用途：处理SQLite 数据相关工作，并把结果交给调用方。
  function sqliteMatchRecord(document: unknown, query: RecordFilter) {
    return Object.entries(query).every(([key, expected]) => sqliteReadValues(document, key.split('.')).some(value =>
      Array.isArray(expected) ? expected.includes(value as string) : expected === null ? value == null : value === expected))
  }
  // 用途：处理当前模块相关工作，并把结果交给调用方。
  function records<T extends { _id: string }>(space: string): StorageRecords<T> {
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    function read(id: string): T | null {
      const row = sqlite.prepare('SELECT value FROM records WHERE space=? AND id=?').get(space, id)
      return row ? JSON.parse(String(row.value)) : null
    }
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    function write(document: T, insert: boolean, session: StorageSession) {
      const previous = read(document._id)
      const workspace = (document as T & { workspaceId?: string }).workspaceId ?? null
      const value = JSON.stringify(document)
      if (insert) sqlite.prepare('INSERT INTO records(space,id,workspace,value) VALUES(?,?,?,?)').run(space, document._id, workspace, value)
      else {
        const result = sqlite.prepare('UPDATE records SET workspace=?,value=? WHERE space=? AND id=?').run(workspace, value, space, document._id)
        if (!result.changes) throw new Error(RuntimeMessage.CANNOT_REPLACE_A_MISSING_RECORD)
      }
      const visible = (value: T | null) => {
        if (!value) return null
        if (space === 'graphv3') return { revision: (value as T & { revision: number }).revision }
        const { writeFence: _fence, ...rest } = value as T & { writeFence?: number }
        return rest
      }
      if (JSON.stringify(visible(previous)) !== JSON.stringify(visible(document))) dirty.get(session)!.set(space + ':' + document._id, { table: space, id: document._id })
    }
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    async function mutate<R>(session: StorageSession | null | undefined, action: (tx: StorageSession) => Promise<R>): Promise<R> {
      if (session) { sqliteReadSession(session); return action(session) }
      return transaction(action)
    }
    return {
      get: (id, session) => sqliteRunRead(session, () => read(id)),
      first: async (query, session) => (await records<T>(space).list(query, session))[0] ?? null,
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async count(query = {}, session) {
        if (Object.keys(query).some(key => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) || Object.values(query).some(Array.isArray)) return (await records<T>(space).list(query, session)).length
        return sqliteRunRead(session, () => {
          const clauses = ['space=?'], values: Array<string | number | null> = [space]
          for (const [key, value] of Object.entries(query)) {
            clauses.push((key === '_id' ? 'id' : key === 'workspaceId' ? 'workspace' : "json_extract(value,'$." + key + "')") + ' IS ?')
            values.push(typeof value === 'boolean' ? Number(value) : value as string | number | null)
          }
          return Number(sqlite.prepare('SELECT count(*) amount FROM records WHERE ' + clauses.join(' AND ')).get(...values)!.amount)
        })
      },
      list: (query = {}, session) => sqliteRunRead(session, () => {
        const rows = typeof query.workspaceId === 'string'
          ? sqlite.prepare('SELECT value FROM records WHERE space=? AND workspace=?').all(space, query.workspaceId)
          : typeof query._id === 'string' ? sqlite.prepare('SELECT value FROM records WHERE space=? AND id=?').all(space, query._id)
          : sqlite.prepare('SELECT value FROM records WHERE space=?').all(space)
        return rows.map(row => JSON.parse(String(row.value)) as T).filter(row => sqliteMatchRecord(row, query))
      }),
      insert: (document, session) => mutate(session, async tx => { write(document, true, tx) }),
      replace: (document, session) => mutate(session, async tx => { write(document, false, tx) }),
      change: (id, update, session) => mutate(session, async tx => {
        const row = read(id), next = row && update(row)
        if (next) write(next, false, tx)
        return next
      }),
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async index(fields, options) {
        if (!options?.unique) return // Workspace queries use the physical workspace index.
        if (fields.some(field => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))) throw new Error(RuntimeMessage.UNIQUE_INDEXES_REQUIRE_SCALAR_FIELDS)
        const name = 'record_' + createHash('sha256').update(space + fields.join(',')).digest('hex').slice(0, 16)
        if (!/^[A-Za-z0-9_]+$/.test(space)) throw new Error(RuntimeMessage.INVALID_RECORD_SPACE)
        const expressions = fields.map(field => "json_extract(value,'$." + field + "')").join(',')
        await sqliteRunRead(null, () => sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS " + name + " ON records(" + expressions + ") WHERE space='" + space + "'"))
      },
    }
  }
  // 用途：读取SQLite 数据，并把结构化结果交给调用方。
  function sqliteReadBlobPath(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(RuntimeMessage.INVALID_LOCAL_BLOB_IDENTITY)
    return path.join(blobDirectory, id)
  }
  const database: SqlitePersistence = {
    records, transaction, initialize: async () => {}, now: async () => Date.now(),
    graph: session => sqliteCreateGraphStore(database, session),
    blobs: {
      // 用途：处理当前模块相关工作，并把结果交给调用方。
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
        } catch (error) { await unlink(temporary).catch(() => {}); throw error }
      },
      read: id => createReadStream(sqliteReadBlobPath(id)),
      // 用途：处理当前模块相关工作，并把结果交给调用方。
      async remove(id) { try { await unlink(sqliteReadBlobPath(id)); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error } },
    },
    // 用途：处理当前模块相关工作，并把结果交给调用方。
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    // 用途：关闭当前模块并释放占用的资源。
    close() { return closeTask ??= (async () => { closing = true; await tail; listeners.clear(); sqlite.close(); closed = true })() },
  }
  return database
}
