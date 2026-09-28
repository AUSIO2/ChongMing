// 提供 052 历史契约的类型化请求样例，不发送网络请求或修改运行数据。
/** 类型化请求示例仅供静态检查，不发送请求或修改运行中的应用。 */
import type { CommandRequest, DshProposal, QueryRequest } from './052-接口契约.js'

const mapId = '10000000-0000-4000-8000-000000000001'
const newsId = '20000000-0000-4000-8000-000000000001'
const runId = '30000000-0000-4000-8000-000000000001'

export const readMap = {
  method: 'map.get', params: { mapId },
} satisfies QueryRequest

export const createNews = {
  requestId: '40000000-0000-4000-8000-000000000001',
  method: 'graph.apply',
  params: {
    mapId, expectedRevision: 0,
    changes: { nodes: { put: [{ id: newsId, data: { kind: 'news', content: '待拆分的新闻正文', context: { sourceNote: { value: '人工背景备注', visibleToAI: false } } } }] } },
  },
} satisfies CommandRequest

export const createLinkedClaim = {
  requestId: '40000000-0000-4000-8000-000000000005',
  method: 'graph.apply',
  params: {
    mapId, expectedRevision: 1,
    changes: {
      nodes: { put: [{ id: '20000000-0000-4000-8000-000000000002', data: { kind: 'claim', content: '一个可核查的陈述', category: 'data' } }] },
      edges: { put: [{ id: '60000000-0000-4000-8000-000000000001', kind: 'mentions', from: newsId, to: '20000000-0000-4000-8000-000000000002', quote: null }] },
    },
  },
} satisfies CommandRequest

export const startRun = {
  requestId: '40000000-0000-4000-8000-000000000002',
  method: 'run.start',
  params: { mapId, expectedRevision: 1, id: runId, scope: { nodeIds: [newsId] }, until: 'verified', mode: 'human-in-loop' },
} satisfies CommandRequest

export const approveReview = {
  requestId: '40000000-0000-4000-8000-000000000003',
  method: 'review.answer',
  params: {
    mapId, expectedRevision: 8, runId,
    reviewId: '50000000-0000-4000-8000-000000000001', expectedReviewRevision: 2,
    decision: 'approve', note: null,
  },
} satisfies CommandRequest

// 下列提案标识和版本必须来自 Host 的 data.read proposalTokens，不能由模型自行生成。
export const emptySplitReport = {
  kind: 'report', proposalId: 'host-issued-report-token', draftRevision: 1,
  content: { kind: 'split', claims: [] },
} satisfies DshProposal

export const validateEmptySplit = {
  kind: 'validate', proposalId: 'host-issued-validate-token', draftRevision: 2,
  draft: { operation: 'split', nodes: [], edges: [], acceptedNodeIds: [], reportIds: ['accepted-report-id'] },
} satisfies DshProposal

export const saveCanonicalDraft = {
  kind: 'save', proposalId: 'host-issued-save-token', draftRevision: 2,
  draftFingerprint: 'sha256-from-operation-context',
} satisfies DshProposal

export const retryFailedRun = {
  requestId: '40000000-0000-4000-8000-000000000004',
  method: 'run.retry',
  params: { mapId, expectedRevision: 20, previousRunId: runId, id: '30000000-0000-4000-8000-000000000002' },
} satisfies CommandRequest

// 暂停作用于同一个业务 Run；恢复沿用已有报告和审核决定。
export const pauseRun = {
  requestId: '40000000-0000-4000-8000-000000000006', method: 'run.pause',
  params: { mapId, expectedRevision: 21, runId },
} satisfies CommandRequest

export const resumeRun = {
  requestId: '40000000-0000-4000-8000-000000000007', method: 'run.resume',
  params: { mapId, expectedRevision: 22, runId },
} satisfies CommandRequest
