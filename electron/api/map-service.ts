import { randomUUID } from 'node:crypto'
import { MapModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import { MAP_DEFAULT_SCOPE, mapScopeReadKey, mapScopeReadAllClaims } from '../shared/map-scope'
import { WORKSPACE_DEFAULT_ID } from '../shared/types'
import type {
  CreateMapInput,
  DisplayMap,
  DisplayMapSummary,
  MapGraphPersist,
  MapRunPersist,
  MapTimelineDto,
  UpdateMapInput,
} from './types'
import {
  serialReadContextMap,
  serialReadMap,
  serialReadMapSummary,
} from './serialize'
import {
  workspaceAttachMap,
  workspaceDetachMap,
  workspaceGet,
} from './workspace-service'

function chainScopeEnsure(
  doc: InstanceType<typeof MapModel>,
  scopeNodeId: string,
) {
  const chainKey = mapScopeReadKey(scopeNodeId)
  const chains = doc.get('chains') as Map<string, Record<string, unknown>>
  if (!chains.has(chainKey)) {
    chains.set(chainKey, {
      content: '',
      context: new Map(),
      claims: [],
    })
  }
  return chains.get(chainKey)!
}

export async function mapCreate(input: CreateMapInput): Promise<DisplayMap> {
  const workspaceId = input.workspaceId?.trim() || WORKSPACE_DEFAULT_ID
  const ws = await workspaceGet(workspaceId)
  if (!ws) {
    throw new AppError(ErrorCode.WORKSPACE_NOT_FOUND, `Workspace not found: ${workspaceId}`)
  }

  const _id = input._id ?? randomUUID()
  const scopeNodeId = input.scopeNodeId ?? MAP_DEFAULT_SCOPE
  const hasContent = Boolean(input.content?.trim())

  const chains: Record<string, {
    content: string
    context: ReturnType<typeof serialReadContextMap>
    claims: []
  }> = {}

  if (hasContent) {
    chains[scopeNodeId] = {
      content: input.content ?? '',
      context: serialReadContextMap(input.context),
      claims: [],
    }
  }

  const doc = await MapModel.create({
    _id,
    workspaceId,
    name: input.name?.trim() || undefined,
    chains,
    timeline: hasContent
      ? {
          startX: 0,
          endX: 3,
          activeScope: scopeNodeId,
        }
      : {
          startX: 0,
          endX: 3,
          activeScope: '',
        },
  })
  await workspaceAttachMap(workspaceId, _id)
  return serialReadMap(doc, hasContent ? scopeNodeId : '')
}

export async function mapReadIndex(workspaceId: string): Promise<DisplayMapSummary[]> {
  const id = workspaceId?.trim() || WORKSPACE_DEFAULT_ID
  const docs = await MapModel.find({ workspaceId: id }).sort({ updatedAt: -1 }).lean()
  return docs.map(doc => serialReadMapSummary(doc))
}

export async function mapRead(mapId: string): Promise<DisplayMap | null> {
  const doc = await MapModel.findById(mapId).lean()
  if (!doc) return null
  const activeScope = (doc.timeline as { activeScope?: string } | undefined)
    ?.activeScope ?? MAP_DEFAULT_SCOPE
  return serialReadMap(doc, activeScope)
}

export async function mapReadAllClaims(mapId: string): Promise<DisplayMap['claims']> {
  const doc = await MapModel.findById(mapId).lean()
  if (!doc) return []
  return mapScopeReadAllClaims(doc) as DisplayMap['claims']
}

export async function mapUpdate(
  mapId: string,
  patch: UpdateMapInput,
): Promise<DisplayMap> {
  const doc = await MapModel.findById(mapId)
  if (!doc) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }

  const scopeNodeId = patch.scopeNodeId ?? MAP_DEFAULT_SCOPE

  if (patch.content !== undefined || patch.context !== undefined) {
    const scope = chainScopeEnsure(doc, scopeNodeId)
    if (patch.content !== undefined) {
      scope.content = patch.content
    }
    if (patch.context !== undefined) {
      scope.context = serialReadContextMap(patch.context)
    }
    doc.markModified('chains')
  }

  if (patch.name !== undefined) {
    const trimmed = patch.name.trim()
    doc.set('name', trimmed || undefined)
  }

  if (patch.timeline !== undefined) {
    const current = (doc.timeline ?? {}) as MapTimelineDto
    const next: MapTimelineDto = {
      startX: patch.timeline.startX ?? current.startX ?? 0,
      endX: patch.timeline.endX ?? current.endX ?? 3,
      activeScope: patch.timeline.activeScope ?? current.activeScope ?? '',
      stateIndex: patch.timeline.stateIndex !== undefined
        ? patch.timeline.stateIndex
        : current.stateIndex,
    }
    if (next.startX > next.endX) {
      throw new AppError(
        ErrorCode.MAP_SCOPE_NOT_FOUND,
        `timeline startX ${next.startX} > endX ${next.endX}`,
      )
    }
    doc.set('timeline', next)
    doc.markModified('timeline')
  }

  await doc.save()
  return serialReadMap(doc, scopeNodeId)
}

export async function mapUpdatePersistMap(
  mapId: string,
  data: {
    mapRun?: MapRunPersist | null
    mapGraph?: MapGraphPersist | null
  },
): Promise<void> {
  const exists = await MapModel.exists({ _id: mapId })
  if (!exists) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
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

  await MapModel.updateOne({ _id: mapId }, update)
}

export async function mapDelete(mapId: string): Promise<void> {
  const existing = await MapModel.findById(mapId).select('workspaceId').lean()
  if (!existing) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  const result = await MapModel.deleteOne({ _id: mapId })
  if (result.deletedCount === 0) {
    throw new AppError(ErrorCode.MAP_NOT_FOUND, `Map not found: ${mapId}`)
  }
  const workspaceId = (existing as { workspaceId?: string }).workspaceId
  if (workspaceId) {
    await workspaceDetachMap(workspaceId, mapId)
  }
}
