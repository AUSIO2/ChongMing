// 从当前Map与明确选中Run派生只读节点标记；布局、类型色和相机不承载执行状态。
import { ACTIVITY_LABELS, type GraphActivity } from '../../../../contracts/activity'
import type { GraphNode } from '../../../../contracts/graph'
import type { GraphSnapshot } from '../../../../contracts/graph-api'
import type { GraphOperation, GraphRun } from '../../../../contracts/graph-run'
import { runHasPendingReview } from '../run/run-progress'

export interface GraphNodeActivity {
  readonly label: string
  readonly state: 'idle' | 'running' | 'review' | 'paused' | 'failed' | 'completed' | 'cancelled' | 'skipped' | 'ended'
  readonly stale: boolean
  readonly operationCount: number
  readonly activeWorkCount: number
  readonly waitingReviewCount: number
}

export function graphReadNodeActivity(
  /* 当前已获权Map快照，不借其它图的同名节点。 */ snapshot: GraphSnapshot,
  /* 会话明确选择的运行；缺失时不回落其它Run。 */ selectedRunId: string | null,
  /* 公共事件边界已验证的临时活动摘要，空数组表示无实时活动。 */ activities: readonly GraphActivity[],
): ReadonlyMap<string, GraphNodeActivity> {
  // 归属以真实保存input为准，context不冒充正在被处理的数据，陈旧标记独立保留。
  const run = snapshot.runs.find((/* 当前Map保存的一份运行。 */ item) => /* 只解释明确选择。 */ item.id === selectedRunId)
  const nodes = new Map(snapshot.nodes.map((/* 当前真实节点。 */ node) => /* 用于核对精确输入版本。 */ [node.id, node]))
  const operationsByNode = new Map<string, GraphOperation[]>(), inputIdsByOperation = new Map<string, Set<string>>()
  for (const operation of run?.operations ?? []) {
    const inputIds = new Set(operation.group.inputRefs.filter((/* 该Operation保存的一项输入。 */ ref) =>
      /* 编辑后的新版本不显示旧输入活动，context不参加此索引。 */ inputMatchesNode(ref, nodes.get(ref.id))).map((/* 已匹配真实节点的输入引用。 */ ref) =>
      /* 多个端口复用同节点仍只计一份Operation。 */ ref.id))
    inputIdsByOperation.set(operation.id, inputIds)
    for (const id of inputIds) {
      const current = operationsByNode.get(id) ?? []
      current.push(operation); operationsByNode.set(id, current)
    }
  }
  const liveByOperation = readLiveActivities(snapshot.mapId, run, inputIdsByOperation, activities)
  const result = new Map<string, GraphNodeActivity>()
  for (const node of snapshot.nodes) {
    const operations = operationsByNode.get(node.id) ?? []
    const live = operations.flatMap((/* 当前节点真实参与的Operation。 */ operation) => /* 不把另一个处理项的活动借给本节点。 */ liveByOperation.get(operation.id) ?? [])
    const waitingReviewCount = operations.filter((/* 当前节点的实际处理项。 */ operation) =>
      /* 共用当前运行的审核条件，终态与复制记录只保留审计。 */ run !== undefined && runHasPendingReview(run, operation)).length
    const presentation = readPresentation(run, operations, live, waitingReviewCount)
    const stale = node.validity === 'stale'
    result.set(node.id, { ...presentation, label: presentation.state === 'idle' && stale ? '需要重新处理' : presentation.label,
      stale, operationCount: operations.length, activeWorkCount: live.length, waitingReviewCount })
  }
  return result
}

function inputMatchesNode(
  /* 保存的精确Operation输入引用。 */ ref: GraphOperation['group']['inputRefs'][number],
  /* 当前Map同身份节点，缺失时保持无匹配。 */ node: GraphNode | undefined,
): boolean {
  // 只核对已保存身份版本，不读取或修改payload，不把当前正文套入旧输入。
  return node !== undefined && node.id === ref.id && node.revision === ref.revision && node.typeId === ref.type.id && node.typeVersion === ref.type.version
}

