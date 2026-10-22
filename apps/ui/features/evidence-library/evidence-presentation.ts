// 将库快照与收录草稿投影为界面内容，保留原陈述和固定 0/1 的含义。
import type { DefinitionCatalog } from '../../../../contracts/data-definition'
import type { EvidenceBasisRef, EvidenceClaimRef, EvidenceEntrySummary, EvidenceLibraryEntry, EvidenceRelationEdge, EvidenceRelationNode, EvidenceRelationsView } from '../../../../contracts/evidence-library'
import { graphArrangeScene, type Graph3DEdge, type Graph3DLayout, type GraphSceneNodeInput } from '../graph/graph-3d-layout'
import type { EvidenceCollectInput } from './evidence-state'
import { graphReadNodeText } from '../graph/graph-layout'
import { readerFindDefinition, readerReadFieldLabel, readerReadFields, readerReadHeading, type ReaderField } from '../reader/reader-content'
import { readerSourceRangeStatus, type ReaderSourceRange } from '../reader/reader-sources'

export interface EvidenceFixedPresentation { heading: string; fields: ReaderField[] }
export interface EvidenceScopeRow { label: string; value: string }
export interface EvidenceBasisPresentation {
  key: string
  label: string
  text: string
  claim: EvidenceClaimRef | null
  basisIndex: number
  basis: EvidenceBasisRef
}
export interface EvidenceBasisOpen {
  entryId: string
  contentDigest: string
  basisIndex: number
  basis: EvidenceBasisRef
}
export interface EvidenceRelationDetail {
  key: string
  relation: EvidenceRelationEdge
  from: EvidenceRelationNode
  to: EvidenceRelationNode
  fromTitle: string
  toTitle: string
  title: string
  fieldLabel: string | null
  basisNumber: number | null
}
export interface EvidenceFixedSourceNote {
  relationKey: string
  number: number
  source: EvidenceRelationNode
  target: EvidenceRelationNode
  ranges: ReaderSourceRange[]
}
export interface EvidenceCollectDraft {
  confidence: '0' | '1' | ''
  subject: string
  event: string
  from: string
  to: string
  place: string
  conditions: string
  reason: string
  basisRefs: EvidenceBasisRef[]
}
export enum EvidencePresentationMessage {
  CONFIDENCE_REQUIRED = '请选择确定错误（0）或确定正确（1）。',
  REASON_REQUIRED = '请填写收录理由。',
  TIME_INCOMPLETE = '时间范围需要同时填写起始与结束时间。',
  TIME_INVALID = '请填写有效时间，并确保结束时间不早于起始时间。',
  BASIS_LIMIT = '收录依据最多64项。',
  BASIS_TEXT_REQUIRED = '人工依据不能只包含空白。',
  ENTRY_UNAVAILABLE = '条目当前不可用。',
  RELATION_SNAPSHOT_MISSING = '此条目收录时未保存关系快照。',
  RELATION_TRUNCATED = '关系快照已截断；达到节点、关系或深度上限，当前链路不完整。',
}
export type EvidenceCollectDraftResult =
  | { ok: true; params: EvidenceCollectInput }
  | { ok: false; message: EvidencePresentationMessage }

export function evidenceReadJudgment(
  /* 库条目已经确定的数字判断，0 表示原陈述完全错误。 */ confidence: 0 | 1,
): string {
  // 将固定判断写成完整语义，避免把 0 解释为缺乏依据。
  return confidence === 0 ? '0 · 确定错误' : '1 · 确定正确'
}

export function evidenceReadStatus(
  /* 库条目的当前可用状态，不影响收录时固定正文。 */ status: EvidenceLibraryEntry['status'],
): string {
  // 为当前库状态提供简短标签，固定判断仍在独立位置显示。
  return status === 'active' ? '有效' : status === 'withdrawn' ? '已撤回' : '已替代'
}

export function evidenceReadFixedPresentation(
  /* evidence.get 返回的完整固定快照，单页不读取现行来源节点。 */ entry: EvidenceLibraryEntry,
  /* 工作区精确版本目录；缺少旧定义时保留原始 payload 展示。 */ catalog: DefinitionCatalog | null,
): EvidenceFixedPresentation {
  // 复用 Reader 字段规则，只以库内 nodeSnapshot 及精确类型版本生成正文。
  const node = entry.claim.nodeSnapshot
  const definition = readerFindDefinition(node, catalog, [])
  return { heading: readerReadHeading(node, definition), fields: readerReadFields(node, definition) }
}

