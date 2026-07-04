import type { NewsContext } from '../shared/types'
import { toNewsContext } from '../shared/context'
import type {
  DisplayNews,
  DisplayNewsSummary,
  DisplaySplitMeta,
  GraphSplitState,
  DisplayOpinion,
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

/** Mongoose 文档 → 前端 DTO */
export function serializeNewsDocument(doc: unknown): DisplayNews {
  const record = doc as {
    toObject?: () => Record<string, unknown>
    _id: unknown
    content: string
    context?: unknown
    claims?: unknown
    splitMeta?: unknown
    confidence?: number | null
    confidenceUpdatedAt?: unknown
    createdAt?: unknown
    updatedAt?: unknown
  }
  const raw = typeof record.toObject === 'function' ? record.toObject() : record
  const splitMetaRaw = raw.splitMeta as {
    model?: string
    routeInstructions?: DisplaySplitMeta['routeInstructions']
    subAgentResults?: GraphSplitRecordDto[]
    rawMergeResponse?: string
    splitAt?: unknown
  } | null | undefined

  const splitMeta = splitMetaRaw
    ? {
        model: String(splitMetaRaw.model),
        routeInstructions: splitMetaRaw.routeInstructions,
        subAgentResults: splitMetaRaw.subAgentResults as GraphSplitRecordDto[],
        rawMergeResponse: String(splitMetaRaw.rawMergeResponse),
        splitAt: toIsoString(splitMetaRaw.splitAt) as string,
      }
    : undefined

  const mapRunRaw = (raw as Record<string, unknown>).mapRun as
    | MapRunPersist
    | null
    | undefined
  const mapGraphRaw = (raw as Record<string, unknown>).mapGraph as
    | MapGraphPersist
    | null
    | undefined

  return {
    _id: String(raw._id),
    content: String(raw.content),
    context: toNewsContext(raw.context),
    claims: (raw.claims ?? []) as DisplayNews['claims'],
    splitMeta,
    mapRun: mapRunRaw
      ? {
          ...mapRunRaw,
          updatedAt: toIsoString(mapRunRaw.updatedAt) ?? new Date().toISOString(),
        }
      : undefined,
    mapGraph: mapGraphRaw
      ? {
          ...mapGraphRaw,
          updatedAt: toIsoString(mapGraphRaw.updatedAt) ?? new Date().toISOString(),
        }
      : undefined,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : undefined,
    confidenceUpdatedAt: toIsoString(raw.confidenceUpdatedAt),
    createdAt: toIsoString(raw.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(raw.updatedAt) ?? new Date().toISOString(),
  }
}

export function serializeNewsSummary(doc: {
  _id: unknown
  content: string
  claims?: unknown[]
  createdAt?: unknown
  updatedAt?: unknown
}): DisplayNewsSummary {
  return {
    _id: String(doc._id),
    content: doc.content,
    claimCount: Array.isArray(doc.claims) ? doc.claims.length : 0,
    createdAt: toIsoString(doc.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(doc.updatedAt) ?? new Date().toISOString(),
  }
}

export function serializeSplitState(state: {
  newsId: string
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
    newsId: state.newsId,
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

export function serializeVerifyState(state: {
  newsId: string
  claimId: string
  mode: GraphVerifyState['mode']
  claimContent: string
  originalContent: string
  visibleContext: Record<string, string>
  routeInstructions: GraphVerifyState['routeInstructions']
  subAgentOpinions: DisplayOpinion[]
  finalScore: GraphVerifyState['finalScore']
  finalReason: string
  rawMergeResponse: string
  opinionSaveIndex?: number
}): GraphVerifyState {
  return {
    newsId: state.newsId,
    claimId: state.claimId,
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

/** 前端传入的 context 转为 Mongoose 可写入的 Map 结构 */
export function contextToMap(context: NewsContext): Map<string, { value: unknown; visibleToAI: boolean }> {
  const map = new Map<string, { value: unknown; visibleToAI: boolean }>()
  for (const [key, field] of Object.entries(context)) {
    if (field) {
      map.set(key, { value: field.value, visibleToAI: field.visibleToAI })
    }
  }
  return map
}
