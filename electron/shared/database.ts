import mongoose, { Schema } from 'mongoose'
import { errReadMessage } from './errors'
import { MAP_DEFAULT_NEWS_ID } from './map-ids'
import { MAP_DEFAULT_SCOPE } from './map-scope'

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

const routeInstructionSchema = new Schema({
  agentName: { type: String, required: true },
  priority: { type: String, enum: ['high', 'medium', 'low'], required: true },
  hint: String,
  instanceId: { type: String, required: true },
}, { _id: false })

const splitMetaSchema = new Schema({
  model: String,
  routeInstructions: [routeInstructionSchema],
  subAgentResults: [subAgentSplitRecordSchema],
  rawMergeResponse: String,
  splitAt: Date,
}, { _id: false })

const mapChainScopeSchema = new Schema({
  content: { type: String, default: '' },
  context: { type: Map, of: contextFieldSchema, default: () => new Map() },
  claims: { type: [splitClaimSchema], default: [] },
  splitMeta: splitMetaSchema,
}, { _id: false })

const mapTimelineSchema = new Schema({
  startX: { type: Number, default: 0 },
  endX: { type: Number, default: 3 },
  stateIndex: Number,
  activeScope: { type: String, default: '' },
}, { _id: false })

const mapRunSchema = new Schema({
  runId: { type: String, required: true },
  threadId: { type: String, required: true },
  transitionKey: { type: String, enum: ['0-1', '1-2', '2-3'], required: true },
  parentNodeId: { type: String, required: true },
  mode: { type: String, enum: ['auto', 'human-in-loop'], required: true },
  gate: { type: String, enum: ['confirmRoute', 'validate', 'save'] },
  pendingTool: { type: String, enum: ['invoke', 'validate', 'save'] },
  activeNodeId: String,
  status: {
    type: String,
    enum: ['running', 'interrupted', 'error'],
    required: true,
  },
  updatedAt: { type: Date, default: Date.now },
}, { _id: false })

const mapGraphSchema = new Schema({
  nodes: { type: Schema.Types.Mixed, default: [] },
  edges: { type: Schema.Types.Mixed, default: [] },
  runPhase: String,
  mode: String,
  activeNodeId: String,
  pendingTool: String,
  nextNode: String,
  transitionKey: String,
  draft: Schema.Types.Mixed,
  error: String,
  updatedAt: { type: Date, default: Date.now },
}, { _id: false })

const mapDocumentSchema = new Schema({
  _id: { type: String, required: true },
  name: String,
  chains: {
    type: Map,
    of: mapChainScopeSchema,
    default: () => new Map(),
  },
  timeline: mapTimelineSchema,
  mapRun: mapRunSchema,
  mapGraph: mapGraphSchema,
  confidence: Number,
  confidenceUpdatedAt: Date,
}, { timestamps: true })

export const MapModel = mongoose.model('Map', mapDocumentSchema)

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

function mapRunMigrateLegacy(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const graphType = raw.graphType as string | undefined
  const transitionKey = raw.transitionKey
    ?? (graphType === 'split' ? '1-2' : graphType === 'verify' ? '2-3' : undefined)
  const parentNodeId = raw.parentNodeId ?? raw.claimId ?? MAP_DEFAULT_SCOPE
  if (!transitionKey || !parentNodeId) return raw as Record<string, unknown>
  const { graphType: _g, claimId: _c, ...rest } = raw
  return { ...rest, transitionKey, parentNodeId }
}

function draftMigrateLegacy(draft: unknown): unknown {
  if (!draft || typeof draft !== 'object') return draft
  const d = draft as Record<string, unknown>
  if (d.mapId !== undefined) return draft
  if (typeof d.newsId !== 'string') return draft
  const { newsId, ...rest } = d
  return { mapId: newsId, ...rest }
}

/** 一次性：News 集合 → Map 集合 */
async function dbMigrateNewsToMap(): Promise<void> {
  const conn = mongoose.connection
  if (!conn.db) return

  const newsColl = conn.db.collection('news')
  const mapsColl = conn.db.collection('maps')

  const newsCount = await newsColl.countDocuments()
  if (newsCount === 0) return

  const docs = await newsColl.find({}).toArray()
  for (const doc of docs) {
    const mapId = String(doc._id)
    const exists = await mapsColl.findOne({ _id: mapId } as Record<string, unknown>)
    if (exists) continue

    const scope = {
      content: String(doc.content ?? ''),
      context: doc.context ?? {},
      claims: doc.claims ?? [],
      ...(doc.splitMeta ? { splitMeta: doc.splitMeta } : {}),
    }

    let mapRun = doc.mapRun as Record<string, unknown> | undefined
    if (mapRun) mapRun = mapRunMigrateLegacy(mapRun) as Record<string, unknown>

    let mapGraph = doc.mapGraph as Record<string, unknown> | undefined
    if (mapGraph) {
      const graphType = mapGraph.graphType as string | undefined
      mapGraph = {
        ...mapGraph,
        transitionKey: mapGraph.transitionKey
          ?? (graphType === 'split' ? '1-2' : graphType === 'verify' ? '2-3' : mapGraph.transitionKey),
        draft: draftMigrateLegacy(mapGraph.draft),
      }
      delete mapGraph.graphType
    }

    await mapsColl.insertOne({
      _id: mapId,
      chains: { [MAP_DEFAULT_SCOPE]: scope },
      timeline: {
        startX: 0,
        endX: 3,
        activeScope: MAP_DEFAULT_SCOPE,
      },
      ...(mapRun ? { mapRun } : {}),
      ...(mapGraph ? { mapGraph } : {}),
      ...(doc.confidence !== undefined ? { confidence: doc.confidence } : {}),
      ...(doc.confidenceUpdatedAt ? { confidenceUpdatedAt: doc.confidenceUpdatedAt } : {}),
      createdAt: doc.createdAt ?? new Date(),
      updatedAt: doc.updatedAt ?? new Date(),
    } as Record<string, unknown>)
  }

  await newsColl.drop().catch(() => {})
  console.log(`[db] 已迁移 ${docs.length} 条 News → Map`)
}