export function evidenceReadSceneNodes(
  /* 已真实加载的摘要；条目身份与来源 Claim 身份不互相替代。 */ items: readonly EvidenceEntrySummary[],
): GraphSceneNodeInput[] {
  // 仅投影已加载条目，不创造来源节点、连线或未加载的总数。
  return items.map((/* 当前实际收录条目的摘要。 */ item) => {
    // 固定数字与状态进入节点标签，撤回节点由公共场景显示灰色。
    return { id: item.id, typeId: 'factcheck.claim', title: evidenceReadJudgment(item.confidence),
      summary: item.content, stale: item.status !== 'active', color: item.confidence === 0 ? '#9e4034' : '#557469',
      // 摘要没有收录时间，空排序键让公共布局只按真实 entryId 稳定排列。
      createdAt: '' }
  })
}

export function evidenceReadRelationSceneKey(
  /* 当前邻域所属的真实库条目身份。 */ entryId: string,
  /* 保存关系节点完整 key，不以 nodeId 猜测其身份。 */ nodeKey: string,
  /* 当前固定快照的根节点 key。 */ rootKey: string,
): string {
  // 根沿用 actual entryId，其他节点保留库根和完整关系身份组成的独立 key。
  return nodeKey === rootKey ? entryId : JSON.stringify(['evidence-relation', entryId, nodeKey])
}

export function evidenceReadRelationScene(
  /* 当前搜索真实加载的库摘要，不作为关系端点来源。 */ items: readonly EvidenceEntrySummary[],
  /* 当前 get 接纳的固定库根，撤回后即使不在搜索也保持可见。 */ entry: EvidenceLibraryEntry | null,
  /* 当前选择 evidence.relations 返回的固定关系包。 */ view: EvidenceRelationsView | null,
  /* 精确版本目录，仅用于保存节点的展示标签。 */ catalog: DefinitionCatalog | null,
): Graph3DLayout {
  // 把已加载库条目与当前根的实际固定邻域合成共用场景，不造假业务 Map。
  const nodes = new Map(evidenceReadSceneNodes(items).map((/* 已加载库条目展示投影。 */ node) => /* 以真实条目身份保留浏览节点。 */ [node.id, node]))
  if (entry) {
    nodes.set(entry.id, { id: entry.id, typeId: entry.claim.type.id, title: evidenceReadJudgment(entry.confidence),
      summary: graphReadNodeText(entry.claim.nodeSnapshot, catalog), stale: entry.status !== 'active',
      color: entry.confidence === 0 ? '#9e4034' : '#557469', createdAt: '' })
  }
  const snapshot = view?.snapshot
  if (!view || !snapshot || (entry && (view.entryId !== entry.id || view.workspaceId !== entry.workspaceId || view.contentDigest !== entry.contentDigest))) {
    return graphArrangeScene([...nodes.values()], [])
  }
  const root = nodes.get(view.entryId)
  if (!root) return graphArrangeScene([...nodes.values()], [])
  const colors: Record<EvidenceRelationNode['role'], string> = {
    claim: '#557469', upstream: '#aa673a', downstream: '#777092', basis: '#ad8a43', dependency: '#53778b',
  }
  const ids = new Map<string, string>()
  for (const node of snapshot.nodes) {
    const id = evidenceReadRelationSceneKey(view.entryId, node.key, snapshot.rootKey)
    ids.set(node.key, id)
    if (node.key === snapshot.rootKey) continue
    const presentation = evidenceReadRelationPresentation(node, catalog)
    nodes.set(id, { id, typeId: node.nodeSnapshot.typeId, title: `${evidenceReadRelationRole(node.role)} · ${presentation.heading}`,
      summary: graphReadNodeText(node.nodeSnapshot, catalog), stale: node.nodeSnapshot.validity === 'stale',
      color: colors[node.role], createdAt: node.nodeSnapshot.createdAt })
  }
  const edges: Graph3DEdge[] = []
  for (const edge of snapshot.edges) {
    const from = ids.get(edge.from), to = ids.get(edge.to)
    if (!from || !to) continue
    edges.push({ id: JSON.stringify(['evidence-relation-edge', view.entryId, edge.key]), from, to,
      kind: edge.kind === 'graph' ? edge.edge.kind : 'reference' })
  }
  return graphArrangeScene([...nodes.values()], edges)
}

