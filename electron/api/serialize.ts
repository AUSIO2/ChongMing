import type { NewsContext, MapSubAgentParams } from '../shared/types'
import {
  MAP_DEFAULT_SCOPE,
  mapScopeReadContext,
  mapScopeReadKey,
  type MapChainScope,
} from '../shared/map-scope'
import type {
  DisplayMap,
  DisplayMapSummary,
  DisplaySplitMeta,
  GraphParseState,
  GraphSplitState,
  GraphSplitRecordDto,
  GraphVerifyState,
  MapGraphPersist,
  MapRunPersist,
  MapTimelineDto,
} from './types'

function toIsoString(value: unknown): string | undefined {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

function splitMetaRead(raw: unknown): DisplaySplitMeta | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const splitMetaRaw = raw as {
    model?: string
    routeInstructions?: DisplaySplitMeta['routeInstructions']
    subAgentResults?: GraphSplitRecordDto[]
    rawMergeResponse?: string
    splitAt?: unknown
  }
  return {
    model: String(splitMetaRaw.model ?? 'langgraph'),
    routeInstructions: splitMetaRaw.routeInstructions,
    subAgentResults: (splitMetaRaw.subAgentResults ?? []) as GraphSplitRecordDto[],
    rawMergeResponse: String(splitMetaRaw.rawMergeResponse ?? ''),
    splitAt: toIsoString(splitMetaRaw.splitAt) ?? new Date().toISOString(),
  }
}

function serialReadPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function serialReadStateIndex(value: unknown): 0 | 1 | 2 | 3 | undefined {
  if (typeof value !== 'number' || value < 0 || value > 3) return undefined
  return value as 0 | 1 | 2 | 3
}

function serialReadTimeline(raw: unknown): MapTimelineDto {
  if (!raw || typeof raw !== 'object') {
    return { startX: 0, endX: 3, activeScope: '' }
  }
  const t = raw as Record<string, unknown>

  if (t.scopes && typeof t.scopes === 'object') {
    const activeScope = String(t.activeScope ?? '')
    const scopes = t.scopes as Record<string, {
      startX?: number
      endX?: number
      stateIndex?: number
    }>
    const scope = (activeScope && scopes[activeScope])
      ? scopes[activeScope]
      : Object.values(scopes)[0]
    return {
      startX: serialReadStateIndex(scope?.startX) ?? 0,
      endX: serialReadStateIndex(scope?.endX) ?? 3,
      stateIndex: serialReadStateIndex(scope?.stateIndex),
      activeScope,
    }
  }

  return {
    startX: serialReadStateIndex(t.startX) ?? 0,
    endX: serialReadStateIndex(t.endX) ?? 3,
    stateIndex: serialReadStateIndex(t.stateIndex),
    activeScope: String(t.activeScope ?? ''),
  }
}

function scopeReadForDisplay(
  doc: { chains?: unknown },
  scopeNodeId: string = MAP_DEFAULT_SCOPE,
) {
  const chains = doc.chains as Map<string, {
    content?: string
    context?: unknown
    claims?: unknown[]
    splitMeta?: unknown
  }> | Record<string, {
    content?: string
    context?: unknown
    claims?: unknown[]
    splitMeta?: unknown
  }> | undefined

  let scope: {
    content?: string
    context?: unknown
    claims?: unknown[]
    splitMeta?: unknown
  } | undefined

  if (chains instanceof Map) {
    scope = chains.get(mapScopeReadKey(scopeNodeId))
  } else if (chains) {
    scope = chains[mapScopeReadKey(scopeNodeId)]
  }

  if (!scope) {
    return {
      content: '',
      context: {},
      claims: [],
      splitMeta: undefined,
    }
  }

  return {
    content: String(scope.content ?? ''),
    context: mapScopeReadContext(scope as MapChainScope),
    claims: serialReadPlain(scope.claims ?? []) as DisplayMap['claims'],
    splitMeta: splitMetaRead(scope.splitMeta),
  }
}

