// 文件职责：创建满足事务读写要求的 Mongo 连接，并提供脱敏连接地址用于诊断。
import mongoose, { mongo, type Connection } from 'mongoose'
/**
 * 创建使用主节点和多数派读写的 Mongo 连接，等待就绪后交给调用方管理。
 *
 * @param uri 部署配置提供的 Mongo 连接字符串，可含凭据，只用于建立受控连接。
 */
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
/**
 * 解析 Mongo 地址供日志显示，隐藏凭据和查询参数，解析失败时仅返回固定说明。
 *
 * @param uri 需要写入诊断的原连接字符串，返回值会隐藏凭据和查询选项。
 */
export function localReadUri(uri: string): string {
  try {
    const parsed = new mongo.MongoClient(uri).options
    const scheme = uri.startsWith('mongodb+srv:') ? 'mongodb+srv' : 'mongodb'
    const hosts = parsed.srvHost ?? parsed.hosts.map(host => /* 将解析后的主机地址转换为可展示文本。 */  host.toString()).join(',')
    return `${scheme}://${parsed.credentials ? '***@' : ''}${hosts}/${encodeURIComponent(parsed.dbName)}`
      + (uri.includes('?') ? '?<options-redacted>' : '')
  } catch { return '<invalid Mongo URI>' }
}
