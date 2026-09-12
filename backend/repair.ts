import type { Connection } from 'mongoose'
import { GRAPH_COLLECTION } from './store'

/** Explicit repair for empty News contexts omitted by pre-056 Mongoose serialization. */
export async function repairUpdateNewsContext(connection: Connection, apply = false) {
  const graphs = connection.collection(GRAPH_COLLECTION)
  const filter = { deletedAt: { $exists: false }, nodes: { $elemMatch: { 'data.kind': 'news', 'data.context': { $exists: false } } } }
  const matchedMaps = await graphs.countDocuments(filter)
  if (!apply || !matchedMaps) return { matchedMaps, modifiedMaps: 0 }
  const result = await graphs.updateMany(filter, [{ $set: {
    nodes: { $map: { input: '$nodes', as: 'node', in: { $cond: [
      { $and: [{ $eq: ['$$node.data.kind', 'news'] }, { $eq: [{ $type: '$$node.data.context' }, 'missing'] }] },
      { $mergeObjects: ['$$node', { data: { $mergeObjects: ['$$node.data', { $literal: { context: {} } }] } }] },
      '$$node',
    ] } } },
    revision: { $add: ['$revision', 1] }, updatedAt: '$$NOW',
  } }])
  return { matchedMaps, modifiedMaps: result.modifiedCount }
}
