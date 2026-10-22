// 验证运行目录的有界摘要、成员版本和绑定查询的分页游标。
import { describe, expect, it } from 'vitest'
import type { GraphRun, GraphOperation } from '../../../../contracts/graph-run'
import type { GraphDocument } from '../../../../backend/modules/graph/graph-record'
import { graphReadRunPage as readRunPage, graphReadRunPageParams } from '../../../../backend/modules/graph/run-history'
import { runCancelRun } from '../../../../backend/modules/graph/run-state'

const createdAt = '2026-10-20T00:00:00.000Z'

/** 从公开参数解析入口到纯目录计算验证完整只读行为。 */
function graphReadRunPage(
  /* 已构造的当前图记录。 */ source: GraphDocument,
  /* 模拟外部查询的原始参数，包含故意无效的测试输入。 */ params: unknown,
) {
  // 原始类型只在领域边界解析一次，内部只消费可信 GraphQuery 参数。
  return readRunPage(source, graphReadRunPageParams(params))
}

/** 构造只用于目录计数的已保存运行，不执行 Agent 或模型。 */
function savedRun(
  /* 目录内稳定运行身份。 */ id: string,
  /* 相同时间用身份作为稳定次排序键。 */ time = createdAt,
): GraphRun {
  // 目录只读保存结构，因此空定义目录足以覆盖分页而不引入执行夹具。
  return { id, status: 'completed', mode: 'auto', paused: false, regenerate: false,
    scope: { nodeIds: [] }, plan: { steps: [] }, definitions: { revision: 1, packages: [], index: [], dataTypes: [], transitions: [] },
    agents: [], tools: [], steps: [], operations: [], createdAt: time, updatedAt: time }
}

/** 构造带待审核和两个实际产物的 Operation，摘要不得带出冻结正文。 */
function savedOperation(
  /* 保存记录中的普通 Operation 身份，特意不使用 UUID。 */ id: string,
): GraphOperation {
  // 保存最小合法形状；目录只计数，不解析或更改冻结规格。
  const transition = { id: 'fixture.transition', version: 1, title: 'Fixture', cardinality: '1:1' as const,
    ports: { input: [], context: [], output: [] }, group: { mode: 'explicit-members' as const, ready: 'sealed-all-required' as const },
    execution: { stages: [], resultStage: 'result' }, review: { mode: 'required' as const, at: 'result' as const, onReject: 'fail' as const } }
  return { id, stepId: 'first', transitionRef: { id: transition.id, version: 1 }, specHash: 'frozen-hash',
    executionSpec: { transition, dataTypes: [], inputs: {}, context: {}, stages: [], resultStage: 'result',
      review: transition.review, definitionDigests: [], specHash: 'frozen-hash' },
    group: { id: 'group', inputRefs: [], contextRefs: [], sealed: true }, externalInputs: {}, status: 'waiting', stages: [],
    outputRefs: ['one', 'two'].map((/* 一份保存产物身份。 */ key) => /* 正式产物数量来自保存引用。 */
      ({ id: key, revision: 0, port: 'result', workId: 'work', key })),
    review: { id: 'review', kind: 'result', revision: 0, state: 'pending', decision: null, createdAt, answeredAt: null } }
}

/** 建立纯内存记录，保留副作用前后的完整比较对象。 */
function document(
  /* 尚未归档的运行。 */ runs: GraphRun[] = [],
  /* 已归档的运行。 */ history: GraphRun[] = [],
): GraphDocument {
  // 当前与历史记录由调用方明确分配，避免测试靠内部排序准备数据。
  return { id: '00000000-0000-4000-8000-000000000001', workspaceId: 'workspace', revision: 1, name: 'Run directory', nodes: [], edges: [], runs,
    runHistory: history, leases: {}, receipts: [], createdAt, updatedAt: createdAt }
}

/** 取得真实下一页游标，避免在其他场景伪造内部游标格式。 */
function nextCursor(
  /* 提供至少两条匹配运行的记录。 */ source: GraphDocument,
  /* 可选精确 Operation 筛选。 */ operationId?: string,
): string {
  // 继续页必须使用服务返回的游标，而不是测试重写分页实现。
  const page = graphReadRunPage(source, { mapId: source.id, limit: 1, ...(operationId ? { operationId } : {}) })
  if (!page.nextCursor) throw new Error('Fixture next cursor is missing')
  return page.nextCursor
}

