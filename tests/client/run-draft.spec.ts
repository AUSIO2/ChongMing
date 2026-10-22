// C16先行：单份steps草稿构造真实端口/DAG，保留C15默认、隔离、单步和选材语义。
import { reactive } from 'vue'
import { describe, expect, it } from 'vitest'

import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphRunStep } from '../../contracts/graph-run'
import { libraryTestCatalog, libraryTestDocument } from '../backend/fixtures/library-claims'
import { runAddStep, runBindPort, runBuildSubmission, runCreateDraft, runCreateStep, runReadScopeNodeIds,
  runReadSelectionKey, runRemoveStep, runSetDependencies, runValidateDraft, type RunDraft, type RunStartInput, type RunStepDraft } from '../../apps/ui/features/run/run-draft'

function fixture() {
  // 复用真实类型和单步定义，只形成前端快照，不启动模型或服务。
  const { document, input } = libraryTestDocument(), catalog = libraryTestCatalog(), transition = catalog.transitions[0]
  const snapshot: GraphSnapshot = { mapId: document.id, workspaceId: document.workspaceId, revision: document.revision,
    name: document.name, nodes: document.nodes, edges: [], runs: [], ownershipRevision: 0, ownerships: [], runControls: [], updatedAt: document.updatedAt }
  return { snapshot, catalog, transition, input, seed: { transitionRef: { id: transition.id, version: transition.version }, nodeIds: [input.id] },
    refs: [{ entryId: 'fixed-entry', contentDigest: 'fixed-digest' }] }
}
function step(
  /* 当前独立步骤草稿。 */ draft: RunDraft,
  /* 步骤在本次表单的位置，不当作持久身份。 */ index = 0,
): RunStepDraft {
  // 缺少实际步骤时明确失败，不用非空断言掩盖未初始化。
  const current = draft.steps[index]
  if (!current) throw new Error('Expected initialized draft step')
  return current
}
function ids(
  /* 保存scope来源的当前步骤。 */ current: RunStepDraft,
  /* 要操作的input端口位置。 */ index = 0,
): string[] {
  // 只操作明确scope数组，动态来源用例直接写真实联合类型。
  const binding = current.input[index]
  if (!binding || binding.source.kind !== 'scope') throw new Error('Expected scope input')
  return binding.source.nodeIds
}
function business(
  /* 独立创建的单步运行提交。 */ input: RunStartInput,
) {
  // 仅排除随机步骤UUID，原C15两入口全部业务参数仍参与比较。
  return { ...input, plan: { steps: input.plan.steps.map((/* 已构造步骤。 */ current) => /* 保留其它所有字段。 */ ({ ...current, id: 'generated-step' })) } }
}
function multiFixture() {
  // 前步两个input和必填context，后步只消费前步精确正式输出端口。
  const f = fixture()
  const nodes = ['a', 'b', 'c', 'd', 'context'].map((/* 同图不同身份。 */ id) => /* 同正文仍由ID区分。 */ ({ ...structuredClone(f.input), id }))
  f.snapshot.nodes = nodes
  const compare = structuredClone(f.transition)
  compare.id = 'fixture.compare'; compare.cardinality = 'N:1'
  compare.ports.input = ['primary', 'comparison'].map((/* 两个必填端口。 */ name) => /* 每组逐端口核对。 */ ({ name,
    inputType: { id: f.input.typeId, version: f.input.typeVersion }, count: { min: 1, max: 2 } }))
  compare.ports.context = [{ name: 'background', inputType: { id: f.input.typeId, version: f.input.typeVersion }, count: { min: 1, max: 1 } }]
  const next = structuredClone(f.transition)
  next.id = 'fixture.next'; next.ports.input = [{ name: 'opinion', inputType: { ...f.transition.ports.output[0].outputType }, count: { min: 1, max: 1 } }]
  f.catalog.transitions.push(compare, next)
  const first: RunStepDraft = { id: 'source-step', transitionRef: { id: compare.id, version: compare.version }, dependsOn: [],
    input: [{ port: 'primary', source: { kind: 'scope', nodeIds: ['a', 'b'] } }, { port: 'comparison', source: { kind: 'scope', nodeIds: ['c', 'd'] } }],
    context: [{ port: 'background', source: { kind: 'scope', nodeIds: ['context'] } }], grouping: { mode: 'all' }, onEmpty: 'fail',
    libraryClaimRefs: [{ entryId: 'first-material', contentDigest: 'first-digest' }] }
  const second: RunStepDraft = { id: 'next-step', transitionRef: { id: next.id, version: next.version }, dependsOn: [first.id],
    input: [{ port: 'opinion', source: { kind: 'step', stepId: first.id, port: 'opinion' } }], context: [], grouping: { mode: 'each' }, onEmpty: 'skip',
    libraryClaimRefs: [{ entryId: 'second-material', contentDigest: 'second-digest' }] }
  const draft: RunDraft = { steps: [first, second], mode: 'human-in-loop', regenerate: false }
  return { ...f, nodes, compare, next, first, second, draft }
}

