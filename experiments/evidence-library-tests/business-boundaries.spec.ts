// 补充证据库业务边界；不测试数据库引擎、Host 租约或崩溃恢复。
import { randomUUID } from 'node:crypto'
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'
import { applicability, collectInput, immutableFields, libraryRef } from './fixtures'
import { createTestEnvironment, type TestEnvironment } from './load-target'
import type { Applicability, Confidence, Entry, EvidenceTestTarget, ScopeField } from './test-contract'

const TEXT = '澄川本次公交试点包含 12 条线路。'
let environment: TestEnvironment | undefined
let target: EvidenceTestTarget

beforeEach(async () => {
  // 每条业务用例使用未来真实目标的独立环境，不创建模拟业务状态。
  environment = await createTestEnvironment()
  target = environment.target
})

afterEach(async () => {
  // 所有结果均释放本次资源；不把清理异常当成业务成功。
  const current = environment
  environment = undefined
  if (current) await current.dispose()
})

async function entryFixture(
  /* 明确的收录判断。 */ confidence: Confidence,
  /* 本条来源原文。 */ text = TEXT,
  /* 本条明确的适用范围。 */ scope: Applicability = applicability(),
): Promise<Entry> {
  // 只准备输入并调用收录服务，不计算匹配、摘要或去重结果。
  const claim = await target.fixtures.createNode(target.workspaceId, 'claim', text)
  return (await target.request('editor', 'collect', collectInput(target, claim, confidence, { applicability: scope }))).entry
}

describe('正常匹配与适用性', () => {
  // 匹配提供候选及范围依据，不对新陈述自动收录或修改其判断。
  it.each([0, 1] as const)('相同陈述和范围返回判断 %s 的真实候选', async (
    /* 本次候选的固定判断。 */ confidence,
  ) => {
    const entry = await entryFixture(confidence)
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    const before = await target.inspect.counts(target.workspaceId)
    const candidates = await target.request('viewer', 'match', { workspaceId: target.workspaceId,
      claim: consumer, applicability: entry.applicability, limit: 10 })
    const found = candidates.find(/* 真实候选。 */ candidate => /* 定位已知收录身份。 */ candidate.entry.id === entry.id)
    assert.exists(found)
    expect(found.entry).toMatchObject({ confidence, content: TEXT, contentDigest: entry.contentDigest })
    expect(found.scope).toEqual({ status: 'compatible', differences: [] })
    expect(found.reason.trim()).not.toBe('')
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toMatchObject(immutableFields(entry))
  })

  const differences: Array<{ field: ScopeField; change: Partial<Applicability> }> = [
    { field: 'subject', change: { subject: '其他公交公司' } },
    { field: 'event', change: { event: '另一轮试点' } },
    { field: 'place', change: { place: '另一座城市' } },
    { field: 'time', change: { time: { from: '2027-01-01T00:00:00Z', to: '2027-01-31T23:59:59Z' } } },
    { field: 'conditions', change: { conditions: ['仅非试点线路'] } },
  ]
  it.each(differences)('范围不一致的候选不能标为适用：$field', async (
    /* 显式不同的字段及其输入差异。 */ { field, change },
  ) => {
    // 可排除不适用候选，或保留并标明差异；不能把相关性当成适用性。
    const entry = await entryFixture(1)
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    const candidates = await target.request('viewer', 'match', { workspaceId: target.workspaceId,
      claim: consumer, applicability: applicability(change), limit: 10 })
    const found = candidates.find(/* 实际候选。 */ candidate => /* 检查原条目的范围判定。 */ candidate.entry.id === entry.id)
    if (found) {
      expect(found.scope.status).toBe('different')
      expect(found.scope.differences).toContain(field)
      expect(found.entry.confidence).toBe(1)
    }
  })

  it.each(['subject', 'time', 'place'] as const)('未知 %s 范围保持未知，不默认为普遍适用', async (
    /* 不能自动视为无限制的范围字段。 */ field,
  ) => {
    const scope = applicability()
    Object.assign(scope, { [field]: null })
    const entry = await entryFixture(0, TEXT, scope)
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    const candidates = await target.request('viewer', 'match', { workspaceId: target.workspaceId,
      claim: consumer, applicability: applicability(), limit: 10 })
    const found = candidates.find(/* 同文候选。 */ candidate => /* 检查结构化范围未知。 */ candidate.entry.id === entry.id)
    assert.exists(found)
    expect(found.scope.status).toBe('unknown')
    expect(found.entry.confidence).toBe(0)
    expect(found.reason.trim()).not.toBe('')
  })

  it('查询条件次序变化不修改收录范围或误判为不同条件', async () => {
    // 条件作为同一集合比较；库中原始收录顺序仍保留。
    const scope = applicability({ conditions: ['本次试点', '仅工作日'] })
    const entry = await entryFixture(1, TEXT, scope)
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    const candidates = await target.request('viewer', 'match', { workspaceId: target.workspaceId,
      claim: consumer, applicability: applicability({ conditions: [...scope.conditions].reverse() }), limit: 10 })
    const found = candidates.find(/* 实际候选。 */ candidate => /* 定位其原条目。 */ candidate.entry.id === entry.id)
    assert.exists(found)
    expect(found.scope.status).toBe('compatible')
    expect((await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).applicability).toEqual(scope)
  })
})

