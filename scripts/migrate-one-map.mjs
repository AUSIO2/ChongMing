/**
 * 一次性：将指定 Map 文档整理为阶段 A 可解读格式。
 * 用法: node scripts/migrate-one-map.mjs <mapId>
 */
import { MongoClient } from 'mongodb'

const MAP_DEFAULT_SCOPE = '__news_root__'
const uri = process.env.MONGO_URI ?? 'mongodb://localhost:27017/chongming'
const mapId = process.argv[2]

if (!mapId) {
  console.error('用法: node scripts/migrate-one-map.mjs <mapId>')
  process.exit(1)
}

function draftMigrate(draft) {
  if (!draft || typeof draft !== 'object') return draft
  const d = { ...draft }
  if (d.newsId && !d.mapId) {
    d.mapId = d.newsId
    delete d.newsId
  }
  if (d.claimId && !d.parentNodeId) {
    d.parentNodeId = d.claimId
    delete d.claimId
  }
  if (!d.parentNodeId && d.mapId) {
    d.parentNodeId = MAP_DEFAULT_SCOPE
  }
  if (!d.scopeNodeId && d.parentNodeId && d.parentNodeId !== MAP_DEFAULT_SCOPE) {
    d.scopeNodeId = MAP_DEFAULT_SCOPE
  }
  return d
}

function mapGraphMigrate(mapGraph) {
  if (!mapGraph || typeof mapGraph !== 'object') return mapGraph
  const g = { ...mapGraph }
  if (g.graphType === 'split') g.transitionKey = '1-2'
  else if (g.graphType === 'verify') g.transitionKey = '2-3'
  delete g.graphType
  if (g.draft) g.draft = draftMigrate(g.draft)
  if (g.transitionKey == null) delete g.transitionKey
  if (g.draft == null) delete g.draft
  return g
}

function mapRunMigrate(mapRun) {
  if (!mapRun || typeof mapRun !== 'object') return mapRun
  const r = { ...mapRun }
  if (r.graphType === 'split') r.transitionKey = '1-2'
  else if (r.graphType === 'verify') r.transitionKey = '2-3'
  delete r.graphType
  if (r.claimId && !r.parentNodeId) {
    r.parentNodeId = r.claimId
    delete r.claimId
  }
  return r
}

const client = new MongoClient(uri)
await client.connect()
const coll = client.db().collection('maps')
const doc = await coll.findOne({ _id: mapId })

if (!doc) {
  console.error('未找到 map:', mapId)
  process.exit(1)
}

const $set = {}
const $unset = {}

// 根级旧字段 → chains
if (doc.content !== undefined || doc.claims !== undefined || doc.splitMeta !== undefined) {
  const scope = doc.chains?.[MAP_DEFAULT_SCOPE] ?? {}
  $set.chains = {
    ...(doc.chains ?? {}),
    [MAP_DEFAULT_SCOPE]: {
      content: String(scope.content ?? doc.content ?? ''),
      context: scope.context ?? doc.context ?? {},
      claims: scope.claims ?? doc.claims ?? [],
      ...(scope.splitMeta || doc.splitMeta ? { splitMeta: scope.splitMeta ?? doc.splitMeta } : {}),
    },
  }
  for (const k of ['content', 'claims', 'splitMeta', 'context']) {
    $unset[k] = ''
  }
}

if (!doc.chains?.[MAP_DEFAULT_SCOPE] && !doc.content) {
  console.error('文档无 chains 且无根级 content，无法迁移')
  process.exit(1)
}

if (!doc.timeline) {
  $set.timeline = {
    activeScope: MAP_DEFAULT_SCOPE,
    scopes: { [MAP_DEFAULT_SCOPE]: { startX: 1, endX: 3 } },
  }
}

// 已完成且无 mapRun：丢弃陈旧 mapGraph，由前端 docCreateMap 从 chains 重建
const mapGraph = doc.mapGraph
const mapRun = doc.mapRun
const completedIdle =
  mapGraph?.runPhase === 'completed'
  && !mapRun

if (completedIdle) {
  $unset.mapGraph = ''
  console.log('移除已完成 mapGraph，打开时从 chains 重建')
} else if (mapGraph) {
  $set.mapGraph = mapGraphMigrate(mapGraph)
}

if (mapRun) {
  $set.mapRun = mapRunMigrate(mapRun)
}

const update = {}
if (Object.keys($set).length) update.$set = $set
if (Object.keys($unset).length) update.$unset = $unset

if (!Object.keys(update).length) {
  console.log('无需变更')
} else {
  await coll.updateOne({ _id: mapId }, update)
  console.log('已更新', mapId, update)
}

const after = await coll.findOne({ _id: mapId })
const preview = after.chains?.[MAP_DEFAULT_SCOPE]?.content?.slice(0, 40)
console.log('预览:', preview)
console.log('chains.claims:', after.chains?.[MAP_DEFAULT_SCOPE]?.claims?.length)
console.log('mapGraph:', after.mapGraph ? Object.keys(after.mapGraph) : '(none)')
console.log('mapRun:', after.mapRun ? after.mapRun.transitionKey : '(none)')

await client.close()
