// 验证保留的离线新闻修复只补缺失 context，并保持显式预览和幂等写入。
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { MongoMemoryReplSet } from 'mongodb-memory-server'
import type { Connection } from 'mongoose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { storeCreateConnection } from '../../../../backend/adapters/storage/mongo/connection'
import { repairUpdateNewsContext } from '../../../../backend/adapters/storage/mongo/maintenance'
import { GRAPH_COLLECTION } from '../../../../backend/modules/graph/graph-record'

let server: MongoMemoryReplSet, connection: Connection, uri: string
beforeAll(async () => {
  // 创建独立 Mongo 副本集，修复测试不接触开发者数据库。
  server = await MongoMemoryReplSet.create({ instanceOpts: [{ launchTimeout: 30_000 }], replSet: { count: 1, storageEngine: 'wiredTiger' } })
  uri = server.getUri('news_context_' + randomUUID())
  connection = await storeCreateConnection(uri)
})
afterAll(async () => {
  // 测试退出时关闭连接并停止临时副本集。
  try { await connection?.close() }
  finally { await server?.stop() }
})

async function runRepairCommand(
  /* 管理命令使用的隔离 Mongo 连接串。 */ targetUri: string,
  /* 通过标准输入交给命令的预览或应用参数。 */ input: unknown,
): Promise<{ code: number | null; output: string; errors: string }> {
  // 运行真实 admin 入口并收集 JSON 结果，以验证路由未偷渡应用初始化。
  const args = ['--import', 'tsx', path.resolve('apps/graph-server/admin.ts'), 'data.repair-news-context']
  const child = spawn(process.execPath, args, {
    cwd: path.resolve('.'),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHONGMING_MONGO_URI: targetUri,
      CHONGMING_CONFIG_DIR: path.join(tmpdir(), 'unused-news-repair-' + randomUUID()),
    },
  })
  let output = '', errors = ''
  child.stdout.on('data', /* 命令的一段标准输出。 */ chunk => { /* 保留结构化结果。 */ output += chunk.toString() })
  child.stderr.on('data', /* 命令的一段诊断输出。 */ chunk => { /* 保留失败原因供断言。 */ errors += chunk.toString() })
  const closed = new Promise<number | null>((/* 子进程关闭后的最终退出码。 */ resolve, /* 启动失败原因。 */ reject) => {
    // 同时等待启动错误和 stdio 排空后的关闭，避免截断命令结果。
    child.once('error', reject)
    child.once('close', resolve)
  })
  child.stdin.end(JSON.stringify(input))
  return { code: await closed, output, errors }
}

describe('Explicit legacy News context repair', () => {
  // 覆盖修复的字段范围、版本推进和重复执行语义。
  it('previews without writes, only restores missing legacy News contexts, and is idempotent', async () => {
    // 构造缺失、已有、当前格式和已删除图，检查只修复仍有效的历史缺失字段。
    const db = connection.db
    if (!db) throw new Error('expected connected database')
    const graphs = db.collection<{ _id: string; [key: string]: unknown }>(GRAPH_COLLECTION)
    const time = new Date('2026-08-20T10:00:00.000Z')
    const original = { _id: randomUUID(), revision: 7, updatedAt: time, nodes: [
      { id: 'missing', data: { kind: 'news', content: 'Article' } },
      { id: 'present', data: { kind: 'news', content: 'Article', context: { author: { value: 'Reporter', visibleToAI: true } } } },
      { id: 'claim', data: { kind: 'claim', content: 'Claim' } },
      { id: 'current', typeId: 'factcheck.news', typeVersion: 1, payload: { content: 'Current article', context: {} } },
    ] }
    const deleted = { _id: randomUUID(), revision: 2, updatedAt: time, deletedAt: time,
      nodes: [{ id: 'deleted-news', data: { kind: 'news', content: 'Deleted' } }] }
    await graphs.insertMany([original, deleted])
    expect(await repairUpdateNewsContext(connection)).toEqual({ matchedMaps: 1, modifiedMaps: 0 })
    expect(await graphs.findOne({ _id: original._id })).toEqual(original)
    const collectionsBefore = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map(/* 预览前的集合记录。 */ item => /* 只比较稳定集合名。 */ item.name)
      .sort()
    const preview = await runRepairCommand(uri, {})
    expect(preview.code, preview.errors).toBe(0)
    expect(JSON.parse(preview.output)).toEqual({ matchedMaps: 1, modifiedMaps: 0 })
    const collectionsAfter = (await db.listCollections({}, { nameOnly: true }).toArray())
      .map(/* 命令退出后的集合记录。 */ item => /* 只比较稳定集合名。 */ item.name)
      .sort()
    expect(collectionsAfter).toEqual(collectionsBefore)
    expect(await repairUpdateNewsContext(connection, true)).toEqual({ matchedMaps: 1, modifiedMaps: 1 })
    expect(await graphs.findOne({ _id: original._id })).toMatchObject({ revision: 8, nodes: [
      { ...original.nodes[0], data: { kind: 'news', content: 'Article', context: {} } },
      ...original.nodes.slice(1),
    ] })
    expect(await graphs.findOne({ _id: deleted._id })).toEqual(deleted)
    expect(await repairUpdateNewsContext(connection, true)).toEqual({ matchedMaps: 0, modifiedMaps: 0 })
  })
})
