/** Typed request examples; these do not send requests or mutate a running application. */
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
  params: { mapId, expectedRevision: 1, id: runId, scope: { kind: 'nodes', nodeIds: [newsId] }, until: 'verified', mode: 'human-in-loop' },
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

// IDs/revisions below must come from the Host's data.read proposalTokens, not be invented by a model.
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