const LEGACY_NEWS_ROOT_ID = '__news_root__'

function graphMigrateLegacyNewsRoot(graph: {
  nodes?: Array<{ id?: string; parentId?: string }>
  edges?: Array<{ id?: string; from?: string; to?: string }>
}): boolean {
  let changed = false
  if (Array.isArray(graph.nodes)) {
    for (const node of graph.nodes) {
      if (node.id === LEGACY_NEWS_ROOT_ID) {
        node.id = MAP_DEFAULT_NEWS_ID
        changed = true
      }
      if (node.parentId === LEGACY_NEWS_ROOT_ID) {
        node.parentId = MAP_DEFAULT_NEWS_ID
        changed = true
      }
    }
  }
  if (Array.isArray(graph.edges)) {
    for (const edge of graph.edges) {
      if (edge.from === LEGACY_NEWS_ROOT_ID) {
        edge.from = MAP_DEFAULT_NEWS_ID
        changed = true
      }
      if (edge.to === LEGACY_NEWS_ROOT_ID) {
        edge.to = MAP_DEFAULT_NEWS_ID
        changed = true
      }
      if (edge.id?.includes(LEGACY_NEWS_ROOT_ID)) {
        edge.id = edge.id.split(LEGACY_NEWS_ROOT_ID).join(MAP_DEFAULT_NEWS_ID)
        changed = true
      }
    }
  }
  return changed
}

/** 一次性：__news_root__ → default(chains) / news:default(图节点) */
async function dbMigrateLegacyNewsRoot(): Promise<void> {
  const cursor = MapModel.find({}).cursor()
  let count = 0
  for await (const doc of cursor) {
    let dirty = false

    if (doc.chains instanceof Map) {
      if (doc.chains.has(LEGACY_NEWS_ROOT_ID)) {
        if (!doc.chains.has(MAP_DEFAULT_SCOPE)) {
          const legacy = doc.chains.get(LEGACY_NEWS_ROOT_ID)
          if (legacy) doc.chains.set(MAP_DEFAULT_SCOPE, legacy)
        }
        doc.chains.delete(LEGACY_NEWS_ROOT_ID)
        dirty = true
      }
      // 修复误迁移为 news:default 的 chains 键
      if (doc.chains.has(MAP_DEFAULT_NEWS_ID)) {
        if (!doc.chains.has(MAP_DEFAULT_SCOPE)) {
          const misplaced = doc.chains.get(MAP_DEFAULT_NEWS_ID)
          if (misplaced) doc.chains.set(MAP_DEFAULT_SCOPE, misplaced)
        }
        doc.chains.delete(MAP_DEFAULT_NEWS_ID)
        dirty = true
      }
    }

    const graph = doc.mapGraph as {
      nodes?: Array<{ id?: string; parentId?: string }>
      edges?: Array<{ id?: string; from?: string; to?: string }>
    } | undefined
    if (graph && graphMigrateLegacyNewsRoot(graph)) {
      doc.mapGraph = graph as typeof doc.mapGraph
      doc.markModified('mapGraph')
      dirty = true
    }

    if (doc.timeline?.activeScope === LEGACY_NEWS_ROOT_ID) {
      doc.timeline.activeScope = MAP_DEFAULT_NEWS_ID
      doc.markModified('timeline')
      dirty = true
    }

    if (doc.mapRun?.parentNodeId === LEGACY_NEWS_ROOT_ID) {
      doc.mapRun.parentNodeId = MAP_DEFAULT_NEWS_ID
      doc.markModified('mapRun')
      dirty = true
    }

    if (dirty) {
      await doc.save({ validateBeforeSave: false })
      count++
    }
  }
  if (count > 0) {
    console.log(`[db] 已迁移 ${count} 条 Map legacy news root → ${MAP_DEFAULT_NEWS_ID}`)
  }
}

export async function dbCreate(uri?: string): Promise<void> {
  const configured = uri
    ?? process.env.MONGO_URI
    ?? 'mongodb://localhost:27017/chongming'

  if (configured === 'memory') {
    const memUri = await startMemoryServer()
    await mongoose.connect(memUri)
    console.log('[db] 使用内存数据库 (mongodb-memory-server)')
    await dbMigrateNewsToMap()
    await dbMigrateLegacyNewsRoot()
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

  await dbMigrateNewsToMap()
  await dbMigrateLegacyNewsRoot()
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
