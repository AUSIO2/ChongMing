// 092 先行图规则测试：显式材料独立于本图分支，并沿冻结规格提供给 Work。
import { describe, expect, it } from 'vitest'

import type { EvidenceFrozenClaim, EvidenceUseRef } from '../../../../contracts/evidence-library'
import { runCreateRun, runReadData, runUpdateProposal } from '../../../../backend/modules/graph/run-state'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { storeAssertCurrentGraphSchema } from '../../../../backend/modules/graph/graph-record'
import { definitionsDigest } from '../../../../backend/modules/shared/data-definition'
import { LIBRARY_TEST_AGENT, LIBRARY_TEST_OUTPUT, LIBRARY_TEST_TIME, libraryTestCatalog, libraryTestDocument, libraryTestFrozenClaim, libraryTestStartInput } from '../../fixtures/library-claims'

enum LibraryRunTestMessage { WORK_MISSING = 'Expected library-claim work', STEP_WORK_MISSING = 'Expected current step work' }

function start(
  /* app 已提供的固定材料集合；默认一份 0 判断条目。 */ claims: EvidenceFrozenClaim[] = [libraryTestFrozenClaim()],
  /* 本用例的实际目标 Map，默认独立建立。 */ target = libraryTestDocument(),
) {
  // 直接调用真实图领域规则，不通过内存数据库替代库冻结或使用事务。
  const { document, input } = target
  const parameters = libraryTestStartInput(document, input.id, claims)
  runCreateRun(document, parameters, { definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4,
    ...(claims.length ? { libraryClaimSets: [{ stepId: 'verify', claims }] } : {}) }, LIBRARY_TEST_TIME)
  const work = workReadItems(document)[0]
  if (!work) throw new Error(LibraryRunTestMessage.WORK_MISSING)
  return { document, input, claims, work }
}

function publish(
  /* 当前真实图与获权 Work。 */ f: ReturnType<typeof start>,
  /* 模型显式声明使用的固定库条目与非空理由。 */ refs?: EvidenceUseRef[],
) {
  // 正式提案沿现有输出合同发布，库引用属于节点元信息而非payload schema。
  return runUpdateProposal(f.document, { mapId: f.document.id, operationId: f.work.operationId, id: f.work.workId, specHash: f.work.specHash,
    kind: 'outputs', reason: '核查完成', outputs: [{ key: 'opinion', port: 'opinion', typeRef: LIBRARY_TEST_OUTPUT,
      payload: { score: 0.5, reason: '核查意见保留原分数' }, ...(refs === undefined ? {} : { libraryClaimRefs: refs }) }] }, f.work, LIBRARY_TEST_TIME)
}