describe('C15 behavior retained in the steps draft', () => {
  // 原拒绝高级端口迁移成C16合法表达，其余默认和参数保护继续验收。
  it('creates fresh human review drafts with independent seed identities and arrays', () => {
    // 两入口都不继承另一目标的模式、重生成或材料。
    const f = fixture(), first = runCreateDraft(reactive(f.seed), f.catalog, f.snapshot), second = runCreateDraft(f.seed, f.catalog, f.snapshot)
    expect(first).toMatchObject({ mode: 'human-in-loop', regenerate: false, steps: [{ transitionRef: f.seed.transitionRef }] })
    const reference = step(first).transitionRef
    if (!reference) throw new Error('Expected transition')
    reference.version = 9; ids(step(first)).push('later-node'); first.mode = 'auto'; first.regenerate = true
    expect(step(second).transitionRef).toEqual(f.seed.transitionRef); expect(ids(step(second))).toEqual(f.seed.nodeIds)
    expect(second.mode).toBe('human-in-loop'); expect(second.regenerate).toBe(false)
    expect(runCreateDraft()).toMatchObject({ mode: 'human-in-loop', regenerate: false, steps: [{ transitionRef: null }] })
  })
  it('builds equal business submissions for the same seed and preserves different batch scope', () => {
    // 两次独立UUID不影响相同seed语义，批量默认范围差异必须仍明确。
    const f = fixture(), first = runCreateDraft(f.seed, f.catalog, f.snapshot), second = runCreateDraft(f.seed, f.catalog, f.snapshot)
    step(first).libraryClaimRefs = f.refs; step(second).libraryClaimRefs = structuredClone(f.refs)
    first.mode = second.mode = 'auto'; first.regenerate = second.regenerate = true
    const a = runBuildSubmission(first, f), b = runBuildSubmission(second, f)
    expect(a.ok).toBe(true); expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(business(a.input)).toEqual(business(b.input)); expect(a.input).toMatchObject({ mode: 'auto', regenerate: true })
    f.snapshot.nodes.push({ ...structuredClone(f.input), id: 'another' })
    const batch = runBuildSubmission(runCreateDraft({ ...f.seed, nodeIds: [f.input.id, 'another'] }, f.catalog, f.snapshot), f)
    expect(batch.ok).toBe(true)
    if (batch.ok) expect(batch.input.scope.nodeIds).toEqual([f.input.id, 'another'])
    expect(b.input.scope.nodeIds).toEqual([f.input.id])
  })
  it.each(['1:1', '1:N', 'N:1', 'N:M'] as const)('retains %s defaults and explicit empty optional context', (/* 原有数量关系。 */ cardinality) => {
    // 能容纳单节点的单input默认each，原min=2聚合仍默认all。
    const f = fixture(), grouped = cardinality === 'N:1' || cardinality === 'N:M'
    f.transition.cardinality = cardinality; f.transition.ports.input[0].count = grouped ? { min: 2, max: 3 } : { min: 1, max: 1 }
    f.transition.ports.context = [{ name: 'background', inputType: { ...f.transition.ports.input[0].inputType }, count: { min: 0, max: 3 } }]
    f.snapshot.nodes.push({ ...structuredClone(f.input), id: 'another' })
    const result = runBuildSubmission(runCreateDraft({ ...f.seed, nodeIds: [f.input.id, 'another'] }, f.catalog, f.snapshot), f)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.input.plan.steps[0]).toMatchObject({ dependsOn: [], grouping: { mode: grouped ? 'all' : 'each' }, onEmpty: 'fail',
      context: [{ port: 'background', source: { kind: 'scope', nodeIds: [] } }] })
  })
  it('rejects exact identity type missing duplicate and known count failures', () => {
    // 原C15缺失/重复/错类型版本与数量保护不因扩步骤而丢失。
    const changes: Array<(/* 独立夹具。 */ f: ReturnType<typeof fixture>) => void> = [
      (/* 夹具。 */ f) => { /* 不回落latest。 */ f.seed.transitionRef.version = 99 },
      (/* 夹具。 */ f) => { /* 必填起点为空。 */ f.seed.nodeIds = [] },
      (/* 夹具。 */ f) => { /* 重复节点不当两项。 */ f.seed.nodeIds.push(f.input.id) },
      (/* 夹具。 */ f) => { /* 节点已删除。 */ f.snapshot.nodes = [] },
      (/* 夹具。 */ f) => { /* 类型ID不符。 */ f.input.typeId = 'other.type' },
      (/* 夹具。 */ f) => { /* 精确类型版本不符。 */ f.input.typeVersion += 1 },
      (/* 夹具。 */ f) => { /* 聚合数量不足。 */ f.transition.ports.input[0].count = { min: 2, max: 3 } },
      (/* 夹具。 */ f) => { /* 起点不被数量上界容纳。 */ f.transition.ports.input[0].count = { min: 0, max: 0 } },
    ]
    for (const change of changes) { const f = fixture(); change(f); expect(runBuildSubmission(runCreateDraft(f.seed, f.catalog, f.snapshot), f).ok).toBe(false) }
    const f = fixture(), draft = runCreateDraft(f.seed, f.catalog, f.snapshot)
    expect(runBuildSubmission(runCreateDraft(), f).ok).toBe(false)
    expect(runBuildSubmission(draft, { snapshot: null, catalog: f.catalog }).ok).toBe(false)
    expect(runBuildSubmission(draft, { snapshot: f.snapshot, catalog: null }).ok).toBe(false)
  })
  it('copies explicit step materials without inheriting node citations or expanding scope', () => {
    // 正文保存引用不自动选材；计划scope/input与材料分别拥有独立数组。
    const f = fixture(); f.input.libraryClaimRefs = [{ entryId: 'node-citation', contentDigest: 'saved', reason: '原引用' }]
    const draft = runCreateDraft(f.seed, f.catalog, f.snapshot), empty = runBuildSubmission(draft, f)
    expect(empty.ok).toBe(true)
    if (empty.ok) expect(empty.input.plan.steps[0].libraryClaimRefs).toBeUndefined()
    step(draft).libraryClaimRefs = f.refs
    const result = runBuildSubmission(reactive(draft), f)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.scope.nodeIds).toEqual([f.input.id]); expect(result.input.plan.steps[0].context).toEqual([])
    f.refs[0].contentDigest = 'later'; ids(step(draft)).push('later-node')
    expect(result.input.plan.steps[0].libraryClaimRefs).toEqual([{ entryId: 'fixed-entry', contentDigest: 'fixed-digest' }])
    result.input.scope.nodeIds.push('submission-only')
    expect(result.input.plan.steps[0].input[0].source).toEqual({ kind: 'scope', nodeIds: [f.input.id] })
    expect(ids(step(draft))).toEqual([f.input.id, 'later-node'])
  })
  it('keys materials by target revision and capability but not graph revision mode or regeneration', () => {
    // C15目标失效规则现在精确绑定一个稳定stepId。
    const f = fixture(), draft = runCreateDraft(f.seed, f.catalog, f.snapshot), current = step(draft)
    const key = runReadSelectionKey(draft, f.snapshot, true, current.id)
    f.snapshot.revision += 1; f.snapshot.ownershipRevision += 1; f.snapshot.nodes.push({ ...structuredClone(f.input), id: 'unrelated' })
    draft.mode = 'auto'; draft.regenerate = true
    expect(runReadSelectionKey(draft, f.snapshot, true, current.id)).toBe(key)
    f.input.revision += 1; expect(runReadSelectionKey(draft, f.snapshot, true, current.id)).not.toBe(key); f.input.revision -= 1
    expect(runReadSelectionKey(draft, f.snapshot, false, current.id)).not.toBe(key)
    const reference = current.transitionRef
    if (!reference) throw new Error('Expected transition')
    reference.version += 1; expect(runReadSelectionKey(draft, f.snapshot, true, current.id)).not.toBe(key); reference.version -= 1
    ids(current).splice(0, 1, 'missing'); expect(runReadSelectionKey(draft, f.snapshot, true, current.id)).not.toBe(key)
    ids(current).splice(0, 1, f.input.id); f.snapshot.mapId = 'other-map'; expect(runReadSelectionKey(draft, f.snapshot, true, current.id)).not.toBe(key)
  })
  it('does not mutate the original draft snapshot or catalog during construction', () => {
    // 计划构造不能偷偷升版或写回任何保存对象。
    const f = fixture(), draft = runCreateDraft(f.seed, f.catalog, f.snapshot), before = structuredClone({ draft, snapshot: f.snapshot, catalog: f.catalog })
    expect(runBuildSubmission(draft, f).ok).toBe(true); expect({ draft, snapshot: f.snapshot, catalog: f.catalog }).toEqual(before)
  })
})

