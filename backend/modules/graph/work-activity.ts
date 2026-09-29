// 将当前有效工作授权投影为临时执行活动，拒绝过期或已不可执行的活动。
import { RuntimeMessage } from '../../../contracts/messages'
import type { ActivityStatus, GraphActivity } from '../../../contracts/activity'
import type { GraphWorkProof } from '../../../contracts/graph'
import type { GraphStore } from '../../ports/graph-store'
import { GraphError } from '../shared/domain-error'
import { workReadItems } from './work-state'

export async function activityReadRecord(/* 用于按存储时钟校验工作租约的图存储。 */ store: GraphStore, /* 活动所属图的稳定身份。 */ mapId: string, /* 活动上报者的 work、holder 和 fence 证明。 */ proof: GraphWorkProof, /* 活动当前所处的执行状态。 */ status: ActivityStatus, /* 同一 work 与 fence 授权内递增的活动序号；重新领取产生新 fence 后可重新计数。 */ sequence: number): Promise<GraphActivity> {
  // 验证工作仍持有有效租约且处于可执行阶段，再投影 Agent、节点和活动序号；不持久化活动。
  const document = await store.readLease(mapId, proof)
  const work = document && workReadItems(document).find(/* 当前与上报工作身份匹配的可执行工作。 */ work => /* 从当前可执行工作中确认上报者对应的工作仍存在。 */ work.workId === proof.workId)
  if (!document || !work) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.ACTIVITY_NO_LONGER_BELONGS_TO_EXECUTABLE_WORK)
  const run = document.runs.find(item => item.id === work.runId)!
  const operation = run.operations.find(/* 当前与工作绑定的 Operation。 */ operation => /* 读取活动所属操作以选择其冻结阶段。 */ operation.id === work.operationId)!
  const stage = operation.executionSpec.stages.find(item => item.id === work.stageId)!
  const group = operation.stages.find(item => item.stageId === work.stageId)!
  const slot = group.planSlots.find(item => item.id === work.slotId)
  const plannedAgent = operation.executionSpec.stages.flatMap(item => item.plan?.agents ?? [])
    .find(item => slot && item.ref.id === slot.agentRef.id && item.ref.version === slot.agentRef.version)
  const agent = slot && !(slot.id === stage.id && slot.agentRef.id === stage.agent.ref.id && slot.agentRef.version === stage.agent.ref.version)
    ? plannedAgent : stage.agent
  if (!agent) throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.ACTIVITY_NO_LONGER_BELONGS_TO_EXECUTABLE_WORK)
  return { mapId, runId: run.id, operationId: operation.id, nodeId: operation.group.inputRefs[0]?.id ?? operation.id,
    workId: work.workId, stageId: work.stageId, slotId: work.slotId, agentName: agent.profile.name.slice(0, 256),
    status, fence: proof.fence, sequence, updatedAt: new Date().toISOString() }
}