describe('092 frozen library material in generic graph execution', () => {
  // 图领域保证授权集合、投影和产物元信息，实际使用索引由注入的提交回调承担。
  it('stores complete claims once per step and keeps source ids outside graph branch/input/context', () => {
    // 即使来源与目标 nodeId 相同，库材料也不能冒充本图输入或扩大写范围。
    const target = libraryTestDocument()
    const material = libraryTestFrozenClaim(undefined, undefined, target.input.id)
    const f = start([material], target)
    const run = f.document.runs[0]
    expect(run.libraryClaimSets).toEqual([{ stepId: 'verify', claims: [material] }])
    expect(run.libraryClaimSets?.[0].claims[0]).not.toBe(material)
    expect(run.branchState?.scope.nodeIds).toEqual([f.input.id])
    const op = run.operations[0]
    expect(op.group.inputRefs.map((/* 本图封闭输入引用。 */ ref) => /* 只查看实际本图节点身份。 */ ref.id)).toEqual([f.input.id])
    expect(op.group.contextRefs).toEqual([])
    expect(op.executionSpec.libraryClaimRefs).toEqual([material.ref])
    expect(op.executionSpec).not.toHaveProperty('libraryClaims')
    expect(f.document.nodes).toHaveLength(1)
    expect(material.entry.claim.origin.nodeId).toBe(f.input.id)
    expect(material.entry.claim.origin.mapId).not.toBe(f.document.id)
  })

  it('projects only the current step frozen claims without changing raw stored material', () => {
    // 隐藏字段和visibleToAI=false字典项不进入Work，fixed0和原范围仍保留。
    const f = start()
    const data = runReadData(f.document, f.work.operationId, f.work)
    expect(data.libraryClaims).toHaveLength(1)
    const material = data.libraryClaims?.[0]
    expect(material?.entry.confidence).toBe(0)
    expect(material?.entry.applicability.conditions).toEqual(['原条件'])
    expect(material?.entry.claim.nodeSnapshot.payload).toEqual({ content: '该事情完全错误，原陈述不被反写。',
      context: { visible: { value: '模型可见依据', visibleToAI: true } } })
    expect(f.document.runs[0].libraryClaimSets?.[0].claims[0].entry.claim.nodeSnapshot.payload).toHaveProperty('secret')
    expect(data.inputs.claim[0].node.id).toBe(f.input.id)
  })

  it('returns only the active operation step collection when another step selected different claims', () => {
    // 同一Run有多个合法材料集合，前一Work不能得到尚未获权后一步的材料。
    const { document, input } = libraryTestDocument()
    const a = libraryTestFrozenClaim(), b = libraryTestFrozenClaim()
    const parameters = libraryTestStartInput(document, input.id, [a])
    const later = { ...structuredClone(parameters.plan.steps[0]), id: 'later', dependsOn: ['verify'], libraryClaimRefs: [b.ref] }
    parameters.plan.steps.push(later)
    runCreateRun(document, parameters, { definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4,
      libraryClaimSets: [{ stepId: 'verify', claims: [a] }, { stepId: 'later', claims: [b] }] }, LIBRARY_TEST_TIME)
    const work = workReadItems(document)[0]
    if (!work) throw new Error(LibraryRunTestMessage.STEP_WORK_MISSING)
    const data = runReadData(document, work.operationId, work)
    expect(data.libraryClaims?.map((/* 当前Work实际得到的固定材料。 */ item) => /* 只核验库条目身份。 */ item.ref.entryId)).toEqual([a.ref.entryId])
    expect(document.runs[0].libraryClaimSets).toHaveLength(2)
  })

  it('publishes selected use metadata without forcing Opinion score to fixed library judgment', () => {
    // 合法产物声明获权条目，保留0.5 Opinion与库0的独立含义。
    const f = start()
    const used = { ...f.claims[0].ref, reason: '显式使用固定事实核对依据' }
    const result = publish(f, [used])
    expect(result.nodeIds).toHaveLength(1)
    expect(f.document.nodes.at(-1)).toMatchObject({ payload: { score: 0.5 }, libraryClaimRefs: [used] })
    expect(f.document.nodes.at(-1)?.payload).not.toHaveProperty('libraryClaimRefs')
  })

  it.each(['unselected', 'wrong-digest', 'empty-reason'] as const)('rejects %s output library metadata before accepting candidates', (
    /* 模型使用未获权条目、错误摘要或空理由的不同输入。 */ invalid,
  ) => {
    // Work只接受当前Operation冻结集合；失败不能留下候选或正式节点。
    const f = start()
    const use = { ...f.claims[0].ref, reason: '明确使用理由' }
    if (invalid === 'unselected') use.entryId = libraryTestFrozenClaim().ref.entryId
    else if (invalid === 'wrong-digest') use.contentDigest = 'f'.repeat(64)
    else use.reason = ' '
    const before = structuredClone(f.document)
    expect(() => publish(f, [use])).toThrow()
    expect(f.document).toEqual(before)
  })

  it('continues a frozen run after material withdrawal without consulting current library status', () => {
    // 撤回不能把已经获权的冻结材料改成不可发布，也不调用当前库读取。
    const f = start()
    f.claims[0].entry.status = 'withdrawn'
    f.claims[0].entry.statusReason = '启动后撤回'
    const data = runReadData(f.document, f.work.operationId, f.work)
    expect(data.libraryClaims?.[0].entry.status).toBe('active')
    expect(publish(f, [{ ...f.claims[0].ref, reason: '使用启动时冻结材料' }]).nodeIds).toHaveLength(1)
  })

  it.each(['same', 'different'] as const)('reuses completed outputs only for the %s selected set', (
    /* 后继Run是否选择相同的精确库依赖集合。 */ selection,
  ) => {
    // 保留既有复用能力，集合变化只通过specHash拒绝错误复用，不全局关掉复用。
    const original = libraryTestFrozenClaim()
    const f = start([original])
    publish(f, [{ ...original.ref, reason: '第一轮明确使用' }])
    const nextClaims = selection === 'same' ? [original] : [libraryTestFrozenClaim()]
    runCreateRun(f.document, libraryTestStartInput(f.document, f.input.id, nextClaims), {
      definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4, libraryClaimSets: [{ stepId: 'verify', claims: nextClaims }],
    }, LIBRARY_TEST_TIME)
    const current = f.document.runs[0].operations[0]
    if (selection === 'same') {
      expect(current.status).toBe('completed')
      expect(current.reusedFromOperationId).toBe(f.document.runHistory[0].operations[0].id)
    } else {
      expect(current.status).toBe('running')
      expect(current).not.toHaveProperty('reusedFromOperationId')
      expect(current.specHash).not.toBe(f.document.runHistory[0].operations[0].specHash)
    }
  })

  it('keeps empty material legacy runs and rejects corrupted stored use metadata', () => {
    // 历史无字段保持原data_read形状，新增存储元信息不允许损坏理由蒙混进入图快照。
    const f = start([])
    expect(runReadData(f.document, f.work.operationId, f.work)).not.toHaveProperty('libraryClaims')
    expect(f.document.runs[0]).not.toHaveProperty('libraryClaimSets')
    const bad = structuredClone(f.document)
    Object.assign(bad.nodes[0], { libraryClaimRefs: [{ entryId: 'not-a-uuid', contentDigest: 'x', reason: '' }] })
    expect(() => storeAssertCurrentGraphSchema(bad)).toThrow()
  })

  it('rejects an array that stringifies to a valid stored edge kind', () => {
    // 持久化边界不能把畸形 JSON 类型解释成可执行的 successor/reference 关系。
    const f = start([]), bad = structuredClone(f.document)
    bad.edges.push({ id: 'edge', kind: 'reference', from: f.input.id, to: 'other-node', revision: 0,
      createdAt: LIBRARY_TEST_TIME, updatedAt: LIBRARY_TEST_TIME })
    expect(() => /* 确认本用例只破坏关系种类，其他存储形状仍被接受。 */ storeAssertCurrentGraphSchema(bad)).not.toThrow()
    Object.assign(bad.edges[0], { kind: ['reference'] })
    expect(() => /* 拒绝数组冒充的合法枚举文字。 */ storeAssertCurrentGraphSchema(bad))
      .toThrowError(expect.objectContaining({ code: 'NODE_SCHEMA_UNSUPPORTED' }))
  })

  it.each(['step-material', 'operation-ref'] as const)('rejects corrupted optional stored %s fields', (
    /* 已存图的新冻结集合或Operation引用损坏路径。 */ path,
  ) => {
    // 历史无字段可以读取，已经声明字段的损坏不能被默认丢弃或解释成空集合。
    const f = start()
    const bad = structuredClone(f.document)
    if (path === 'step-material') {
      const set = bad.runs[0].libraryClaimSets?.[0]
      if (!set) throw new Error(LibraryRunTestMessage.WORK_MISSING)
      set.claims[0].ref.contentDigest = ''
    } else {
      Object.assign(bad.runs[0].operations[0].executionSpec, { libraryClaimRefs: [{ entryId: 'not-a-uuid', contentDigest: '' }] })
    }
    expect(() => storeAssertCurrentGraphSchema(bad)).toThrow()
  })

  it('rejects an execution spec whose hash no longer binds its selected material closure', () => {
    // 把Operation和spec同时改成同一错误hash仍不能获得库材料执行授权。
    const f = start()
    const bad = structuredClone(f.document)
    const operation = bad.runs[0].operations[0]
    operation.specHash = 'a'.repeat(64)
    operation.executionSpec.specHash = operation.specHash
    expect(() => storeAssertCurrentGraphSchema(bad)).toThrow()
  })

  it.each(['body', 'fixed judgment'] as const)('rejects a changed frozen %s while ref, library digest and specHash remain unchanged', (
    /* 原Run完整冻结材料中被单字段损坏的内容。 */ corruption,
  ) => {
    // 单改合法形状的原文或0↔1不能冒充仍获权的固定材料；不测试底层数据库故障算法。
    const f = start()
    expect(() => storeAssertCurrentGraphSchema(f.document)).not.toThrow()
    const bad = structuredClone(f.document)
    const material = bad.runs[0].libraryClaimSets?.[0].claims[0]
    if (!material) throw new Error(LibraryRunTestMessage.WORK_MISSING)
    const originalRef = structuredClone(material.ref)
    const originalLibraryDigest = material.entry.contentDigest
    const originalSpecHash = bad.runs[0].operations[0].specHash
    if (corruption === 'body') material.entry.claim.nodeSnapshot.payload.content = '存储seam改坏的固定原文。'
    else material.entry.confidence = material.entry.confidence === 0 ? 1 : 0
    expect(material.ref).toEqual(originalRef)
    expect(material.entry.contentDigest).toBe(originalLibraryDigest)
    expect(bad.runs[0].operations[0].specHash).toBe(originalSpecHash)
    expect(() => storeAssertCurrentGraphSchema(bad)).toThrow(expect.objectContaining({ code: 'RUN_SCHEMA_UNSUPPORTED' }))
  })

  it('rejects changed complete material even when its local snapshot digest is recomputed while the operation remains unchanged', () => {
    // 局部快照自洽不足以取得旧Operation授权；规格必须仍绑定原来的完整材料。
    const f = start()
    expect(() => storeAssertCurrentGraphSchema(f.document)).not.toThrow()
    const bad = structuredClone(f.document)
    const material = bad.runs[0].libraryClaimSets?.[0].claims[0]
    if (!material) throw new Error(LibraryRunTestMessage.WORK_MISSING)
    const originalRef = structuredClone(material.ref)
    const originalSpec = structuredClone(bad.runs[0].operations[0].executionSpec)
    const oldSnapshotDigest = material.snapshotDigest
    material.entry.claim.nodeSnapshot.payload.content = '原材料改变，但局部摘要被重新计算。'
    material.snapshotDigest = definitionsDigest({ ref: material.ref, entry: material.entry, definition: material.definition })
    expect(material.snapshotDigest).not.toBe(oldSnapshotDigest)
    expect(material.snapshotDigest).toBe(definitionsDigest({ ref: material.ref, entry: material.entry, definition: material.definition }))
    expect(material.ref).toEqual(originalRef)
    expect(bad.runs[0].operations[0].executionSpec).toEqual(originalSpec)
    expect(() => storeAssertCurrentGraphSchema(bad)).toThrow(expect.objectContaining({ code: 'RUN_SCHEMA_UNSUPPORTED' }))
  })

  it('rejects a self-consistent replacement operation snapshot digest that does not bind the run material', () => {
    // 即使规格和Operation的hash同时重算自洽，也不能引用与Run完整材料不符的快照标签。
    const f = start()
    expect(() => storeAssertCurrentGraphSchema(f.document)).not.toThrow()
    const bad = structuredClone(f.document)
    const material = bad.runs[0].libraryClaimSets?.[0].claims[0]
    if (!material) throw new Error(LibraryRunTestMessage.WORK_MISSING)
    const originalMaterial = structuredClone(material)
    const operation = bad.runs[0].operations[0]
    const replacement = `${material.snapshotDigest.startsWith('0') ? '1' : '0'}${material.snapshotDigest.slice(1)}`
    operation.executionSpec.librarySnapshotDigests = [replacement]
    const { specHash: _oldHash, ...body } = operation.executionSpec
    operation.executionSpec.specHash = definitionsDigest(body)
    operation.specHash = operation.executionSpec.specHash
    expect(operation.specHash).toBe(definitionsDigest(body))
    expect(replacement).not.toBe(material.snapshotDigest)
    expect(material).toEqual(originalMaterial)
    expect(() => storeAssertCurrentGraphSchema(bad)).toThrow(expect.objectContaining({ code: 'RUN_SCHEMA_UNSUPPORTED' }))
  })
})