export function evidenceReadRelationPresentation(
  /* 已保存的邻域节点完整快照，不是当前 Map 节点。 */ node: EvidenceRelationNode,
  /* 以精确 typeId/version 读取展示定义，缺失则保留完整 JSON。 */ catalog: DefinitionCatalog | null,
): EvidenceFixedPresentation {
  // 邻域单页复用 ReaderField，Opinion 原分数保持原值，不附加库根 0/1 判断。
  const definition = readerFindDefinition(node.nodeSnapshot, catalog, [])
  return { heading: readerReadHeading(node.nodeSnapshot, definition), fields: readerReadFields(node.nodeSnapshot, definition) }
}

export function evidenceReadRelationRole(
  /* 捕获时保存的节点相对根 Claim 的实际角色。 */ role: EvidenceRelationNode['role'],
): string {
  // 用业务角色解释固定邻域，引用材料与结构上游、下游保持区别。
  switch (role) {
    case 'claim': return '收录事实'
    case 'upstream': return '来源上游'
    case 'downstream': return '核查下游'
    case 'basis': return '收录依据'
    case 'dependency': return '引用材料'
  }
}

export function evidenceReadRelationDetails(
  /* 已接纳且与当前库根关联的固定关系视图，旧记录可没有快照。 */ view: EvidenceRelationsView | null,
  /* 当前阅读的完整保存节点key，null表示固定根，不按nodeId猜测。 */ nodeKey: string | null,
  /* 仅用于精确类型的字段及标题说明，缺少时保留原路径。 */ catalog: DefinitionCatalog | null,
): EvidenceRelationDetail[] {
  // 保留每条真实边身份和原始元信息，不按端点合并或借节点角色推断关系种类。
  const snapshot = view?.snapshot
  if (!snapshot) return []
  const key = nodeKey ?? snapshot.rootKey
  const nodes = new Map(snapshot.nodes.map((/* 一份保存的精确节点。 */ node) => /* 同Map同ID不同版本仍有独立key。 */ [node.key, node]))
  if (!nodes.has(key)) return []
  return snapshot.edges.flatMap((/* 已保存的一条graph、payload或basis关系。 */ relation) => {
    // 只解释当前节点相邻的实际关系，悬空端点不补当前图。
    if (relation.from !== key && relation.to !== key) return []
    const from = nodes.get(relation.from), to = nodes.get(relation.to)
    if (!from || !to) return []
    const title = relation.kind === 'graph' ? relation.edge.kind === 'successor' ? '结构后继' : '图中引用'
      : relation.kind === 'payload' ? '字段引用' : '收录依据'
    const definition = readerFindDefinition(from.nodeSnapshot, catalog, [])
    return [{ key: relation.key, relation, from, to,
      fromTitle: evidenceReadRelationPresentation(from, catalog).heading,
      toTitle: evidenceReadRelationPresentation(to, catalog).heading,
      title, fieldLabel: relation.kind === 'payload' ? readerReadFieldLabel(relation.path, definition) : null,
      basisNumber: relation.kind === 'basis' ? relation.basisIndex + 1 : null }]
  })
}