describe('bounded Run history directory', () => {
  it('returns an empty bounded page and never mutates the supplied document', () => {
    const source = document(), before = structuredClone(source)
    expect(graphReadRunPage(source, { mapId: source.id })).toEqual({ mapId: source.id, items: [], nextCursor: null,
      directoryVersion: expect.any(String) })
    expect(source).toEqual(before)
  })

  it('uses a default 25 and accepts a maximum 100 without returning full run bodies', () => {
    const source = document(Array.from({ length: 101 }, (/* 未使用的数组值。 */ _, /* 唯一身份序号。 */ index) =>
      /* 同时间身份刻意补零以保持明确的跨页顺序。 */ savedRun(`run-${String(index).padStart(3, '0')}`)))
    const first = graphReadRunPage(source, { mapId: source.id })
    expect(first.items).toHaveLength(25)
    expect(first.nextCursor).toEqual(expect.any(String))
    const maximum = graphReadRunPage(source, { mapId: source.id, limit: 100 })
    expect(maximum.items).toHaveLength(100)
    expect(Object.keys(maximum.items[0]).sort()).toEqual(['runId', 'status', 'archived', 'mode', 'paused', 'createdAt', 'updatedAt',
      'stepCount', 'operationCount', 'pendingReviewCount', 'outputCount'].sort())
  })

  it('sorts newest creation first with stable identity order across equal-time pages', () => {
    const source = document([savedRun('c'), savedRun('a'), savedRun('z', '2026-10-21T00:00:00.000Z')], [savedRun('b')])
    const first = graphReadRunPage(source, { mapId: source.id, limit: 2 })
    expect(first.items.map((/* 当前页摘要。 */ item) => /* 只比较业务身份。 */ item.runId)).toEqual(['z', 'a'])
    const second = graphReadRunPage(source, { mapId: source.id, limit: 2, cursor: first.nextCursor ?? undefined })
    expect(second.items.map((/* 继续页摘要。 */ item) => /* 相同时间使用稳定身份排序。 */ item.runId)).toEqual(['b', 'c'])
    expect(second.nextCursor).toBeNull()
  })

  it('prefers current records over duplicate archived identities and counts saved records', () => {
    const current = savedRun('a'), archivedDuplicate = savedRun('a'), archiveOnly = savedRun('b')
    current.mode = 'human-in-loop'; current.paused = true
    current.operations = [savedOperation('plain-operation')]
    current.operations[0].status = 'completed'
    current.operations[0].review = { id: 'review', kind: 'result', revision: 1, state: 'answered', decision: 'approve', createdAt, answeredAt: createdAt }
    current.plan.steps = [{ id: 'first', transitionRef: { id: 'fixture.transition', version: 1 }, dependsOn: [], input: [], context: [],
      grouping: { mode: 'all' }, onEmpty: 'skip' }]
    current.steps = [{ stepId: 'first', status: 'completed', operationIds: ['plain-operation'] }]
    const source = document([current], [archivedDuplicate, archiveOnly])
    expect(graphReadRunPage(source, { mapId: source.id }).items).toEqual([
      { runId: 'a', status: 'completed', archived: false, mode: 'human-in-loop', paused: true, createdAt, updatedAt: createdAt,
        stepCount: 1, operationCount: 1, pendingReviewCount: 0, outputCount: 2 },
      { runId: 'b', status: 'completed', archived: true, mode: 'auto', paused: false, createdAt, updatedAt: createdAt,
        stepCount: 0, operationCount: 0, pendingReviewCount: 0, outputCount: 0 },
    ])
  })

  it('counts frozen plan steps independently of available execution-state records', () => {
    // 目录合同读取完整计划数量，不把已有执行状态数量当作声明的步骤总数。
    const run = savedRun('planned')
    run.plan.steps = ['first', 'second'].map((/* 计划内的步骤身份。 */ id) =>
      /* 纯保存记录用于区分声明计划与执行状态，不模拟额外运行行为。 */ ({ id,
        transitionRef: { id: 'fixture.transition', version: 1 }, dependsOn: [], input: [], context: [],
        grouping: { mode: 'all' as const }, onEmpty: 'skip' as const }))
    run.steps = [{ stepId: 'first', status: 'completed', operationIds: [] }]
    const source = document([run])
    expect(graphReadRunPage(source, { mapId: source.id }).items[0].stepCount).toBe(2)
  })

  it('does not count a pending Review identity retained by the actual cancellation operation', () => {
    // runCancelRun 保留审核记录但会取消 Operation；终态不再是可回答的待审核。
    const run: GraphRun = { ...savedRun('cancelled'), status: 'waiting', maxAgentSlots: 1,
      branchState: { scope: { rootIds: [], nodeIds: [], edgeIds: [] }, version: 'fixture-version' },
      operations: [{ ...savedOperation('cancel-me'), outputRefs: [] }] }
    const source = document([run])
    expect(graphReadRunPage(source, { mapId: source.id }).items[0].pendingReviewCount).toBe(1)
    runCancelRun(source, run.id, '2026-10-20T01:00:00.000Z')
    expect(run).toMatchObject({ status: 'cancelled', operations: [{ status: 'cancelled', review: { state: 'pending' } }] })
    source.runs = []; source.runHistory = [run]
    expect(graphReadRunPage(source, { mapId: source.id }).items[0]).toMatchObject({ archived: true, pendingReviewCount: 0 })
  })

  it('counts only waiting Operations in active Runs, excluding retained reviews of failed history', () => {
    // 用保存字段验证目录的审核资格，不宣称非等待 Operation 的旧身份可经公开 API 回答。
    const waiting = savedOperation('waiting'), failed = savedOperation('failed')
    failed.status = 'failed'
    const active: GraphRun = { ...savedRun('active'), status: 'running', maxAgentSlots: 1,
      branchState: { scope: { rootIds: [], nodeIds: [], edgeIds: [] }, version: 'fixture-version' },
      operations: [waiting, failed] }
    const terminal: GraphRun = { ...savedRun('failed-history'), status: 'failed', operations: [structuredClone(waiting), failed] }
    const source = document([active], [terminal])
    expect(graphReadRunPage(source, { mapId: source.id }).items.map((/* 两份保存运行的目录摘要。 */ item) =>
      /* active 的 waiting 计一项，终态即使保留 pending 身份也为零。 */ [item.runId, item.pendingReviewCount]))
      .toEqual([['active', 1], ['failed-history', 0]])
  })

  it('filters exact operation identities after current-priority deduplication', () => {
    const a = savedRun('a'), b = savedRun('b'), duplicate = savedRun('a')
    a.operations = [savedOperation('operation-1')]; b.operations = [savedOperation('operation-10')]
    duplicate.operations = [savedOperation('archive-only')]
    const source = document([a], [duplicate, b])
    expect(graphReadRunPage(source, { mapId: source.id, operationId: 'operation-1' }).items.map(
      (/* 精确筛选摘要。 */ item) => /* 前缀不能误命中。 */ item.runId)).toEqual(['a'])
    expect(graphReadRunPage(source, { mapId: source.id, operationId: 'archive-only' }).items).toEqual([])
    expect(graphReadRunPage(source, { mapId: source.id, operationId: 'missing' }).items).toEqual([])
  })

  it('keeps a cursor valid through status updates and current-to-history movement', () => {
    const source = document([savedRun('a'), savedRun('b')]), cursor = nextCursor(source)
    const first = source.runs.shift()
    if (!first) throw new Error('Fixture current run is missing')
    first.status = 'cancelled'; first.updatedAt = '2026-10-22T00:00:00.000Z'; source.runHistory.push(first)
    expect(graphReadRunPage(source, { mapId: source.id, limit: 1, cursor }).items[0].runId).toBe('b')
  })

  it('expires a valid cursor when matching members are added or removed', () => {
    const source = document([savedRun('a'), savedRun('b')]), cursor = nextCursor(source)
    source.runs.push(savedRun('c'))
    expect(() => graphReadRunPage(source, { mapId: source.id, limit: 1, cursor }))
      .toThrow(expect.objectContaining({ status: 409, code: 'RUN_CURSOR_EXPIRED' }))
    source.runs = [savedRun('a')]
    expect(() => graphReadRunPage(source, { mapId: source.id, limit: 1, cursor }))
      .toThrow(expect.objectContaining({ status: 409, code: 'RUN_CURSOR_EXPIRED' }))
  })

  it('ignores changes outside an exact operation-filtered directory', () => {
    const a = savedRun('a'), b = savedRun('b')
    a.operations = [savedOperation('shared-operation')]; b.operations = [savedOperation('shared-operation')]
    const source = document([a, b]), cursor = nextCursor(source, 'shared-operation')
    source.runs.push(savedRun('outside-filter'))
    expect(graphReadRunPage(source, { mapId: source.id, operationId: 'shared-operation', limit: 1, cursor }).items[0].runId).toBe('b')
  })

  it('rejects malformed, oversized and cross-query cursors as invalid rather than expired', () => {
    const source = document([savedRun('a'), savedRun('b')]), cursor = nextCursor(source)
    for (const invalid of ['', '*', 'a'.repeat(1025), Buffer.from('{}').toString('base64url')]) {
      expect(() => graphReadRunPage(source, { mapId: source.id, limit: 1, cursor: invalid }))
        .toThrow(expect.objectContaining({ status: 400, code: 'INVALID_CURSOR' }))
    }
    for (const params of [{ mapId: '00000000-0000-4000-8000-000000000002', limit: 1 }, { mapId: source.id, limit: 2 },
      { mapId: source.id, limit: 1, operationId: 'another-operation' }]) {
      expect(() => graphReadRunPage(source, { ...params, cursor }))
        .toThrow(expect.objectContaining({ status: 400, code: 'INVALID_CURSOR' }))
    }
  })

  it('rejects non-integral and out-of-bounds page sizes with an argument error', () => {
    const source = document()
    for (const limit of [0, -1, 1.5, 101, NaN, Infinity]) {
      expect(() => graphReadRunPage(source, { mapId: source.id, limit }))
        .toThrow(expect.objectContaining({ status: 400, code: 'INVALID_ARGUMENT' }))
    }
  })
})
