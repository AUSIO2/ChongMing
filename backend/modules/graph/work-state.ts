import { RuntimeMessage } from '../../../contracts/messages'
import type { GraphWork, GraphWorkGrant, GraphWorkProof } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import type { GraphDocument } from './graph-record'

/** Discover business work from accepted state; DSH owns execution inside each assignment. */
// 用途：读取条目，并把结构化结果交给调用方。
export function workReadItems(document: GraphDocument): GraphWork[] {
  const run = document.run
  if (!run || run.status !== 'running' || run.paused) return []
  return run.operations.flatMap<GraphWork>(operation => {
  if (operation.status !== 'running') return []
  const base = { mapId: document.id, runId: run.id, operationId: operation.id }
  if (operation.kind === 'parse') return [{ ...base, workId: `${operation.id}:parse`, actor: { role: 'parse' as const }, routeRevision: 0 }]
  const route = operation.route
  if (!route) return [{ ...base, workId: `${operation.id}:route`, actor: { role: 'router' as const }, routeRevision: 0 }]
  if (!route.approved || operation.draft || operation.contentDraft) return []
  const reports = operation.kind === 'split' ? operation.splitReports : operation.reports
  const remaining = route.slots.filter(slot => !reports.some(report => report.slotId === slot.id))
  const priority = { high: 0, medium: 1, low: 2 }
  if (remaining.length) return remaining.sort((a, b) => priority[a.priority] - priority[b.priority]).map(slot => ({
    ...base, workId: `${operation.id}:report:${route.revision}:${slot.id}`,
    actor: { role: 'worker' as const, slotId: slot.id }, routeRevision: route.revision,
  }))
  return [{ ...base, workId: `${operation.id}:merge:${route.revision}`, actor: { role: 'merge' as const }, routeRevision: route.revision }]
  })
}

// 用途：读取授权，并把结构化结果交给调用方。
export function workReadGrant(document: GraphDocument, proof: GraphWorkProof): GraphWorkGrant {
  const grant = document.leases[proof.workId]
  if (!grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence) {
    throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_GRANT_WAS_SUPERSEDED_OR_DOES_NOT_EXIST)
  }
  return grant
}
