// C17先行：步骤解释只读冻结计划和保存状态，不估算未来处理项或重写DAG状态。
import { describe, expect, it } from 'vitest'

import type { GraphOperation, GraphRun } from '../../contracts/graph-run'
import { runCreateRun } from '../../backend/modules/graph/run-state'
import { libraryTestCatalog, libraryTestDocument, libraryTestStartInput, LIBRARY_TEST_AGENT, LIBRARY_TEST_TIME } from '../backend/fixtures/library-claims'
import { runHasPendingReview, runReadDependencyLinks, runReadStepPresentation } from '../../apps/ui/features/run/run-progress'

function progressFixture(): { run: GraphRun; operation: GraphOperation } {
  // 复用真实冻结目录和Operation，只固定步骤状态投影需要的已保存计划与状态。
  const { document, input } = libraryTestDocument()
  runCreateRun(document, libraryTestStartInput(document, input.id, []), {
    definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4, libraryClaimSets: [],
  }, LIBRARY_TEST_TIME)
  const run = document.runs[0], operation = run?.operations[0]
  if (!run || !operation) throw new Error('Expected frozen progress fixture')
  const first = run.plan.steps[0]
  run.plan.steps = [first, { ...structuredClone(first), id: 'later-step', dependsOn: [first.id] },
    { ...structuredClone(first), id: 'last-step', dependsOn: ['later-step'] }]
  run.steps = [{ stepId: first.id, status: 'running', operationIds: [operation.id] },
    { stepId: 'later-step', status: 'pending', operationIds: [] }, { stepId: 'last-step', status: 'pending', operationIds: [] }]
  return { run, operation }
}

