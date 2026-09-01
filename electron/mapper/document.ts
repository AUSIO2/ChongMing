import { randomUUID } from 'node:crypto'
import { MapModel, WorkspaceModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import {
  mapAssertWritable,
  mapLeaseRelease,
  mapLeaseTryAcquire,
} from '../api/map-lease'
import type {
  MapperDocument,
  MapperMapSummary,
  MapperRun,
  MapperTimeline,
  NewsRecord,
} from './types'

function toIso(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : typeof value === 'string'
      ? value
      : new Date().toISOString()
}

function readRun(value: unknown): MapperRun | undefined {
  if (!value || typeof value !== 'object') return undefined
  const run = value as MapperRun & { updatedAt: unknown }
  return {
    ...run,
    draft: {
      ...run.draft,
      calls: run.draft.calls.map(call => ({
        ...call,
        plannedAt: toIso(call.plannedAt),
        startedAt: call.startedAt ? toIso(call.startedAt) : undefined,
        completedAt: call.completedAt ? toIso(call.completedAt) : undefined,
      })),
    },
    updatedAt: toIso(run.updatedAt),
  }
}

function readDocument(raw: Record<string, unknown>): MapperDocument {
  return {
    id: String(raw._id),
    workspaceId: String(raw.workspaceId),
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : undefined,
    sources: (raw.sources ?? []) as MapperDocument['sources'],
    news: (raw.news ?? []) as NewsRecord[],
    claims: (raw.claims ?? []) as MapperDocument['claims'],
    routes: (raw.routes ?? []) as MapperDocument['routes'],
    timeline: (raw.timeline ?? {
      startX: 0,
      endX: 3,
      activeScope: '',
    }) as MapperTimeline,
    run: readRun(raw.run),
    revision: typeof raw.revision === 'number' ? raw.revision : 0,
    createdAt: toIso(raw.createdAt),
    updatedAt: toIso(raw.updatedAt),
  }
}

export async function mapDocumentCreate(input: {
  workspaceId: string
  name?: string
}): Promise<MapperDocument> {
  const workspaceId = input.workspaceId.trim()
  if (!await WorkspaceModel.exists({ _id: workspaceId })) {
    throw new AppError(
      ErrorCode.WORKSPACE_NOT_FOUND,
      `Workspace not found: ${workspaceId}`,
    )
  }

  const id = randomUUID()
  await MapModel.create({
    _id: id,
    workspaceId,
    name: input.name?.trim() || undefined,
    sources: [],
    news: [],
    claims: [],
    routes: [],
    timeline: { startX: 0, endX: 3, activeScope: '' },
    revision: 0,
  })
  await mapLeaseTryAcquire(id)
  return (await mapDocumentRead(id))!
}

export async function mapDocumentInsert(
  document: MapperDocument,
  workspaceId: string,
): Promise<MapperDocument> {
  await MapModel.create({
    _id: document.id,
    workspaceId,
    name: document.name,
    sources: document.sources,
    news: document.news,
    claims: document.claims,
    routes: document.routes,
    timeline: document.timeline,
    run: document.run
      ? { ...document.run, updatedAt: new Date(document.run.updatedAt) }
      : undefined,
    revision: document.revision,
  })
  return (await mapDocumentRead(document.id))!
}

export async function mapDocumentList(workspaceId: string): Promise<MapperMapSummary[]> {
  const rows = await MapModel.find({ workspaceId })
    .select({ _id: 1, workspaceId: 1, name: 1, news: 1, claims: 1, createdAt: 1, updatedAt: 1 })
    .sort({ updatedAt: -1 })
    .lean()
  return rows.map(row => ({
    id: String(row._id),
    workspaceId: String(row.workspaceId),
    name: typeof row.name === 'string' && row.name.trim() ? row.name : undefined,
    newsCount: row.news?.length ?? 0,
    claimCount: row.claims?.length ?? 0,
    createdAt: toIso(row.createdAt),
    updatedAt: toIso(row.updatedAt),
  }))
}

export async function mapDocumentRead(mapId: string): Promise<MapperDocument | null> {
  const doc = await MapModel.findById(mapId)
  if (!doc) return null
  const raw = (doc.toObject as (
    options: { flattenMaps: boolean },
  ) => Record<string, unknown>)({ flattenMaps: true })
  return readDocument(raw)
}

export async function mapDocumentCommit(
  document: MapperDocument,
  expectedRevision: number,
): Promise<MapperDocument> {
  await mapAssertWritable(document.id)
  const $set = {
    name: document.name,
    sources: document.sources,
    news: document.news,
    claims: document.claims,
    routes: document.routes,
    timeline: document.timeline,
    ...(document.run ? { run: document.run } : {}),
  }
  const update = document.run
    ? { $set, $inc: { revision: 1 } }
    : { $set, $unset: { run: 1 as const }, $inc: { revision: 1 } }
  const result = await MapModel.updateOne(
    { _id: document.id, revision: expectedRevision },
    update,
  )
  if (result.matchedCount === 0) {
    if (!await MapModel.exists({ _id: document.id })) {
      throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${document.id}`)
    }
    throw new AppError(
      ErrorCode.MAP_REVISION_CONFLICT,
      `Map revision changed: ${document.id}`,
    )
  }
  return (await mapDocumentRead(document.id))!
}

export async function mapDocumentDelete(mapId: string): Promise<void> {
  await mapAssertWritable(mapId)
  await mapLeaseRelease(mapId)
  const result = await MapModel.deleteOne({ _id: mapId })
  if (result.deletedCount === 0) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
}
