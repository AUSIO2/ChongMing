import { randomUUID } from 'node:crypto'
import { MapModel } from '../shared/database'
import { AppError, ErrorCode } from '../shared/errors'
import { MAP_DEFAULT_SCOPE } from '../shared/map-scope'
import type {
  CreateMapInput,
  DisplayMap,
  DisplayMapSummary,
  MapGraphPersist,
  MapRunPersist,
  UpdateMapInput,
} from './types'
import {
  serialReadContextMap,
  serialReadMap,
  serialReadMapSummary,
} from './serialize'

function chainScopeEnsure(
  doc: InstanceType<typeof MapModel>,
  scopeNodeId: string,
) {
  const chains = doc.get('chains') as Map<string, Record<string, unknown>>
  if (!chains.has(scopeNodeId)) {
    chains.set(scopeNodeId, {
      content: '',
      context: new Map(),
      claims: [],
    })
  }
  return chains.get(scopeNodeId)!
}

export async function mapCreate(input: CreateMapInput): Promise<DisplayMap> {
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
    chains,
    timeline: hasContent
      ? {
          activeScope: scopeNodeId,
          scopes: { [scopeNodeId]: { startX: 1, endX: 3 } },
        }
      : {
          activeScope: '',
          scopes: {},
        },
  })
  return serialReadMap(doc, hasContent ? scopeNodeId : '')
}

export async function mapReadIndex(): Promise<DisplayMapSummary[]> {
  const docs = await MapModel.find().sort({ updatedAt: -1 }).lean()
  return docs.map(doc => serialReadMapSummary(doc))
}

export async function mapRead(mapId: string): Promise<DisplayMap | null> {
  const doc = await MapModel.findById(mapId).lean()
  if (!doc) return null
  const activeScope = (doc.timeline as { activeScope?: string } | undefined)
    ?.activeScope ?? MAP_DEFAULT_SCOPE
  return serialReadMap(doc, activeScope)
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
  const scope = chainScopeEnsure(doc, scopeNodeId)

  if (patch.content !== undefined) {
    scope.content = patch.content
  }
  if (patch.context !== undefined) {
    scope.context = serialReadContextMap(patch.context)
  }

  doc.markModified('chains')
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
