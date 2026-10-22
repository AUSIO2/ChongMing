// 仅通过未来真实实现的接入口验证证据库规则；不提供业务参考实现，也不自动跳过缺失目标。
import { randomUUID } from 'node:crypto'

import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest'

import { applicability, collectInput, immutableFields, libraryRef } from './fixtures'
import { createTestEnvironment, type TestEnvironment } from './load-target'
import type { ClaimRef, CollectInput, CollectResult, Confidence, Entry, EvidenceTestTarget } from './test-contract'

const CLAIM_TEXT = '澄川本次公交试点包含 12 条线路。'
let environment: TestEnvironment | undefined
let target: EvidenceTestTarget

beforeEach(async () => {
  // 每条用例独占一个真实隔离环境；缺少目标工厂时由加载器直接报错。
  environment = await createTestEnvironment()
  target = environment.target
})

afterEach(async () => {
  // 用例成功或失败后都关闭其真实目标，并清理加载器创建的临时目录。
  const current = environment
  environment = undefined
  if (current) await current.dispose()
})

async function createClaim(
  /* 本条测试写入来源图的原文。 */ content = CLAIM_TEXT,
  /* 原 Claim 所属的隔离工作区，省略时使用主工作区。 */ workspaceId = target.workspaceId,
): Promise<ClaimRef> {
  // 经真实图接口准备 Claim，不在夹具中构造收录结果。
  return target.fixtures.createNode(workspaceId, 'claim', content)
}

async function collectFixture(
  /* 本条测试明确选择的固定判断。 */ confidence: Confidence,
  /* 收录输入的显式差异。 */ changes: Partial<CollectInput> = {},
): Promise<{ origin: ClaimRef; input: CollectInput; result: CollectResult; entry: Entry }> {
  // 创建来源 Claim 并调用真实收录动作，返回后续用例需要的输入和真实结果。
  const origin = await createClaim()
  const input = collectInput(target, origin, confidence, changes)
  const result = await target.request('editor', 'collect', input)
  return { origin, input, result, entry: result.entry }
}

describe('固定判断与收录快照', () => {
  // 验证 0/1 的严格含义、原文保留、来源版本及固定材料的持久化边界。
  it.each([0, 1] as const)('收录数字 %s 时保留同一陈述原文及原 Claim 身份', async (
    /* 本次明确收录为完全错误或完全正确的判断。 */ confidence,
  ) => {
    // 0 不改写成否定句，1 也不替换原陈述，二者都绑定原始版本和精确定义。
    const { origin, entry, result } = await collectFixture(confidence)
    expect(entry.confidence).toBe(confidence)
    expect(entry.claim.origin).toEqual(origin)
    expect(entry.claim.nodeSnapshot).toMatchObject({ id: origin.nodeId, revision: origin.revision,
      typeId: 'factcheck.claim', payload: { content: CLAIM_TEXT } })
    expect(entry.claim.type).toEqual({ id: entry.claim.nodeSnapshot.typeId, version: entry.claim.nodeSnapshot.typeVersion })
    expect(entry.claim.definitionDigest).not.toBe('')
    expect(entry.contentDigest).not.toBe('')
    expect(entry.collectedBy).not.toBe('')
    expect(Number.isFinite(Date.parse(entry.collectedAt))).toBe(true)
    expect(result).toMatchObject({ existing: false, replayed: false, conflictEntryIds: [] })
  })

  it.each([0.5, -1, 2, null, undefined, '0', '1', true, Number.NaN])('拒绝非数字 0/1 输入 %s 且不发布收录或收据', async (
    /* 故意不符合固定判断约定的外部置信度值。 */ confidence,
  ) => {
    // 不接受中间置信度、字符串或默认值，也不为拒绝的请求留下部分记录。
    const origin = await createClaim(), before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'collect', collectInput(target, origin, confidence)))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_CONFIDENCE_INVALID' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('拒绝空收录理由且不发布部分状态', async () => {
    // 只有 0/1 不足以解释收录判断，空理由必须在业务入口被拒绝。
    const origin = await createClaim(), before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'collect', collectInput(target, origin, 1, { reason: '   ' })))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_REASON_REQUIRED' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('允许用明确人工理由收录没有上游或核查引用的独立陈述', async () => {
    // 依据可由明确人工说明表达，不强迫每条记录具备图上游或核查下游。
    const origin = await createClaim()
    const input = collectInput(target, origin, 0, { basisRefs: [], reason: '人工对照隔离档案，确认此陈述完全错误。' })
    const result = await target.request('editor', 'collect', input)
    expect(result.entry).toMatchObject({ confidence: 0, decision: { reason: input.reason, basisRefs: [] } })
  })

  it.each(['news', 'source'] as const)('拒绝将 %s 材料伪装为库内 Claim', async (
    /* 内容可能相同但不属于 Claim 的原节点类型。 */ type,
  ) => {
    // 只有 Claim 可收录，原文和材料继续由 News/Source 承载。
    const origin = await target.fixtures.createNode(target.workspaceId, type, CLAIM_TEXT)
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'collect', collectInput(target, origin, 1)))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_CLAIM_TYPE_INVALID' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('新请求引用过期来源版本时原子拒绝', async () => {
    // 来源更新后不能把新原文误记为旧 Claim 版本的收录快照。
    const origin = await createClaim()
    await target.fixtures.updateClaim(origin, '澄川本次试点改为 15 条线路。')
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'collect', collectInput(target, origin, 1)))
      .rejects.toMatchObject({ status: 409, code: 'EVIDENCE_SOURCE_VERSION_CONFLICT' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('来源原文更新后库内原文、范围、依据和判断均不变化', async () => {
    // 已收录内容固定于当时版本；来源当前值不回写收录条目。
    const { origin, entry } = await collectFixture(0)
    await target.fixtures.updateClaim(origin, '澄川本次公交试点包含 15 条线路。')
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toMatchObject(immutableFields(entry))
  })

  it('原 Claim 删除后仍能读取其已收录快照', async () => {
    // 库内容不依赖来源节点继续存在，删除来源不能丢失历史原文或固定判断。
    const { origin, entry } = await collectFixture(0)
    await target.fixtures.deleteClaim(origin)
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toMatchObject(immutableFields(entry))
  })

  it('整张来源图删除后仍保留收录时的正文、判断和出处身份', async () => {
    // 收录快照独立于原 Map 的生命周期，图删除不级联删除固定内容。
    const { origin, entry } = await collectFixture(0)
    await target.fixtures.deleteMap(origin.mapId)
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toMatchObject(immutableFields(entry))
  })

  it('调用方改写请求和结果对象不能改变持久化的固定内容', async () => {
    // 检查 API 所有权边界，避免请求或返回快照与存储共享可变对象。
    const { input, entry } = await collectFixture(1), fixed = immutableFields(entry)
    input.applicability.conditions.push('收录后的额外条件')
    input.reason = '收录后改写的理由'
    input.basisRefs.splice(0, input.basisRefs.length)
    entry.claim.nodeSnapshot.payload.content = '调用方改写返回的原文'
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toMatchObject(fixed)
  })

  it('冻结的附件依据在条目撤回后仍受到删除保护', async () => {
    // 撤回只影响新选择，历史固定材料仍参与真实资产删除保护。
    const asset = await target.fixtures.createAsset(target.workspaceId, '公交试点档案：12 条线路。')
    const { entry } = await collectFixture(1, { basisRefs: [{ kind: 'asset', assetId: asset.id, sha256: asset.sha256 }] })
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '暂停新选择', requestId: randomUUID() })
    await expect(target.fixtures.deleteAsset(asset.id)).rejects.toMatchObject({ status: 409, code: 'ASSET_REFERENCED' })
    const saved = await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })
    expect(saved.decision.basisRefs).toEqual([{ kind: 'asset', assetId: asset.id, sha256: asset.sha256 }])
  })
})

