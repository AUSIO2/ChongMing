import type { NewsContext, MapSubAgentParams } from '../shared/types'
import {
  MAP_DEFAULT_SCOPE,
  mapScopeReadContext,
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
    scope = chains.get(scopeNodeId)
  } else if (chains) {
    scope = chains[scopeNodeId]
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

  return {
    _id: String(raw._id),
    content: scope.content,
    context: scope.context,
    claims: scope.claims,
    splitMeta: scope.splitMeta,
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
  chains?: unknown
  createdAt?: unknown
  updatedAt?: unknown
}): DisplayMapSummary {
  const scope = scopeReadForDisplay(doc)
  return {
    _id: String(doc._id),
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
