import mongoose, { mongo, type Connection } from 'mongoose'
// 用途：创建连接，供后续流程使用。
export async function storeCreateConnection(uri: string): Promise<Connection> {
  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5_000,
    readPreference: 'primary',
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority', wtimeoutMS: 5_000 },
  })
  await connection.asPromise()
  return connection
}

// 用途：读取地址，并把结构化结果交给调用方。
export function localReadUri(uri: string): string {
  try {
    const parsed = new mongo.MongoClient(uri).options
    const scheme = uri.startsWith('mongodb+srv:') ? 'mongodb+srv' : 'mongodb'
    const hosts = parsed.srvHost ?? parsed.hosts.map(host => host.toString()).join(',')
    return `${scheme}://${parsed.credentials ? '***@' : ''}${hosts}/${encodeURIComponent(parsed.dbName)}`
      + (uri.includes('?') ? '?<options-redacted>' : '')
  } catch { return '<invalid Mongo URI>' }
}
