// 只读解释保存Run的步骤、直接依赖和已实例化处理项，不推演未来Operation数量。
import type { GraphOperation, GraphRun, GraphRunStep } from '../../../../contracts/graph-run'

type RunStepState = GraphRun['steps'][number]['status']
export interface RunDependencyLink {
  readonly fromStepId: string
  readonly toStepId: string
  readonly state: RunStepState | null
}
export interface RunStepPresentation {
  readonly step: GraphRunStep
  readonly title: string
  readonly state: RunStepState | null
  readonly operations: GraphOperation[]
  readonly missingOperationIds: string[]
  readonly counts: { total: number; completed: number; skipped: number; failed: number; waitingReview: number; reused: number }
  readonly dependencyState: 'ready' | 'waiting' | 'blocked' | 'unknown'
  readonly paused: boolean
}

export function runReadStepPresentation(
  /* 当前选中Run或一份历史详情，定义和计划均来自其自身保存记录。 */ run: GraphRun,
): RunStepPresentation[] {
  // 沿计划顺序读取实际五态；缺状态不猜，缺处理项明确列身份，未归类审计仍留在原Run。
  const links = runReadDependencyLinks(run)
  return run.plan.steps.map((/* 一份保存的完整步骤配置。 */ step) => {
    // 状态记录存在时核对其成员及归属，旧记录缺状态时仍保留同stepId的真实处理项。
    const state = run.steps.find((/* 一份保存步骤状态。 */ item) => /* 精确对应当前计划身份。 */ item.stepId === step.id)
    const operations = state ? state.operationIds.flatMap((/* 已保存的处理项成员身份。 */ id) => {
      // 同名但归属于另一步的处理项不冒充本步结果。
      const operation = run.operations.find((/* 本Run内的一份处理记录。 */ item) => /* 身份与所属步骤同时核对。 */ item.id === id && item.stepId === step.id)
      return operation ? [operation] : []
    }) : run.operations.filter((/* 旧记录中真实存在的处理项。 */ operation) => /* 不因缺状态就丢弃已有审计。 */ operation.stepId === step.id)
    const assigned = new Set(operations.map((/* 已核对归属的真实处理项。 */ operation) => /* 只取本步实际身份。 */ operation.id))
    const missingOperationIds = state?.operationIds.filter((/* 状态中保存的处理项身份。 */ id) => /* 缺失或错归属都明确保留原ID。 */ !assigned.has(id)) ?? []
    const transition = run.definitions.transitions.find((/* 运行保存的一份精确转换。 */ item) =>
      /* 不能用同名其它版本或当前工作区配置替代。 */ item.id === step.transitionRef.id && item.version === step.transitionRef.version)
    const counts = { total: operations.length, completed: 0, skipped: 0, failed: 0, waitingReview: 0, reused: 0 }
    for (const operation of operations) {
      if (operation.status === 'completed') counts.completed += 1
      if (operation.status === 'skipped') counts.skipped += 1
      if (operation.status === 'failed') counts.failed += 1
      if (operation.reusedFromOperationId !== undefined) counts.reused += 1
      if (runHasPendingReview(run, operation)) counts.waitingReview += 1
    }
    return { step, title: transition?.title ?? `${step.transitionRef.id}@${step.transitionRef.version}`, state: state?.status ?? null,
      operations, missingOperationIds, counts, dependencyState: readDependencyState(links.filter((/* 一份保存直接依赖。 */ link) =>
        /* 只解释当前步骤自己的直接前置条件。 */ link.toStepId === step.id)), paused: run.paused }
  })
}

export function runHasPendingReview(
  /* 审核记录所在的保存运行，终态不再接受新的审核动作。 */ run: GraphRun,
  /* 本次真实处理项，复制历史记录不产生再次人工决定。 */ operation: GraphOperation,
): boolean {
  // 供步骤计数、图标记和审核入口共用；暂停不撤销有效审核，终态只保留原审计。
  return (run.status === 'running' || run.status === 'waiting') && operation.status === 'waiting'
    && operation.reusedFromOperationId === undefined && operation.review?.state === 'pending'
}

export function runReadDependencyLinks(
  /* 保存了完整计划和实际步骤状态的单份Run。 */ run: GraphRun,
): RunDependencyLink[] {
  // 只投影计划声明的直接依赖及其真实状态，不构造传递边或据运行终态改写pending。
  return run.plan.steps.flatMap((/* 一份保存步骤配置。 */ step) => /* 不按表单排序猜依赖关系。 */ step.dependsOn.map((/* 保存的直接依赖身份。 */ fromStepId) =>
    /* 缺记录保持null，不能据其它步骤的同名Operation推算完成。 */ ({ fromStepId, toStepId: step.id,
      state: run.steps.find((/* 本Run保存的步骤状态。 */ item) => /* 精确对应此直接依赖。 */ item.stepId === fromStepId)?.status ?? null })))
}

function readDependencyState(
  /* 当前步骤明确保存的所有直接依赖。 */ links: RunDependencyLink[],
): RunStepPresentation['dependencyState'] {
  // 依赖满足仅解释保存前置状态，不声称暂停、终态或未知配置已具备执行资格。
  if (links.some((/* 一份直接依赖。 */ link) => /* 失败阻断，不伪造成后代失败。 */ link.state === 'failed')) return 'blocked'
  if (links.some((/* 一份直接依赖。 */ link) => /* 缺状态不当作完成或等待。 */ link.state === null)) return 'unknown'
  if (links.some((/* 一份直接依赖。 */ link) => /* 尚未完成的前置保持等待。 */ link.state === 'pending' || link.state === 'running')) return 'waiting'
  return 'ready'
}
