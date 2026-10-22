import { describe, expect, it } from 'vitest'

import type { DataTypeDefinition, DefinitionCatalog } from '../../contracts/data-definition'
import type { EvidenceBasisRef, EvidenceLibraryEntry, EvidenceRelationNode, EvidenceRelationsView, EvidenceRelationSnapshot } from '../../contracts/evidence-library'
import { EvidencePresentationMessage, evidenceBuildCollectParams, evidenceCreateCollectDraft, evidenceFindFixedBasisNode, evidenceReadBasis, evidenceReadFixedPresentation, evidenceReadJudgment, evidenceReadSceneNodes, evidenceReadScope } from '../../apps/ui/features/evidence-library/evidence-presentation'

const time = '2026-10-06T00:00:00.000Z'

function fixedEntry(): EvidenceLibraryEntry {
  // 建立原文为否定陈述的库快照，测试展示不会翻转陈述或丢失数字 0。
  return { id: 'entry', workspaceId: 'workspace', revision: 1,
    claim: { origin: { mapId: 'source-map', nodeId: 'source-claim', revision: 3 }, type: { id: 'factcheck.claim', version: 1 }, definitionDigest: 'definition-digest',
      nodeSnapshot: { id: 'source-claim', revision: 3, typeId: 'factcheck.claim', typeVersion: 1,
        payload: { content: '该事件没有发生。\n数字 0 原样保留。', count: 0, reviewed: false }, createdAt: time, updatedAt: time } },
    confidence: 0, applicability: { subject: '主体 A', event: null, time: null, place: null, conditions: ['仅在条件甲下', '排除条件乙'] },
    decision: { reason: '原陈述确定错误。', basisRefs: [] }, collectedBy: 'collector', collectedAt: time,
    contentDigest: 'content-digest', status: 'active', statusReason: null, replacementEntryId: null }
}

function definition(
  /* 测试目录内精确版本，旧版和新版采用不同标题。 */ version: number,
): DataTypeDefinition {
  // 建立精确版本的注册展示定义，字段顺序区别用于发现误用最新版本。
  return { id: 'factcheck.claim', version, title: version === 1 ? '原版事实' : '新版事实',
    schema: { type: 'object', properties: { content: { type: 'string' }, count: { type: 'number' }, reviewed: { type: 'boolean' } } },
    successorTypes: [], references: [], agentProjection: { include: ['/content'], mapEntryFilters: [] },
    presentation: { fieldOrder: ['/content', '/count', '/reviewed'], fieldLabels: { '/content': '原陈述' } } }
}

function catalog(
  /* 本用例拥有的类型版本列表。 */ dataTypes: DataTypeDefinition[],
): DefinitionCatalog {
  // 仅为读取投影提供真实类型目录结构，不模拟后端库行为。
  return { revision: 1, packages: [], index: [], dataTypes, transitions: [] }
}

function fixedBasisView(): EvidenceRelationsView & { snapshot: EvidenceRelationSnapshot } {
  // 同nodeId在两个Map保留独立完整身份，普通材料类型不必是Claim。
  const entry = fixedEntry()
  const root: EvidenceRelationNode = { key: 'root', ref: { ...entry.claim.origin },
    nodeSnapshot: entry.claim.nodeSnapshot, definitionDigest: 'root-definition', role: 'claim' }
  const basis: EvidenceRelationNode = { key: 'other-map-material', ref: { mapId: 'other-map', nodeId: 'source-claim', revision: 7 },
    nodeSnapshot: { ...entry.claim.nodeSnapshot, revision: 7, typeId: 'demo.material', payload: { text: '另一图固定材料' } },
    definitionDigest: 'material-definition', role: 'basis' }
  return { workspaceId: entry.workspaceId, entryId: entry.id, contentDigest: entry.contentDigest, snapshot: {
    version: 1, capturedAt: time, rootKey: root.key, truncated: false, nodes: [root, basis],
    edges: [{ key: 'basis-to-root', kind: 'basis', from: basis.key, to: root.key, basisIndex: 1 }],
  } }
}

