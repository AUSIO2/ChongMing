import { randomUUID } from 'node:crypto'
import type {
  GraphDataActor, GraphDataProposal, GraphDataRead, GraphNode,
  GraphRouteSlot, GraphRun, GraphRunConfiguration,
} from '../contracts/graph'
import { GraphError } from './graph-error'
import { configurationRead, configurationReadSlots } from './configuration'
import type { GraphDocument } from './store'

function runReadRun(document: GraphDocument): GraphRun {
  if (!document.run) throw new GraphError(404, 'RUN_NOT_FOUND', 'Map has no Run')
  return document.run
}

function runReadExecution(document: GraphDocument): GraphRun {
  const run = runReadRun(document)
  if (!['running', 'waiting'].includes(run.status)) throw new GraphError(409, 'RUN_NOT_ACTIVE', 'Run is terminal')
  return run
}

function runValidateInputs(document: GraphDocument, run: GraphRun): void {
  for (const ref of run.operation.inputRefs) {
    if (!document.nodes.some(node => node.id === ref.id && node.revision === ref.revision)) {
      throw new GraphError(409, 'INPUT_STALE', `Run input changed: ${ref.id}`)
    }
  }
}

function runValidateSlots(configuration: GraphRunConfiguration, input: GraphRouteSlot[]): GraphRouteSlot[] {
  const slots = configurationReadSlots(input)
  if (!slots.length || slots.length > configuration.maxSlots || new Set(slots.map(slot => slot.id)).size !== slots.length) {
    throw new GraphError(422, 'INVALID_ROUTE', 'Route must contain unique slots within maxSlots')
  }
  for (const slot of slots) {
    const agent = configuration.agents.find(agent => agent.id === slot.agentId)
    if (!agent) throw new GraphError(422, 'UNKNOWN_AGENT', `Unknown route agent: ${slot.agentId}`)
    if (new Set(slot.tools).size !== slot.tools.length || slot.tools.some(tool => !agent.tools.includes(tool))) {
      throw new GraphError(422, 'TOOL_NOT_ALLOWED', `Tools exceed the allowed capabilities of ${agent.id}`)
    }
  }
  return slots
}

function runCreateReview(run: GraphRun, kind: 'route' | 'result', now: string): void {
  run.status = 'waiting'
  run.operation.status = 'waiting'
  run.operation.review = {
    id: randomUUID(), kind, revision: 0, state: 'pending', decision: null, createdAt: now, answeredAt: null,
  }
}

function runReadPhase(run: GraphRun): GraphDataRead['phase'] {
  if (!['running', 'waiting'].includes(run.status)) return 'done'
  if (run.status === 'waiting') return 'waiting'
  const route = run.operation.route
  if (!route) return 'route'
  if (!route.approved) return 'waiting'
  return route.slots.every(slot => run.operation.reports.some(report => report.slotId === slot.id)) ? 'merge' : 'workers'
}

function runReadProposalId(run: GraphRun, actor: GraphDataActor): string {
  if (actor.role === 'router') return `${run.operation.id}:route`
  const version = run.operation.route?.revision ?? 0
  return actor.role === 'worker' ? `${run.operation.id}:report:${version}:${actor.slotId}` : `${run.operation.id}:merge:${version}`
}

