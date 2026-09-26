import { RuntimeMessage } from '../../../contracts/messages'
import type { ActivityStatus, GraphActivity } from '../../../contracts/activity'
import type { GraphWorkProof } from '../../../contracts/graph'
import type { GraphStore } from '../../ports/graph-store'
import { GraphError } from '../shared/domain-error'
import { workReadItems } from './work-state'

// 用途：读取活动状态，并把结构化结果交给调用方。
export async function activityReadRecord(store: GraphStore, mapId: string, proof: GraphWorkProof, status: ActivityStatus, sequence: number): Promise<GraphActivity> {
  const document = await store.readLease(mapId, proof)
  const work = document && workReadItems(document).find(work => work.workId === proof.workId)
  if (!document || !work) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.ACTIVITY_NO_LONGER_BELONGS_TO_EXECUTABLE_WORK)
  const run = document.run!
  const operation = run.operations.find(operation => operation.id === work.operationId)!
  const configuration = operation.kind === 'split' ? run.configuration.split! : run.configuration
  const actor = work.actor
  const slot = actor.role === 'worker' ? operation.route!.slots.find(slot => slot.id === actor.slotId)! : null
  const profile = actor.role === 'parse' ? run.configuration.parse!
    : actor.role === 'router' ? configuration.router
    : actor.role === 'merge' ? configuration.merger : configuration.agents.find(agent => agent.id === slot!.agentId)!
  return { mapId, runId: run.id, operationId: operation.id, nodeId: operation.targetId, workId: work.workId,
    actor, agentName: profile.name.slice(0, 256), status, fence: proof.fence, sequence, updatedAt: new Date().toISOString() }
}
