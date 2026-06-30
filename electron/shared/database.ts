import mongoose, { Schema } from 'mongoose'

// ==========================================
// Mongoose Schema 定义
// ==========================================

const contextFieldSchema = new Schema({
  value: { type: Schema.Types.Mixed, required: true },
  visibleToAI: { type: Boolean, required: true },
}, { _id: false })

const subAgentOpinionSchema = new Schema({
  agentName: { type: String, required: true },
  priority: { type: String, enum: ['high', 'medium', 'low'], required: true },
  score: { type: Number, enum: [1, 0.5, 0], required: true },
  reason: String,
  rawResponse: String,
}, { _id: false })

const verifyResultSchema = new Schema({
  score: { type: Number, enum: [1, 0.5, 0], required: true },
  reason: String,
  opinions: [subAgentOpinionSchema],
  rawMergeResponse: String,
  verifiedAt: Date,
}, { _id: false })

const splitClaimSchema = new Schema({
  claimId: { type: String, required: true },
  content: { type: String, required: true },
  category: String,
  sourceAgent: String,
  verifyResult: verifyResultSchema,
}, { _id: false })

const subAgentSplitRecordSchema = new Schema({
  agentName: { type: String, required: true },
  priority: { type: String, enum: ['high', 'medium', 'low'] },
  claims: [{ content: String, category: String, sourceAgent: String, _id: false }],
  rawResponse: String,
}, { _id: false })

const splitMetaSchema = new Schema({
  model: String,
  subAgentResults: [subAgentSplitRecordSchema],
  rawMergeResponse: String,
  splitAt: Date,
}, { _id: false })

const newsDocumentSchema = new Schema({
  _id: { type: String, required: true },
  content: { type: String, required: true },
  context: { type: Map, of: contextFieldSchema },
  claims: { type: [splitClaimSchema], default: [] },
  splitMeta: splitMetaSchema,
  confidence: Number,
  confidenceUpdatedAt: Date,
}, { timestamps: true })

export const NewsModel = mongoose.model('News', newsDocumentSchema)

// ==========================================
// 连接管理
// ==========================================

const CONNECT_TIMEOUT_MS = 3000

let memoryServer: { stop: () => Promise<boolean>; getUri: () => string } | null = null
let usingMemoryDB = false

async function startMemoryServer(): Promise<string> {
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  memoryServer = await MongoMemoryServer.create()
  usingMemoryDB = true
  return memoryServer.getUri()
}

/** 当前是否使用内存数据库 */
export function isUsingMemoryDB(): boolean {
  return usingMemoryDB
}

/**
 * 连接 MongoDB
 * 优先级：参数 uri → MONGO_URI 环境变量 → localhost
 * - MONGO_URI=memory：直接使用内存库
 * - 连接失败：自动 fallback 到 mongodb-memory-server
 */
export async function connectDB(uri?: string): Promise<void> {
  const configured = uri
    ?? process.env.MONGO_URI
    ?? 'mongodb://localhost:27017/chongming'

  if (configured === 'memory') {
    const memUri = await startMemoryServer()
    await mongoose.connect(memUri)
    console.log('[db] 使用内存数据库 (mongodb-memory-server)')
    return
  }

  try {
    await mongoose.connect(configured, {
      serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS,
    })
    usingMemoryDB = false
    console.log(`[db] 已连接 MongoDB: ${configured}`)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[db] 连接 ${configured} 失败 (${reason})，回退到内存数据库`)

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect()
    }

    const memUri = await startMemoryServer()
    await mongoose.connect(memUri)
    console.log('[db] 使用内存数据库 (fallback)')
  }
}

/** 断开连接并停止内存数据库实例 */
export async function disconnectDB(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect()
  }
  if (memoryServer) {
    await memoryServer.stop()
    memoryServer = null
  }
  usingMemoryDB = false
}
