// 文件职责：创建满足事务读写要求的 Mongo 连接，并提供脱敏连接地址用于诊断。
import mongoose, { mongo, type Connection } from 'mongoose'
export async function storeCreateConnection(/* 部署配置提供的 Mongo 连接字符串，可含凭据，只用于建立受控连接。 */ uri: string): Promise<Connection> {
  // 创建使用主节点和多数派读写的 Mongo 连接，等待就绪后交给调用方管理。
  const connection = mongoose.createConnection(uri, {
    serverSelectionTimeoutMS: 5_000,
    readPreference: 'primary',
    readConcern: { level: 'majority' },
    writeConcern: { w: 'majority', wtimeoutMS: 5_000 },
  })
  await connection.asPromise()
  return connection
}
export function localReadUri(/* 需要写入诊断的原连接字符串，返回值会隐藏凭据和查询选项。 */ uri: string): string {
  // 解析 Mongo 地址供日志显示，隐藏凭据和查询参数，解析失败时仅返回固定说明。
  try {
    const parsed = new mongo.MongoClient(uri).options
    const scheme = uri.startsWith('mongodb+srv:') ? 'mongodb+srv' : 'mongodb'
    const hosts = parsed.srvHost ?? parsed.hosts.map(/* Mongo 驱动已解析的单个主机地址，不包含连接凭据。 */ host => /* 将解析后的主机地址转换为可展示文本。 */  host.toString()).join(',')
    return `${scheme}://${parsed.credentials ? '***@' : ''}${hosts}/${encodeURIComponent(parsed.dbName)}`
      + (uri.includes('?') ? '?<options-redacted>' : '')
  } catch { return '<invalid Mongo URI>' }
}
