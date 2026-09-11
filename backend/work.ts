import type { GraphWork, GraphWorkGrant, GraphWorkProof } from '../contracts/graph'
import { GraphError } from './graph-error'
import type { GraphDocument } from './store'

/** Discover business work from accepted state; DSH owns execution inside each assignment. */
export function workReadItems(document: GraphDocument): GraphWork[] {
  const run = document.run
  if (!run || run.status !== 'running') return []
  const operation = run.operation
  const base = { mapId: document.id, runId: run.id, operationId: operation.id }
  const route = operation.route
  if (!route) return [{ ...base, workId: `${operation.id}:route`, actor: { role: 'router' }, routeRevision: 0 }]
  if (!route.approved || operation.draft) return []
  const remaining = route.slots.filter(slot => !operation.reports.some(report => report.slotId === slot.id))
  const priority = { high: 0, medium: 1, low: 2 }
  if (remaining.length) return remaining.sort((a, b) => priority[a.priority] - priority[b.priority]).map(slot => ({
    ...base, workId: `${operation.id}:report:${route.revision}:${slot.id}`,
    actor: { role: 'worker' as const, slotId: slot.id }, routeRevision: route.revision,
  }))
  return [{ ...base, workId: `${operation.id}:merge:${route.revision}`, actor: { role: 'merge' }, routeRevision: route.revision }]
}

export function workReadGrant(document: GraphDocument, proof: GraphWorkProof): GraphWorkGrant {
  const grant = document.leases[proof.workId]
  if (!grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence) {
    throw new GraphError(409, 'LEASE_LOST', 'Work grant was superseded or does not exist')
  }
  return grant
}
