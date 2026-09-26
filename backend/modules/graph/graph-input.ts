import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import type { GraphNodeData, GraphReport } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { inputReadObject, inputReadString, inputReadId, inputReadNames, inputReadRevision, inputReadScore, inputReadArray } from '../shared/input-validation'

// 用途：处理数据图相关工作，并把结果交给调用方。
function graphInputReadReport(value: unknown): GraphReport {
  const item = inputReadObject(value,
    ['id', 'slotId', 'agentId', 'agentName', 'angle', 'tools', 'routeRevision', 'score', 'reason', 'createdAt'], 'opinion')
  const createdAt = inputReadString(item.createdAt, 'opinion.createdAt')
  if (Number.isNaN(Date.parse(createdAt))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.OPINION_CREATEDAT_IS_INVALID)
  return {
    id: inputReadString(item.id, 'opinion.id'), slotId: inputReadString(item.slotId, 'opinion.slotId'),
    agentId: inputReadString(item.agentId, 'opinion.agentId'), agentName: inputReadString(item.agentName, 'opinion.agentName'),
    angle: inputReadString(item.angle, 'opinion.angle'), tools: inputReadNames(item.tools, 'opinion.tools'),
    routeRevision: inputReadRevision(item.routeRevision, 'opinion.routeRevision'), score: inputReadScore(item.score),
    reason: inputReadString(item.reason, 'opinion.reason'), createdAt,
  }
}

// 用途：处理数据图相关工作，并把结果交给调用方。
export function graphInputReadNodeData(value: unknown, label: string): GraphNodeData {
  const base = inputReadObject(
    value,
    ['kind', 'content', 'context', 'category', 'score', 'reason', 'reportIds', 'opinions', 'locator', 'label', 'capturedAt'],
    label,
  )
  if (base.kind === 'source' || base.kind === 'evidence') {
    inputReadObject(value, base.kind === 'source' ? ['kind', 'locator', 'label'] : ['kind', 'content', 'locator', 'capturedAt'], label)
    const locator = inputReadObject(base.locator, ['kind', 'assetId', 'mediaType', 'url'], `${label}.locator`)
    let parsed: Extract<GraphNodeData, { kind: 'source' }>['locator']
    if (locator.kind === 'asset') {
      inputReadObject(base.locator, ['kind', 'assetId', 'mediaType'], 'locator')
      parsed = { kind: 'asset', assetId: inputReadId(locator.assetId, 'assetId'), mediaType: inputReadString(locator.mediaType, 'mediaType') }
    } else if (locator.kind === 'url') {
      inputReadObject(base.locator, ['kind', 'url'], 'locator')
      const url = inputReadString(locator.url, 'url')
      let address: URL
      try { address = new URL(url) } catch { throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.LOCATOR_URL_MUST_BE_A_URL) }
      if (!['http:', 'https:'].includes(address.protocol)) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.LOCATOR_URL_MUST_USE_HTTP_S)
      parsed = { kind: 'url', url }
    } else throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.LOCATOR_KIND_IS_INVALID)
    if (base.kind === 'source') {
      if (base.label !== null && typeof base.label !== 'string') throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.SOURCE_LABEL_MUST_BE_STRING_OR_NULL)
      return { kind: 'source', locator: parsed, label: base.label }
    }
    const capturedAt = inputReadString(base.capturedAt, 'capturedAt')
    if (Number.isNaN(Date.parse(capturedAt))) throw new GraphError(400, 'INVALID_ARGUMENT', RuntimeMessage.CAPTUREDAT_IS_INVALID)
    return { kind: 'evidence', locator: parsed, content: inputReadString(base.content, 'content'), capturedAt }
  }
  if (base.kind === 'verification') {
    inputReadObject(value, ['kind', 'score', 'reason', 'reportIds', 'opinions'], label)
    return {
      kind: 'verification',
      score: inputReadScore(base.score),
      reason: inputReadString(base.reason, `${label}.reason`),
      reportIds: inputReadNames(base.reportIds, `${label}.reportIds`),
      opinions: inputReadArray(base.opinions, `${label}.opinions`).map(graphInputReadReport),
    }
  }
  const content = inputReadString(base.content, `${label}.content`)
  if (base.kind === 'claim') {
    inputReadObject(value, ['kind', 'content', 'category'], label)
    if (base.category !== null && base.category !== undefined && typeof base.category !== 'string') {
      throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CATEGORY_MUST_BE_A_STRING_OR_NULL, label))
    }
    return { kind: 'claim' as const, content, category: (base.category as string | null) ?? null }
  }
  if (base.kind !== 'news') throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_KIND_IS_INVALID, label))
  inputReadObject(value, ['kind', 'content', 'context'], label)
  if (!base.context || typeof base.context !== 'object' || Array.isArray(base.context)) {
    throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTEXT_MUST_BE_AN_OBJECT, label))
  }
  const rawContext = base.context as Record<string, unknown>
  const context = Object.fromEntries(Object.entries(rawContext).map(([key, item]) => {
    const field = inputReadObject(item, ['value', 'visibleToAI'], `${label}.context.${key}`)
    if (typeof field.value !== 'string' || typeof field.visibleToAI !== 'boolean') {
      throw new GraphError(400, 'INVALID_ARGUMENT', messageFormat(RuntimeMessage.VALUE_CONTEXT_VALUE_IS_INVALID, label, key))
    }
    return [key, { value: field.value, visibleToAI: field.visibleToAI }]
  }))
  return { kind: 'news' as const, content, context }
}
