import mongoose, { Schema } from 'mongoose'

// ==========================================
// Mongoose Schema 定义
// ==========================================

const contextFieldSchema = new Schema({
  value: { type: Schema.Types.Mixed, required: true },
  visibleToAI: { type: Boolean, required: true },
}, { _id: false })

const splitClaimSchema = new Schema({
  claimId: { type: String, required: true },
  content: { type: String, required: true },
  category: String,
}, { _id: false })

const subAgentSplitRecordSchema = new Schema({
  agentName: { type: String, required: true },
  claims: [{ content: String, category: String, _id: false }],
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
}, { timestamps: true })

export const NewsModel = mongoose.model('News', newsDocumentSchema)

// ==========================================
// 连接管理
// ==========================================

/**
 * 连接 MongoDB
 * 通过 uri 参数或 MONGO_URI 环境变量控制连接目标
 * 本地 / Atlas 一行切换
 */
export async function connectDB(uri?: string): Promise<void> {
  const dbUri = uri
    ?? process.env.MONGO_URI
    ?? 'mongodb://localhost:27017/chongming'
  await mongoose.connect(dbUri)
}

/** 断开连接 */
export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect()
}