describe('C17 frozen Run step presentation', () => {
  // 步骤状态、审核与暂停是不同维度，未实例化项不能伪装成完成进度。
  it('shares an actionable pending-review predicate across active paused terminal and reused records', () => {
    // 同一保存条件供计数与按钮使用，暂停仍允许原审核，终态和复制记录不生成本次动作。
    const { run, operation } = progressFixture()
    operation.status = 'waiting'; operation.review = { id: 'review', kind: 'result', state: 'pending', revision: 0,
      decision: null, createdAt: LIBRARY_TEST_TIME, answeredAt: null }
    for (const status of ['running', 'waiting'] as const) {
      run.status = status
      expect(runHasPendingReview(run, operation)).toBe(true)
      run.paused = true
      expect(runHasPendingReview(run, operation)).toBe(true)
      run.paused = false
    }
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      run.status = status
      expect(runHasPendingReview(run, operation)).toBe(false)
    }
    run.status = 'waiting'; operation.reusedFromOperationId = 'earlier-operation'
    expect(runHasPendingReview(run, operation)).toBe(false)
    delete operation.reusedFromOperationId
    operation.review.state = 'answered'
    expect(runHasPendingReview(run, operation)).toBe(false)
    operation.review.state = 'pending'; operation.status = 'running'
    expect(runHasPendingReview(run, operation)).toBe(false)
  })

  it('reads every frozen plan step in order including pending steps without Operations', () => {
    // 没有实例化的后续步骤仍可见，运行分母不从一个Operation推算。
    const { run, operation } = progressFixture()
    const rows = runReadStepPresentation(run)
    expect(rows.map((/* 一份步骤投影。 */ row) => /* 按保存计划顺序显示稳定身份。 */ row.step.id)).toEqual(run.plan.steps.map((/* 保存计划项。 */ step) => /* 不重编号。 */ step.id))
    expect(rows[0]).toMatchObject({ state: 'running', title: run.definitions.transitions[0].title, operations: [operation], missingOperationIds: [],
      counts: { total: 1, completed: 0, skipped: 0, failed: 0, waitingReview: 0, reused: 0 } })
    expect(rows[1]).toMatchObject({ state: 'pending', operations: [], counts: { total: 0 }, dependencyState: 'waiting' })
    expect(rows[2]).toMatchObject({ state: 'pending', operations: [], counts: { total: 0 } })
  })

  it('counts only instantiated Operations and real pending reviews excluding copied historical approvals', () => {
    // 一步可含多个处理项，部分完成和待审核不等于整步完成；复制审核不算本次等待。
    const { run, operation } = progressFixture()
    const completed = { ...structuredClone(operation), id: 'completed-operation', status: 'completed' as const }
    const skipped = { ...structuredClone(operation), id: 'skipped-operation', status: 'skipped' as const }
    const waiting: GraphOperation = { ...structuredClone(operation), id: 'waiting-operation', status: 'waiting',
      review: { id: 'pending-review', kind: 'result' as const, state: 'pending' as const, revision: 0, decision: null, createdAt: LIBRARY_TEST_TIME, answeredAt: null } }
    const reused = { ...structuredClone(waiting), id: 'reused-operation', status: 'completed' as const, reusedFromOperationId: 'original-operation' }
    run.operations = [completed, skipped, waiting, reused]
    run.steps[0].operationIds = run.operations.map((/* 保存处理项。 */ item) => /* 当前步骤明确记录其成员。 */ item.id)
    const row = runReadStepPresentation(run)[0]
    expect(row.state).toBe('running')
    expect(row.counts).toEqual({ total: 4, completed: 2, skipped: 1, failed: 0, waitingReview: 1, reused: 1 })
    if (waiting.review) waiting.review.state = 'answered'
    expect(runReadStepPresentation(run)[0].counts.waitingReview).toBe(0)
  })

  it('explains direct dependencies as waiting blocked ready or unknown without rewriting saved pending status', () => {
    // failed只阻断依赖，Run失败不会把尚未开始的后代伪造成failed。
    const { run } = progressFixture()
    const changes: Array<{ status: GraphRun['steps'][number]['status']; expected: 'waiting' | 'blocked' | 'ready' }> = [
      { status: 'pending', expected: 'waiting' }, { status: 'running', expected: 'waiting' },
      { status: 'failed', expected: 'blocked' }, { status: 'completed', expected: 'ready' }, { status: 'skipped', expected: 'ready' },
    ]
    for (const change of changes) {
      run.steps[0].status = change.status
      expect(runReadDependencyLinks(run)[0]).toEqual({ fromStepId: run.plan.steps[0].id, toStepId: 'later-step', state: change.status })
      expect(runReadStepPresentation(run)[1]).toMatchObject({ state: 'pending', dependencyState: change.expected })
    }
    run.status = 'failed'; run.steps[0].status = 'failed'
    expect(runReadStepPresentation(run)[2].state).toBe('pending')
    run.steps.shift()
    expect(runReadDependencyLinks(run)[0].state).toBeNull()
    expect(runReadStepPresentation(run)[1].dependencyState).toBe('unknown')
  })

  it('preserves saved skip and failure without inventing an Operation or inferring the cause from onEmpty', () => {
    // 跳过和失败可无Operation，onEmpty只是配置，不能冒充实际原因记录。
    const { run } = progressFixture()
    run.steps[1].status = 'skipped'; run.steps[2].status = 'failed'
    run.plan.steps[1].onEmpty = 'fail'; run.plan.steps[2].onEmpty = 'skip'
    const rows = runReadStepPresentation(run)
    expect(rows[1]).toMatchObject({ state: 'skipped', operations: [], counts: { total: 0, completed: 0 } })
    expect(rows[2]).toMatchObject({ state: 'failed', operations: [], counts: { total: 0, failed: 0 } })
  })

  it('keeps pause independent of real running and review states and restores the same saved rows', () => {
    // 暂停不完成步骤、不回答审核、不制造产物；恢复只去掉暂停标记。
    const { run, operation } = progressFixture()
    operation.status = 'waiting'; operation.review = { id: 'review', kind: 'plan', state: 'pending', revision: 0, decision: null, createdAt: LIBRARY_TEST_TIME, answeredAt: null }
    const before = structuredClone({ steps: run.steps, operations: run.operations })
    run.paused = true
    expect(runReadStepPresentation(run)[0]).toMatchObject({ paused: true, state: 'running', counts: { waitingReview: 1 } })
    run.paused = false
    expect(runReadStepPresentation(run)[0]).toMatchObject({ paused: false, state: 'running', counts: { waitingReview: 1 } })
    expect({ steps: run.steps, operations: run.operations }).toEqual(before)
  })

  it.each(['failed', 'cancelled', 'completed'] as const)('does not count a preserved pending review as actionable after Run %s', (/* 已经结束的运行状态。 */ status) => {
    // Run终态可保留等待审核的旧Operation，摘要不能误称仍可审核，但不改原审计记录。
    const { run, operation } = progressFixture()
    operation.status = 'waiting'
    operation.review = { id: 'preserved-review', kind: 'result', state: 'pending', revision: 0, decision: null,
      createdAt: LIBRARY_TEST_TIME, answeredAt: null }
    run.status = status
    const before = structuredClone({ steps: run.steps, operations: run.operations })
    expect(runReadStepPresentation(run)[0]).toMatchObject({ state: 'running', counts: { waitingReview: 0 } })
    expect({ steps: run.steps, operations: run.operations }).toEqual(before)
    expect(operation.review.state).toBe('pending')
  })

  it('retains frozen exact port sources grouping empty policy and materials without current settings', () => {
    // 展开内容来自保存plan，不拿当前图正文、Agent或同名新版本替换。
    const { run } = progressFixture()
    const saved = run.plan.steps[1]
    saved.input[0].source = { kind: 'step', stepId: run.plan.steps[0].id, port: 'opinion' }
    saved.context = [{ port: 'background', source: { kind: 'scope', nodeIds: ['saved-context-id'] } }]
    saved.grouping = { mode: 'explicit', groups: [{ id: 'saved-group', members: { claim: ['saved-input-id'] } }] }
    saved.onEmpty = 'skip'; saved.libraryClaimRefs = [{ entryId: 'fixed-entry', contentDigest: 'fixed-digest' }]
    expect(runReadStepPresentation(run)[1].step).toEqual(saved)
    saved.transitionRef.version = 99
    expect(runReadStepPresentation(run)[1].title).toBe(`${saved.transitionRef.id}@99`)
  })

  it('reads terminal archived records with missing state and Operations while preserving unassigned audit entries', () => {
    // 归档无需可执行branchState，缺状态按真实stepId保留审计，错归属ID明确列出而不伪造处理项。
    const { run, operation } = progressFixture()
    const archived: GraphRun = { ...run, status: 'completed', branchState: undefined }
    archived.steps = archived.steps.filter((/* 保存的步骤状态。 */ current) => /* 模拟旧归档缺少首步状态。 */ current.stepId !== operation.stepId)
    const rows = runReadStepPresentation(archived)
    expect(rows[0]).toMatchObject({ state: null, operations: [operation] })
    const orphan = { ...structuredClone(operation), id: 'orphan-operation', stepId: 'unrecorded-plan-step' }
    archived.operations.push(orphan)
    archived.steps[0].operationIds = ['missing-operation', orphan.id]
    const after = runReadStepPresentation(archived)
    expect(after[1].missingOperationIds).toEqual(['missing-operation', orphan.id])
    expect(after[1].operations).toEqual([])
    const assigned = new Set(after.flatMap((/* 只读分组。 */ row) => /* 根页面用同样差集保留未归类项。 */ row.operations.map((/* 已核实处理项。 */ current) => /* 只取真实身份。 */ current.id)))
    expect(archived.operations.filter((/* 保存的审计项。 */ current) => /* 不因plan不含它就删除审计。 */ !assigned.has(current.id))).toEqual([orphan])
  })

  it('does not mutate either Run or reuse another Run projection with matching local IDs', () => {
    // 投影没有跨Run缓存，同名步骤/处理项仍各自读取自己的冻结记录。
    const { run } = progressFixture(), another = structuredClone(run)
    another.id = 'different-run'; another.steps[0].status = 'completed'; another.definitions.transitions[0].title = '另一运行保存标题'
    const before = structuredClone({ run, another })
    expect(runReadStepPresentation(run)[0].state).toBe('running')
    expect(runReadStepPresentation(another)[0]).toMatchObject({ state: 'completed', title: '另一运行保存标题' })
    runReadDependencyLinks(run); runReadDependencyLinks(another)
    expect({ run, another }).toEqual(before)
  })
})