function readLiveActivities(
  /* 当前Map真实身份。 */ mapId: string,
  /* 当前明确选中的Run。 */ run: GraphRun | undefined,
  /* 各Operation已经核对过的当前input身份。 */ inputIdsByOperation: ReadonlyMap<string, Set<string>>,
  /* 公共协议已验证的活动数组。 */ activities: readonly GraphActivity[],
): Map<string, GraphActivity[]> {
  // 只核对保存的工作归属、未接纳和未封闭事实，不复制Host派发、slot或租约引擎。
  const result = new Map<string, GraphActivity[]>()
  if (!run || run.status !== 'running' || run.paused) return result
  const latestByWork = new Map<string, GraphActivity>()
  for (const activity of activities) {
    if (activity.mapId !== mapId || activity.runId !== run.id) continue
    const operation = run.operations.find((/* 所选Run的一份真实处理项。 */ item) => /* 活动不能跨Operation借归属。 */ item.id === activity.operationId)
    if (!operation || operation.status !== 'running' || !inputIdsByOperation.get(operation.id)?.has(activity.nodeId)) continue
    const group = operation.stages.find((/* 保存阶段组。 */ item) => /* 不接纳未知或另一个阶段的work。 */ item.stageId === activity.stageId)
    if (!group || group.closed || !group.expectedWorkIds.includes(activity.workId)
      || group.results.some((/* 已接纳的阶段结果。 */ accepted) => /* 接纳后旧临时活动立即失效。 */ accepted.workId === activity.workId)) continue
    const key = JSON.stringify([operation.id, activity.workId]), previous = latestByWork.get(key)
    if (!previous || compareSameWork(activity, previous) > 0) latestByWork.set(key, activity)
  }
  for (const activity of latestByWork.values()) {
    const current = result.get(activity.operationId) ?? []
    current.push(activity); result.set(activity.operationId, current)
  }
  return result
}

function compareSameWork(
  /* 同一Map/Run/Operation/work的一份候选摘要。 */ left: GraphActivity,
  /* 同work之前已保留的摘要。 */ right: GraphActivity,
): number {
  // 代次先于序号，时间只在同代同序时打平；这些数字绝不跨work比较。
  if (left.fence !== right.fence) return left.fence - right.fence
  if (left.sequence !== right.sequence) return left.sequence - right.sequence
  const timestamp = Date.parse(left.updatedAt) - Date.parse(right.updatedAt)
  if (timestamp !== 0) return timestamp
  return JSON.stringify([left.agentName, left.status, left.stageId, left.slotId]).localeCompare(JSON.stringify([right.agentName, right.status, right.stageId, right.slotId]))
}

function readPresentation(
  /* 当前明确选择的保存运行。 */ run: GraphRun | undefined,
  /* 当前节点精确参与的所有处理项。 */ operations: GraphOperation[],
  /* 这些处理项真正仍活动的不同work。 */ live: GraphActivity[],
  /* 仍waiting且未复用的真实待审核数。 */ waitingReviewCount: number,
): Pick<GraphNodeActivity, 'state' | 'label'> {
  // 确定一个简短标记，保留数量供界面说明混合状态，不用find首项掩盖其它处理。
  if (!run || !operations.length) return { state: 'idle', label: '' }
  if (operations.some((/* 一份节点处理项。 */ operation) => /* 显示实际失败，不据全局失败猜该项失败。 */ operation.status === 'failed')) return { state: 'failed', label: '处理失败' }
  const active = operations.some((/* 一份节点处理项。 */ operation) => /* 审核等待也仍属于未结束的处理。 */ operation.status === 'running' || operation.status === 'waiting')
  if (active && run.status !== 'running' && run.status !== 'waiting') return { state: 'ended', label: '运行已结束' }
  if (active && run.paused) return { state: 'paused', label: waitingReviewCount ? '已暂停 · 等待审核' : '已暂停' }
  if (waitingReviewCount) return { state: 'review', label: waitingReviewCount > 1 ? `${waitingReviewCount} 项待审核` : '等待审核' }
  if (active) {
    if (live.length > 1) return { state: 'running', label: `${live.length} 个任务处理中` }
    const activity = live[0]
    return { state: 'running', label: activity ? `${activity.agentName} · ${ACTIVITY_LABELS[activity.status]}` : '处理中（无实时活动）' }
  }
  if (operations.some((/* 一份节点处理项。 */ operation) => /* 取消不冒充失败或成功。 */ operation.status === 'cancelled')) return { state: 'cancelled', label: '处理已取消' }
  if (operations.some((/* 一份节点处理项。 */ operation) => /* 跳过和完成分别解释，不把未生成当生成。 */ operation.status === 'completed')) return { state: 'completed', label: '处理完成' }
  return { state: 'skipped', label: '处理已跳过' }
}