describe('陈述内容与输入边界', () => {
  // 业务指纹保留语义，数据库只执行我们选择的键和条件。
  it.each([
    ['试点包含 12 条线路。', '试点包含 120 条线路。'],
    ['本次试点已经启动。', '本次试点没有启动。'],
    ['试点线路全长 12 公里。', '试点线路全长 12 米。'],
    ['工作日有 12 条试点线路。', '周末有 12 条试点线路。'],
  ])('数字、否定、单位或条件不同的原文不能产生相同陈述冲突：%s', async (
    /* 两条语义不同但形式相近的原文。 */ correctText, wrongText,
  ) => {
    const correct = await entryFixture(1, correctText)
    const claim = await target.fixtures.createNode(target.workspaceId, 'claim', wrongText)
    const result = await target.request('editor', 'collect', collectInput(target, claim, 0))
    expect(result.existing).toBe(false)
    expect(result.conflictEntryIds).not.toContain(correct.id)
    expect(result.entry.claim.nodeSnapshot.payload.content).toBe(wrongText)
    expect(result.entry.confidence).toBe(0)
  })

  it.each([false, Infinity, -Infinity, {}, []])('补充非法置信度输入 %s 不创建记录', async (
    /* 必须拒绝的外部值。 */ confidence,
  ) => {
    const claim = await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'collect', collectInput(target, claim, confidence)))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_CONFIDENCE_INVALID' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it.each([
    { from: '不是日期', to: '2026-10-31T23:59:59Z' },
    { from: '2026-11-01T00:00:00Z', to: '2026-10-01T00:00:00Z' },
  ])('收录拒绝无法解释或反向的时间范围 $from', async (
    /* 应在业务输入边界验证的时间范围。 */ time,
  ) => {
    const claim = await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'collect', collectInput(target, claim, 1, { applicability: applicability({ time }) })))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })
})

describe('查询结果与库状态', () => {
  // 检查业务选择的筛选规则，不验证数据库引擎优化算法。
  it('未显式收录的 Claim 不会仅因图中存在而出现在库里', async () => {
    await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    expect((await target.request('viewer', 'search', { workspaceId: target.workspaceId })).items).toEqual([])
    expect((await target.inspect.counts(target.workspaceId)).entries).toBe(0)
  })

  it('空库及零命中搜索返回空页和终止游标', async () => {
    const empty = await target.request('viewer', 'search', { workspaceId: target.workspaceId, limit: 25 })
    expect(empty).toMatchObject({ items: [], nextCursor: null })
    await entryFixture(1)
    const missing = await target.request('viewer', 'search', { workspaceId: target.workspaceId, query: 'zzunmatchedterm' })
    expect(missing).toMatchObject({ items: [], nextCursor: null })
  })

  it('主体和事件筛选不能混入其他适用范围', async () => {
    const selected = await entryFixture(0)
    await entryFixture(1, TEXT, applicability({ subject: '另一主体', event: '另一个事件' }))
    const page = await target.request('viewer', 'search', { workspaceId: target.workspaceId,
      subject: selected.applicability.subject ?? '', event: selected.applicability.event ?? '' })
    expect(page.items.map(/* 实际筛选结果。 */ item => /* 比对身份。 */ item.id)).toEqual([selected.id])
  })

  it.each([0, -1, 1.5])('拒绝无效分页大小 %s 而不回退整库查询', async (
    /* 应在公共入口拒绝的页大小。 */ limit,
  ) => {
    await expect(target.request('viewer', 'search', { workspaceId: target.workspaceId, limit }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_QUERY_LIMIT_INVALID' })
  })

  it('撤回和替代后的条目不进入默认选择，但历史仍按原身份读取', async () => {
    const old = await entryFixture(0), replacement = await entryFixture(1)
    await target.request('editor', 'supersede', { workspaceId: target.workspaceId, entryId: old.id,
      replacementEntryId: replacement.id, expectedRevision: old.revision, reason: '纠正旧依据', requestId: randomUUID() })
    const page = await target.request('viewer', 'search', { workspaceId: target.workspaceId })
    expect(page.items.map(/* 当前可选记录。 */ item => /* 排除被替代条目。 */ item.id)).toEqual([replacement.id])
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: old.id }))
      .toMatchObject({ ...immutableFields(old), status: 'superseded', replacementEntryId: replacement.id })
  })

  it('撤回合法重放只确认第一次管理动作，不增加版本和收据', async () => {
    const entry = await entryFixture(0)
    const input = { workspaceId: target.workspaceId, entryId: entry.id, expectedRevision: entry.revision,
      reason: '暂停后续使用', requestId: randomUUID() }
    const first = await target.request('editor', 'withdraw', input)
    const before = await target.inspect.counts(target.workspaceId)
    expect(await target.request('editor', 'withdraw', input)).toEqual(first)
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
    expect((await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).revision).toBe(first.revision)
  })

  it('同一管理请求身份改变理由被拒绝且不改变原撤回状态', async () => {
    const entry = await entryFixture(1)
    const input = { workspaceId: target.workspaceId, entryId: entry.id, expectedRevision: entry.revision,
      reason: '第一次理由', requestId: randomUUID() }
    const first = await target.request('editor', 'withdraw', input)
    await expect(target.request('editor', 'withdraw', { ...input, reason: '第二次理由' }))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' })
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toMatchObject(first)
  })
})

