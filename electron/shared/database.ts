import mongoose, { Schema } from 'mongoose'
import { errorMessage } from './errors'

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
  instanceId: { type: String, required: true },
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
  instanceId: { type: String, required: true },
  claims: [{ content: String, category: String, sourceAgent: String, _id: false }],
  rawResponse: String,
}, { _id: false })

/** 拆分槽位历史，用于从 DB 重建 Map 拓扑 */
const routeInstructionSchema = new Schema({
  agentName: { type: String, required: true },
  priority: { type: String, enum: ['high', 'medium', 'low'], required: true },
  hint: String,
  instanceId: { type: String, required: true },
}, { _id: false })

const splitMetaSchema = new Schema({
  model: String,
  /** AI/人工确认后的拆分 SubAgent 槽（含 instanceId） */
  routeInstructions: [routeInstructionSchema],
  subAgentResults: [subAgentSplitRecordSchema],
  rawMergeResponse: String,
  splitAt: Date,
}, { _id: false })

/** 未完成 run 会话（断点恢复） */
const mapRunSchema = new Schema({
  runId: { type: String, required: true },
  threadId: { type: String, required: true },
  graphType: { type: String, enum: ['split', 'verify'], required: true },
  mode: { type: String, enum: ['auto', 'human-in-loop'], required: true },
  gate: { type: String, enum: ['confirmRoute', 'validate', 'save'] },
  pendingTool: { type: String, enum: ['invoke', 'validate', 'save'] },
  activeNodeId: String,
  status: {
    type: String,
    enum: ['running', 'interrupted', 'error'],
    required: true,
  },
  claimId: String,
  updatedAt: { type: Date, default: Date.now },
}, { _id: false })

/** Map 图快照（断点恢复） */
const mapGraphSchema = new Schema({
  nodes: { type: Schema.Types.Mixed, default: [] },
  edges: { type: Schema.Types.Mixed, default: [] },
  runPhase: String,
  mode: String,
  activeNodeId: String,
  pendingTool: String,
  nextNode: String,
  graphType: String,
  draft: Schema.Types.Mixed,
  error: String,
  updatedAt: { type: Date, default: Date.now },
}, { _id: false })

const newsDocumentSchema = new Schema({
  _id: { type: String, required: true },
  content: { type: String, required: true },
  context: { type: Map, of: contextFieldSchema },
  claims: { type: [splitClaimSchema], default: [] },
  splitMeta: splitMetaSchema,
  mapRun: mapRunSchema,
  mapGraph: mapGraphSchema,
  confidence: Number,
  confidenceUpdatedAt: Date,
}, { timestamps: true })

export const NewsModel = mongoose.model('News', newsDocumentSchema)

// ==========================================
// 连接管理
// ==========================================

const CONNECT_TIMEOUT_MS = 3000

let memoryServer: { stop: () => Promise<boolean>; getUri: () => string } | null = null

async function startMemoryServer(): Promise<string> {
  const { MongoMemoryServer } = await import('mongodb-memory-server')
  memoryServer = await MongoMemoryServer.create()
  return memoryServer.getUri()
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
    console.log(`[db] 已连接 MongoDB: ${configured}`)
  } catch (error) {
    const reason = errorMessage(error)
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
}
