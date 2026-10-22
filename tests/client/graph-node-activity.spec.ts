// C21先行：图标记只认当前Map、明确Run和保存输入；实时活动与节点陈旧分别解释。
import { describe, expect, it } from 'vitest'

import type { GraphActivity } from '../../contracts/activity'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphOperation } from '../../contracts/graph-run'
import { runCreateRun } from '../../backend/modules/graph/run-state'
import { libraryTestCatalog, libraryTestDocument, libraryTestStartInput, LIBRARY_TEST_AGENT, LIBRARY_TEST_TIME } from '../backend/fixtures/library-claims'
import { graphReadNodeActivity } from '../../apps/ui/features/graph/graph-node-activity'

function activityFixture() {
  // 复用真实冻结Run、Operation和expectedWorkId，不在测试重新推导执行或租约。
  const { document, input } = libraryTestDocument()
  runCreateRun(document, libraryTestStartInput(document, input.id, []), {
    definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4, libraryClaimSets: [],
  }, LIBRARY_TEST_TIME)
  const run = document.runs[0], operation = run?.operations[0], group = operation?.stages[0]
  const workId = group?.expectedWorkIds[0]
  if (!run || !operation || !group || !workId) throw new Error('Expected real active work fixture')
  const snapshot: GraphSnapshot = { mapId: document.id, workspaceId: document.workspaceId, revision: document.revision, name: document.name,
    nodes: document.nodes, edges: document.edges, runs: document.runs, ownershipRevision: 0, ownerships: [], runControls: [], updatedAt: document.updatedAt }
  const activity: GraphActivity = { mapId: snapshot.mapId, runId: run.id, operationId: operation.id, nodeId: input.id, workId,
    stageId: group.stageId, slotId: group.planSlots[0]?.id ?? group.stageId, agentName: '保存的智能体', status: 'model', fence: 1, sequence: 1, updatedAt: LIBRARY_TEST_TIME }
  return { snapshot, run, operation, group, input, activity }
}

