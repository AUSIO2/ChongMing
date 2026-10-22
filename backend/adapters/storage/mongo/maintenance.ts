// 显式修复早期 Mongo 图中被序列化省略的空新闻上下文。
import type { Connection } from 'mongoose'

import { GRAPH_COLLECTION } from '../../../modules/graph/graph-record'

/**
 * 统计缺失新闻上下文的图，仅在显式应用时补空对象并推进图版本。
 *
 * @param connection 管理员显式提供的 Mongo 连接，修复只操作该库的图集合。
 * @param apply 是否真正写回修复；默认 false 仅统计匹配图数量。
 */
export async function repairUpdateNewsContext(
  /* 管理命令显式连接的目标数据库。 */ connection: Connection,
  /* false 只统计，true 补齐缺失字段并推进图版本。 */ apply = false,
): Promise<{ matchedMaps: number; modifiedMaps: number }> {
  // 只修复旧新闻缺失的 context，不覆盖现有上下文或其他节点。
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
