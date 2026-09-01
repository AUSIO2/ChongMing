import mongoose, { Schema } from 'mongoose'
import { errReadMessage } from './errors'

// ==========================================
// Mongoose Schema 定义
// ==========================================

const contextFieldSchema = new Schema({
  value: { type: Schema.Types.Mixed, required: true },
  visibleToAI: { type: Boolean, required: true },
}, { _id: false })

const mapperSourceSchema = new Schema({
  id: { type: String, required: true },
  uri: { type: String, required: true },
  kind: { type: String, enum: ['file', 'url'], required: true },
  label: String,
}, { _id: false })

const mapperNewsSchema = new Schema({
  id: { type: String, required: true },
  sourceId: String,
  content: { type: String, default: '' },
  context: { type: Map, of: contextFieldSchema, default: () => new Map() },
}, { _id: false })

const mapperRouteSchema = new Schema({
  parentId: { type: String, required: true },
  agentName: { type: String, required: true },
  priority: { type: String, enum: ['high', 'medium', 'low'], required: true },
  hint: String,
  instanceId: { type: String, required: true },
}, { _id: false })

const mapperOpinionSchema = new Schema({
  agentName: { type: String, required: true },
  instanceId: { type: String, required: true },
  priority: { type: String, enum: ['high', 'medium', 'low'], required: true },
  score: { type: Number, enum: [1, 0.5, 0], required: true },
  reason: { type: String, default: '' },
}, { _id: false })

const mapperVerifySchema = new Schema({
  score: { type: Number, enum: [1, 0.5, 0], required: true },
  reason: { type: String, default: '' },
  opinions: { type: [mapperOpinionSchema], default: [] },
}, { _id: false })

const mapperClaimSchema = new Schema({
  id: { type: String, required: true },
  newsId: String,
  content: { type: String, required: true },
  category: String,
  sourceAgent: String,
  sourceInstanceId: String,
  verify: { type: mapperVerifySchema, default: undefined },
}, { _id: false })

const mapperDraftCallSchema = new Schema({
  callId: { type: String, required: true },
  agentName: { type: String, required: true },
  instanceId: String,
  text: { type: String, required: true },
  sessionId: String,
}, { _id: false })

const mapperRunSchema = new Schema({
  runId: { type: String, required: true },
  stage: { type: String, enum: ['parse', 'split', 'verify'], required: true },
  step: {
    type: String,
    enum: ['load', 'route', 'confirm-route', 'workers', 'merge', 'validate', 'save', 'done'],
    required: true,
  },
  status: {
    type: String,
    enum: ['running', 'interrupted', 'cancelled', 'error'],
    required: true,
  },
  mode: { type: String, enum: ['auto', 'human-in-loop'], required: true },
  targetId: { type: String, required: true },
  error: String,
  draft: {
    routes: { type: [mapperRouteSchema], default: [] },
    calls: { type: [mapperDraftCallSchema], default: [] },
    output: String,
    claims: { type: [mapperClaimSchema], default: undefined },
    opinions: { type: [mapperOpinionSchema], default: undefined },
    verify: { type: mapperVerifySchema, default: undefined },
    saveIndex: { type: Number, default: 0 },
  },
  updatedAt: { type: Date, default: Date.now },
}, { _id: false })

const mapTimelineSchema = new Schema({
  startX: { type: Number, default: 0 },
  endX: { type: Number, default: 3 },
  stateIndex: Number,
  activeScope: { type: String, default: '' },
}, { _id: false })

const mapDocumentSchema = new Schema({
  _id: { type: String, required: true },
  workspaceId: { type: String, index: true },
  name: String,
  sources: { type: [mapperSourceSchema], default: [] },
  news: { type: [mapperNewsSchema], default: [] },
  claims: { type: [mapperClaimSchema], default: [] },
  routes: { type: [mapperRouteSchema], default: [] },
  run: mapperRunSchema,
  revision: { type: Number, default: 0 },
  timeline: mapTimelineSchema,
  writeLease: {
    holderId: String,
    acquiredAt: Date,
    heartbeatAt: Date,
  },
}, { timestamps: true })

export const MapModel = mongoose.model('Map', mapDocumentSchema)

const agentDocSchema = new Schema({
  promptPath: { type: String, required: true },
  agentType: {
    type: String,
    enum: ['split', 'verify', 'parse', 'coordinator'],
    required: true,
  },
  agentName: String,
  displayLabel: { type: String, required: true },
  description: String,
  content: { type: String, required: true },
  promptVars: { type: [String], default: [] },
  defaultPriority: { type: String, enum: ['high', 'medium', 'low'] },
  claimCategory: { type: String, enum: ['data', 'quote', 'causal'] },
  tools: [String],
  model: String,
  baseUrl: String,
  updatedAt: { type: Date, default: Date.now },
}, { _id: false })

const localAgentSchema = new Schema({
  _id: { type: String, required: true },
  promptPath: { type: String, required: true },
  agentType: {
    type: String,
    enum: ['split', 'verify', 'parse', 'coordinator'],
    required: true,
  },
  agentName: String,
  displayLabel: { type: String, required: true },
  description: String,
  content: { type: String, required: true },
  promptVars: { type: [String], default: [] },
  defaultPriority: { type: String, enum: ['high', 'medium', 'low'] },
  claimCategory: { type: String, enum: ['data', 'quote', 'causal'] },
  tools: [String],
  model: String,
  baseUrl: String,
}, { timestamps: true })

export const LocalAgentModel = mongoose.model('LocalAgent', localAgentSchema)

const workspaceUiSchema = new Schema({
  currentMapId: String,
  openMapIds: [String],
}, { _id: false })

const agentSourceSchema = new Schema({
  promptPath: { type: String, required: true },
  copiedFrom: { type: String, enum: ['local'], required: true },
  localUpdatedAt: Date,
  uploadedAt: { type: Date, required: true },
}, { _id: false })

const workspaceDocumentSchema = new Schema({
  _id: { type: String, required: true },
  name: { type: String, required: true },
  description: String,
  agents: { type: [agentDocSchema], default: [] },
  agentSources: { type: [agentSourceSchema], default: [] },
  ui: workspaceUiSchema,
}, { timestamps: true })

export const WorkspaceModel = mongoose.model('Workspace', workspaceDocumentSchema)

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

export async function dbCreate(uri?: string): Promise<void> {
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
    const reason = errReadMessage(error)
    console.warn(`[db] 连接 ${configured} 失败 (${reason})，回退到内存数据库`)

    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect()
    }

    const memUri = await startMemoryServer()
    await mongoose.connect(memUri)
    console.log('[db] 使用内存数据库 (fallback)')
  }

}

export async function dbDelete(): Promise<void> {
  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect()
  }
  if (memoryServer) {
    await memoryServer.stop()
    memoryServer = null
  }
}