describe('evidence library presentation', () => {
  // 覆盖固定 0、来源版本和显式输入的产品语义，防止通用 Map 投影改写库含义。
  it('keeps zero as a completely false statement and retains original negative text', () => {
    // 数字 0 的文案必须是确定错误，原负面陈述仍从固定快照读取。
    const entry = fixedEntry()
    const result = evidenceReadFixedPresentation(entry, catalog([definition(1)]))
    expect(evidenceReadJudgment(entry.confidence)).toBe('0 · 确定错误')
    expect(result.fields.map((/* 已生成的只读字段。 */ field) => /* 汇总实际展示值供断言。 */ field.value))
      .toEqual(['该事件没有发生。\n数字 0 原样保留。', 0, false])
    expect(result.fields[0].kind).toBe('text')
    expect(entry.claim.nodeSnapshot.payload.content).toBe('该事件没有发生。\n数字 0 原样保留。')
  })

  it('uses exact type version and shows complete JSON when only a newer definition exists', () => {
    // 更新目录不能让固定旧快照套用新版标签或丢失未知字段；缺失旧定义时显示中文通用标题。
    const entry = fixedEntry()
    expect(evidenceReadFixedPresentation(entry, catalog([definition(2), definition(1)])).heading).toBe('原版事实')
    const missing = evidenceReadFixedPresentation(entry, catalog([definition(2)]))
    expect(missing.heading).toBe('数据节点')
    expect(missing.fields).toHaveLength(1)
    expect(missing.fields[0].value).toEqual(entry.claim.nodeSnapshot.payload)
  })

  it('uses library entry identity for actual scene nodes and greys historical entries', () => {
    // 库场景不把来源 Claim 当成条目身份，也不生成关系端点。
    const nodes = evidenceReadSceneNodes([
      { id: 'entry-zero', content: '陈述零', confidence: 0, contentDigest: 'zero', status: 'active' },
      { id: 'entry-one', content: '陈述一', confidence: 1, contentDigest: 'one', status: 'withdrawn' },
    ])
    expect(nodes.map((/* 实际投影场景节点。 */ node) => /* 对比视觉身份与状态语义。 */ [node.id, node.title, node.stale]))
      .toEqual([['entry-zero', '0 · 确定错误', false], ['entry-one', '1 · 确定正确', true]])
    expect(evidenceReadSceneNodes([])).toEqual([])
  })

  it('shows exact scope and existing basis without inferring links from free text', () => {
    // 原条件原样显示，人工文本不会变成可导航节点引用。
    expect(evidenceReadScope(fixedEntry().applicability)).toContainEqual({ label: '条件', value: '仅在条件甲下\n排除条件乙' })
    const source = { mapId: 'map', nodeId: 'claim', revision: 7 }
    const refs: EvidenceBasisRef[] = [{ kind: 'manual', text: '见 map/claim' }, { kind: 'node', ref: source },
      { kind: 'library', ref: { entryId: 'other-entry', contentDigest: 'fixed-digest' } },
      { kind: 'asset', assetId: 'asset', sha256: 'asset-digest' }]
    const basis = evidenceReadBasis(refs)
    expect(basis.map((/* 每项真实保存依据的展示投影。 */ item) => /* 只提取明确来源节点的导航身份。 */ item.claim)).toEqual([null, source, null, null])
    expect(basis[1].text).toContain('原版本 7')
    expect(basis[2].text).toContain('fixed-digest')
    expect(basis.map((
      /* 展示行对应的完整依据，而不是推断出来的当前目标。 */ item,
    ) => /* 保留原顺序索引及四类精确引用供导航。 */ ({ basisIndex: item.basisIndex, basis: item.basis })))
      .toEqual(refs.map((
        /* 原来冻结的依据协议值。 */ basis,
        /* 原依据在收录决定中的位置。 */ basisIndex,
      ) => /* 导航位置不能受展示排序改变。 */ ({ basisIndex, basis })))
  })

  it('shows unknown scope as unspecified rather than universal applicability', () => {
    // 空范围只表达尚未注明，不给固定判断增加普遍适用的含义。
    expect(evidenceReadScope({ subject: null, event: null, time: null, place: null, conditions: [] })).toEqual([
      { label: '主体', value: '未注明' }, { label: '事件', value: '未注明' }, { label: '时间', value: '未注明' },
      { label: '地点', value: '未注明' }, { label: '条件', value: '未注明' },
    ])
  })

  it('requires an explicit judgment and reason before creating a collection intent', () => {
    // 新草稿不替用户默认选择 0 或 1，空理由不能进入命令状态。
    const source = { mapId: 'map', nodeId: 'claim', revision: 0 }
    const draft = evidenceCreateCollectDraft()
    expect(draft).toHaveProperty('basisRefs', [])
    expect(draft).not.toHaveProperty('basis')
    expect(evidenceBuildCollectParams(source, draft)).toEqual({ ok: false, message: EvidencePresentationMessage.CONFIDENCE_REQUIRED })
    draft.confidence = '0'
    expect(evidenceBuildCollectParams(source, draft)).toEqual({ ok: false, message: EvidencePresentationMessage.REASON_REQUIRED })
  })

  it('creates numeric zero with explicit empty scope and independent source data', () => {
    // 将表单字符串 0 编码为数字，输出独立参数而不传入 Vue 的来源代理。
    const source = { mapId: 'map', nodeId: 'claim', revision: 4 }
    // 内部草稿改用统一有序basisRefs，人工原文保留边缘空白，收录理由仍归一化。
    const draft = { ...evidenceCreateCollectDraft(), confidence: '0' as const, reason: '  已核实错误  ', conditions: '\n 条件一 \r\n\n 条件二 ',
      basisRefs: [{ kind: 'manual' as const, text: '  人工复核依据  ' }] }
    const result = evidenceBuildCollectParams(source, draft)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.params).toEqual({ claim: source, confidence: 0, applicability: { subject: null, event: null, time: null, place: null, conditions: ['条件一', '条件二'] }, reason: '已核实错误', basisRefs: [{ kind: 'manual', text: '  人工复核依据  ' }] })
    expect(result.params.claim).not.toBe(source)
    source.revision = 5
    expect(result.params.claim.revision).toBe(4)
    expect(draft.reason).toBe('  已核实错误  ')
  })

  it('copies all four basis kinds in order and keeps same node ids from different Maps distinct', () => {
    // 依据只记录明确选择的原版本和摘要，构造结果不与可变表单共享嵌套引用。
    const source = { mapId: 'consumer-map', nodeId: 'claim', revision: 3 }
    const manual = { kind: 'manual' as const, text: '  第一行依据\n第二行依据  ' }
    const first = { kind: 'node' as const, ref: { mapId: 'map-a', nodeId: 'same-node', revision: 2 } }
    const second = { kind: 'node' as const, ref: { mapId: 'map-b', nodeId: 'same-node', revision: 8 } }
    const asset = { kind: 'asset' as const, assetId: 'file', sha256: 'a'.repeat(64) }
    const library = { kind: 'library' as const, ref: { entryId: 'entry', contentDigest: 'b'.repeat(64) } }
    const refs = [manual, first, asset, library, second]
    const draft = { ...evidenceCreateCollectDraft(), confidence: '1' as const, reason: '明确收录理由', basisRefs: refs }
    const before = structuredClone(draft)

    const result = evidenceBuildCollectParams(source, draft)

    expect(result.ok).toBe(true)
    expect(draft).toEqual(before)
    if (!result.ok) return
    expect(result.params.basisRefs).toEqual(before.basisRefs)
    manual.text = '草稿后改'
    first.ref.revision = 99
    second.ref.mapId = 'changed-map'
    asset.sha256 = 'c'.repeat(64)
    library.ref.contentDigest = 'd'.repeat(64)
    refs.reverse()
    expect(result.params.basisRefs).toEqual(before.basisRefs)
  })

  it.each([64, 65])('checks the total basis limit for %s ordered items', (
    /* 四种依据共同使用的总条数，不为每个分支单独计算容量。 */ count,
  ) => {
    // 64项可以完整提交，65项必须在构造参数前明确拒绝，不截断列表。
    const basisRefs: EvidenceBasisRef[] = Array.from({ length: count }, (
      /* 数组占位值。 */ _value,
      /* 原始依据顺序。 */ index,
    ) => /* 为上限检查生成非空人工文本。 */ ({ kind: 'manual', text: `依据 ${index + 1}` }))
    const draft = { ...evidenceCreateCollectDraft(), confidence: '0' as const, reason: '容量检查', basisRefs }
    const result = evidenceBuildCollectParams({ mapId: 'map', nodeId: 'claim', revision: 0 }, draft)
    expect(result.ok).toBe(count === 64)
    if (result.ok) expect(result.params.basisRefs).toHaveLength(64)
    expect(draft.basisRefs).toHaveLength(count)
  })

  it('refuses a blank manual basis without trimming or dropping valid original text', () => {
    // 空白行不是一份有效人工依据，不能在提交时静默删除它再当作成功。
    const draft = { ...evidenceCreateCollectDraft(), confidence: '1' as const, reason: '仍有明确收录理由',
      basisRefs: [{ kind: 'manual' as const, text: ' \n\t ' }] }
    expect(evidenceBuildCollectParams({ mapId: 'map', nodeId: 'claim', revision: 0 }, draft).ok).toBe(false)
    expect(draft.basisRefs[0].text).toBe(' \n\t ')
  })

  it('finds a fixed basis by its edge and complete identity even when roles merge or the view is truncated', () => {
    // 已明确捕获的依据不会仅因角色合并或其他邻域截断而变为不可读。
    expect(evidenceFindFixedBasisNode).toBeTypeOf('function')
    const view = fixedBasisView()
    const [root, basis] = view.snapshot.nodes
    expect(evidenceFindFixedBasisNode(view, 1, basis.ref)).toEqual(basis)
    basis.role = 'upstream'
    view.snapshot.truncated = true
    expect(evidenceFindFixedBasisNode(view, 1, basis.ref)).toEqual(basis)
    view.snapshot.edges[0].from = root.key
    expect(evidenceFindFixedBasisNode(view, 1, root.ref)).toEqual(root)
  })

  it('does not substitute a fixed basis when its snapshot, index, root edge or complete identity is missing', () => {
    // 不从nodeId猜Map和版本，也不把另一个依据边或当前图当作所需历史快照。
    expect(evidenceFindFixedBasisNode).toBeTypeOf('function')
    const view = fixedBasisView()
    const ref = view.snapshot.nodes[1].ref
    expect(evidenceFindFixedBasisNode(null, 1, ref)).toBeNull()
    expect(evidenceFindFixedBasisNode({ ...view, snapshot: null }, 1, ref)).toBeNull()
    expect(evidenceFindFixedBasisNode(view, 2, ref)).toBeNull()
    expect(evidenceFindFixedBasisNode(view, 1, { ...ref, mapId: 'source-map' })).toBeNull()
    expect(evidenceFindFixedBasisNode(view, 1, { ...ref, nodeId: 'other-node' })).toBeNull()
    expect(evidenceFindFixedBasisNode(view, 1, { ...ref, revision: 6 })).toBeNull()
    view.snapshot.edges[0].to = 'not-root'
    expect(evidenceFindFixedBasisNode(view, 1, ref)).toBeNull()
  })

  it('rejects partial and reversed times while preserving explicit fixed boundaries', () => {
    // 时间范围需要完整且有序，合法值归一到协议 UTC 时间。
    const source = { mapId: 'map', nodeId: 'claim', revision: 1 }
    const draft = { ...evidenceCreateCollectDraft(), confidence: '1' as const, reason: '正确', from: time }
    expect(evidenceBuildCollectParams(source, draft)).toEqual({ ok: false, message: EvidencePresentationMessage.TIME_INCOMPLETE })
    draft.to = '2026-10-05T00:00:00.000Z'
    expect(evidenceBuildCollectParams(source, draft)).toEqual({ ok: false, message: EvidencePresentationMessage.TIME_INVALID })
    draft.to = 'invalid-time'
    expect(evidenceBuildCollectParams(source, draft)).toEqual({ ok: false, message: EvidencePresentationMessage.TIME_INVALID })
    draft.to = '2026-10-07T00:00:00.000Z'
    const result = evidenceBuildCollectParams(source, draft)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.params.applicability.time).toEqual({ from: time, to: '2026-10-07T00:00:00.000Z' })
  })
})