function runCreateVerification(document: GraphDocument, run: GraphRun, now: string) {
  const draft = run.operation.draft
  if (!draft) throw new GraphError(409, 'MERGE_REQUIRED', 'No accepted merge draft')
  const nodeId = randomUUID()
  const edgeId = randomUUID()
  const node: GraphNode = {
    id: nodeId, revision: 0,
    data: {
      kind: 'verification', score: draft.score, reason: draft.reason,
      reportIds: draft.reportIds, opinions: structuredClone(run.operation.reports),
    },
    createdAt: now, updatedAt: now,
  }
  document.nodes.push(node)
  document.edges.push({
    id: edgeId, revision: 0, kind: 'verifies', from: nodeId,
    to: run.operation.targetId, createdAt: now, updatedAt: now,
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
  configuration: GraphRunConfiguration, now: string,
): GraphDocument {
  if (document.run && ['running', 'waiting'].includes(document.run.status)) {
    throw new GraphError(409, 'RUN_ACTIVE', 'Map already has an active Run')
  }
  if (document.run?.id === input.id || document.runHistory.some(run => run.id === input.id)) {
    throw new GraphError(409, 'RUN_ID_REUSED', 'Use a new Run id')
  }
  const target = document.nodes.find(node => node.id === input.targetId)
  if (!target || target.data.kind !== 'claim') throw new GraphError(422, 'INVALID_RUN_TARGET', 'verify target must be a Claim')
  const contextIds = new Set(document.edges.filter(edge => edge.kind === 'mentions' && edge.to === target.id).map(edge => edge.from))
  if (document.run) document.runHistory.push(document.run)
  document.run = {
    id: input.id, mode: input.mode, status: 'running', configuration: configurationRead(configuration),
    operation: {
      id: `${input.id}:verify:${input.targetId}`, kind: 'verify', targetId: input.targetId, status: 'running',
      inputRefs: document.nodes.filter(node => node.id === target.id || contextIds.has(node.id))
        .map(node => ({ id: node.id, revision: node.revision })),
      route: null, reports: [], draft: null, review: null, resultNodeId: null,
    },
    createdAt: now, updatedAt: now,
  }
  document.updatedAt = now
  return document
}

export function runCancelRun(document: GraphDocument, runId: string, now: string): GraphDocument {
  const run = runReadExecution(document)
  if (run.id !== runId) throw new GraphError(409, 'RUN_CONFLICT', 'runId is not active')
  run.status = 'cancelled'
  run.operation.status = 'cancelled'
  run.updatedAt = now
  document.updatedAt = now
  return document
}

export function runUpdateReview(document: GraphDocument, input: {
  runId: string; reviewId: string; expectedReviewRevision: number; reason: string; slots: GraphRouteSlot[]
}, now: string): GraphDocument {
  const run = runReadExecution(document)
  const review = run.operation.review
  const route = run.operation.route
  if (run.id !== input.runId || !review || review.id !== input.reviewId || review.state !== 'pending'
    || review.kind !== 'route' || review.revision !== input.expectedReviewRevision || !route || route.approved) {
    throw new GraphError(409, 'REVIEW_CONFLICT', 'Route Review is not editable')
  }
  route.slots = runValidateSlots(run.configuration, input.slots)
  route.reason = input.reason
  route.revision++
  review.revision++
  run.updatedAt = now
  document.updatedAt = now
  return document
}

export function runAnswerReview(document: GraphDocument, input: {
  runId: string; reviewId: string; expectedReviewRevision: number; decision: 'approve' | 'reject'
}, now: string): { document: GraphDocument; nodeId?: string; edgeId?: string } {
  const run = runReadExecution(document)
  const review = run.operation.review
  if (run.id !== input.runId || !review || review.id !== input.reviewId
    || review.state !== 'pending' || review.revision !== input.expectedReviewRevision) {
    throw new GraphError(409, 'REVIEW_CONFLICT', 'Review changed or is no longer pending')
  }
  runValidateInputs(document, run)
  review.state = 'answered'
  review.decision = input.decision
  review.answeredAt = now
  review.revision++
  run.updatedAt = now
  document.updatedAt = now
  if (input.decision === 'reject') {
    run.status = 'failed'
    run.operation.status = 'failed'
    return { document }
  }
  if (review.kind === 'route') {
    if (!run.operation.route) throw new GraphError(409, 'ROUTE_REQUIRED', 'No route to approve')
    run.operation.route.approved = true
    run.status = 'running'
    run.operation.status = 'running'
    return { document }
  }
  return { document, ...runCreateVerification(document, run, now) }
}

export function runReadData(document: GraphDocument, operationId: string, actor: GraphDataActor): GraphDataRead {
  const run = runReadRun(document)
  if (run.operation.id !== operationId) throw new GraphError(404, 'OPERATION_NOT_FOUND', 'Unknown operation')
  if (!run.configuration) throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', 'Create a new configured Run')
  const claim = document.nodes.find(node => node.id === run.operation.targetId)
  if (!claim || claim.data.kind !== 'claim') throw new GraphError(409, 'INPUT_STALE', 'Claim is missing')
  if (actor.role === 'worker' && (!run.operation.route?.approved || !run.operation.route.slots.some(slot => slot.id === actor.slotId))) {
    throw new GraphError(403, 'SLOT_NOT_ALLOWED', 'Worker has no approved slot')
  }
  const context = document.nodes.flatMap(node => node.data.kind === 'news' && run.operation.inputRefs.some(ref => ref.id === node.id)
    ? [{ id: node.id, content: node.data.content, context: Object.fromEntries(Object.entries(node.data.context).filter(([, field]) => field.visibleToAI)) }]
    : [])
  return {
    mapId: document.id, runId: run.id, operationId, claim: claim as GraphDataRead['claim'], context,
    configuration: run.configuration, route: run.operation.route, reports: run.operation.reports,
    draft: run.operation.draft, review: run.operation.review, phase: runReadPhase(run), proposalId: runReadProposalId(run, actor),
  }
}

export function runUpdateProposal(document: GraphDocument, proposal: GraphDataProposal, actor: GraphDataActor, now: string): {
  document: GraphDocument; nodeId?: string; edgeId?: string
} {
  const run = runReadExecution(document)
  if (run.operation.id !== proposal.operationId) throw new GraphError(404, 'OPERATION_NOT_FOUND', 'Unknown operation')
  if (proposal.id !== runReadProposalId(run, actor)) {
    throw new GraphError(409, 'PROPOSAL_CONFLICT', 'Proposal identity does not match operation/route/slot')
  }
  runValidateInputs(document, run)
  if (proposal.kind === 'route') {
    if (actor.role !== 'router') throw new GraphError(403, 'ROLE_NOT_ALLOWED', 'Only router may submit a route')
    if (run.operation.route) throw new GraphError(409, 'ROUTE_EXISTS', 'Route has already been submitted')
    run.operation.route = {
      revision: 1, reason: proposal.reason,
      slots: runValidateSlots(run.configuration, proposal.slots), approved: run.mode === 'auto',
    }
    if (run.mode === 'human-in-loop') runCreateReview(run, 'route', now)
  } else {
    const route = run.operation.route
    if (!route?.approved || route.revision !== proposal.routeRevision || run.status !== 'running') {
      throw new GraphError(409, 'ROUTE_NOT_APPROVED', 'No matching approved route')
    }
    if (proposal.kind === 'report') {
      if (actor.role !== 'worker' || actor.slotId !== proposal.slotId) {
        throw new GraphError(403, 'SLOT_NOT_ALLOWED', 'Worker may only submit its bound slot')
      }
      const slot = route.slots.find(slot => slot.id === actor.slotId)
      if (!slot) throw new GraphError(403, 'SLOT_NOT_ALLOWED', 'Unknown route slot')
      if (run.operation.reports.some(report => report.slotId === slot.id)) {
        throw new GraphError(409, 'REPORT_SLOT_CONFLICT', 'Slot already has a report')
      }
      const profile = run.configuration.agents.find(agent => agent.id === slot.agentId)!
      run.operation.reports.push({
        id: proposal.id, slotId: slot.id, agentId: profile.id, agentName: profile.name,
        angle: slot.angle, tools: [...slot.tools], routeRevision: route.revision,
        score: proposal.score, reason: proposal.reason, createdAt: now,
      })
    } else {
      if (actor.role !== 'merge') throw new GraphError(403, 'ROLE_NOT_ALLOWED', 'Only merger may submit a conclusion')
      const reports = run.operation.reports
      if (reports.length !== route.slots.length || !route.slots.every(slot => reports.some(report => report.slotId === slot.id))
        || new Set(proposal.reportIds).size !== reports.length || proposal.reportIds.length !== reports.length
        || reports.some(report => !proposal.reportIds.includes(report.id))) {
        throw new GraphError(409, 'REPORTS_INCOMPLETE', 'Merge must cite exactly all approved slot reports')
      }
      run.operation.draft = {
        id: proposal.id, routeRevision: route.revision,
        reportIds: [...proposal.reportIds], score: proposal.score, reason: proposal.reason,
      }
      if (run.mode === 'human-in-loop') runCreateReview(run, 'result', now)
      else {
        document.updatedAt = now
        return { document, ...runCreateVerification(document, run, now) }
      }
    }
  }
  run.updatedAt = now
  document.updatedAt = now
  return { document }
}