describe('合法重放、重复收录与冲突', () => {
  // 验证授权后的重放顺序、含依据的去重键及不同固定判断的独立保存。
  it('来源编辑后合法重放仍返回原收录结果', async () => {
    // 已接受收据先于新请求的来源版本校验，防止成功操作在重试时变成版本错误。
    const { origin, input, result } = await collectFixture(1)
    await target.fixtures.updateClaim(origin, '来源编辑后的不同原文')
    const before = await target.inspect.counts(target.workspaceId)
    expect(await target.request('editor', 'collect', input)).toEqual({ ...result, replayed: true })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('来源删除后合法重放仍返回原收录结果', async () => {
    // 原节点不存在也不能推翻此前已经接受的幂等请求。
    const { origin, input, result } = await collectFixture(0)
    await target.fixtures.deleteClaim(origin)
    const before = await target.inspect.counts(target.workspaceId)
    expect(await target.request('editor', 'collect', input)).toEqual({ ...result, replayed: true })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('条目撤回后收录重放保留原收据且不重新激活条目', async () => {
    // 重放确认原操作；当前条目管理状态仍由后续撤回决定。
    const { input, result, entry } = await collectFixture(1)
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '发现需要重新核查', requestId: randomUUID() })
    expect(await target.request('editor', 'collect', input)).toEqual({ ...result, replayed: true })
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toMatchObject({ status: 'withdrawn' })
  })

  it('同一请求身份改变判断时拒绝幂等冲突且不增加条目', async () => {
    // 改变输入属于新的收录意图，不能沿用原 requestId。
    const { input } = await collectFixture(1), before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'collect', { ...input, confidence: 0 }))
      .rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('精确重复收录以新请求返回同一条目', async () => {
    // 相同原 Claim 版本、范围、判断和依据只建立一个收录身份。
    const { input, entry } = await collectFixture(1)
    const duplicate = await target.request('editor', 'collect', { ...input, requestId: randomUUID() })
    expect(duplicate).toMatchObject({ existing: true, replayed: false, entry: { id: entry.id } })
    expect((await target.inspect.counts(target.workspaceId)).entries).toBe(1)
  })

  it('精确重复已撤回条目不会将其重新激活', async () => {
    // 新请求的重复检测保留撤回事实，恢复使用需要明确的新收录或管理决定。
    const { input, entry } = await collectFixture(1)
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '撤回本次依据', requestId: randomUUID() })
    const duplicate = await target.request('editor', 'collect', { ...input, requestId: randomUUID() })
    expect(duplicate).toMatchObject({ existing: true, entry: { id: entry.id, status: 'withdrawn' } })
    expect((await target.request('viewer', 'search', { workspaceId: target.workspaceId })).items).toEqual([])
  })

  it('相同原 Claim 和判断使用不同依据时建立独立条目', async () => {
    // 依据摘要参与去重；新的判定材料不能被原条目的身份吞并。
    const { input, entry } = await collectFixture(1)
    const independent = await target.request('editor', 'collect', { ...input, requestId: randomUUID(),
      basisRefs: [{ kind: 'manual', text: '独立的第二份公交试点档案。' }] })
    expect(independent.existing).toBe(false)
    expect(independent.entry.id).not.toBe(entry.id)
    expect(independent.entry.decision.basisRefs).not.toEqual(entry.decision.basisRefs)
    expect((await target.inspect.counts(target.workspaceId)).entries).toBe(2)
  })

  it('已知范围与未知范围不合并成同一条目', async () => {
    // 未知时间不解释为永久有效，也不等同于明确时间范围。
    const { input, entry } = await collectFixture(1)
    const different = await target.request('editor', 'collect', { ...input, requestId: randomUUID(), applicability: applicability({ time: null }) })
    expect(different.existing).toBe(false)
    expect(different.entry.id).not.toBe(entry.id)
    expect(different.entry.applicability.time).toBeNull()
  })

  it('相反的 0/1 判断返回冲突并保留双方原文', async () => {
    // 冲突提示不自动覆盖判断、不改写错误陈述，也不替用户撤回任何一方。
    const { input, entry } = await collectFixture(1)
    const contrary = await target.request('editor', 'collect', { ...input, requestId: randomUUID(), confidence: 0 })
    expect(contrary.conflictEntryIds).toContain(entry.id)
    expect(contrary.entry).toMatchObject({ confidence: 0, status: 'active', claim: { nodeSnapshot: { payload: { content: CLAIM_TEXT } } } })
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toEqual(entry)
    expect((await target.inspect.counts(target.workspaceId)).entries).toBe(2)
  })

  it('相同陈述来自不同原 Claim 时保留各自出处', async () => {
    // 内容匹配不能静默丢弃不同来源身份。
    const first = await collectFixture(1), secondOrigin = await createClaim()
    const second = await target.request('editor', 'collect', collectInput(target, secondOrigin, 1))
    expect(second.entry.id).not.toBe(first.entry.id)
    expect(second.entry.claim.origin).toEqual(secondOrigin)
    expect(first.entry.claim.origin).not.toEqual(second.entry.claim.origin)
    expect((await target.inspect.counts(target.workspaceId)).entries).toBe(2)
  })

  it('[适配器集成] 业务去重键并发只提交一个条目', async () => {
    // 真实存储唯一约束处理并发，不靠顺序夹具预先计算去重结果。
    const origin = await createClaim()
    const inputs = Array.from({ length: 8 }, () => /* 为同一来源生成八个独立幂等身份。 */ collectInput(target, origin, 1))
    const results = await Promise.all(inputs.map(
      /* 并发收录的一个完整外部输入。 */ input => /* 发起真实收录请求以争用同一个精确重复键。 */ target.request('editor', 'collect', input),
    ))
    expect(new Set(results.map(/* 真实并发结果。 */ result => /* 只比较实际返回的收录身份。 */ result.entry.id)).size).toBe(1)
    expect(await target.inspect.counts(target.workspaceId)).toMatchObject({ entries: 1, receipts: inputs.length })
    for (const [index, input] of inputs.entries()) {
      expect(await target.request('editor', 'collect', input)).toEqual({ ...results[index], replayed: true })
    }
  })

  it('不同 Map 中相同 nodeId 不被误判为同一来源', async () => {
    // 原 Claim 身份包含 mapId，不能仅凭节点文本 ID 做精确去重。
    const nodeId = randomUUID()
    const first = await target.fixtures.createNode(target.workspaceId, 'claim', CLAIM_TEXT, { nodeId })
    const second = await target.fixtures.createNode(target.workspaceId, 'claim', CLAIM_TEXT, { nodeId })
    expect(first.nodeId).toBe(nodeId)
    expect(second.nodeId).toBe(nodeId)
    expect(first.mapId).not.toBe(second.mapId)
    const left = await target.request('editor', 'collect', collectInput(target, first, 1))
    const right = await target.request('editor', 'collect', collectInput(target, second, 1))
    expect(right.entry.id).not.toBe(left.entry.id)
    expect(right.entry.claim.origin).toEqual(second)
    expect((await target.inspect.counts(target.workspaceId)).entries).toBe(2)
  })
})

