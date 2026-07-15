import type {
  CreateMapInput,
  DisplayMap,
  MapGraphPersist,
  MapRunPersist,
  UpdateMapInput,
} from '../../../electron/api/types'
import type { MapAPI as ElectronMapAPI } from '../../../electron/api/types'
import { docReadSnapshot } from '@flow-map/graph-doc'
import type { MapGraphDoc } from '@flow-map/graph-doc'

const store = new Map<string, DisplayMap>()

export function mockMapReset(): void {
  store.clear()
}

export function mockMapSeed(display: DisplayMap): void {
  store.set(display._id, structuredClone(display))
}

export function mockMapRead(mapId: string): DisplayMap | undefined {
  return store.get(mapId)
}

function mockSyncClaimsFromGraph(map: DisplayMap, mapGraph: MapGraphPersist): void {
  const nodes = (mapGraph.nodes ?? []) as Array<{
    id: string
    kind: string
    parentId?: string
    dataPhase?: string
    params?: { content?: string; sourceAgent?: string; category?: string }
  }>
  const claimNodes = nodes.filter(
    n => n.kind === 'claim' && n.dataPhase === 'persisted',
  )
  const existing = new Map(map.claims.map(c => [c.claimId, c]))
  for (const node of claimNodes) {
    const opinions = nodes.filter(
      o => o.kind === 'opinion' && o.parentId === node.id && o.dataPhase === 'persisted',
    )
    const verifyResult = opinions.length > 0
      ? {
          score: 0.9,
          reason: 'ok',
          opinions: [],
          rawMergeResponse: '',
          verifiedAt: new Date().toISOString(),
        }
      : undefined
    const prev = existing.get(node.id)
    if (prev) {
      if (verifyResult) prev.verifyResult = verifyResult
      continue
    }
    map.claims.push({
      claimId: node.id,
      content: node.params?.content ?? '',
      category: node.params?.category,
      sourceAgent: node.params?.sourceAgent,
      verifyResult,
    })
  }
}

export function mockMapBuildAPI(): ElectronMapAPI {
  return {
    async create(input: CreateMapInput) {
      const map: DisplayMap = {
        _id: input._id ?? crypto.randomUUID(),
        workspaceId: input.workspaceId,
        content: input.content ?? '',
        context: input.context ?? {},
        claims: [],
        timeline: { startX: 0, endX: 3, activeScope: '' },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      store.set(map._id, map)
      return structuredClone(map)
    },

    async list(workspaceId: string) {
      return [...store.values()]
        .filter(m => m.workspaceId === workspaceId)
        .map(m => ({
          _id: m._id,
          workspaceId: m.workspaceId,
          name: m.name,
          content: m.content,
          claimCount: m.claims.length,
          createdAt: m.createdAt,
          updatedAt: m.updatedAt,
        }))
    },

    async get(mapId) {
      const map = store.get(mapId)
      return map ? structuredClone(map) : null
    },

    async update(mapId, patch: UpdateMapInput) {
      const map = store.get(mapId)
      if (!map) throw new Error(`map not found: ${mapId}`)
      if (patch.content !== undefined) map.content = patch.content
      if (patch.timeline) map.timeline = { ...map.timeline, ...patch.timeline }
      map.updatedAt = new Date().toISOString()
      return structuredClone(map)
    },

    async delete(mapId) {
      store.delete(mapId)
    },

    async saveMapPersistence(mapId, data) {
      const map = store.get(mapId)
      if (!map) return
      if (data.mapGraph) {
        map.mapGraph = structuredClone(data.mapGraph) as MapGraphPersist
        mockSyncClaimsFromGraph(map, data.mapGraph)
      }
      if (data.mapRun === null) {
        map.mapRun = undefined
      } else if (data.mapRun) {
        map.mapRun = structuredClone(data.mapRun) as MapRunPersist
      }
      map.updatedAt = new Date().toISOString()
    },

    async readAllClaims(mapId) {
      const map = store.get(mapId)
      return map ? structuredClone(map.claims) : []
    },
  }
}

export function mockMapSyncClaimsFromDoc(mapId: string, doc: MapGraphDoc): void {
  const map = store.get(mapId)
  if (!map?.mapGraph) return
  mockSyncClaimsFromGraph(map, map.mapGraph)
  const snap = docReadSnapshot(doc)
  for (const node of snap.nodes) {
    if (node.kind !== 'claim' || node.dataPhase !== 'persisted') continue
    if (map.claims.some(c => c.claimId === node.id)) continue
    map.claims.push({
      claimId: node.id,
      content: node.params.content,
      category: node.params.category,
      sourceAgent: node.params.sourceAgent,
    })
  }
}