describe('C16 typed multi-port Run composition', () => {
  // 合法多端口先到达旧builder取有效行为红，再保护依赖和逐组边界。
  it('builds valid multi-input required-context and step-output plans with separate materials', () => {
    // 本例直接构造真实steps DTO调用已有builder，不依赖缺失的新export制造失败。
    const f = multiFixture(), result = runBuildSubmission(f.draft, f)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.input.scope.nodeIds).toEqual(['a', 'b', 'c', 'd', 'context'])
    expect(result.input.plan.steps).toEqual(f.draft.steps)
    expect(result.input.plan.steps[1]).toMatchObject({ onEmpty: 'skip', input: [{ port: 'opinion', source: { kind: 'step', stepId: f.first.id, port: 'opinion' } }] })
    f.first.libraryClaimRefs?.push({ entryId: 'later', contentDigest: 'later' })
    expect(result.input.plan.steps[0].libraryClaimRefs).toEqual([{ entryId: 'first-material', contentDigest: 'first-digest' }])
    expect(result.input.plan.steps[1].libraryClaimRefs).toEqual([{ entryId: 'second-material', contentDigest: 'second-digest' }])
  })
  it('initializes every port and fills only the first matching input while retaining unknown exact seeds', () => {
    // 同类型多个端口不重复播种；缺精确转换也保留用户ref供提示。
    const f = multiFixture(); f.compare.ports.input[0].inputType = { ...f.next.ports.input[0].inputType }
    const draft = runCreateDraft({ transitionRef: { id: f.compare.id, version: 1 }, nodeIds: ['a'] }, f.catalog, f.snapshot)
    expect(step(draft).input).toEqual([{ port: 'primary', source: { kind: 'scope', nodeIds: [] } }, { port: 'comparison', source: { kind: 'scope', nodeIds: ['a'] } }])
    expect(step(draft).context).toEqual([{ port: 'background', source: { kind: 'scope', nodeIds: [] } }]); expect(step(draft).grouping).toEqual({ mode: 'all' })
    expect(runValidateDraft(draft, f).length).toBeGreaterThan(0)
    expect(step(runCreateDraft({ transitionRef: { id: 'missing.exact', version: 9 } }, f.catalog, f.snapshot)).transitionRef).toEqual({ id: 'missing.exact', version: 9 })
    expect(runCreateStep(f.compare).input).toHaveLength(2)
  })
  it('keeps stable IDs and blocks deleting steps or dependencies that are still referenced', () => {
    // 不级联丢弃草稿，删除其它卡不重编号。
    const f = multiFixture(), added = runAddStep(f.draft, f.transition)
    expect(added.steps.slice(0, 2).map((/* 原步骤。 */ current) => /* 身份保持稳定。 */ current.id)).toEqual([f.first.id, f.second.id])
    expect(runRemoveStep(added, f.first.id).ok).toBe(false); expect(runSetDependencies(added, f.second.id, []).ok).toBe(false)
    const removed = runRemoveStep(added, added.steps[2].id)
    expect(removed.ok).toBe(true)
    if (removed.ok) expect(removed.draft.steps.map((/* 剩余步骤。 */ current) => /* 不重编号。 */ current.id)).toEqual([f.first.id, f.second.id])
    expect(f.draft.steps).toHaveLength(2)
  })
  it('replaces a whole port source and explicitly adds its direct dependency on an independent draft', () => {
    // 选择产物来源不拼未来节点ID，也不把scope与step混入同一个端口。
    const f = multiFixture(); f.second.dependsOn = []; f.second.input[0].source = { kind: 'scope', nodeIds: [] }
    const next = runBindPort(f.draft, { stepId: f.second.id, kind: 'input', port: 'opinion', source: { kind: 'step', stepId: f.first.id, port: 'opinion' } })
    expect(next.steps[1].dependsOn).toEqual([f.first.id]); expect(runBuildSubmission(next, f).ok).toBe(true)
    expect(f.second.input[0].source).toEqual({ kind: 'scope', nodeIds: [] })
  })
  it('rejects missing duplicate wrong-type and non-direct or cyclic bindings', () => {
    // 每次仅破坏一个能由当前目录和快照证明的条件。
    const changes: Array<(/* 独立多步夹具。 */ f: ReturnType<typeof multiFixture>) => void> = [
      (/* 夹具。 */ f) => { /* 必填input未选。 */ ids(f.first, 1).splice(0) },
      (/* 夹具。 */ f) => { /* onEmpty不代替必填context。 */ f.first.context = []; f.first.onEmpty = 'skip' },
      (/* 夹具。 */ f) => { /* 同端口不能重复绑定。 */ f.first.input.push(structuredClone(f.first.input[0])) },
      (/* 夹具。 */ f) => { /* 缺失节点。 */ ids(f.first).push('missing-node') },
      (/* 夹具。 */ f) => { /* 类型版本变化。 */ f.nodes[0].typeVersion += 1 },
      (/* 夹具。 */ f) => { /* context逐组共享但仍有数量上限。 */ f.first.context[0].source = { kind: 'scope', nodeIds: ['context', 'a'] } },
      (/* 夹具。 */ f) => { /* 必须直接依赖。 */ f.second.dependsOn = [] },
      (/* 夹具。 */ f) => { /* 不存在的输出端口。 */ f.second.input[0].source = { kind: 'step', stepId: f.first.id, port: 'missing-output' } },
      (/* 夹具。 */ f) => { /* 输出精确类型版本不符。 */ f.next.ports.input[0].inputType.version += 1 },
      (/* 夹具。 */ f) => { /* 缺失依赖。 */ f.second.dependsOn = ['missing-step'] },
      (/* 夹具。 */ f) => { /* 自依赖。 */ f.second.dependsOn.push(f.second.id) },
      (/* 夹具。 */ f) => { /* 有向环。 */ f.first.dependsOn = [f.second.id] },
    ]
    for (const change of changes) { const f = multiFixture(); change(f); expect(runValidateDraft(f.draft, f).length).toBeGreaterThan(0); expect(runBuildSubmission(f.draft, f).ok).toBe(false) }
  })
  it('does not guess dynamic output counts while preserving onEmpty behavior', () => {
    // 静态输出定义不能证明上游多Operation汇总后的真实节点数量。
    const f = multiFixture(); f.second.grouping = { mode: 'all' }; f.second.onEmpty = 'fail'; f.next.ports.input[0].count = { min: 7, max: 9 }
    expect(runValidateDraft(f.draft, f)).toEqual([])
    const result = runBuildSubmission(f.draft, f); expect(result.ok).toBe(true)
    if (result.ok) expect(result.input.plan.steps[1].onEmpty).toBe('fail')
  })
  it('permits each for one input that can contain one node even under N:1', () => {
    // 另一个可选input仍禁止each，不能从cardinality字符串猜分组限制。
    const f = fixture(); f.transition.cardinality = 'N:1'; f.transition.ports.input[0].count = { min: 1, max: 8 }
    const draft = runCreateDraft(f.seed, f.catalog, f.snapshot)
    expect(step(draft).grouping).toEqual({ mode: 'each' }); expect(runValidateDraft(draft, f)).toEqual([])
    f.transition.ports.input[0].count.min = 2; expect(runValidateDraft(draft, f).length).toBeGreaterThan(0)
    f.transition.ports.input[0].count.min = 1; f.transition.ports.input.push({ ...f.transition.ports.input[0], name: 'optional', count: { min: 0, max: 1 } })
    step(draft).input.push({ port: 'optional', source: { kind: 'scope', nodeIds: [] } }); expect(runValidateDraft(draft, f).length).toBeGreaterThan(0)
  })
  it('validates explicit per-port groups while allowing reuse across groups and incomplete coverage', () => {
    // members只引用其input已选成员，context不进表，组间不强制互斥或全覆盖。
    const f = multiFixture()
    f.first.grouping = { mode: 'explicit', groups: [{ id: 'group-a', members: { primary: ['a'], comparison: ['c'] } }, { id: 'group-b', members: { primary: ['a'], comparison: ['d'] } }] }
    expect(runValidateDraft(f.draft, f)).toEqual([])
    const changes: Array<(/* 独立分组副本。 */ grouping: Extract<GraphRunStep['grouping'], { mode: 'explicit' }>) => void> = [
      (/* 分组。 */ grouping) => { /* 单组单端口重复。 */ grouping.groups[0].members.primary = ['a', 'a'] },
      (/* 分组。 */ grouping) => { /* 节点只在另一个端口。 */ grouping.groups[0].members.primary = ['c'] },
      (/* 分组。 */ grouping) => { /* 必填成员缺少。 */ delete grouping.groups[0].members.comparison },
      (/* 分组。 */ grouping) => { /* context不在members。 */ grouping.groups[0].members.background = ['context'] },
      (/* 分组。 */ grouping) => { /* 组身份重复。 */ grouping.groups[1].id = 'group-a' },
    ]
    for (const change of changes) { const grouping = structuredClone(f.first.grouping); change(grouping); const draft = structuredClone(f.draft); draft.steps[0].grouping = grouping; expect(runValidateDraft(draft, f).length).toBeGreaterThan(0) }
    f.second.grouping = { mode: 'explicit', groups: [{ id: 'future-group', members: { opinion: ['future-node'] } }] }
    expect(runValidateDraft(f.draft, f).length).toBeGreaterThan(0)
  })
  it('accepts branch/join dependencies up to 64 steps with unique stable identities', () => {
    // 步数上限不当作节点上限；同节点可被多个独立步骤明确引用。
    const f = fixture(), draft = runCreateDraft(f.seed, f.catalog, f.snapshot), first = step(draft)
    draft.steps = Array.from({ length: 64 }, (/* 不用数组占位值。 */ _value, /* 稳定测试步骤号。 */ index) => {
      // 前四步形成分叉和汇聚，剩余步骤是同范围内独立合法处理。
      let dependsOn: string[] = []
      if (index === 1 || index === 2) dependsOn = ['step-0']
      else if (index === 3) dependsOn = ['step-1', 'step-2']
      return { ...structuredClone(first), id: `step-${index}`, dependsOn }
    })
    expect(runValidateDraft(draft, f)).toEqual([]); expect(runReadScopeNodeIds(draft)).toEqual([f.input.id])
    draft.steps.push({ ...structuredClone(first), id: 'step-64' }); expect(runValidateDraft(draft, f).length).toBeGreaterThan(0)
    expect(runValidateDraft({ ...draft, steps: [] }, f).length).toBeGreaterThan(0)
    draft.steps.pop(); draft.steps[1].id = draft.steps[0].id; expect(runValidateDraft(draft, f).length).toBeGreaterThan(0)
  })
  it('invalidates only a changed step and its descendants while ignoring all material refs', () => {
    // 无关分支保持选择；改材料本身不反向清空该材料，mode也不影响目标。
    const f = multiFixture(), unrelated = structuredClone(f.first); unrelated.id = 'unrelated-step'; f.draft.steps.push(unrelated)
    const before = f.draft.steps.map((/* 每步稳定身份。 */ current) => /* 与真实UI共用key。 */ runReadSelectionKey(f.draft, f.snapshot, true, current.id))
    f.first.libraryClaimRefs?.push({ entryId: 'new-material', contentDigest: 'new-digest' }); f.draft.mode = 'auto'; f.draft.regenerate = true
    expect(f.draft.steps.map((/* 每步稳定身份。 */ current) => /* 材料和全局模式不改变目标。 */ runReadSelectionKey(f.draft, f.snapshot, true, current.id))).toEqual(before)
    f.first.input[0].source = { kind: 'scope', nodeIds: ['b'] }
    expect(runReadSelectionKey(f.draft, f.snapshot, true, f.first.id)).not.toBe(before[0]); expect(runReadSelectionKey(f.draft, f.snapshot, true, f.second.id)).not.toBe(before[1])
    expect(runReadSelectionKey(f.draft, f.snapshot, true, unrelated.id)).toBe(before[2])
    const changed = runReadSelectionKey(f.draft, f.snapshot, true, f.second.id); f.nodes[1].revision += 1
    expect(runReadSelectionKey(f.draft, f.snapshot, true, f.second.id)).not.toBe(changed)
    expect(runReadSelectionKey(f.draft, f.snapshot, false, unrelated.id)).not.toBe(before[2])
  })
})