describe('固定证据集的成员边界', () => {
  // 历史回放允许撤回材料，不意味着可以绕过固定清单成员限制。
  it('历史模式不能使用不在指定快照中的条目', async () => {
    const selected = await entryFixture(0), unselected = await entryFixture(1)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId,
      refs: [libraryRef(selected)], requestId: randomUUID() })
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', '历史回放目标')
    await expect(target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer,
      refs: [libraryRef(unselected)], mode: 'historical', snapshotId: snapshot.id }))
      .rejects.toMatchObject({ status: 403, code: 'EVIDENCE_REFERENCE_UNAUTHORIZED' })
  })

  it('历史模式必须指定真实快照，不能仅靠模式标记绕过撤回', async () => {
    const entry = await entryFixture(0)
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '撤回后不在实时选择', requestId: randomUUID() })
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', '不能伪造快照的目标')
    await expect(target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer,
      refs: [libraryRef(entry)], mode: 'historical' })).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' })
  })

  it('其他 workspace 的快照不能作为本库历史回放依据', async () => {
    const claim = await target.fixtures.createNode(target.otherWorkspaceId, 'claim', TEXT)
    const foreign = (await target.request('owner', 'collect', collectInput(target, claim, 1, { workspaceId: target.otherWorkspaceId }))).entry
    const snapshot = await target.request('owner', 'snapshotCreate', { workspaceId: target.otherWorkspaceId,
      refs: [libraryRef(foreign)], requestId: randomUUID() })
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', TEXT)
    await expect(target.request('owner', 'freeze', { workspaceId: target.workspaceId, target: consumer,
      refs: snapshot.entries, mode: 'historical', snapshotId: snapshot.id }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_WORKSPACE_MISMATCH' })
  })

  it('快照合法重放返回原清单，不重新生成快照身份', async () => {
    const entry = await entryFixture(1)
    const input = { workspaceId: target.workspaceId, refs: [libraryRef(entry)], requestId: randomUUID() }
    const first = await target.request('editor', 'snapshotCreate', input)
    const before = await target.inspect.counts(target.workspaceId)
    expect(await target.request('editor', 'snapshotCreate', input)).toEqual(first)
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })
})

describe('数据包业务内容', () => {
  // 验证库自身的固定内容和引用，不验证数据库恢复或组合图包框架。
  it('导出同时包含 0 和 1，原文不被改成相反表述', async () => {
    const wrong = await entryFixture(0, '已确认错误的原陈述。'), correct = await entryFixture(1, '已确认正确的原陈述。')
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId,
      refs: [libraryRef(wrong), libraryRef(correct)], requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    expect(bundle.entries).toHaveLength(2)
    for (const original of [wrong, correct]) {
      const exported = bundle.entries.find(/* 实际导出条目。 */ item => /* 定位原身份。 */ item.id === original.id)
      assert.exists(exported)
      expect(exported).toMatchObject(immutableFields(original))
    }
  })

  it('导入拒绝被篡改的原文，不只检查摘要字段是否存在', async () => {
    const entry = await entryFixture(0)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId,
      refs: [libraryRef(entry)], requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    const item = bundle.entries[0]
    assert.exists(item)
    item.claim.nodeSnapshot.payload.content = '被篡改后的原文。'
    const before = await target.inspect.counts(target.otherWorkspaceId)
    await expect(target.request('owner', 'import', { workspaceId: target.otherWorkspaceId, bundle, requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_DIGEST_MISMATCH' })
    expect(await target.inspect.counts(target.otherWorkspaceId)).toEqual(before)
  })

  it('仅导出选定清单，不泄露库中未选择的条目', async () => {
    const selected = await entryFixture(1), unselected = await entryFixture(0)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId,
      refs: [libraryRef(selected)], requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    expect(bundle.entries.map(/* 实际导出成员。 */ item => /* 比对固定清单闭包。 */ item.id)).toEqual([selected.id])
    expect(bundle.entries.some(/* 未选择记录。 */ item => /* 不带出无依赖的其他条目。 */ item.id === unselected.id)).toBe(false)
  })
})
