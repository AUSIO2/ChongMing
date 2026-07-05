import { randomUUID } from 'node:crypto'
import { NewsModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import type {
  CreateNewsInput,
  DisplayNews,
  DisplayNewsSummary,
  MapGraphPersist,
  MapRunPersist,
  UpdateNewsInput,
} from './types'
import {
  serialReadContextMap,
  serialReadNews,
  serialReadNewsSummary,
} from './serialize'

export async function newsCreate(input: CreateNewsInput): Promise<DisplayNews> {
  const _id = input._id ?? randomUUID()
  const doc = await NewsModel.create({
    _id,
    content: input.content,
    context: serialReadContextMap(input.context),
    claims: [],
  })
  return serialReadNews(doc)
}

export async function newsReadIndex(): Promise<DisplayNewsSummary[]> {
  const docs = await NewsModel.find().sort({ updatedAt: -1 }).lean()
  return docs.map(doc => serialReadNewsSummary(doc))
}

export async function newsRead(newsId: string): Promise<DisplayNews | null> {
  const doc = await NewsModel.findById(newsId)
  if (!doc) return null
  return serialReadNews(doc)
}

export async function newsUpdate(
  newsId: string,
  patch: UpdateNewsInput,
): Promise<DisplayNews> {
  const doc = await NewsModel.findById(newsId)
  if (!doc) {
    throw new AppError(ErrorCode.NEWS_NOT_FOUND, `News not found: ${newsId}`)
  }

  if (patch.content !== undefined) {
    doc.set('content', patch.content)
  }
  if (patch.context !== undefined) {
    doc.set('context', serialReadContextMap(patch.context))
  }

  await doc.save()
  return serialReadNews(doc)
}

/** 持久化 Map 运行会话与图快照（断点恢复）。传 null 表示 $unset。 */
export async function newsUpdatePersistMap(
  newsId: string,
  data: {
    mapRun?: MapRunPersist | null
    mapGraph?: MapGraphPersist | null
  },
): Promise<void> {
  const exists = await NewsModel.exists({ _id: newsId })
  if (!exists) {
    throw new AppError(ErrorCode.NEWS_NOT_FOUND, `News not found: ${newsId}`)
  }

  const $set: Record<string, unknown> = {}
  const $unset: Record<string, 1> = {}

  if (data.mapRun === null) {
    $unset.mapRun = 1
  } else if (data.mapRun !== undefined) {
    $set.mapRun = { ...data.mapRun, updatedAt: new Date(data.mapRun.updatedAt) }
  }

  if (data.mapGraph === null) {
    $unset.mapGraph = 1
  } else if (data.mapGraph !== undefined) {
    $set.mapGraph = { ...data.mapGraph, updatedAt: new Date(data.mapGraph.updatedAt) }
  }

  const update: Record<string, unknown> = {}
  if (Object.keys($set).length) update.$set = $set
  if (Object.keys($unset).length) update.$unset = $unset
  if (Object.keys(update).length === 0) return

  await NewsModel.updateOne({ _id: newsId }, update)
}
