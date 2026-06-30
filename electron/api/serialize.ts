import type { NewsContext } from '../shared/types'
import { toNewsContext } from '../shared/context'
import type {
  NewsDocumentDTO,
  NewsDocumentSummaryDTO,
  SplitGraphStateDTO,
  SubAgentOpinionDTO,
  SubAgentSplitRecordDTO,
  VerifyGraphStateDTO,
} from './types'

function toIsoString(value: unknown): string | undefined {
  if (!value) return undefined
  if (value instanceof Date) return value.toISOString()
  return String(value)
}

/** Mongoose 文档 → 前端 DTO */
export function serializeNewsDocument(doc: unknown): NewsDocumentDTO {
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
    subAgentResults?: SubAgentSplitRecordDTO[]
    rawMergeResponse?: string
    splitAt?: unknown
  } | null | undefined

  const splitMeta = splitMetaRaw
    ? {
        model: splitMetaRaw.model ?? 'langgraph',
        subAgentResults: splitMetaRaw.subAgentResults ?? [],
        rawMergeResponse: splitMetaRaw.rawMergeResponse ?? '',
        splitAt: toIsoString(splitMetaRaw.splitAt) ?? new Date().toISOString(),
      }
    : undefined

  return {
    _id: String(raw._id ?? record._id),
    content: String(raw.content ?? record.content),
    context: toNewsContext(raw.context ?? record.context),
    claims: (raw.claims ?? record.claims ?? []) as NewsDocumentDTO['claims'],
    splitMeta,
    confidence: typeof (raw.confidence ?? record.confidence) === 'number'
      ? (raw.confidence ?? record.confidence) as number
      : undefined,
    confidenceUpdatedAt: toIsoString(raw.confidenceUpdatedAt ?? record.confidenceUpdatedAt),
    createdAt: toIsoString(raw.createdAt ?? record.createdAt) ?? new Date().toISOString(),
    updatedAt: toIsoString(raw.updatedAt ?? record.updatedAt) ?? new Date().toISOString(),
  }
}

export function serializeNewsSummary(doc: {
  _id: unknown
  content: string
  claims?: unknown[]
  createdAt?: unknown
  updatedAt?: unknown
}): NewsDocumentSummaryDTO {
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
  mode: SplitGraphStateDTO['mode']
  content: string
  visibleContext: Record<string, string>
  routeInstructions: SplitGraphStateDTO['routeInstructions']
  subAgentResults: SubAgentSplitRecordDTO[]
  mergedClaims: SplitGraphStateDTO['mergedClaims']
  rawMergeResponse: string
}): SplitGraphStateDTO {
  return {
    newsId: state.newsId,
    mode: state.mode,
    content: state.content,
    visibleContext: state.visibleContext,
    routeInstructions: state.routeInstructions,
    subAgentResults: state.subAgentResults,
    mergedClaims: state.mergedClaims,
    rawMergeResponse: state.rawMergeResponse,
  }
}

export function serializeVerifyState(state: {
  newsId: string
  claimId: string
  mode: VerifyGraphStateDTO['mode']
  claimContent: string
  originalContent: string
  visibleContext: Record<string, string>
  routeInstructions: VerifyGraphStateDTO['routeInstructions']
  subAgentOpinions: SubAgentOpinionDTO[]
  finalScore: VerifyGraphStateDTO['finalScore']
  finalReason: string
  rawMergeResponse: string
}): VerifyGraphStateDTO {
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
