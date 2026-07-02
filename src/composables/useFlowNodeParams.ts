import { computed, type Ref } from 'vue'
import type {
  GraphType,
  NewsDocumentDTO,
  SplitGraphStateDTO,
  VerifyGraphStateDTO,
} from '../../electron/api/types'
import type { FlowNodeVM } from '../types/flow'
import { parseRouteIndexFromNodeId } from '../utils/routeNodeId'

export interface ParamRow {
  key: string
  value: string
}

export interface ParamSection {
  title: string
  rows: ParamRow[]
  json?: unknown
}

function isSplitState(s: SplitGraphStateDTO | VerifyGraphStateDTO): s is SplitGraphStateDTO {
  return 'mergedClaims' in s
}

function rowsFromRecord(record: Record<string, unknown>): ParamRow[] {
  return Object.entries(record).map(([key, value]) => ({
    key,
    value: value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value),
  }))
}

export function useFlowNodeParams(
  selectedNode: Ref<FlowNodeVM | null>,
  graphState: Ref<SplitGraphStateDTO | VerifyGraphStateDTO | null>,
  _graphType: Ref<GraphType | null>,
  currentNews: Ref<NewsDocumentDTO | null>,
  selectedClaimId: Ref<string | null>,
) {
  const sections = computed<ParamSection[]>(() => {
    const node = selectedNode.value
    if (!node) return []

    const kind = node.kind

    const meta: ParamSection = {
      title: '节点元信息',
      rows: [
        { key: 'id', value: node.id },
        { key: 'kind', value: node.kind },
        { key: 'label', value: node.label },
        { key: 'phase', value: node.phase },
        ...(node.agentName ? [{ key: 'agentName', value: node.agentName }] : []),
        ...(node.claimId ? [{ key: 'claimId', value: node.claimId }] : []),
        ...(node.claimIndex != null ? [{ key: 'claimIndex', value: String(node.claimIndex) }] : []),
        ...(node.parentId ? [{ key: 'parentId', value: node.parentId }] : []),
        ...(node.spawnIndex != null ? [{ key: 'spawnIndex', value: String(node.spawnIndex) }] : []),
      ],
    }

    const state = graphState.value
    const news = currentNews.value

    if (kind === 'loadNews' && !state && news) {
      const ctx = Object.fromEntries(
        Object.entries(news.context).map(([k, v]) => [k, v?.value ?? '']),
      )
      return [
        meta,
        {
          title: '加载参数（来自当前新闻）',
          rows: [
            { key: 'newsId', value: news._id },
            { key: 'claimCount', value: String(news.claims.length) },
          ],
        },
        { title: 'context', rows: rowsFromRecord(ctx as Record<string, unknown>) },
        { title: 'content', rows: [], json: news.content },
      ]
    }

    if (kind === 'loadClaim' && !state && news && selectedClaimId.value) {
      const claim = news.claims.find(c => c.claimId === selectedClaimId.value)
      return [
        meta,
        {
          title: '加载参数（来自当前新闻）',
          rows: [
            { key: 'newsId', value: news._id },
            { key: 'claimId', value: selectedClaimId.value },
          ],
        },
        { title: 'claimContent', rows: [], json: claim?.content ?? '—' },
        { title: 'originalContent', rows: [], json: news.content },
      ]
    }

    if (!state) return [meta]

    if (kind === 'loadNews' && isSplitState(state)) {
      return [
        meta,
        {
          title: '加载参数',
          rows: [
            { key: 'newsId', value: state.newsId },
            { key: 'mode', value: state.mode },
          ],
        },
        {
          title: 'visibleContext',
          rows: rowsFromRecord(state.visibleContext as Record<string, unknown>),
        },
        {
          title: 'content',
          rows: [],
          json: state.content,
        },
      ]
    }

    if (kind === 'loadClaim' && !isSplitState(state)) {
      return [
        meta,
        {
          title: '加载参数',
          rows: [
            { key: 'newsId', value: state.newsId },
            { key: 'claimId', value: state.claimId },
            { key: 'mode', value: state.mode },
          ],
        },
        {
          title: 'visibleContext',
          rows: rowsFromRecord(state.visibleContext as Record<string, unknown>),
        },
        {
          title: 'claimContent',
          rows: [],
          json: state.claimContent,
        },
        {
          title: 'originalContent',
          rows: [],
          json: state.originalContent,
        },
      ]
    }

    if (kind === 'claim' && node.isBridge && news) {
      const claim = news.claims.find(c => c.claimId === node.claimId)
      const sections: ParamSection[] = [
        meta,
        {
          title: '桥接事实',
          rows: [
            { key: 'claimId', value: node.claimId ?? '—' },
            { key: 'category', value: claim?.category ?? '—' },
            { key: 'sourceAgent', value: claim?.sourceAgent ?? '—' },
          ],
          json: claim?.content ?? null,
        },
      ]
      if (claim?.verifyResult) {
        sections.push({
          title: '核查结果',
          rows: [
            { key: 'score', value: String(claim.verifyResult.score) },
            { key: 'reason', value: claim.verifyResult.reason || '—' },
          ],
          json: claim.verifyResult,
        })
      }
      return sections
    }

    if (kind === 'claim' && node.agentName != null && node.claimIndex != null) {
      let result = null
      if (state && isSplitState(state)) {
        if (node.parentId) {
          const resultIndex = parseRouteIndexFromNodeId(node.parentId)
          if (resultIndex != null && resultIndex < state.subAgentResults.length) {
            result = state.subAgentResults[resultIndex]
          }
        }
        if (!result) {
          result = state.subAgentResults.find(r => r.agentName === node.agentName) ?? null
        }
      }
      const claim = result?.claims[node.claimIndex]
      return [
        meta,
        {
          title: 'SubAgent Claim',
          rows: [
            { key: 'agentName', value: node.agentName },
            { key: 'index', value: String(node.claimIndex) },
            { key: 'category', value: claim?.category ?? '—' },
            { key: 'sourceAgent', value: claim?.sourceAgent ?? node.agentName },
          ],
          json: claim ?? null,
        },
        ...(result
          ? [{
              title: 'SubAgent 原始响应',
              rows: [{ key: 'priority', value: result.priority }],
              json: result.rawResponse,
            }]
          : []),
      ]
    }

    if (kind === 'opinion' && node.agentName && node.claimId) {
      const claim = news?.claims.find(c => c.claimId === node.claimId)
      const opinion = claim?.verifyResult?.opinions.find(o => o.agentName === node.agentName)
        ?? (state && !isSplitState(state)
          ? state.subAgentOpinions.find(o => o.agentName === node.agentName)
          : null)
      return [
        meta,
        {
          title: '核查意见',
          rows: [
            { key: 'agentName', value: node.agentName },
            { key: 'claimId', value: node.claimId },
            { key: 'score', value: opinion ? String(opinion.score) : '—' },
          ],
          json: opinion ?? null,
        },
      ]
    }

    if (kind === 'route') {
      return [
        meta,
        {
          title: 'routeInstructions',
          rows: [],
          json: state.routeInstructions,
        },
      ]
    }

    if (kind === 'subAgent' && node.agentName) {
      const routeIdx = node.spawnIndex
      const instruction = routeIdx != null && routeIdx < state.routeInstructions.length
        ? state.routeInstructions[routeIdx]
        : state.routeInstructions.find(r => r.agentName === node.agentName)
      const sections: ParamSection[] = [
        meta,
        {
          title: '路由指令',
          rows: instruction
            ? [
                { key: 'agentName', value: instruction.agentName },
                { key: 'priority', value: instruction.priority },
                { key: 'hint', value: instruction.hint ?? '—' },
              ]
            : [{ key: '—', value: '暂无路由指令' }],
        },
      ]

      if (isSplitState(state)) {
        const result = routeIdx != null && routeIdx < state.subAgentResults.length
          ? state.subAgentResults[routeIdx]
          : state.subAgentResults.find(r => r.agentName === node.agentName)
        sections.push({
          title: 'SubAgent 拆分结果',
          rows: result
            ? [{ key: 'priority', value: result.priority }, { key: 'claims', value: `${result.claims.length} 条` }]
            : [{ key: '—', value: '尚未执行' }],
          json: result ?? null,
        })
      } else {
        const opinion = routeIdx != null && routeIdx < state.subAgentOpinions.length
          ? state.subAgentOpinions[routeIdx]
          : state.subAgentOpinions.find(o => o.agentName === node.agentName)
        sections.push({
          title: 'SubAgent 核查意见',
          rows: [],
          json: opinion ?? null,
        })
      }
      return sections
    }

    if (kind === 'merge') {
      if (isSplitState(state)) {
        return [
          meta,
          {
            title: '合并结果 mergedClaims',
            rows: [{ key: 'count', value: String(state.mergedClaims.length) }],
            json: state.mergedClaims,
          },
          {
            title: 'rawMergeResponse',
            rows: [],
            json: state.rawMergeResponse,
          },
        ]
      }
      return [
        meta,
        {
          title: '合并核查结论',
          rows: [
            { key: 'finalScore', value: String(state.finalScore) },
            { key: 'finalReason', value: state.finalReason || '—' },
          ],
        },
        {
          title: 'subAgentOpinions',
          rows: [],
          json: state.subAgentOpinions,
        },
        {
          title: 'rawMergeResponse',
          rows: [],
          json: state.rawMergeResponse,
        },
      ]
    }

    if (kind === 'save') {
      if (isSplitState(state)) {
        return [
          meta,
          {
            title: '待保存事实',
            rows: [{ key: 'count', value: String(state.mergedClaims.length) }],
            json: state.mergedClaims,
          },
        ]
      }
      return [
        meta,
        {
          title: '待保存核查结果',
          rows: [
            { key: 'claimId', value: state.claimId },
            { key: 'finalScore', value: String(state.finalScore) },
            { key: 'finalReason', value: state.finalReason || '—' },
          ],
          json: {
            opinions: state.subAgentOpinions,
            rawMergeResponse: state.rawMergeResponse,
          },
        },
      ]
    }

    return [meta]
  })

  const title = computed(() => selectedNode.value?.label ?? '节点详情')

  return { sections, title }
}
