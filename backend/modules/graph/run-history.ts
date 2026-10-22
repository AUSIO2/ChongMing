// 读取当前与归档 Run 的有界摘要目录，并将游标绑定到精确查询及成员集合。
import type { GraphQuery } from '../../../contracts/graph-api'
import type { GraphRun, GraphRunPage, GraphRunSummary } from '../../../contracts/graph-run'
import { RuntimeMessage } from '../../../contracts/messages'
import { GraphError } from '../shared/domain-error'
import { inputReadId, inputReadObject, inputReadString } from '../shared/input-validation'
import { storeCreateInputHash, type GraphDocument } from './graph-record'

type RunListParams = Extract<GraphQuery, { method: 'run.list' }>['params']
interface DirectoryEntry { run: GraphRun; archived: boolean }
interface DirectoryCursor {
  mapId: string
  queryHash: string
  directoryVersion: string
  after: { createdAt: string; runId: string }
}

/** 解析一次外部目录参数；不读取图、不授权或取得控制权。 */
export function graphReadRunPageParams(
  /* HTTP 交付的未知 params 对象，尚未检查白名单和页大小。 */ value: unknown,
): RunListParams {
  // 只在外部边界检查原始类型；内部 GraphQuery 继续使用明确的可信参数类型。
  const params = inputReadObject(value, ['mapId', 'operationId', 'cursor', 'limit'], 'params')
  const mapId = inputReadId(params.mapId, 'params.mapId')
  const operationId = params.operationId === undefined ? undefined : inputReadString(params.operationId, 'params.operationId')
  let limit: number | undefined
  if (params.limit !== undefined) {
    if (typeof params.limit !== 'number' || !Number.isSafeInteger(params.limit) || params.limit < 1 || params.limit > 100) {
      throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.RUN_HISTORY_LIMIT_INVALID)
    }
    limit = params.limit
  }
  let cursor: string | undefined
  if (params.cursor !== undefined) {
    if (typeof params.cursor !== 'string' || !params.cursor || params.cursor.length > 1024) throw invalidCursor()
    cursor = params.cursor
  }
  return { mapId, ...(operationId === undefined ? {} : { operationId }), ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }) }
}

/** 从已授权的同一图快照读取目录；只返回摘要，不修改记录或分配身份。 */
export function graphReadRunPage(
  /* 应用层已核对当前 viewer 权限及未删除状态的完整图。 */ document: GraphDocument,
  /* 由公开参数边界验证的查询；缺省页大小规范为 25。 */ params: RunListParams,
): GraphRunPage {
  // current 优先的身份去重先于精确过滤，避免归档重复记录冒充当前内容。
  const entries = readDirectoryEntries(document, params.operationId)
  const limit = params.limit ?? 25
  const queryHash = storeCreateInputHash({ limit, operationId: params.operationId ?? null })
  const directoryVersion = graphReadRunDirectoryVersion(entries)
  let offset = 0
  if (params.cursor !== undefined) {
    const cursor = readCursor(params.cursor)
    if (cursor.mapId !== params.mapId || cursor.queryHash !== queryHash) throw invalidCursor()
    if (cursor.directoryVersion !== directoryVersion) {
      throw new GraphError(409, 'RUN_CURSOR_EXPIRED', RuntimeMessage.RUN_HISTORY_CURSOR_EXPIRED)
    }
    const position = entries.findIndex((/* 当前有序目录的一项。 */ entry) =>
      /* 游标位置必须实际属于同一成员版本，拒绝伪造的跳页位置。 */
      entry.run.id === cursor.after.runId && entry.run.createdAt === cursor.after.createdAt)
    if (position < 0) throw invalidCursor()
    offset = position + 1
  }
  const page = entries.slice(offset, offset + limit)
  const last = page[page.length - 1]
  const nextCursor = last && offset + page.length < entries.length
    ? Buffer.from(JSON.stringify({ mapId: params.mapId, queryHash, directoryVersion,
      after: { createdAt: last.run.createdAt, runId: last.run.id } } satisfies DirectoryCursor)).toString('base64url') : null
  return { mapId: params.mapId, items: page.map(readSummary), nextCursor, directoryVersion }
}