describe('C21 selected Run node activity projection', () => {
  // 聚合是显示事实，不替Host判断执行资格，不混入其它Run或上下文处理。
  it('shows only the explicitly selected Run and never falls back to another run', () => {
    // 相同输入可出现在多个Run，选择变化后不再被跨Run find的首条覆盖。
    const f = activityFixture(), another = structuredClone(f.run)
    another.id = 'other-run'; another.operations[0].id = 'other-operation'
    const otherActivity = { ...f.activity, runId: another.id, operationId: another.operations[0].id, agentName: '另一运行智能体' }
    f.snapshot.runs.push(another)
    const states = graphReadNodeActivity(f.snapshot, another.id, [f.activity, otherActivity])
    expect(states.get(f.input.id)).toMatchObject({ state: 'running', operationCount: 1, activeWorkCount: 1 })
    expect(states.get(f.input.id)?.label).toContain('另一运行智能体')
    expect(graphReadNodeActivity(f.snapshot, null, [f.activity]).get(f.input.id)).toMatchObject({ state: 'idle', operationCount: 0, activeWorkCount: 0 })
    expect(graphReadNodeActivity(f.snapshot, 'missing-run', [f.activity]).get(f.input.id)?.state).toBe('idle')
  })

  it('rejects mismatched activity identities and already accepted or closed work', () => {
    // 使用保存expectedWorkId和阶段事实，不解析work哈希或复制阶段DAG派发规则。
    const invalid: GraphActivity[] = []
    const f = activityFixture()
    for (const field of ['mapId', 'runId', 'operationId', 'nodeId', 'workId', 'stageId'] as const) invalid.push({ ...f.activity, [field]: `different-${field}` })
    for (const activity of invalid) expect(graphReadNodeActivity(f.snapshot, f.run.id, [activity]).get(f.input.id)?.activeWorkCount).toBe(0)
    f.group.closed = true
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)?.activeWorkCount).toBe(0)
    f.group.closed = false
    f.group.results = [{ mode: 'outputs', workId: f.activity.workId, stageId: f.group.stageId, slotId: f.activity.slotId, acceptedAt: LIBRARY_TEST_TIME, reason: '已接纳结果', outputs: [] }]
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)?.activeWorkCount).toBe(0)
  })

  it('replaces stale execution summaries with saved review pause and terminal states', () => {
    // 审核、暂停、终态收到旧活动也不继续显示模型执行中。
    const f = activityFixture()
    f.operation.status = 'waiting'; f.operation.review = { id: 'review', kind: 'result', state: 'pending', revision: 0, decision: null, createdAt: LIBRARY_TEST_TIME, answeredAt: null }
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)).toMatchObject({ state: 'review', waitingReviewCount: 1, activeWorkCount: 0 })
    f.run.paused = true
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)).toMatchObject({ state: 'paused', waitingReviewCount: 1, activeWorkCount: 0 })
    f.run.paused = false; f.operation.review = null
    for (const status of ['completed', 'failed', 'cancelled', 'skipped'] as const) {
      f.operation.status = status
      const current = graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)
      expect(current?.state).toBe(status); expect(current?.activeWorkCount).toBe(0)
    }
    f.operation.status = 'running'; f.run.status = 'failed'
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)).toMatchObject({ state: 'ended', label: '运行已结束', activeWorkCount: 0 })
  })

  it.each(['failed', 'cancelled', 'completed'] as const)('keeps preserved review audit but reports no current wait after Run %s', (/* 已结束的实际运行状态。 */ status) => {
    // Run结束后残留pending审核只作原审计，不让图标记再报告可审核数量。
    const f = activityFixture()
    f.operation.status = 'waiting'; f.operation.review = { id: 'preserved-review', kind: 'result', state: 'pending', revision: 0,
      decision: null, createdAt: LIBRARY_TEST_TIME, answeredAt: null }
    f.run.status = status
    const before = structuredClone({ run: f.run, node: f.input })
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)).toMatchObject({ state: 'ended', waitingReviewCount: 0, activeWorkCount: 0 })
    expect({ run: f.run, node: f.input }).toEqual(before)
  })

  it('marks all exact inputs of a multi-input Operation without pretending its read-only context is processed', () => {
    // 活动摘要nodeId只是该组首input，组内其它真实input共享处理状态，context不共享。
    const f = activityFixture(), second = { ...structuredClone(f.input), id: 'second-input' }, context = { ...structuredClone(f.input), id: 'context-node' }
    f.snapshot.nodes.push(second, context)
    f.operation.group.inputRefs.push({ ...structuredClone(f.operation.group.inputRefs[0]), key: 'second-key', id: second.id })
    f.operation.group.contextRefs.push({ ...structuredClone(f.operation.group.inputRefs[0]), key: 'context-key', id: context.id, port: 'background' })
    const states = graphReadNodeActivity(f.snapshot, f.run.id, [f.activity])
    expect(states.get(second.id)).toMatchObject({ state: 'running', operationCount: 1, activeWorkCount: 1 })
    expect(states.get(context.id)).toMatchObject({ state: 'idle', operationCount: 0, activeWorkCount: 0 })
    f.input.revision += 1
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)).toMatchObject({ state: 'idle', operationCount: 0 })
  })

  it('keeps stale validity independent of live activity and does not rewrite node types or source data', () => {
    // 活动与陈旧同时存在，类型颜色仍由原typeId决定，投影无写入副作用。
    const f = activityFixture(); f.input.validity = 'stale'
    const before = structuredClone(f)
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)).toMatchObject({ state: 'running', stale: true, activeWorkCount: 1 })
    expect(graphReadNodeActivity(f.snapshot, null, []).get(f.input.id)).toMatchObject({ state: 'idle', stale: true, label: '需要重新处理' })
    expect(f).toEqual(before)
  })

  it('selects the newest generation within one work and aggregates different works without comparing their fences', () => {
    // 同work新fence可从sequence1开始，不同work只计任务数，不让一个大fence覆盖其它执行者。
    const f = activityFixture()
    const old = { ...f.activity, fence: 1, sequence: 999, agentName: '旧授权', status: 'model' as const }
    const current = { ...f.activity, fence: 2, sequence: 1, agentName: '新授权', status: 'tool' as const }
    const latest = { ...current, sequence: 2, status: 'result' as const }
    const states = graphReadNodeActivity(f.snapshot, f.run.id, [latest, old, current])
    expect(states.get(f.input.id)?.activeWorkCount).toBe(1)
    expect(states.get(f.input.id)?.label).toContain('新授权')
    expect(states.get(f.input.id)?.label).toContain('正在处理工具结果')
    f.group.expectedWorkIds.push('parallel-work')
    const parallel = { ...f.activity, workId: 'parallel-work', fence: 1, sequence: 1, agentName: '并行任务', updatedAt: '2026-10-07T00:00:01.000Z' }
    const a = graphReadNodeActivity(f.snapshot, f.run.id, [parallel, latest]), b = graphReadNodeActivity(f.snapshot, f.run.id, [latest, parallel])
    expect(a.get(f.input.id)).toMatchObject({ activeWorkCount: 2, label: '2 个任务处理中' })
    expect(a.get(f.input.id)).toEqual(b.get(f.input.id))
  })

  it('aggregates several real Operations but never counts copied historical review as a current wait', () => {
    // 同节点多处理项不取find首项，历史复用保留记录但不冒充本次批准等待。
    const f = activityFixture()
    const waiting: GraphOperation = { ...structuredClone(f.operation), id: 'waiting-operation', status: 'waiting',
      review: { id: 'pending-review', kind: 'plan', state: 'pending', revision: 0, decision: null, createdAt: LIBRARY_TEST_TIME, answeredAt: null } }
    const reused = { ...structuredClone(waiting), id: 'reused-operation', status: 'completed' as const, reusedFromOperationId: 'historical-operation' }
    f.run.operations.push(waiting, reused)
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)).toMatchObject({ state: 'review', operationCount: 3, waitingReviewCount: 1 })
    waiting.status = 'failed'
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)?.state).toBe('failed')
  })

  it('drops transient agent text on empty activity or Map switches while retaining saved running state', () => {
    // 断流不伪称失败，切图旧活动不能借同节点ID留在新Map。
    const f = activityFixture()
    expect(graphReadNodeActivity(f.snapshot, f.run.id, []).get(f.input.id)).toMatchObject({ state: 'running', label: '处理中（无实时活动）', activeWorkCount: 0 })
    f.snapshot.mapId = 'another-map'
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).get(f.input.id)?.activeWorkCount).toBe(0)
    f.snapshot.nodes = []
    expect(graphReadNodeActivity(f.snapshot, f.run.id, [f.activity]).size).toBe(0)
  })
})
