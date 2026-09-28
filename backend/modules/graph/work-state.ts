// 从已接纳的图运行状态推导可执行工作，并核对工作授权身份。
import { RuntimeMessage } from '../../../contracts/messages'
import type { GraphWork, GraphWorkGrant, GraphWorkProof } from '../../../contracts/graph'
import { GraphError } from '../shared/domain-error'
import type { GraphDocument } from './graph-record'

export function workReadItems(/* 用于推导当前可执行工作的完整图状态。 */ document: GraphDocument): GraphWork[] {
  // 从 Run 已接纳的状态推导待执行工作；这里只描述任务，领取与执行由 Host 完成。
  const run = document.run
  if (!run || run.status !== 'running' || run.paused) return []
  return run.operations.flatMap<GraphWork>(/* 当前检查执行阶段和缺失任务的 Operation。 */ operation => {
    // 为仍在运行的 Operation 选择解析、路由、缺失报告或汇总阶段的工作。
    if (operation.status !== 'running') return []
    const base = { mapId: document.id, runId: run.id, operationId: operation.id }
    if (operation.kind === 'parse') return [{ ...base, workId: `${operation.id}:parse`, actor: { role: 'parse' as const }, routeRevision: 0 }]
    const route = operation.route
    if (!route) return [{ ...base, workId: `${operation.id}:route`, actor: { role: 'router' as const }, routeRevision: 0 }]
    if (!route.approved || operation.draft || operation.contentDraft) return []
    const reports = operation.kind === 'split' ? operation.splitReports : operation.reports
    const remaining = route.slots.filter(/* 当前检查是否已有报告的已批准路由槽位。 */ slot =>
      /* 只为尚未接纳报告的槽位生成工作。 */
      !reports.some(/* 当前与路由槽位身份比较的已接纳报告。 */ report => /* 用槽位身份匹配已接纳报告。 */ report.slotId === slot.id))
    const priority = { high: 0, medium: 1, low: 2 }
    // 工作身份包含路由版本，避免路由调整后旧报告或旧汇总被当作当前工作。
    if (remaining.length) return remaining
      .sort((/* 排序时位于左侧的待执行槽位。 */ a, /* 排序时位于右侧的待执行槽位。 */ b) => /* 将高优先级槽位排在前面。 */ priority[a.priority] - priority[b.priority])
      .map(/* 按优先级排序后转换为工作描述的槽位。 */ slot => /* 绑定槽位及路由版本，供 Host 领取。 */ ({
        ...base, workId: `${operation.id}:report:${route.revision}:${slot.id}`,
        actor: { role: 'worker' as const, slotId: slot.id }, routeRevision: route.revision,
      }))
    return [{ ...base, workId: `${operation.id}:merge:${route.revision}`, actor: { role: 'merge' as const }, routeRevision: route.revision }]
  })
}

export function workReadGrant(/* 保存当前 Run 和授权记录的图状态。 */ document: GraphDocument, /* 调用者提供的 work、holder 和 fence 身份证明。 */ proof: GraphWorkProof): GraphWorkGrant {
  // 核对工作凭证的持有者与栅栏版本，拒绝已被替换的授权；有效期由存储端另行检查。
  const grant = document.leases[proof.workId]
  if (!grant || grant.holderId !== proof.holderId || grant.fence !== proof.fence) {
    throw new GraphError(409, 'LEASE_LOST', RuntimeMessage.WORK_GRANT_WAS_SUPERSEDED_OR_DOES_NOT_EXIST)
  }
  return grant
}
