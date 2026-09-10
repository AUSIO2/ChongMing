import { randomUUID } from 'node:crypto'
import type {
  GraphDataRead,
  GraphNode,
  GraphReportProposal,
  GraphRun,
} from '../contracts/graph'
import { GraphError } from './graph-error'
import type { GraphDocument } from './store'

function runReadActive(document: GraphDocument): GraphRun {
  const run = document.run
  if (!run || !['running', 'waiting'].includes(run.status)) {
    throw new GraphError(409, 'RUN_NOT_ACTIVE', 'Map has no active run')
  }
  return run
}

function runReadScore(run: GraphRun): 0 | 0.5 | 1 {
  const [first, second] = run.operation.reports
  if (!first || !second) throw new Error('Verification requires two reports')
  return first.score === second.score ? first.score : 0.5
}

function runCreateVerification(document: GraphDocument, run: GraphRun, now: string) {
  const nodeId = randomUUID()
  const edgeId = randomUUID()
  const node: GraphNode = {
    id: nodeId,
    revision: 0,
    data: {
      kind: 'verification',
      score: runReadScore(run),
      reason: run.operation.reports
        .map(report => `[${report.slotId}] ${report.reason}`)
        .join('\n'),
      reportIds: run.operation.reports.map(report => report.id),
    },
    createdAt: now,
    updatedAt: now,
  }
  document.nodes.push(node)
  document.edges.push({
    id: edgeId,
    revision: 0,
    kind: 'verifies',
    from: nodeId,
    to: run.operation.targetId,
    createdAt: now,
    updatedAt: now,
  })
  run.operation.resultNodeId = nodeId
  run.operation.status = 'completed'
  run.status = 'completed'
  run.updatedAt = now
  return { nodeId, edgeId }
}

export function runCreateRun(
  document: GraphDocument,
  input: { id: string; targetId: string; mode: 'auto' | 'human-in-loop' },
  now: string,
): GraphDocument {
  if (document.run && ['running', 'waiting'].includes(document.run.status)) {
    throw new GraphError(409, 'RUN_ACTIVE', 'Map already has an active run')
  }
  const target = document.nodes.find(node => node.id === input.targetId)
  if (!target || target.data.kind !== 'claim') {
    throw new GraphError(422, 'INVALID_RUN_TARGET', 'verify run target must be a Claim')
  }
  document.run = {
    id: input.id,
    mode: input.mode,
    status: 'running',
    operation: {
      id: `${input.id}:verify:${input.targetId}`,
      kind: 'verify',
      targetId: input.targetId,
      status: 'running',
      reports: [],
      review: null,
      resultNodeId: null,
    },
    createdAt: now,
    updatedAt: now,
  }
  document.updatedAt = now
  return document
}

export function runCancelRun(document: GraphDocument, runId: string, now: string): GraphDocument {
  const run = runReadActive(document)
  if (run.id !== runId) throw new GraphError(409, 'RUN_CONFLICT', 'runId is not active')
  run.status = 'cancelled'
  run.operation.status = 'cancelled'
  run.updatedAt = now
  document.updatedAt = now
  return document
}

export function runAnswerReview(
  document: GraphDocument,
  input: {
    runId: string
    reviewId: string
    expectedReviewRevision: number
    decision: 'approve' | 'reject'
  },
  now: string,
): { document: GraphDocument; nodeId?: string; edgeId?: string } {
  const run = runReadActive(document)
  const review = run.operation.review
  if (run.id !== input.runId || !review || review.id !== input.reviewId) {
    throw new GraphError(409, 'REVIEW_CONFLICT', 'Review is not active')
  }
  if (review.state !== 'pending' || review.revision !== input.expectedReviewRevision) {
    throw new GraphError(409, 'REVIEW_CONFLICT', 'Review revision changed')
  }
  review.state = 'answered'
  review.decision = input.decision
  review.answeredAt = now
  review.revision++
  if (input.decision === 'reject') {
    run.status = 'failed'
    run.operation.status = 'failed'
    run.updatedAt = now
    document.updatedAt = now
    return { document }
  }
  const created = runCreateVerification(document, run, now)
  document.updatedAt = now
  return { document, ...created }
}

export function runReadData(document: GraphDocument, operationId: string): GraphDataRead {
  const run = runReadActive(document)
  if (run.operation.id !== operationId) {
    throw new GraphError(404, 'OPERATION_NOT_FOUND', `Operation not found: ${operationId}`)
  }
  const claim = document.nodes.find(node => node.id === run.operation.targetId)
  if (!claim || claim.data.kind !== 'claim') throw new Error('Run target Claim disappeared')
  return {
    mapId: document.id,
    runId: run.id,
    operationId,
    claim: claim as GraphDataRead['claim'],
    reports: run.operation.reports,
    review: run.operation.review,
  }
}

export function runUpdateReport(
  document: GraphDocument,
  proposal: GraphReportProposal,
  now: string,
): { document: GraphDocument; nodeId?: string; edgeId?: string } {
  const run = runReadActive(document)
  if (run.status !== 'running' || run.operation.status !== 'running') {
    throw new GraphError(409, 'RUN_STATE_INVALID', 'Operation is not accepting reports')
  }
  if (run.operation.id !== proposal.operationId) {
    throw new GraphError(404, 'OPERATION_NOT_FOUND', `Operation not found: ${proposal.operationId}`)
  }
  if (run.operation.reports.some(report => report.slotId === proposal.report.slotId)) {
    throw new GraphError(409, 'REPORT_SLOT_CONFLICT', 'A report for this slot already exists')
  }
  if (run.operation.reports.length >= 2) {
    throw new GraphError(409, 'REPORT_LIMIT', 'Verification already has two reports')
  }
  run.operation.reports.push({ ...proposal.report, createdAt: now })
  run.updatedAt = now
  document.updatedAt = now
  if (run.operation.reports.length < 2) return { document }
  if (run.mode === 'auto') {
    const created = runCreateVerification(document, run, now)
    return { document, ...created }
  }
  run.status = 'waiting'
  run.operation.status = 'waiting'
  run.operation.review = {
    id: randomUUID(),
    revision: 0,
    state: 'pending',
    decision: null,
    createdAt: now,
    answeredAt: null,
  }
  return { document }
}
