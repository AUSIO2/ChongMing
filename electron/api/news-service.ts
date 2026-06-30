import { randomUUID } from 'node:crypto'
import { NewsModel } from '../shared/database'
import type {
  CreateNewsInput,
  NewsDocumentDTO,
  NewsDocumentSummaryDTO,
  UpdateNewsInput,
} from './types'
import {
  contextToMap,
  serializeNewsDocument,
  serializeNewsSummary,
} from './serialize'

export async function createNews(input: CreateNewsInput): Promise<NewsDocumentDTO> {
  const _id = input._id ?? randomUUID()
  const doc = await NewsModel.create({
    _id,
    content: input.content,
    context: contextToMap(input.context),
    claims: [],
  })
  return serializeNewsDocument(doc)
}

export async function listNews(): Promise<NewsDocumentSummaryDTO[]> {
  const docs = await NewsModel.find().sort({ updatedAt: -1 }).lean()
  return docs.map(doc => serializeNewsSummary(doc))
}

export async function getNews(newsId: string): Promise<NewsDocumentDTO | null> {
  const doc = await NewsModel.findById(newsId)
  if (!doc) return null
  return serializeNewsDocument(doc)
}

export async function updateNews(
  newsId: string,
  patch: UpdateNewsInput,
): Promise<NewsDocumentDTO> {
  const doc = await NewsModel.findById(newsId)
  if (!doc) throw new Error(`News not found: ${newsId}`)

  if (patch.content !== undefined) {
    doc.set('content', patch.content)
  }
  if (patch.context !== undefined) {
    doc.set('context', contextToMap(patch.context))
  }
  if (patch.claims !== undefined) {
    doc.set('claims', patch.claims)
    doc.markModified('claims')
  }

  await doc.save()
  return serializeNewsDocument(doc)
}
