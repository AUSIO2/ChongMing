// 从冻结阶段组推导可执行 Agent Work，并核对租约授权。
import { RuntimeMessage } from '../../../contracts/messages'
import { createHash } from 'node:crypto'
import type { GraphOperation, GraphStageGroup, GraphWork, GraphWorkGrant, GraphWorkProof } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import type { GraphDocument } from './graph-record'

/**
 * Mongo 租约以 workId 作为字段键；阶段和槽位可含点，因此只把安全摘要放进持久化键。
 *
 * @param operationId Work 所属 Operation 身份。
 * @param stageId 冻结阶段身份。
 * @param slotId 本次阶段实例槽位身份。
 */
export function workCreateId(operationId: string, stageId: string, slotId: string): string {
  const identity = createHash('sha256').update(stageId).update('\0').update(slotId).digest('hex').slice(0, 32)
  return `${operationId}:${identity}`
}

/**
 * 只有全部依赖阶段封闭后才能派发；每个 expectedWorkId 恰好对应一份可独立领取的 Agent 工作。
 *
 * @param operation Work 所属 Operation。
 * @param group Work 所属阶段组。
 */
function workReadStage(
  operation: GraphOperation,
  group: GraphStageGroup,
): GraphWork[] {
  const spec = operation.executionSpec.stages.find(stage => stage.id === group.stageId)
  if (!spec || group.closed || !spec.dependsOn.every(stageId => operation.stages.some(stage => stage.stageId === stageId && stage.closed))) return []
  const accepted = new Set(group.results.map(result => result.workId))
  return group.expectedWorkIds.flatMap(workId => {
    if (accepted.has(workId)) return []
    const planned = group.planSlots.find(slot => workCreateId(operation.id, group.stageId, slot.id) === workId)
    const slotId = planned?.id ?? group.stageId
    return [{
      workId,
      mapId: '',
      runId: '',
      operationId: operation.id,
      stageId: group.stageId,
      slotId,
      specHash: operation.specHash,
      priority: planned?.priority ?? 'medium',
    }]
  })
}

/**
 * Host 数量与槽数不改变工作推导；它们只并发领取这里返回的同一组 Work。
 *
 * @param document 用于推导当前可执行工作的完整图状态。
 */
export function workReadItems(document: GraphDocument): GraphWork[] {
  const priority = { high: 0, medium: 1, low: 2 }
  return document.runs.filter(run => run.status === 'running' && !run.paused).flatMap(run => run.operations.flatMap(operation => {
      if (operation.status !== 'running') return []
      return operation.stages.flatMap(group => workReadStage(operation, group)).sort((a, b) => priority[a.priority] - priority[b.priority]).map(work => ({
        ...work,
        mapId: document.id,
        runId: run.id,
      }))
    }))
}

/**
 * 核对工作凭证的持有者与栅栏版本，拒绝已被替换的授权；有效期由存储端另行检查。
 *
 * @param document 保存当前 Run 和授权记录的图状态。
 * @param proof 调用者提供的 work、holder 和 fence 身份证明。
 */
export function workReadGrant(
  document: GraphDocument,
  proof: GraphWorkProof,
): GraphWorkGrant {
  const grant = document.leases[proof.workId]
  if (!grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence) {
    throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_GRANT_WAS_SUPERSEDED_OR_DOES_NOT_EXIST)
  }
  return grant
}
