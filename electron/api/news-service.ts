import { randomUUID } from 'node:crypto'
import { NewsModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import type {
  CreateNewsInput,
  DisplayNews,
  DisplayNewsSummary,
  UpdateNewsInput,
} from './types'
import {
  contextToMap,
  serializeNewsDocument,
  serializeNewsSummary,
} from './serialize'

export async function createNews(input: CreateNewsInput): Promise<DisplayNews> {
  const _id = input._id ?? randomUUID()
  const doc = await NewsModel.create({
    _id,
    content: input.content,
    context: contextToMap(input.context),
    claims: [],
  })
  return serializeNewsDocument(doc)
}

export async function listNews(): Promise<DisplayNewsSummary[]> {
  const docs = await NewsModel.find().sort({ updatedAt: -1 }).lean()
  return docs.map(doc => serializeNewsSummary(doc))
}

export async function getNews(newsId: string): Promise<DisplayNews | null> {
  const doc = await NewsModel.findById(newsId)
  if (!doc) return null
  return serializeNewsDocument(doc)
}

export async function updateNews(
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
    doc.set('context', contextToMap(patch.context))
  }

  await doc.save()
  return serializeNewsDocument(doc)
}