export function evidenceReadFixedSourceNotes(
  /* 仅使用库关系包内保存的节点和边，绝不读取现行来源图。 */ view: EvidenceRelationsView | null,
  /* 当前阅读节点的完整保存key，null表示固定库根。 */ nodeKey: string | null,
): EvidenceFixedSourceNote[] {
  // 按实际后继边稳定编号，离散范围分别核对固定正文版本与quote，旧摘录原样保留。
  const snapshot = view?.snapshot
  if (!snapshot) return []
  const key = nodeKey ?? snapshot.rootKey
  const nodes = new Map(snapshot.nodes.map((/* 一份精确固定节点。 */ node) => /* 只按复合保存key解析端点。 */ [node.key, node]))
  if (!nodes.has(key)) return []
  return snapshot.edges.filter((/* 一条真实保存关系。 */ relation): relation is Extract<EvidenceRelationEdge, { kind: 'graph' }> =>
    /* 只有真实后继边具有来源行语义，引用与依据不自动成为行标注。 */ relation.kind === 'graph' && relation.edge.kind === 'successor')
    .sort((/* 较早的固定后继边。 */ left, /* 另一条固定后继边。 */ right) =>
      /* 全快照统一编号，使同一边在根和邻域视图中保持相同脚注号。 */ left.edge.createdAt.localeCompare(right.edge.createdAt) || left.key.localeCompare(right.key))
    .flatMap((/* 真实后继关系。 */ relation, /* 本关系在整个快照来源边中的固定顺序。 */ index) => {
      // 未标行的真实来源仍显示空范围，不从正文或当前图生成新锚点。
      if (relation.from !== key && relation.to !== key) return []
      const source = nodes.get(relation.from), target = nodes.get(relation.to)
      if (!source || !target) return []
      return [{ relationKey: relation.key, number: index + 1, source, target,
        ranges: (relation.edge.sourceAnchors ?? []).map((/* 收录时保存的一段来源定位。 */ anchor) =>
          /* 使用固定nodeSnapshot核对，当前Map的后续版本不参与。 */ ({ anchor,
            status: readerSourceRangeStatus(source.nodeSnapshot, anchor),
            label: anchor.startLine === anchor.endLine ? `第 ${anchor.startLine} 行` : `第 ${anchor.startLine}–${anchor.endLine} 行` })) }]
    })
}

export function evidenceReadRelationNotice(
  /* 当前选择的固定关系视图；null 表示尚未完成读取。 */ view: EvidenceRelationsView | null,
): string {
  // 区分旧条目未保存和已保存但达到捕获边界，独立 Claim 的空邻域不误标缺失。
  if (!view) return ''
  if (view.snapshot === null) return EvidencePresentationMessage.RELATION_SNAPSHOT_MISSING
  return view.snapshot.truncated ? EvidencePresentationMessage.RELATION_TRUNCATED : ''
}

export function evidenceReadScope(
  /* 收录时冻结的适用范围，空值表示未知，不代表普遍适用。 */ scope: EvidenceLibraryEntry['applicability'],
): EvidenceScopeRow[] {
  // 逐项展示冻结范围，保留原条件和显式时间边界。
  return [
    { label: '主体', value: scope.subject ?? '未注明' },
    { label: '事件', value: scope.event ?? '未注明' },
    { label: '时间', value: scope.time ? `${scope.time.from} 至 ${scope.time.to}` : '未注明' },
    { label: '地点', value: scope.place ?? '未注明' },
    { label: '条件', value: scope.conditions.length ? scope.conditions.join('\n') : '未注明' },
  ]
}

export function evidenceReadBasis(
  /* 收录决定冻结的依据引用；这里只展示，不推断上下游。 */ refs: readonly EvidenceBasisRef[],
): EvidenceBasisPresentation[] {
  // 为已有依据生成可读标签，只有真实节点引用带来源打开身份。
  return refs.map((/* 这份已冻结的具体依据。 */ basis, /* 在收录依据中的稳定排列位置。 */ index) => {
    // 根据依据种类展示原文或固定身份，保留版本与摘要信息。
    const identity = { key: `${index}:${basis.kind}`, basisIndex: index, basis: evidenceCloneBasisRef(basis) }
    switch (basis.kind) {
      case 'manual': return { ...identity, label: '人工依据', text: basis.text, claim: null }
      case 'node': return { ...identity, label: '节点依据', text: `${basis.ref.mapId} / ${basis.ref.nodeId} · 原版本 ${basis.ref.revision}`, claim: { ...basis.ref } }
      case 'asset': return { ...identity, label: '资产依据', text: `${basis.assetId}\nSHA-256 ${basis.sha256}`, claim: null }
      case 'library': return { ...identity, label: '库条目依据', text: `${basis.ref.entryId}\n内容摘要 ${basis.ref.contentDigest}`, claim: null }
    }
  })
}