describe('状态、权限与 workspace 隔离', () => {
  // 管理状态可以推进版本，固定内容与收录判断不提供覆盖更新。
  it.each(['confidence', 'claim', 'applicability', 'decision', 'collectedBy', 'collectedAt', 'contentDigest'])('管理命令拒绝覆盖固定字段 %s', async (
    /* 被明确禁止更新的固定内容字段。 */ field,
  ) => {
    // 即使管理版本正确，夹带固定字段也必须在真实输入边界原子拒绝。
    const { entry } = await collectFixture(1), before = await target.inspect.counts(target.workspaceId)
    const input = { workspaceId: target.workspaceId, entryId: entry.id, expectedRevision: entry.revision,
      reason: '非法夹带内容更新', requestId: randomUUID() }
    Object.assign(input, { [field]: field === 'confidence' ? 0 : null })
    await expect(target.request('editor', 'withdraw', input)).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' })
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id }))
      .toMatchObject({ ...immutableFields(entry), status: 'active', revision: entry.revision })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('撤回保存固定内容并从默认搜索和匹配中排除', async () => {
    // 撤回条目仍可按身份查询，但默认实时候选不再包含它。
    const { origin, entry } = await collectFixture(0)
    const withdrawn = await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '待复核', requestId: randomUUID() })
    expect(withdrawn).toMatchObject({ status: 'withdrawn', statusReason: '待复核', confidence: 0, claim: entry.claim,
      decision: entry.decision, applicability: entry.applicability, contentDigest: entry.contentDigest })
    expect(withdrawn.revision).toBeGreaterThan(entry.revision)
    expect((await target.request('viewer', 'search', { workspaceId: target.workspaceId })).items).toEqual([])
    expect((await target.request('viewer', 'search', { workspaceId: target.workspaceId, includeInactive: true })).items.map(
      /* 显式包含非活跃记录的搜索摘要。 */ item => /* 验证历史管理查询仍能定位撤回身份。 */ item.id,
    )).toEqual([entry.id])
    expect(await target.request('viewer', 'match', { workspaceId: target.workspaceId, claim: origin, applicability: entry.applicability, limit: 10 })).toEqual([])
  })

  it('撤回的错误预期版本被拒绝且条目保持原状态', async () => {
    // 管理写入必须使用当前 revision，不能覆盖并发管理结果。
    const { entry } = await collectFixture(1), before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision + 1, reason: '错误预期版本', requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 409, code: 'EVIDENCE_REVISION_CONFLICT' })
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toEqual(entry)
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('替代只改变旧条目的状态和关系，不覆盖旧原文及判断', async () => {
    // 纠正误收录通过新的收录身份完成，旧条目继续解释历史判断。
    const old = await collectFixture(0), replacement = await collectFixture(1)
    const superseded = await target.request('editor', 'supersede', { workspaceId: target.workspaceId, entryId: old.entry.id,
      replacementEntryId: replacement.entry.id, expectedRevision: old.entry.revision, reason: '新档案纠正原收录', requestId: randomUUID() })
    expect(superseded).toMatchObject({ status: 'superseded', replacementEntryId: replacement.entry.id, confidence: 0,
      claim: old.entry.claim, decision: old.entry.decision, contentDigest: old.entry.contentDigest })
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: replacement.entry.id })).toEqual(replacement.entry)
  })

  it('拒绝条目自替代且不建立替代关系', async () => {
    // 同一身份不能把自身作为纠正记录。
    const { entry } = await collectFixture(1), before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'supersede', { workspaceId: target.workspaceId, entryId: entry.id,
      replacementEntryId: entry.id, expectedRevision: entry.revision, reason: '自替代', requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_REPLACEMENT_INVALID' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toEqual(entry)
  })

  it('拒绝替代链循环并保留先前已提交关系', async () => {
    // 两条记录不能通过连续替代产生回到原身份的环。
    const first = await collectFixture(0), second = await collectFixture(1)
    const firstState = await target.request('editor', 'supersede', { workspaceId: target.workspaceId, entryId: first.entry.id,
      replacementEntryId: second.entry.id, expectedRevision: first.entry.revision, reason: '第二条替代第一条', requestId: randomUUID() })
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'supersede', { workspaceId: target.workspaceId, entryId: second.entry.id,
      replacementEntryId: first.entry.id, expectedRevision: second.entry.revision, reason: '形成环', requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_REPLACEMENT_CYCLE' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: first.entry.id })).toEqual(firstState)
  })

  it('拒绝跨 workspace 替代', async () => {
    // 即使调用方可访问两个工作区，替代关系也必须属于同一个库空间。
    const local = await collectFixture(0), foreignOrigin = await createClaim(CLAIM_TEXT, target.otherWorkspaceId)
    const foreign = await target.request('owner', 'collect', collectInput(target, foreignOrigin, 1, { workspaceId: target.otherWorkspaceId }))
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'supersede', { workspaceId: target.workspaceId, entryId: local.entry.id,
      replacementEntryId: foreign.entry.id, expectedRevision: local.entry.revision, reason: '跨库替代', requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_WORKSPACE_MISMATCH' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('viewer 可以读取但不能收录或撤回', async () => {
    // 测试角色映射到真实身份授权，读权限不包含管理写权限。
    const { entry, input } = await collectFixture(1)
    expect(await target.request('viewer', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).toEqual(entry)
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('viewer', 'collect', { ...input, requestId: randomUUID() })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    await expect(target.request('viewer', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '越权撤回', requestId: randomUUID() })).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('非成员知道条目身份也不能读取或搜索库', async () => {
    // 返回授权失败，而不是凭已知条目 ID 绕过 workspace 成员检查。
    const { entry } = await collectFixture(1)
    await expect(target.request('outsider', 'get', { workspaceId: target.workspaceId, entryId: entry.id })).rejects.toMatchObject({ status: 404, code: 'WORKSPACE_NOT_FOUND' })
    await expect(target.request('outsider', 'search', { workspaceId: target.workspaceId })).rejects.toMatchObject({ status: 404, code: 'WORKSPACE_NOT_FOUND' })
  })

  it('来源 Claim 必须属于收录目标 workspace', async () => {
    // 已授权目标库也不能将其他工作区来源身份混入本库。
    const foreign = await createClaim(CLAIM_TEXT, target.otherWorkspaceId), before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('owner', 'collect', collectInput(target, foreign, 1)))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_WORKSPACE_MISMATCH' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('撤权后合法收录重放仍须先通过当前身份授权', async () => {
    // 幂等收据不能让已被撤权的身份继续访问此前的私有收录结果。
    const { input } = await collectFixture(1)
    await target.fixtures.revoke('editor')
    await expect(target.request('editor', 'collect', input)).rejects.toMatchObject({ status: 404, code: 'WORKSPACE_NOT_FOUND' })
  })
})

describe('Work 获权材料、上下游与历史使用', () => {
  // 工作读取的是明确选定的固定集合，库读取不能扩展目标图的结构写范围。
  it('冻结所选库条目并保持目标分支范围独立', async () => {
    // 外部陈述作为只读依据，不把原来源节点纳入目标图 successor 分支。
    const { entry, origin } = await collectFixture(0), consumer = await createClaim('本次试点是否有 15 条线路？')
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [libraryRef(entry)], mode: 'live' })
    expect(work.entries).toEqual([entry])
    expect(work.target).toEqual(consumer)
    expect(work.mapId).toBe(consumer.mapId)
    expect(work.scopeNodeIds).toContain(consumer.nodeId)
    expect(work.scopeNodeIds).not.toContain(origin.nodeId)
    expect(work.specHash).not.toBe('')
    expect(await target.request('viewer', 'readFrozen', { workspaceId: target.workspaceId, workId: work.workId })).toEqual(work)
  })

  it('已撤回条目不能进入新的实时 Work', async () => {
    // 实时选择按当前状态校验，历史读取权限不自动转化为新选择权限。
    const { entry } = await collectFixture(1), consumer = await createClaim('新的待核查陈述')
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '停止实时选择', requestId: randomUUID() })
    await expect(target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [libraryRef(entry)], mode: 'live' }))
      .rejects.toMatchObject({ status: 409, code: 'EVIDENCE_INACTIVE' })
  })

  it('消费 Map 中同名 nodeId 不会替换库内来源版本', async () => {
    // 显式库引用解析原 Map 的冻结内容，不能误用消费 Map 的同名节点。
    const nodeId = randomUUID()
    const origin = await target.fixtures.createNode(target.workspaceId, 'claim', CLAIM_TEXT, { nodeId })
    const result = await target.request('editor', 'collect', collectInput(target, origin, 0))
    const consumer = await target.fixtures.createNode(target.workspaceId, 'claim', '同名但内容不同的待核查陈述。', { nodeId })
    expect(consumer.mapId).not.toBe(origin.mapId)
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId,
      target: consumer, refs: [libraryRef(result.entry)], mode: 'live' })
    expect(work.mapId).toBe(consumer.mapId)
    expect(work.entries).toHaveLength(1)
    expect(work.entries[0]?.claim.origin).toEqual(origin)
    expect(work.entries[0]?.claim.nodeSnapshot.payload.content).toBe(CLAIM_TEXT)
    expect(work.entries[0]?.confidence).toBe(0)
    expect(work.scopeNodeIds).toEqual([consumer.nodeId])
  })

  it('冻结之后撤回仍允许读取原材料并正式发布获权引用', async () => {
    // 发布验证固定集合和当前执行权限，不把后来撤回误当成材料失效。
    const { entry } = await collectFixture(0), consumer = await createClaim('核查另一条陈述')
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [libraryRef(entry)], mode: 'live' })
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '冻结后撤回', requestId: randomUUID() })
    expect(await target.request('viewer', 'readFrozen', { workspaceId: target.workspaceId, workId: work.workId })).toEqual(work)
    const published = await target.request('editor', 'submitUse', { workspaceId: target.workspaceId, workId: work.workId,
      refs: [libraryRef(entry)], reason: '用固定错误陈述作为反驳依据', requestId: randomUUID() })
    expect(published.usages).toHaveLength(1)
    expect(published.usages[0]).toMatchObject({ entryId: entry.id, workId: work.workId, current: true })
  })

  it('拒绝提交未进入 Work 获权集合的条目', async () => {
    // 同工作区中可读取的其他条目不等于本 Work 获权引用。
    const selected = await collectFixture(1), unselected = await collectFixture(0), consumer = await createClaim('另一待核查陈述')
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [libraryRef(selected.entry)], mode: 'live' })
    const before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'submitUse', { workspaceId: target.workspaceId, workId: work.workId,
      refs: [libraryRef(unselected.entry)], reason: '未获权条目', requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 403, code: 'EVIDENCE_REFERENCE_UNAUTHORIZED' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('冻结时摘要不匹配必须拒绝', async () => {
    // 相同条目身份不能掩盖外部提供的错误固定内容摘要。
    const { entry } = await collectFixture(1), consumer = await createClaim('验证错误摘要')
    await expect(target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer,
      refs: [{ entryId: entry.id, contentDigest: 'tampered-digest' }], mode: 'live' }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_DIGEST_MISMATCH' })
  })

  it('独立核查按各自选定材料冻结，不共享另一份集合', async () => {
    // 只检查库输入绑定；不同 Map 避免引入同分支多 Run 的通用授权争用。
    const first = await collectFixture(0), second = await collectFixture(1)
    const left = await createClaim('第一个独立核查目标'), right = await createClaim('第二个独立核查目标')
    const firstWork = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: left, refs: [libraryRef(first.entry)], mode: 'live' })
    const secondWork = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: right, refs: [libraryRef(second.entry)], mode: 'live' })
    expect(firstWork.entries.map(/* 第一份实际材料。 */ libraryRef)).toEqual([libraryRef(first.entry)])
    expect(secondWork.entries.map(/* 第二份实际材料。 */ libraryRef)).toEqual([libraryRef(second.entry)])
    expect(firstWork.entries[0]?.confidence).toBe(0)
    expect(secondWork.entries[0]?.confidence).toBe(1)
  })

  it('已接受 Work 提交重放不会重复登记使用关系', async () => {
    // 使用索引和正式产物的幂等结果一起提交，合法重放只返回原使用身份。
    const { entry } = await collectFixture(1), consumer = await createClaim('验证引用重放')
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [libraryRef(entry)], mode: 'live' })
    const input = { workspaceId: target.workspaceId, workId: work.workId, refs: [libraryRef(entry)], reason: '已有档案支持', requestId: randomUUID() }
    const first = await target.request('editor', 'submitUse', input), before = await target.inspect.counts(target.workspaceId)
    expect(await target.request('editor', 'submitUse', input)).toEqual({ ...first, replayed: true })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
    const relations = await target.request('viewer', 'relations', { workspaceId: target.workspaceId, entryId: entry.id, direction: 'downstream', depth: 1, limit: 25 })
    expect(relations.items.filter(/* 真实返回的一条关系。 */ relation => /* 只统计本条目被核查使用的关系。 */ relation.kind === 'usage')).toHaveLength(1)
  })

  it('移除当前使用关系后仍保留历史使用记录', async () => {
    // 结束当前意见引用不删除此前节点版本如何使用该证据的记录。
    const { entry } = await collectFixture(1), consumer = await createClaim('验证结束当前引用')
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [libraryRef(entry)], mode: 'live' })
    const published = await target.request('editor', 'submitUse', { workspaceId: target.workspaceId, workId: work.workId,
      refs: [libraryRef(entry)], reason: '先建立引用', requestId: randomUUID() })
    const usage = published.usages[0]
    assert.exists(usage, '真实发布必须建立使用记录')
    expect(await target.request('editor', 'endUse', { workspaceId: target.workspaceId, usageId: usage.id, requestId: randomUUID() }))
      .toMatchObject({ id: usage.id, entryId: entry.id, current: false })
    const relations = await target.request('viewer', 'relations', { workspaceId: target.workspaceId, entryId: entry.id, direction: 'downstream', depth: 1, limit: 25 })
    expect(relations.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'usage', usage: expect.objectContaining({ id: usage.id, current: false }) })]))
  })

  it('冻结后移除成员资格仍拒绝用户读取材料', async () => {
    // 用户视图再次检查当前成员资格；Host 授权生命周期另由真实接管场景验证。
    const { entry } = await collectFixture(1), consumer = await createClaim('验证当前授权')
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer, refs: [libraryRef(entry)], mode: 'live' })
    await target.fixtures.revoke('editor')
    await expect(target.request('editor', 'readFrozen', { workspaceId: target.workspaceId, workId: work.workId })).rejects.toMatchObject({ status: 404, code: 'WORKSPACE_NOT_FOUND' })
  })

  it('选定的上游来源关系保留精确节点版本', async () => {
    // 上下游通过真实索引读取，不只检查收录 payload 中是否存了一个节点 ID。
    const source = await target.fixtures.createNode(target.workspaceId, 'source', '试点原始公告正文')
    const { entry } = await collectFixture(1, { basisRefs: [{ kind: 'node', ref: source }] })
    const relations = await target.request('viewer', 'relations', { workspaceId: target.workspaceId, entryId: entry.id, direction: 'upstream', depth: 1, limit: 25 })
    expect(relations.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'source', entryId: entry.id, node: source })]))
    expect(relations.items.length).toBeLessThanOrEqual(25)
  })
})