export function serialReadMap(doc: unknown, scopeNodeId = MAP_DEFAULT_SCOPE): DisplayMap {
  const record = doc as {
    toObject?: () => Record<string, unknown>
    _id: unknown
    confidence?: number | null
    confidenceUpdatedAt?: unknown
    createdAt?: unknown
    updatedAt?: unknown
    chains?: unknown
  }
  const raw = typeof record.toObject === 'function'
    ? (record.toObject as (opts?: { flattenMaps?: boolean }) => Record<string, unknown>)({ flattenMaps: true })
    : record
  const scope = scopeReadForDisplay(raw, scopeNodeId)

  const mapRunRaw = (raw as Record<string, unknown>).mapRun as MapRunPersist | null | undefined
  const mapGraphRaw = (raw as Record<string, unknown>).mapGraph as MapGraphPersist | null | undefined
  const rawName = (raw as Record<string, unknown>).name

  const rawWorkspaceId = (raw as Record<string, unknown>).workspaceId

  return {
    _id: String(raw._id),
    workspaceId: typeof rawWorkspaceId === 'string' && rawWorkspaceId
      ? rawWorkspaceId
      : 'workspace:default',
    name: typeof rawName === 'string' && rawName.trim() ? rawName.trim() : undefined,
    content: scope.content,
    context: scope.context,
    claims: scope.claims,
    splitMeta: scope.splitMeta,
    timeline: serialReadTimeline((raw as Record<string, unknown>).timeline),
    mapRun: mapRunRaw
      ? serialReadPlain({
          ...mapRunRaw,
          updatedAt: toIsoString(mapRunRaw.updatedAt) ?? new Date().toISOString(),
        })
      : undefined,
    mapGraph: mapGraphRaw
      ? serialReadPlain({
          ...mapGraphRaw,
          updatedAt: toIsoString(mapGraphRaw.updatedAt) ?? new Date().toISOString(),
        })
      : undefined,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    confidenceUpdatedAt: toIsoString(raw.confidenceUpdatedAt),
    createdAt: toIsoString(raw.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(raw.updatedAt) ?? new Date().toISOString(),
  }
}

export function serialReadMapSummary(doc: {
  _id: unknown
  workspaceId?: unknown
  name?: unknown
  chains?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}): DisplayMapSummary {
  const scope = scopeReadForDisplay(doc)
  return {
    _id: String(doc._id),
    workspaceId: typeof doc.workspaceId === 'string' && doc.workspaceId
      ? doc.workspaceId
      : 'workspace:default',
    name: typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : undefined,
    content: scope.content,
    claimCount: scope.claims.length,
    createdAt: toIsoString(doc.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(doc.updatedAt) ?? new Date().toISOString(),
  }
}

export function serialReadParseState(state: {
  mapId: string
  parentNodeId: string
  newsNodeId: string
  mode: GraphParseState['mode']
  sourceUri: string
  sourceKind: GraphParseState['sourceKind']
  rawContent: string
  routeInstructions?: MapSubAgentParams[]
  subAgentResults?: GraphSplitRecordDto[]
  parsedContent: string
}): GraphParseState {
  return {
    mapId: state.mapId,
    parentNodeId: state.parentNodeId,
    newsNodeId: state.newsNodeId,
    mode: state.mode,
    sourceUri: state.sourceUri,
    sourceKind: state.sourceKind,
    rawContent: state.rawContent,
    routeInstructions: state.routeInstructions ?? [],
    subAgentResults: state.subAgentResults ?? [],
    parsedContent: state.parsedContent,
  }
}

export function serialReadSplitState(state: {
  mapId: string
  parentNodeId: string
  mode: GraphSplitState['mode']
  content: string
  visibleContext: Record<string, string>
  routeInstructions: GraphSplitState['routeInstructions']
  subAgentResults: GraphSplitRecordDto[]
  mergedClaims: GraphSplitState['mergedClaims']
  rawMergeResponse: string
  saveIndex?: number
}): GraphSplitState {
  return {
    mapId: state.mapId,
    parentNodeId: state.parentNodeId,
    mode: state.mode,
    content: state.content,
    visibleContext: state.visibleContext,
    routeInstructions: state.routeInstructions,
    subAgentResults: state.subAgentResults,
    mergedClaims: state.mergedClaims,
    rawMergeResponse: state.rawMergeResponse,
    saveIndex: state.saveIndex ?? 0,
  }
}

export function serialReadVerifyState(state: {
  mapId: string
  parentNodeId: string
  scopeNodeId: string
  mode: GraphVerifyState['mode']
  claimContent: string
  originalContent: string
  visibleContext: Record<string, string>
  routeInstructions: GraphVerifyState['routeInstructions']
  subAgentOpinions: GraphVerifyState['subAgentOpinions']
  finalScore: GraphVerifyState['finalScore']
  finalReason: string
  rawMergeResponse: string
  opinionSaveIndex?: number
}): GraphVerifyState {
  return {
    mapId: state.mapId,
    parentNodeId: state.parentNodeId,
    scopeNodeId: state.scopeNodeId,
    mode: state.mode,
    claimContent: state.claimContent,
    originalContent: state.originalContent,
    visibleContext: state.visibleContext,
    routeInstructions: state.routeInstructions,
    subAgentOpinions: state.subAgentOpinions,
    finalScore: state.finalScore,
    finalReason: state.finalReason,
    rawMergeResponse: state.rawMergeResponse,
    opinionSaveIndex: state.opinionSaveIndex ?? 0,
  }
}

export function serialReadContextMap(
  context: NewsContext,
): Map<string, { value: unknown; visibleToAI: boolean }> {
  const map = new Map<string, { value: unknown; visibleToAI: boolean }>()
  for (const [key, field] of Object.entries(context)) {
    if (field) {
      map.set(key, { value: field.value, visibleToAI: field.visibleToAI })
    }
  }
  return map
}
