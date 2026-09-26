import { RuntimeMessage, messageFormat } from '../../../contracts/messages'
import { randomUUID } from 'node:crypto'
import type { GraphDataActor, GraphDataProposal, GraphDataRead, GraphNode, GraphOperation, GraphRouteSlot, GraphRun, GraphRunConfiguration, GraphCommand } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import { storeCreateInputHash, type GraphDocument } from './graph-record'

// 用途：读取运行状态，并把结构化结果交给调用方。
function runReadRun(document: GraphDocument): GraphRun {
  if (!document.run) throw new GraphError(404, 'RUN_NOT_FOUND', RuntimeMessage.MAP_HAS_NO_RUN)
  if (!Array.isArray(document.run.operations)) throw new GraphError(409, 'RUN_SCHEMA_UNSUPPORTED', RuntimeMessage.USE_THE_EXPLICIT_NODE_RUN_MIGRATION)
  return document.run
}
// 用途：读取执行状态，并把结构化结果交给调用方。
function runReadExecution(document: GraphDocument): GraphRun {
  const run = runReadRun(document)
  if (!['running', 'waiting'].includes(run.status)) throw new GraphError(409, 'RUN_NOT_ACTIVE', RuntimeMessage.RUN_IS_TERMINAL)
  return run
}
// 用途：读取操作，并把结构化结果交给调用方。
export function runReadOperation(run: GraphRun, id: string): GraphOperation {
  const operation = run.operations.find(item => item.id === id)
  if (!operation) throw new GraphError(404, 'OPERATION_NOT_FOUND', RuntimeMessage.UNKNOWN_OPERATION)
  return operation
}
// 用途：校验输入输入，发现不符合约束时立即报错。
function runValidateInputs(document: GraphDocument, operation: GraphOperation): void {
  for (const ref of operation.inputRefs) if (!document.nodes.some(node => node.id === ref.id && node.revision === ref.revision)) {
    throw new GraphError(409, 'INPUT_STALE', messageFormat(RuntimeMessage.OPERATION_INPUT_CHANGED_VALUE, ref.id))
  }
}
// 用途：读取配置，并把结构化结果交给调用方。
function runReadConfiguration(run: GraphRun, kind: GraphOperation['kind']) {
  if (kind === 'parse') {
    if (!run.configuration.parse) throw new GraphError(422, 'CONFIGURATION_REQUIRED', RuntimeMessage.SOURCE_PARSING_REQUIRES_A_PARSE_AGENT)
    return run.configuration.parse
  }
  if (kind === 'split') {
    if (!run.configuration.split) throw new GraphError(422, 'CONFIGURATION_REQUIRED', RuntimeMessage.NEWS_SPLITTING_REQUIRES_ROUTE_WORKER_AND_MERGE_AGENTS)
    return { ...run.configuration.split, tools: run.configuration.tools, maxSlots: run.configuration.maxSlots }
  }
  const { router, merger, agents, tools, maxSlots } = run.configuration
  return { router, merger, agents, tools, maxSlots }
}
// 用途：校验槽位输入，发现不符合约束时立即报错。
function runValidateSlots(run: GraphRun, operation: GraphOperation, slots: GraphRouteSlot[]): GraphRouteSlot[] {
  const configuration = operation.kind === 'split' ? run.configuration.split! : run.configuration
  if (!slots.length || slots.length > run.configuration.maxSlots || new Set(slots.map(slot => slot.id)).size !== slots.length) {
    throw new GraphError(422, 'INVALID_ROUTE', RuntimeMessage.ROUTE_MUST_CONTAIN_UNIQUE_SLOTS_WITHIN_MAXSLOTS)
  }
  for (const slot of slots) {
    const agent = configuration.agents.find(agent => agent.id === slot.agentId)
    if (!agent) throw new GraphError(422, 'UNKNOWN_AGENT', messageFormat(RuntimeMessage.UNKNOWN_ROUTE_AGENT_VALUE, slot.agentId))
    if (new Set(slot.tools).size !== slot.tools.length || slot.tools.some(tool => !agent.tools.includes(tool))) {
      throw new GraphError(422, 'TOOL_NOT_ALLOWED', messageFormat(RuntimeMessage.TOOLS_EXCEED_CAPABILITIES_OF_VALUE, agent.id))
    }
  }
  return structuredClone(slots)
}
// 用途：创建审核，供后续流程使用。
function runCreateReview(operation: GraphOperation, kind: 'route' | 'result', now: string): void {
  operation.status = 'waiting'
  operation.review = { id: randomUUID(), kind, revision: 0, state: 'pending', decision: null, createdAt: now, answeredAt: null }
}
// 用途：读取阶段，并把结构化结果交给调用方。
function runReadPhase(operation: GraphOperation): GraphDataRead['phase'] {
  if (!['running', 'waiting'].includes(operation.status)) return 'done'
  if (operation.status === 'waiting') return 'waiting'
  if (operation.kind === 'parse') return 'parse'
  if (!operation.route) return 'route'
  if (!operation.route.approved) return 'waiting'
  const reports = operation.kind === 'split' ? operation.splitReports : operation.reports
  return operation.route.slots.every(slot => reports.some(report => report.slotId === slot.id)) ? 'merge' : 'workers'
}
// 用途：读取提案标识，并把结构化结果交给调用方。
function runReadProposalId(operation: GraphOperation, actor: GraphDataActor): string {
  if (actor.role === 'parse') return operation.id + ':parse'
  if (actor.role === 'router') return operation.id + ':route'
  const version = operation.route?.revision ?? 0
  return actor.role === 'worker' ? operation.id + ':report:' + version + ':' + actor.slotId : operation.id + ':merge:' + version
}
// 用途：判断当前操作是否可以作用于运行流程。
function runCanReuse(document: GraphDocument, operation: GraphOperation, next: GraphOperation): boolean {
  if (operation.status !== 'completed' || operation.kind !== next.kind || operation.targetId !== next.targetId
    || operation.configurationHash !== next.configurationHash
    || storeCreateInputHash(operation.inputRefs) !== storeCreateInputHash(next.inputRefs)) return false
  if (operation.kind === 'verify' && (operation.outputRefs.length !== 1 || operation.outputRefs[0].id !== operation.resultNodeId)) return false
  return operation.outputRefs.every(ref => {
    if (!document.nodes.some(node => node.id === ref.id && node.revision === ref.revision && node.validity !== 'stale')) return false
    return document.edges.some(edge => edge.kind === (operation.kind === 'verify' ? 'verifies' : 'derived-from')
      && edge.from === ref.id && edge.to === operation.targetId)
  })
}
/** Recompute the requested dependency closure on the same snapshot as the result commit. */
// 用途：更新进度，并保持相关状态一致。
export function runUpdateProgress(document: GraphDocument, now: string): void {
  const run = runReadRun(document)
  if (['cancelled', 'failed'].includes(run.status)) return
  const pending = [...run.scope.nodeIds], seen = new Set<string>()
  for (let index = 0; index < pending.length; index++) {
    const targetId = pending[index]
    if (seen.has(targetId)) continue
    seen.add(targetId)
    const target = document.nodes.find(node => node.id === targetId)
    if (!target) throw new GraphError(409, 'INPUT_STALE', messageFormat(RuntimeMessage.SCOPE_NODE_IS_MISSING_VALUE, targetId))
    const kind = target.data.kind === 'source' ? 'parse'
      : target.data.kind === 'news' && run.until !== 'news' ? 'split'
      : target.data.kind === 'claim' && run.until === 'verified' ? 'verify' : null
    if (!kind) continue
    let operation = run.operations.find(item => item.kind === kind && item.targetId === targetId)
    if (!operation) {
      const inputIds = new Set([targetId, ...(kind === 'verify'
        ? document.edges.filter(edge => edge.kind === 'mentions' && edge.to === targetId).map(edge => edge.from) : [])])
      operation = {
        id: run.id + ':' + kind + ':' + targetId, kind, targetId, status: 'running',
        inputRefs: document.nodes.filter(node => inputIds.has(node.id)).map(node => ({ id: node.id, revision: node.revision })).sort((a, b) => a.id.localeCompare(b.id)),
        configurationHash: storeCreateInputHash(runReadConfiguration(run, kind)), outputRefs: [],
        route: null, reports: [], splitReports: [], draft: null, contentDraft: null, review: null, resultNodeId: null,
      }
      if (!run.regenerate) {
        const prior = document.runHistory.flatMap(item => item.operations).reverse().find(item => runCanReuse(document, item, operation!))
        if (prior) operation = { ...structuredClone(prior), id: operation.id }
      }
      run.operations.push(operation)
    }
    if (operation.status === 'completed') pending.push(...operation.outputRefs.map(ref => ref.id))
    // Only explicit source/News descendants expand scope; shared relations never expand backwards.
    const historicalOutputs = new Set(document.runHistory.flatMap(history => history.operations)
      .filter(item => item.targetId === targetId && item.kind === kind).flatMap(item => item.outputRefs.map(ref => ref.id)))
    if (kind === 'parse') pending.push(...document.edges.filter(edge => edge.kind === 'derived-from' && edge.to === targetId)
      .map(edge => edge.from).filter(id => !historicalOutputs.has(id) && document.nodes.some(node => node.id === id && node.data.kind === 'news')))
    if (kind === 'split') pending.push(...document.edges.filter(edge => edge.kind === 'mentions' && edge.from === targetId)
      .map(edge => edge.to).filter(id => !historicalOutputs.has(id)))
  }
  run.status = run.operations.some(operation => operation.status === 'failed') ? 'failed'
    : run.operations.some(operation => operation.status === 'running') ? 'running'
    : run.operations.some(operation => operation.status === 'waiting') ? 'waiting' : 'completed'
  run.updatedAt = now; document.updatedAt = now
}
// 用途：创建运行流程，供后续流程使用。
function runCreateOutputs(document: GraphDocument, operation: GraphOperation, now: string) {
  const nodeIds: string[] = [], edgeIds: string[] = []
  // 用途：创建输出，供后续流程使用。
  function runCreateOutput(data: GraphNode['data'], reportId?: string, index?: number) {
    const id = randomUUID()
    document.nodes.push({ id, revision: 0, data, createdAt: now, updatedAt: now })
    operation.outputRefs.push({ id, revision: 0, ...(reportId === undefined ? {} : { reportId, index }) })
    nodeIds.push(id)
    const edgeId = randomUUID()
    document.edges.push({ id: edgeId, revision: 0, kind: operation.kind === 'verify' ? 'verifies' : 'derived-from',
      from: id, to: operation.targetId, createdAt: now, updatedAt: now })
    edgeIds.push(edgeId)
    if (operation.kind === 'split') {
      const mentionId = randomUUID()
      document.edges.push({ id: mentionId, revision: 0, kind: 'mentions', from: operation.targetId, to: id, createdAt: now, updatedAt: now })
      edgeIds.push(mentionId)
    }
    return id
  }
  if (operation.kind === 'verify') {
    if (!operation.draft) throw new GraphError(409, 'MERGE_REQUIRED', RuntimeMessage.NO_ACCEPTED_MERGE_DRAFT)
    operation.resultNodeId = runCreateOutput({ kind: 'verification', score: operation.draft.score, reason: operation.draft.reason,
      reportIds: operation.draft.reportIds, opinions: structuredClone(operation.reports) })
  } else if (operation.contentDraft?.kind === 'parse') {
    for (const news of operation.contentDraft.news) runCreateOutput({ kind: 'news', ...structuredClone(news) })
  } else if (operation.contentDraft?.kind === 'split') {
    for (const selection of operation.contentDraft.selected) {
      const report = operation.splitReports.find(item => item.id === selection.reportId)!
      runCreateOutput({ kind: 'claim', ...structuredClone(report.claims[selection.index]) }, report.id, selection.index)
    }
  } else throw new GraphError(409, 'DRAFT_REQUIRED', RuntimeMessage.NO_ACCEPTED_NODE_DRAFT)
  operation.status = 'completed'
  return { nodeIds, edgeIds }
}
// 用途：创建运行状态，供后续流程使用。
export function runCreateRun(document: GraphDocument, input: Extract<GraphCommand, { method: 'run.start' }>['params'],
  configuration: GraphRunConfiguration, now: string): GraphDocument {
  if (document.run) runReadRun(document)
  if (document.run && ['running', 'waiting'].includes(document.run.status)) throw new GraphError(409, 'RUN_ACTIVE', RuntimeMessage.MAP_ALREADY_HAS_AN_ACTIVE_RUN)
  if (document.run?.id === input.id || document.runHistory.some(run => run.id === input.id)) throw new GraphError(409, 'RUN_ID_REUSED', RuntimeMessage.USE_A_NEW_RUN_ID)
  if (!input.scope.nodeIds.length || new Set(input.scope.nodeIds).size !== input.scope.nodeIds.length) throw new GraphError(422, 'INVALID_SCOPE', RuntimeMessage.CHOOSE_UNIQUE_SCOPE_NODES)
  for (const id of input.scope.nodeIds) {
    const node = document.nodes.find(node => node.id === id)
    if (!node || !['source', 'news', 'claim'].includes(node.data.kind)) throw new GraphError(422, 'INVALID_RUN_TARGET', RuntimeMessage.SCOPE_MUST_CONTAIN_SOURCE_NEWS_OR_CLAIM_NODES)
  }
  if (document.run) document.runHistory.push(document.run)
  document.run = { id: input.id, scope: structuredClone(input.scope), until: input.until, paused: false, regenerate: input.regenerate === true,
    mode: input.mode, status: 'running', configuration: structuredClone(configuration), operations: [], createdAt: now, updatedAt: now }
  runUpdateProgress(document, now)
  return document
}
// 用途：取消运行状态，并释放相关资源。
export function runCancelRun(document: GraphDocument, runId: string, now: string): GraphDocument {
  const run = runReadExecution(document)
  if (run.id !== runId) throw new GraphError(409, 'RUN_CONFLICT', RuntimeMessage.RUNID_IS_NOT_ACTIVE)
  run.status = 'cancelled'
  for (const operation of run.operations) if (['running', 'waiting'].includes(operation.status)) operation.status = 'cancelled'
  run.updatedAt = now; document.updatedAt = now
  return document
}
// 用途：更新运行流程，并保持相关状态一致。
export function runUpdatePause(document: GraphDocument, runId: string, paused: boolean, now: string): GraphDocument {
  const run = runReadExecution(document)
  if (run.id !== runId) throw new GraphError(409, 'RUN_CONFLICT', RuntimeMessage.RUNID_IS_NOT_ACTIVE)
  for (const operation of run.operations) runValidateInputs(document, operation)
  run.paused = paused
  runUpdateProgress(document, now)
  return document
}
// 用途：更新审核，并保持相关状态一致。
export function runUpdateReview(document: GraphDocument, input: Extract<GraphCommand, { method: 'review.update' }>['params'], now: string): GraphDocument {
  const run = runReadExecution(document), operation = runReadOperation(run, input.operationId)
  const review = operation.review, route = operation.route
  if (run.id !== input.runId || !review || review.id !== input.reviewId || review.state !== 'pending'
    || review.kind !== 'route' || review.revision !== input.expectedReviewRevision || !route || route.approved) throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.ROUTE_REVIEW_IS_NOT_EDITABLE)
  route.slots = runValidateSlots(run, operation, input.slots); route.reason = input.reason; route.revision++; review.revision++
  run.updatedAt = now; document.updatedAt = now
  return document
}
// 用途：处理运行流程相关工作，并把结果交给调用方。
export function runAnswerReview(document: GraphDocument, input: Extract<GraphCommand, { method: 'review.answer' }>['params'], now: string) {
  const run = runReadExecution(document), operation = runReadOperation(run, input.operationId), review = operation.review
  if (run.id !== input.runId || !review || review.id !== input.reviewId || review.state !== 'pending'
    || review.revision !== input.expectedReviewRevision) throw new GraphError(409, 'REVIEW_CONFLICT', RuntimeMessage.REVIEW_CHANGED_OR_IS_NO_LONGER_PENDING)
  runValidateInputs(document, operation)
  review.state = 'answered'; review.decision = input.decision; review.answeredAt = now; review.revision++
  let result = { nodeIds: [] as string[], edgeIds: [] as string[] }
  if (input.decision === 'reject') operation.status = 'failed'
  else if (review.kind === 'route') { operation.route!.approved = true; operation.status = 'running' }
  else result = runCreateOutputs(document, operation, now)
  runUpdateProgress(document, now)
  return { document, ...result }
}
// 用途：读取数据，并把结构化结果交给调用方。
export function runReadData(document: GraphDocument, operationId: string, actor: GraphDataActor): Omit<GraphDataRead, 'work'> {
  const run = runReadRun(document), operation = runReadOperation(run, operationId)
  const target = document.nodes.find(node => node.id === operation.targetId)
  if (!target || !['source', 'news', 'claim'].includes(target.data.kind)) throw new GraphError(409, 'INPUT_STALE', RuntimeMessage.OPERATION_TARGET_IS_MISSING)
  runValidateInputs(document, operation)
  if (actor.role === 'worker' && (!operation.route?.approved || !operation.route.slots.some(slot => slot.id === actor.slotId))) throw new GraphError(403, 'SLOT_NOT_ALLOWED', RuntimeMessage.WORKER_HAS_NO_APPROVED_SLOT)
  const context = document.nodes.flatMap(node => node.data.kind === 'news' && operation.inputRefs.some(ref => ref.id === node.id)
    ? [{ id: node.id, content: node.data.content, context: Object.fromEntries(Object.entries(node.data.context).filter(([, field]) => field.visibleToAI)) }] : [])
  const projected = structuredClone(target) as GraphDataRead['target']
  if (projected.data.kind === 'news') projected.data.context = Object.fromEntries(Object.entries(projected.data.context).filter(([, field]) => field.visibleToAI))
  return { mapId: document.id, runId: run.id, operationId, operationKind: operation.kind, target: projected, context,
    ...(operation.rawContent === undefined ? {} : { rawContent: operation.rawContent }), configuration: run.configuration,
    route: operation.route, reports: operation.reports, splitReports: operation.splitReports, draft: operation.draft, contentDraft: operation.contentDraft,
    review: operation.review, phase: runReadPhase(operation), proposalId: runReadProposalId(operation, actor) }
}
// 用途：更新提案，并保持相关状态一致。
export function runUpdateProposal(document: GraphDocument, proposal: GraphDataProposal, actor: GraphDataActor, now: string) {
  const run = runReadExecution(document), operation = runReadOperation(run, proposal.operationId)
  if (run.paused || operation.status !== 'running') throw new GraphError(409, 'WORK_STOPPED', RuntimeMessage.OPERATION_IS_NOT_EXECUTABLE)
  if (proposal.id !== runReadProposalId(operation, actor)) throw new GraphError(409, 'PROPOSAL_CONFLICT', RuntimeMessage.PROPOSAL_IDENTITY_DOES_NOT_MATCH_OPERATION_ROUTE_SLOT)
  runValidateInputs(document, operation)
  let result = { nodeIds: [] as string[], edgeIds: [] as string[] }
  if (proposal.kind === 'parse') {
    if (operation.kind !== 'parse' || actor.role !== 'parse') throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.ONLY_PARSE_WORK_MAY_SUBMIT_NEWS)
    operation.contentDraft = { kind: 'parse', reason: proposal.reason, news: structuredClone(proposal.news) }
    if (run.mode === 'human-in-loop') runCreateReview(operation, 'result', now)
    else result = runCreateOutputs(document, operation, now)
  } else if (proposal.kind === 'route') {
    if (operation.kind === 'parse' || actor.role !== 'router') throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.ONLY_ROUTER_MAY_SUBMIT_A_ROUTE)
    if (operation.route) throw new GraphError(409, 'ROUTE_EXISTS', RuntimeMessage.ROUTE_HAS_ALREADY_BEEN_SUBMITTED)
    operation.route = { revision: 1, reason: proposal.reason, slots: runValidateSlots(run, operation, proposal.slots), approved: run.mode === 'auto' }
    if (run.mode === 'human-in-loop') runCreateReview(operation, 'route', now)
  } else {
    const route = operation.route
    if (!route?.approved || route.revision !== proposal.routeRevision) throw new GraphError(409, 'ROUTE_NOT_APPROVED', RuntimeMessage.NO_MATCHING_APPROVED_ROUTE)
    const split = operation.kind === 'split'
    if ((split && !['split-report', 'split-merge'].includes(proposal.kind)) || (!split && !['report', 'merge'].includes(proposal.kind))) throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.PROPOSAL_DOES_NOT_MATCH_OPERATION_KIND)
    const reports = split ? operation.splitReports : operation.reports
    if (proposal.kind === 'report' || proposal.kind === 'split-report') {
      if (actor.role !== 'worker' || actor.slotId !== proposal.slotId) throw new GraphError(403, 'SLOT_NOT_ALLOWED', RuntimeMessage.WORKER_MAY_ONLY_SUBMIT_ITS_BOUND_SLOT)
      const slot = route.slots.find(slot => slot.id === proposal.slotId)
      if (!slot) throw new GraphError(403, 'SLOT_NOT_ALLOWED', RuntimeMessage.UNKNOWN_ROUTE_SLOT)
      if (reports.some(report => report.slotId === slot.id)) throw new GraphError(409, 'REPORT_SLOT_CONFLICT', RuntimeMessage.SLOT_ALREADY_HAS_A_REPORT)
      const configuration = split ? run.configuration.split! : run.configuration
      const profile = configuration.agents.find(agent => agent.id === slot.agentId)!
      const base = { id: proposal.id, slotId: slot.id, agentId: profile.id, agentName: profile.name, angle: slot.angle,
        tools: [...slot.tools], routeRevision: route.revision, reason: proposal.reason, createdAt: now }
      if (proposal.kind === 'split-report') operation.splitReports.push({ ...base, claims: structuredClone(proposal.claims) })
      else operation.reports.push({ ...base, score: proposal.score })
    } else {
      if (actor.role !== 'merge') throw new GraphError(403, 'ROLE_NOT_ALLOWED', RuntimeMessage.ONLY_MERGER_MAY_SUBMIT_RESULTS)
      if (reports.length !== route.slots.length || !route.slots.every(slot => reports.some(report => report.slotId === slot.id))
        || new Set(proposal.reportIds).size !== reports.length || proposal.reportIds.length !== reports.length
        || !reports.every(report => proposal.reportIds.includes(report.id))) throw new GraphError(409, 'REPORTS_INCOMPLETE', RuntimeMessage.MERGE_MUST_REFERENCE_EVERY_ACCEPTED_REPORT_EXACTLY_ONCE)
      if (proposal.kind === 'split-merge') {
        const keys = new Set<string>()
        for (const item of proposal.selected) {
          const report = operation.splitReports.find(report => report.id === item.reportId), key = item.reportId + ':' + item.index
          if (!report || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= report.claims.length || keys.has(key)) throw new GraphError(422, 'INVALID_SELECTION', RuntimeMessage.SELECT_EACH_EXISTING_CANDIDATE_AT_MOST_ONCE)
          keys.add(key)
        }
        operation.contentDraft = { kind: 'split', reason: proposal.reason, selected: structuredClone(proposal.selected) }
      } else operation.draft = { id: proposal.id, routeRevision: route.revision, reportIds: [...proposal.reportIds], score: proposal.score, reason: proposal.reason }
      if (run.mode === 'human-in-loop') runCreateReview(operation, 'result', now)
      else result = runCreateOutputs(document, operation, now)
    }
  }
  runUpdateProgress(document, now)
  return { document, ...result }
}