/** 合并两处保存记录并按创建时间倒序、身份升序建立稳定目录。 */
function readDirectoryEntries(
  /* 当前图的一致读取快照。 */ document: GraphDocument,
  /* 精确匹配的 Operation 身份，省略时列出所有运行。 */ operationId?: string,
): DirectoryEntry[] {
  // 同一身份总以 current 为准；归档标记和状态均不参与成员版本。
  const byId = new Map<string, DirectoryEntry>()
  for (const run of document.runs) if (!byId.has(run.id)) byId.set(run.id, { run, archived: false })
  for (const run of document.runHistory) if (!byId.has(run.id)) byId.set(run.id, { run, archived: true })
  return [...byId.values()].filter((/* 一个去重后的运行记录。 */ entry) =>
    /* 普通字符串按完整身份相等比较，不做前缀、类型或 runId 猜测。 */
    operationId === undefined || entry.run.operations.some((/* 运行内保存的 Operation。 */ operation) =>
      /* 一个 Operation 精确命中即可保留所属 Run。 */ operation.id === operationId)).sort(
    (/* 前一条运行。 */ left, /* 后一条运行。 */ right) => {
      // 已保存时间为 ISO 字符串，等时再用身份的固定字典顺序稳定分页。
      if (left.run.createdAt !== right.run.createdAt) return left.run.createdAt > right.run.createdAt ? -1 : 1
      return left.run.id < right.run.id ? -1 : left.run.id > right.run.id ? 1 : 0
    },
  )
}

/** 仅绑定筛选目录的有序身份和创建时间，允许状态更新及归档搬移。 */
function graphReadRunDirectoryVersion(
  /* 已去重、过滤并排序的匹配运行。 */ entries: readonly DirectoryEntry[],
): string {
  // 不含 updatedAt、状态或完整 payload；分页期间不承诺状态快照。
  return storeCreateInputHash(entries.map((/* 匹配的一条运行。 */ entry) =>
    /* 成员变化才导致旧游标过期。 */ [entry.run.id, entry.run.createdAt]))
}

/** 从保存结构生成轻量计数，不带出候选正文、配置或完整 Operation。 */
function readSummary(
  /* 当前页一份已经确定归属的记录。 */ entry: DirectoryEntry,
): GraphRunSummary {
  // 步骤取冻结计划总数；待审核只计活动运行内仍等待回答的 Operation。
  const run = entry.run
  return { runId: run.id, status: run.status, archived: entry.archived, mode: run.mode, paused: run.paused,
    createdAt: run.createdAt, updatedAt: run.updatedAt, stepCount: run.plan.steps.length, operationCount: run.operations.length,
    pendingReviewCount: run.status === 'running' || run.status === 'waiting' ? run.operations.filter((/* 一份保存的 Operation。 */ operation) =>
      /* 终态和非等待 Operation 保留的审核身份不再可回答。 */ operation.status === 'waiting' && operation.review?.state === 'pending').length : 0,
    outputCount: run.operations.reduce((/* 已累计的产物数量。 */ count, /* 当前 Operation。 */ operation) =>
      /* 正式发布产物使用保存引用，不把未发布候选计入。 */ count + operation.outputRefs.length, 0) }
}

/** 解码服务器游标并拒绝非规范编码及缺字段内容。 */
function readCursor(
  /* 外部边界已经限制长度的非空 base64url 字符串。 */ value: string,
): DirectoryCursor {
  // 游标始终视为不可信内容；版本只用于一致性，不能代替 Map 成员授权。
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalidCursor()
    const bytes = Buffer.from(value, 'base64url')
    if (bytes.toString('base64url') !== value) throw invalidCursor()
    const raw: unknown = JSON.parse(bytes.toString('utf8'))
    const object = inputReadObject(raw, ['mapId', 'queryHash', 'directoryVersion', 'after'], 'cursor')
    const after = inputReadObject(object.after, ['createdAt', 'runId'], 'cursor.after')
    if (typeof object.mapId !== 'string' || !object.mapId || typeof object.queryHash !== 'string'
      || !/^[a-f0-9]{64}$/.test(object.queryHash) || typeof object.directoryVersion !== 'string'
      || !/^[a-f0-9]{64}$/.test(object.directoryVersion) || typeof after.createdAt !== 'string' || !after.createdAt
      || typeof after.runId !== 'string' || !after.runId) throw invalidCursor()
    return { mapId: object.mapId, queryHash: object.queryHash, directoryVersion: object.directoryVersion,
      after: { createdAt: after.createdAt, runId: after.runId } }
  } catch {
    throw invalidCursor()
  }
}

/** 为所有格式或查询绑定错误保持同一公开游标错误。 */
function invalidCursor(): GraphError {
  // 与成员版本已经变化的 409 过期错误明确区分。
  return new GraphError(400, 'INVALID_CURSOR', RuntimeMessage.RUN_HISTORY_CURSOR_INVALID)
}