describe('固定清单、数据交换与原子失败', () => {
  // 固定快照与便携包必须保留历史材料，目标身份重映射交由真实实现完成。
  it('快照创建后撤回和新增条目不改变清单，历史 Work 可显式回放', async () => {
    // 历史回放使用指定快照，不能把后来撤回的成员重新混入实时默认搜索。
    const { entry } = await collectFixture(0)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId, refs: [libraryRef(entry)], requestId: randomUUID() })
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '快照之后撤回', requestId: randomUUID() })
    await collectFixture(1)
    expect(await target.request('viewer', 'snapshotGet', { workspaceId: target.workspaceId, snapshotId: snapshot.id })).toEqual(snapshot)
    const consumer = await createClaim('历史快照回放目标')
    const work = await target.request('editor', 'freeze', { workspaceId: target.workspaceId, target: consumer,
      refs: snapshot.entries, mode: 'historical', snapshotId: snapshot.id })
    expect(work.entries.map(/* 已获权的历史清单成员。 */ item => /* 只比较实际冻结的收录身份。 */ item.id)).toEqual([entry.id])
    expect(work.entries[0]?.confidence).toBe(0)
    expect(work.entries[0]?.claim.nodeSnapshot.payload.content).toBe(CLAIM_TEXT)
  })

  it('快照创建拒绝错误摘要且不发布清单或收据', async () => {
    // 固定清单必须精确绑定存在的内容，不允许用错误摘要生成可回放快照。
    const { entry } = await collectFixture(1), before = await target.inspect.counts(target.workspaceId)
    await expect(target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId,
      refs: [{ entryId: entry.id, contentDigest: 'tampered-digest' }], requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_DIGEST_MISMATCH' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })

  it('导出撤回快照并导入另一 workspace 后重映射条目、摘要、附件和快照引用', async () => {
    // 0 原文及历史材料随包保存；目标摘要由真实实现按新身份重算。
    const asset = await target.fixtures.createAsset(target.workspaceId, '固定档案：本次实际仅 12 条线路。')
    const { entry } = await collectFixture(0, { basisRefs: [{ kind: 'asset', assetId: asset.id, sha256: asset.sha256 }] })
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId, refs: [libraryRef(entry)], requestId: randomUUID() })
    await target.request('editor', 'withdraw', { workspaceId: target.workspaceId, entryId: entry.id,
      expectedRevision: entry.revision, reason: '保留历史导出', requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    expect(bundle.entries).toEqual(expect.arrayContaining([expect.objectContaining({ id: entry.id, confidence: 0, status: 'withdrawn' })]))
    expect(bundle.assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: asset.id, sha256: asset.sha256 })]))
    const imported = await target.request('owner', 'import', { workspaceId: target.otherWorkspaceId, bundle, requestId: randomUUID() })
    const entryId = imported.entryIds[entry.id], digest = imported.digests[entry.id], assetId = imported.assetIds[asset.id], snapshotId = imported.snapshotIds[snapshot.id]
    assert.exists(entryId, '导入必须返回原条目身份到目标身份的映射')
    assert.exists(digest, '导入必须返回原条目身份到目标摘要的映射')
    assert.exists(assetId, '导入必须返回附件身份映射')
    assert.exists(snapshotId, '导入必须返回快照身份映射')
    expect(entryId).not.toBe(entry.id)
    expect(assetId).not.toBe(asset.id)
    const importedEntry = await target.request('owner', 'get', { workspaceId: target.otherWorkspaceId, entryId })
    expect(importedEntry).toMatchObject({ workspaceId: target.otherWorkspaceId, confidence: 0, contentDigest: digest,
      claim: { nodeSnapshot: { payload: { content: CLAIM_TEXT } } },
      decision: { basisRefs: [{ kind: 'asset', assetId, sha256: asset.sha256 }] } })
    expect(importedEntry.contentDigest).not.toBe(entry.contentDigest)
    expect((await target.request('owner', 'snapshotGet', { workspaceId: target.otherWorkspaceId, snapshotId })).entries)
      .toEqual([{ entryId, contentDigest: digest }])
  })

  it('重复导入返回相同映射且不重复发布附件或收录记录', async () => {
    // 导入收据固定目标身份，合法重放不能重新分配映射。
    const { entry } = await collectFixture(1)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId, refs: [libraryRef(entry)], requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    const input = { workspaceId: target.otherWorkspaceId, bundle, requestId: randomUUID() }
    const first = await target.request('owner', 'import', input), before = await target.inspect.counts(target.otherWorkspaceId)
    expect(await target.request('owner', 'import', input)).toEqual({ ...first, replayed: true })
    expect(await target.inspect.counts(target.otherWorkspaceId)).toEqual(before)
  })

  it('包内固定判断改成 0.5 时拒绝且不发布部分导入', async () => {
    // 外部包不能绕过数字 0/1 入口限制；故意非法输入以 unknown 明确其信任边界。
    const { entry } = await collectFixture(1)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId, refs: [libraryRef(entry)], requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    const item = bundle.entries[0]
    assert.exists(item, '导出包必须包含被选择的条目')
    Object.assign(item, { confidence: 0.5 })
    const before = await target.inspect.counts(target.otherWorkspaceId)
    await expect(target.request('owner', 'import', { workspaceId: target.otherWorkspaceId, bundle, requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_CONFIDENCE_INVALID' })
    expect(await target.inspect.counts(target.otherWorkspaceId)).toEqual(before)
  })

  it('包内缺失固定附件依赖时拒绝且不发布部分导入', async () => {
    // 声明的依据闭包必须完整，不能留下指向源工作区附件的裸外部身份。
    const asset = await target.fixtures.createAsset(target.workspaceId, '完整性测试档案')
    const { entry } = await collectFixture(1, { basisRefs: [{ kind: 'asset', assetId: asset.id, sha256: asset.sha256 }] })
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId, refs: [libraryRef(entry)], requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    bundle.assets = []
    const before = await target.inspect.counts(target.otherWorkspaceId)
    await expect(target.request('owner', 'import', { workspaceId: target.otherWorkspaceId, bundle, requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_BUNDLE_INCOMPLETE' })
    expect(await target.inspect.counts(target.otherWorkspaceId)).toEqual(before)
  })

  it('包内摘要不匹配时拒绝且不发布部分导入', async () => {
    // 修改条目摘要而未更新固定清单不能产生目标库中的错误引用。
    const { entry } = await collectFixture(1)
    const snapshot = await target.request('editor', 'snapshotCreate', { workspaceId: target.workspaceId, refs: [libraryRef(entry)], requestId: randomUUID() })
    const bundle = await target.request('viewer', 'export', { workspaceId: target.workspaceId, snapshotId: snapshot.id })
    const item = bundle.entries[0]
    assert.exists(item, '导出包必须包含被选择的条目')
    item.contentDigest = 'tampered-digest'
    const before = await target.inspect.counts(target.otherWorkspaceId)
    await expect(target.request('owner', 'import', { workspaceId: target.otherWorkspaceId, bundle, requestId: randomUUID() }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_DIGEST_MISMATCH' })
    expect(await target.inspect.counts(target.otherWorkspaceId)).toEqual(before)
  })

  it('[适配器集成] 收录失败时条目与收据同事务撤销', async () => {
    // 故障注入位于真实存储提交 seam，不在适配层伪造业务结果。
    const origin = await createClaim(), before = await target.inspect.counts(target.workspaceId)
    await target.fixtures.failNextCommit()
    await expect(target.request('editor', 'collect', collectInput(target, origin, 1))).rejects.toMatchObject({ status: 503, code: 'EVIDENCE_COMMIT_FAILED' })
    expect(await target.inspect.counts(target.workspaceId)).toEqual(before)
  })
})

describe('有界搜索、游标与真实索引', () => {
  // 分页正确性来自真实数据库查询，检查实际执行观测而不是返回数组的外形。
  it.each([0, 1] as const)('按判断 %s 筛选时只返回对应记录，0 不作为缺失条件', async (
    /* 查询参数中明确给出的数字判断。 */ confidence,
  ) => {
    // 特别检查 falsy 的 0，防止筛选条件被错误省略。
    const falseEntry = await collectFixture(0), trueEntry = await collectFixture(1)
    const page = await target.request('viewer', 'search', { workspaceId: target.workspaceId, confidence })
    expect(page.items.map(/* 对应筛选条件的真实结果。 */ item => /* 对照其收录身份。 */ item.id))
      .toEqual([confidence === 0 ? falseEntry.entry.id : trueEntry.entry.id])
    expect(page.items.every(/* 一条返回的摘要。 */ item => /* 所有记录均满足明确的 0/1。 */ item.confidence === confidence)).toBe(true)
  })

  it('关键词分页无重复遗漏且实际查询使用索引和有界物化', async () => {
    // 预置结果只提供确定命中身份；过滤、排序和 LIMIT 必须由真实目标执行。
    const seeded = await target.fixtures.seed({ seed: 20261006, entries: 41, usages: 0, textBytes: 256 })
    const ids: string[] = [], cursors = new Set<string>()
    let cursor: string | undefined
    for (let pageNumber = 0; pageNumber < 50; pageNumber += 1) {
      const page = await target.request('viewer', 'search', { workspaceId: target.workspaceId, query: seeded.query, limit: 7, ...(cursor ? { cursor } : {}) })
      expect(page.items.length).toBeLessThanOrEqual(7)
      ids.push(...page.items.map(/* 本页的轻量条目摘要。 */ item => /* 累积真实查询身份用于完整性检查。 */ item.id))
      const observation = (await target.inspect.telemetry()).queryObservation
      assert.exists(observation, '分页查询必须提供真实数据库执行观测')
      expect(observation.implementation).toBe(target.info.backend === 'sqlite' ? 'sqlite-index' : 'mongo-index')
      expect(observation.indexNames.length).toBeGreaterThan(0)
      expect(observation.fullWorkspaceScan).toBe(false)
      expect(observation.returnedRows).toBe(page.items.length)
      expect(observation.materializedRows).toBeLessThanOrEqual(8)
      if (page.nextCursor === null) break
      expect(cursors.has(page.nextCursor)).toBe(false)
      cursors.add(page.nextCursor)
      cursor = page.nextCursor
      expect(pageNumber).toBeLessThan(49)
    }
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual([...seeded.expectedQueryIds].sort())
  })

  it('游标绑定工作区和筛选条件，不能跨查询重用', async () => {
    // 游标不是任意 offset，修改条件或 workspace 必须明确拒绝。
    const seeded = await target.fixtures.seed({ seed: 20261006, entries: 41, usages: 0, textBytes: 256 })
    const page = await target.request('viewer', 'search', { workspaceId: target.workspaceId, query: seeded.query, limit: 1 })
    assert.exists(page.nextCursor, '夹具必须准备至少两条命中以产生游标')
    await expect(target.request('viewer', 'search', { workspaceId: target.workspaceId, query: '改动后的查询条件', limit: 1, cursor: page.nextCursor }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_CURSOR_INVALID' })
    await expect(target.request('owner', 'search', { workspaceId: target.otherWorkspaceId, query: seeded.query, limit: 1, cursor: page.nextCursor }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_CURSOR_INVALID' })
  })

  it('跨页期间库发生变化时明确报告游标过期', async () => {
    // 不在变化的读取版本上静默继续分页，避免重复、遗漏或混入新记录。
    const seeded = await target.fixtures.seed({ seed: 20261006, entries: 41, usages: 0, textBytes: 256 })
    const page = await target.request('viewer', 'search', { workspaceId: target.workspaceId, query: seeded.query, limit: 1 })
    assert.exists(page.nextCursor, '夹具必须准备至少两条命中以产生游标')
    await collectFixture(1)
    await expect(target.request('viewer', 'search', { workspaceId: target.workspaceId, query: seeded.query, limit: 1, cursor: page.nextCursor }))
      .rejects.toMatchObject({ status: 409, code: 'EVIDENCE_CURSOR_EXPIRED' })
  })

  it('搜索与匹配只能返回指定 workspace 内的记录', async () => {
    // 两个可访问的 workspace 仍保持检索与匹配数据隔离。
    const { entry } = await collectFixture(1), foreignOrigin = await createClaim(CLAIM_TEXT, target.otherWorkspaceId)
    expect((await target.request('owner', 'search', { workspaceId: target.otherWorkspaceId, query: CLAIM_TEXT })).items).toEqual([])
    expect(await target.request('owner', 'match', { workspaceId: target.otherWorkspaceId, claim: foreignOrigin, applicability: entry.applicability, limit: 50 })).toEqual([])
    expect((await target.request('viewer', 'search', { workspaceId: target.workspaceId, confidence: 1 })).items.map(
      /* 本工作区的查询摘要。 */ item => /* 确認本地记录没有因其他库的查询而丢失。 */ item.id,
    )).toEqual([entry.id])
  })

  it('搜索页与匹配候选上限分别为 100 和 50', async () => {
    // 超限输入明确拒绝，避免接口把整库正文读入内存后截断。
    const origin = await createClaim()
    await expect(target.request('viewer', 'search', { workspaceId: target.workspaceId, limit: 101 }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_QUERY_LIMIT_INVALID' })
    await expect(target.request('viewer', 'match', { workspaceId: target.workspaceId, claim: origin, applicability: applicability(), limit: 51 }))
      .rejects.toMatchObject({ status: 422, code: 'EVIDENCE_QUERY_LIMIT_INVALID' })
  })
})