export function evidenceFindFixedBasisNode(
  /* 当前条目已接纳的固定关系包，旧条目可能没有快照。 */ view: EvidenceRelationsView | null,
  /* 依据在原收录决定中的顺序索引，不按当前展示顺序重排。 */ basisIndex: number,
  /* 原依据保存的完整Map、节点及版本身份。 */ ref: EvidenceClaimRef,
): EvidenceRelationNode | null {
  // 只读取明确捕获的依据边；角色合并与其他邻域截断不取消已经保存的依据。
  const snapshot = view?.snapshot
  if (!snapshot) return null
  for (const edge of snapshot.edges) {
    if (edge.kind !== 'basis' || edge.basisIndex !== basisIndex || edge.to !== snapshot.rootKey) continue
    const node = snapshot.nodes.find((
      /* 收录时保存的一份完整材料。 */ item,
    ) => /* 同nodeId跨Map或版本不同均不是这份固定依据。 */ item.key === edge.from
      && item.ref.mapId === ref.mapId && item.ref.nodeId === ref.nodeId && item.ref.revision === ref.revision)
    if (node) return node
  }
  return null
}

function evidenceCloneBasisRef(
  /* 已由明确选择构造的四类依据，只复制允许提交和导航的协议字段。 */ basis: EvidenceBasisRef,
): EvidenceBasisRef {
  // 解除嵌套ref与表单的关联，保留人工原文、顺序以及精确版本和摘要。
  switch (basis.kind) {
    case 'manual': return { kind: 'manual', text: basis.text }
    case 'node': return { kind: 'node', ref: { mapId: basis.ref.mapId, nodeId: basis.ref.nodeId, revision: basis.ref.revision } }
    case 'asset': return { kind: 'asset', assetId: basis.assetId, sha256: basis.sha256 }
    case 'library': return { kind: 'library', ref: { entryId: basis.ref.entryId, contentDigest: basis.ref.contentDigest } }
  }
}

export function evidenceCreateCollectDraft(): EvidenceCollectDraft {
  // 为新来源建立未选判断的独立草稿，避免默认替用户作出确定判断。
  return { confidence: '', subject: '', event: '', from: '', to: '', place: '', conditions: '', reason: '', basisRefs: [] }
}

export function evidenceBuildCollectParams(
  /* 打开收录对话框时绑定的来源精确版本。 */ claim: EvidenceClaimRef,
  /* 当前对话框独占草稿，函数只读取而不修改。 */ draft: EvidenceCollectDraft,
): EvidenceCollectDraftResult {
  // 校验必要界面输入并把未注明的范围记为 null，保持 0 为数字且原来源身份不变。
  if (draft.confidence !== '0' && draft.confidence !== '1') return { ok: false, message: EvidencePresentationMessage.CONFIDENCE_REQUIRED }
  if (!draft.reason.trim()) return { ok: false, message: EvidencePresentationMessage.REASON_REQUIRED }
  if (draft.basisRefs.length > 64) return { ok: false, message: EvidencePresentationMessage.BASIS_LIMIT }
  if (draft.basisRefs.some((
    /* 用户按顺序明确加入的一份依据。 */ basis,
  ) => /* 人工原文保留空白，但整份空白不是有效材料。 */ basis.kind === 'manual' && !basis.text.trim())) {
    return { ok: false, message: EvidencePresentationMessage.BASIS_TEXT_REQUIRED }
  }
  if (!!draft.from !== !!draft.to) return { ok: false, message: EvidencePresentationMessage.TIME_INCOMPLETE }
  let time: EvidenceLibraryEntry['applicability']['time'] = null
  if (draft.from && draft.to) {
    const from = new Date(draft.from), to = new Date(draft.to)
    if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from > to) {
      return { ok: false, message: EvidencePresentationMessage.TIME_INVALID }
    }
    time = { from: from.toISOString(), to: to.toISOString() }
  }
  return { ok: true, params: {
    claim: { mapId: claim.mapId, nodeId: claim.nodeId, revision: claim.revision }, confidence: draft.confidence === '0' ? 0 : 1,
    applicability: { subject: draft.subject.trim() || null, event: draft.event.trim() || null, time,
      place: draft.place.trim() || null, conditions: draft.conditions.split(/\r?\n/).map(
        (/* 用户每行填写的一条适用条件。 */ condition) => /* 去掉条件边缘空白，保留正文含义。 */ condition.trim(),
      ).filter((/* 已去除边缘空白的条件。 */ condition) => /* 空行没有独立适用条件。 */ condition.length > 0) },
    reason: draft.reason.trim(), basisRefs: draft.basisRefs.map((
      /* 原有序列表中的四类精确依据。 */ basis,
    ) => /* 不重排、合并不同Map的同名节点，也不与草稿共享引用。 */ evidenceCloneBasisRef(basis)),
  } }
}
