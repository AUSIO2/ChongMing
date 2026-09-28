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
  const run = document.run!
  const operation = run.operations.find(/* 当前与工作绑定的 Operation。 */ operation => /* 读取活动所属操作以选择其阶段配置。 */ operation.id === work.operationId)!
  const configuration = operation.kind === 'split' ? run.configuration.split! : run.configuration
  const actor = work.actor
  const slot = actor.role === 'worker' ? operation.route!.slots.find(/* 当前与 Worker 角色槽位匹配的路由项。 */ slot => /* 取得 Worker 绑定的路由槽位，确定实际执行 Agent。 */ slot.id === actor.slotId)! : null
  const profile = actor.role === 'parse' ? run.configuration.parse!
    : actor.role === 'router' ? configuration.router
    : actor.role === 'merge' ? configuration.merger : configuration.agents.find(/* 当前与槽位绑定身份匹配的冻结 Agent 配置。 */ agent => /* 从本 Run 冻结的阶段配置中读取槽位 Agent 的名称。 */ agent.id === slot!.agentId)!
  return { mapId, runId: run.id, operationId: operation.id, nodeId: operation.targetId, workId: work.workId,
    actor, agentName: profile.name.slice(0, 256), status, fence: proof.fence, sequence, updatedAt: new Date().toISOString() }
}
