// 091 先行验收：关系读取时序与固定邻域展示；业务实现完成前不执行此套件。
import { ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'

import { ClientError, type ClientGateway, type QueryInputMap, type QueryOutputMap } from '../../contracts/client'
import type { DefinitionCatalog } from '../../contracts/data-definition'
import type { EvidenceEntrySummary, EvidenceLibraryEntry, EvidencePage, EvidenceRelationNode, EvidenceRelationsView } from '../../contracts/evidence-library'
import type { GraphEdge, GraphNode } from '../../contracts/graph'
import { evidenceCreateState, type EvidenceUiContext } from '../../apps/ui/features/evidence-library/evidence-state'
import { EvidencePresentationMessage, evidenceReadFixedSourceNotes, evidenceReadRelationDetails, evidenceReadRelationNotice, evidenceReadRelationPresentation, evidenceReadRelationScene, evidenceReadRelationSceneKey } from '../../apps/ui/features/evidence-library/evidence-presentation'

const capturedAt = '2026-10-07T00:00:00.000Z'
const catalog: DefinitionCatalog = {
  revision: 1, packages: [], index: [], transitions: [],
  dataTypes: [{ id: 'factcheck.opinion', version: 1, title: '核查意见', schema: { type: 'object',
    properties: { score: { type: 'number' }, reason: { type: 'string' } } },
    successorTypes: [], references: [], agentProjection: { include: ['/score', '/reason'], mapEntryFilters: [] },
    presentation: { fieldOrder: ['/reason', '/score'], fieldLabels: { '/reason': '核查理由', '/score': '原分数' } } }],
}

describe('C18 fixed relation explanations', () => {
  // 同一份保存关系同时用于图旁栏和固定单页，不读取现行来源图或推造缺失信息。
  it('keeps every relation key and explains physical edges, exact payload paths and original basis positions', () => {
    // 同端点的图引用、字段引用和依据各有身份，不能按端点去重或把角色当关系类型。
    const view = relations('entry-a'), saved = snapshotOf(view)
    const root = saved.nodes.find((/* 固定邻域中的节点。 */ item) => /* 取得真实库根。 */ item.key === saved.rootKey)
    const opinion = saved.nodes.find((/* 固定邻域中的节点。 */ item) => /* 找到payload引用发出方。 */ item.ref.nodeId === 'opinion')
    if (!root || !opinion) throw new Error(RelationTestMessage.MISSING_NODE)
    saved.edges.push({ key: 'basis-opinion-root', kind: 'basis', from: opinion.key, to: root.key, basisIndex: 0 })
    const graph = saved.edges.find((/* 一条保存关系。 */ item) => /* 修改原图引用标签用于投影断言。 */ item.key === 'edge-root-reference')
    if (!graph || graph.kind !== 'graph') throw new Error(RelationTestMessage.MISSING_SNAPSHOT)
    graph.edge.label = '原图保存标签'
    const definitions = structuredClone(catalog), opinionDefinition = definitions.dataTypes[0]
    if (!opinionDefinition) throw new Error(RelationTestMessage.MISSING_NODE)
    opinionDefinition.presentation = { ...opinionDefinition.presentation, fieldLabels: { '/claimId': '关联事实' } }
    const before = structuredClone(view)
    const details = evidenceReadRelationDetails(view, root.key, definitions)
    expect(details).toHaveLength(6)
    expect(new Set(details.map((/* 一条已保存关系的说明。 */ item) => /* 关系身份独立于端点。 */ item.key)).size).toBe(6)
    expect(details.find((/* 投影后的说明。 */ item) => /* 保留真实reference及原label。 */ item.key === 'edge-root-reference'))
      .toMatchObject({ title: '图中引用', relation: { kind: 'graph', edge: { kind: 'reference', label: '原图保存标签' } } })
    expect(details.find((/* 投影后的说明。 */ item) => /* 字段标签与原路径并存。 */ item.key === 'payload-opinion-root'))
      .toMatchObject({ title: '字段引用', fieldLabel: '关联事实', relation: { kind: 'payload', path: '/claimId' } })
    expect(details.find((/* 投影后的说明。 */ item) => /* basisIndex 0不能丢失。 */ item.key === 'basis-opinion-root')).toMatchObject({ basisNumber: 1 })
    expect(details.find((/* 投影后的说明。 */ item) => /* 原数组第二项不能随筛选改成第一项。 */ item.key === 'basis-root')).toMatchObject({ basisNumber: 2 })
    expect(view).toEqual(before)
  })

  it('resolves fixed endpoints by complete saved keys across Maps and content revisions', () => {
    // 同nodeId不同Map/版本保留各自来源，当前图没有参与本投影的参数。
    const view = relations('entry-a'), saved = snapshotOf(view)
    const earlier = relationNode('map-a', node('news', 1, 'factcheck.news', { content: '更早版本新闻' }), 'upstream')
    const edge = savedEdge('older-news-claim', 'news', 'claim')
    edge.sourceAnchors = [{ path: '/content', sourceRevision: 1, startLine: 1, endLine: 1, quote: '更早版本新闻' }]
    saved.nodes.push(earlier)
    saved.edges.push({ key: 'older-news-claim', kind: 'graph', from: earlier.key, to: saved.rootKey, mapId: 'map-a', edge })
    const details = evidenceReadRelationDetails(view, saved.rootKey, catalog)
    expect(details.find((/* 按边key定位的一条说明。 */ item) => /* 版本1的节点不能回落同ID版本4。 */ item.key === 'older-news-claim')?.from.ref)
      .toEqual({ mapId: 'map-a', nodeId: 'news', revision: 1 })
    expect(details.find((/* 按边key定位的一条说明。 */ item) => /* 跨Map依据不能误用本图同名claim。 */ item.key === 'basis-root')?.from.ref)
      .toEqual({ mapId: 'other-map', nodeId: 'claim', revision: 9 })
    const notes = evidenceReadFixedSourceNotes(view, saved.rootKey)
    expect(notes.find((/* 保存来源脚注。 */ item) => /* 此边必须读取自己的旧版本正文。 */ item.relationKey === 'older-news-claim')?.ranges[0].status).toBe('current')
    expect(evidenceReadRelationDetails(view, 'not-a-captured-key', catalog)).toEqual([])
  })

  it('keeps disjoint fixed lines and revision zero and assigns the same edge number in either node view', () => {
    // 一条来源边保留第一/第三行两个范围，不能合成含第二行的连续引用。
    const view = relations('entry-a'), saved = snapshotOf(view)
    const source = saved.nodes.find((/* 固定邻域中的节点。 */ item) => /* 对应保存新闻来源。 */ item.ref.nodeId === 'news')
    const relation = saved.edges.find((/* 实际保存关系。 */ item) => /* 使用真实新闻到Claim的后继。 */ item.key === 'edge-news-claim')
    if (!source || !relation || relation.kind !== 'graph') throw new Error(RelationTestMessage.MISSING_NODE)
    source.ref.revision = 0
    source.nodeSnapshot.revision = 0
    source.nodeSnapshot.payload.content = '第一行\r\n\r\n第三行'
    relation.edge.sourceAnchors = [
      { path: '/content', sourceRevision: 0, startLine: 1, endLine: 1, quote: '第一行' },
      { path: '/content', sourceRevision: 0, startLine: 3, endLine: 3, quote: '第三行' },
    ]
    const before = structuredClone(view)
    const rootNote = evidenceReadFixedSourceNotes(view, saved.rootKey).find((/* 当前根看到的来源脚注。 */ item) => /* 用边身份查找。 */ item.relationKey === relation.key)
    const sourceNote = evidenceReadFixedSourceNotes(view, source.key).find((/* 来源页看到的同一条边。 */ item) => /* 使用相同稳定编号。 */ item.relationKey === relation.key)
    expect(rootNote?.ranges.map((/* 原保存的一个离散范围。 */ range) => /* 状态必须结合固定0版本与quote。 */ [range.label, range.status, range.anchor.quote]))
      .toEqual([['第 1 行', 'current', '第一行'], ['第 3 行', 'current', '第三行']])
    expect(rootNote?.source.ref.revision).toBe(0)
    expect(rootNote?.number).toBe(sourceNote?.number)
    expect(rootNote?.ranges).toHaveLength(2)
    expect(view).toEqual(before)
  })

  it.each(['older-revision', 'quote', 'path', 'range'] as const)('keeps the saved quotation without highlighting a mismatched fixed %s', (/* 使定位失效的一条已保存条件。 */ mismatch) => {
    // 旧摘录仍可读，但不会抓当前Map或以行号近似高亮不一致文本。
    const view = relations('entry-a'), saved = snapshotOf(view)
    const relation = saved.edges.find((/* 一条保存关系。 */ item) => /* 找到带来源定位的真实边。 */ item.key === 'edge-news-claim')
    if (!relation || relation.kind !== 'graph') throw new Error(RelationTestMessage.MISSING_SNAPSHOT)
    const anchor = relation.edge.sourceAnchors?.[0]
    if (!anchor) throw new Error(RelationTestMessage.MISSING_SNAPSHOT)
    if (mismatch === 'older-revision') anchor.sourceRevision = 3
    if (mismatch === 'quote') anchor.quote = '与固定正文不同的原摘录'
    if (mismatch === 'path') anchor.path = '/not-saved'
    if (mismatch === 'range') anchor.endLine = 999
    const note = evidenceReadFixedSourceNotes(view, saved.rootKey).find((/* 已投影的固定脚注。 */ item) => /* 不从其它边补定位。 */ item.relationKey === relation.key)
    expect(note?.ranges[0]).toMatchObject({ status: mismatch === 'older-revision' ? 'stale' : 'invalid', anchor: { quote: anchor.quote } })
  })

  it('keeps old, empty and truncated relation records explicit without inventing source anchors', () => {
    // 缺失历史不生成当前关系，截断仍只解释已保存端点，已有来源无行定位就保持空范围。
    const old = { ...relations('entry-a'), snapshot: null }
    expect(evidenceReadRelationDetails(old, null, catalog)).toEqual([])
    expect(evidenceReadFixedSourceNotes(old, null)).toEqual([])
    const view = relations('entry-a'), saved = snapshotOf(view)
    saved.truncated = true
    const relation = saved.edges.find((/* 保存关系。 */ item) => /* 清除已有定位来复现旧无行标记记录。 */ item.key === 'edge-news-claim')
    if (!relation || relation.kind !== 'graph') throw new Error(RelationTestMessage.MISSING_SNAPSHOT)
    delete relation.edge.sourceAnchors
    expect(evidenceReadFixedSourceNotes(view, saved.rootKey).find((/* 固定来源脚注。 */ item) => /* 不从正文自动提取锚点。 */ item.relationKey === relation.key)?.ranges).toEqual([])
    expect(evidenceReadRelationNotice(view)).toBe(EvidencePresentationMessage.RELATION_TRUNCATED)
    expect(evidenceReadRelationDetails(view, saved.rootKey, catalog)).toHaveLength(5)
  })
})
enum RelationTestMessage {
  UNEXPECTED_QUERY = 'Unexpected relation test query',
  UNEXPECTED_WRITE = 'Unexpected relation test write',
  UNEXPECTED_TRANSPORT = 'Unexpected relation test transport',
  MISSING_CALL = 'Expected relation test read was not issued',
  MISSING_SNAPSHOT = 'Expected fixed relation snapshot',
  MISSING_NODE = 'Expected fixed relation node',
  OLD_UNAUTHORIZED = 'Old relation read is unauthorized',
  RELATION_UNAVAILABLE = 'Fixed relation read failed',
}
type RelationReadValue = EvidencePage | EvidenceLibraryEntry | EvidenceRelationsView
interface Deferred<T> {
  promise: Promise<T>
  resolve: (/* 本次读取已经确认的成功结果。 */ value: T) => void
  reject: (/* 本次读取已经确认的异常。 */ cause: unknown) => void
}
interface RelationReadCall extends Deferred<RelationReadValue> {
  method: 'evidence.search' | 'evidence.get' | 'evidence.relations'
  params: unknown
  signal: AbortSignal | undefined
}

function deferred<T>(): Deferred<T> {
  // 保留异步读取的确定性完成入口，测试不以计时器猜测顺序。
  let resolve: (/* 成功结果。 */ value: T) => void = () => { /* Promise 构造器同步替换此入口。 */ }
  let reject: (/* 拒绝原因。 */ cause: unknown) => void = () => { /* Promise 构造器同步替换此入口。 */ }
  const promise = new Promise<T>((/* Promise 成功完成入口。 */ accept, /* Promise 异常完成入口。 */ fail) => {
    // 将完成入口交给本测试所属夹具，不替生产状态生成业务结果。
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function node(
  /* 保存时真实节点身份。 */ id: string,
  /* 此节点精确内容版本。 */ revision: number,
  /* 已注册的数据类型身份。 */ typeId: string,
  /* 保存时真实 payload。 */ payload: GraphNode['payload'],
): GraphNode {
  // 构造只读边界返回的固定节点，正文不依赖当前 Map。
  return { id, revision, typeId, typeVersion: 1, payload, createdAt: capturedAt, updatedAt: capturedAt }
}

function relationNode(
  /* 节点所属真实 Map，跨 Map 依据保留独立身份。 */ mapId: string,
  /* 节点完整固定快照。 */ snapshot: GraphNode,
  /* 捕获时此节点相对根 Claim 的实际角色。 */ role: EvidenceRelationNode['role'],
): EvidenceRelationNode {
  // 保存完整复合身份，不能以 nodeId 单独归并不同来源或版本。
  return { key: JSON.stringify([mapId, snapshot.id, snapshot.revision]),
    ref: { mapId, nodeId: snapshot.id, revision: snapshot.revision }, nodeSnapshot: snapshot, definitionDigest: `definition-${snapshot.typeId}`, role }
}

function savedEdge(
  /* 源 Map 中真实边身份。 */ id: string,
  /* GraphEdge 原端点身份。 */ from: string,
  /* GraphEdge 原终点身份。 */ to: string,
  /* 实际结构或引用边。 */ kind: GraphEdge['kind'] = 'successor',
): GraphEdge {
  // 原图边内容保留在关系包，展示投影只重映射视觉端点。
  return { id, from, to, kind, revision: 2, createdAt: capturedAt, updatedAt: capturedAt }
}

function relations(
  /* 当前固定库条目身份。 */ entryId: string,
): EvidenceRelationsView {
  // 覆盖真实来源链、核查下游、跨 Map node 依据以及已声明的 payload 引用。
  const root = relationNode('map-a', node('claim', 3, 'factcheck.claim', { content: '原 Claim 完全错误。' }), 'claim')
  const source = relationNode('map-a', node('source', 2, 'factcheck.source', { content: '原始来源内容' }), 'upstream')
  const news = relationNode('map-a', node('news', 4, 'factcheck.news', { content: '原始新闻第一行\n第二行' }), 'upstream')
  const opinion = relationNode('map-a', node('opinion', 5, 'factcheck.opinion', { reason: '原核查依据', score: 0.5 }), 'downstream')
  const verification = relationNode('map-a', node('verification', 6, 'factcheck.verification', { score: 0.5, reason: '原汇总意见' }), 'downstream')
  const basis = relationNode('other-map', node('claim', 9, 'factcheck.claim', { content: '另一 Map 的同名依据节点' }), 'basis')
  const sourceNews = savedEdge('source-news', 'source', 'news')
  const newsClaim = savedEdge('news-claim', 'news', 'claim')
  newsClaim.sourceAnchors = [{ path: '/content', sourceRevision: 4, startLine: 1, endLine: 1, quote: '原始新闻第一行' }]
  return { workspaceId: 'workspace-a', entryId, contentDigest: `digest-${entryId}`, snapshot: {
    version: 1, capturedAt, rootKey: root.key, truncated: false, nodes: [source, news, root, opinion, verification, basis],
    edges: [
      { key: 'edge-source-news', kind: 'graph', from: source.key, to: news.key, mapId: 'map-a', edge: sourceNews },
      { key: 'edge-news-claim', kind: 'graph', from: news.key, to: root.key, mapId: 'map-a', edge: newsClaim },
      { key: 'edge-claim-opinion', kind: 'graph', from: root.key, to: opinion.key, mapId: 'map-a', edge: savedEdge('claim-opinion', 'claim', 'opinion') },
      { key: 'edge-opinion-verification', kind: 'graph', from: opinion.key, to: verification.key, mapId: 'map-a', edge: savedEdge('opinion-verification', 'opinion', 'verification') },
      { key: 'edge-root-reference', kind: 'graph', from: root.key, to: opinion.key, mapId: 'map-a', edge: savedEdge('root-reference', 'claim', 'opinion', 'reference') },
      { key: 'payload-opinion-root', kind: 'payload', from: opinion.key, to: root.key, mapId: 'map-a', path: '/claimId' },
      { key: 'basis-root', kind: 'basis', from: basis.key, to: root.key, basisIndex: 1 },
    ],
  } }
}

function entry(
  /* 固定库条目身份。 */ id: string,
): EvidenceLibraryEntry {
  // 数字 0 属于库根判断，邻域 Opinion 保留自己的 0.5 分数。
  return { id, workspaceId: 'workspace-a', revision: 1,
    claim: { origin: { mapId: 'map-a', nodeId: 'claim', revision: 3 }, type: { id: 'factcheck.claim', version: 1 }, definitionDigest: 'definition-factcheck.claim',
      nodeSnapshot: node('claim', 3, 'factcheck.claim', { content: '原 Claim 完全错误。' }) },
    confidence: 0, applicability: { subject: null, event: null, time: null, place: null, conditions: [] },
    decision: { reason: '固定真假判断理由', basisRefs: [] }, collectedBy: 'collector', collectedAt: capturedAt, contentDigest: `digest-${id}`,
    status: 'active', statusReason: null, replacementEntryId: null }
}

function summaries(): EvidenceEntrySummary[] {
  // 展示输入同时含根条目和其他条目，不将邻域变成新收录条目。
  return ['entry-a', 'entry-b'].map((/* 已加载库条目身份。 */ id) =>
    /* 对根库条目保留数字 0 及真实 entryId。 */ ({ id, content: `库陈述 ${id}`, confidence: 0, contentDigest: `digest-${id}`, status: 'active' }))
}

function snapshotOf(
  /* 服务端已交付的关系视图。 */ view: EvidenceRelationsView,
) {
  // 测试明确要求已保存关系时收窄 nullable 快照，旧记录另有独立用例。
  if (!view.snapshot) throw new Error(RelationTestMessage.MISSING_SNAPSHOT)
  return view.snapshot
}

function fixture() {
  // 窗口状态使用受控公共网关，只测试读取隔离，不创建内存证据数据库。
  const reads: RelationReadCall[] = []
  const context = ref<EvidenceUiContext>({ userId: 'user-a', connectionKey: 'service-a', workspaceId: 'workspace-a', active: true, canEdit: true })
  const onUnauthorized = vi.fn()
  const gateway: ClientGateway = {
    async watch() { /* 此套件不建立图订阅。 */ throw new Error(RelationTestMessage.UNEXPECTED_TRANSPORT) },
    async getConnection() { /* 此套件不操作连接。 */ throw new Error(RelationTestMessage.UNEXPECTED_TRANSPORT) },
    async connect() { /* 此套件不登录。 */ throw new Error(RelationTestMessage.UNEXPECTED_TRANSPORT) },
    async disconnect() { /* 此套件通过认证通知观察退出。 */ throw new Error(RelationTestMessage.UNEXPECTED_TRANSPORT) },
    async read<K extends keyof QueryInputMap>(
      /* 状态提交的公开库读取方法。 */ method: K,
      /* 原查询参数，不由夹具替生产状态补齐。 */ params: QueryInputMap[K],
      /* 状态拥有的读取取消信号。 */ signal?: AbortSignal,
    ): Promise<QueryOutputMap[K]> {
      // 原图 read 等方法会直接失败，邻域只能读取关系包已冻结内容。
      let readMethod: RelationReadCall['method']
      if (method === 'evidence.search') readMethod = 'evidence.search'
      else if (method === 'evidence.get') readMethod = 'evidence.get'
      else if (method === 'evidence.relations') readMethod = 'evidence.relations'
      else throw new Error(RelationTestMessage.UNEXPECTED_QUERY)
      const call: RelationReadCall = { ...deferred<RelationReadValue>(), method: readMethod, params, signal }
      reads.push(call)
      // 泛型映射不会自动收窄 K；运行时已经限制为上面三种库读取。
      return await call.promise as QueryOutputMap[K]
    },
    async dispatch() { /* 此关系套件不发写命令。 */ throw new Error(RelationTestMessage.UNEXPECTED_WRITE) },
    async upload() { /* 此关系套件不上传。 */ throw new Error(RelationTestMessage.UNEXPECTED_TRANSPORT) },
    async download() { /* 此关系套件不下载。 */ throw new Error(RelationTestMessage.UNEXPECTED_TRANSPORT) },
  }
  const state = evidenceCreateState(gateway, context, onUnauthorized)
  return { state, context, reads, onUnauthorized }
}

function callAt(
  /* 当前关系窗口环境。 */ f: ReturnType<typeof fixture>,
  /* 需要控制的公开读取方法。 */ method: RelationReadCall['method'],
  /* 该方法的发出序号，默认第一次。 */ index = 0,
): RelationReadCall {
  // 按方法而非总请求下标取得在途读取，明确检查 get 与 relations 并行。
  const call = f.reads.filter((/* 当前真实发出的公开查询。 */ item) => /* 只查看指定方法的时序。 */ item.method === method)[index]
  if (!call) throw new Error(RelationTestMessage.MISSING_CALL)
  return call
}

async function settle(): Promise<void> {
  // 排空已经完成读取的微任务，不依赖延时睡眠。
  await Promise.resolve()
  await Promise.resolve()
}

function completeSearch(
  /* 新创建的关系窗口状态。 */ f: ReturnType<typeof fixture>,
): void {
  // 完成自动列表读取，使本用例只关注选择与关系时序。
  callAt(f, 'evidence.search').resolve({ items: summaries(), nextCursor: null, libraryRevision: 2 })
}

describe('091 fixed relation scene and page projection', () => {
  // 场景根保持 entryId，其他端点只有真实快照身份，原分数不冒充库判断。
  it('maps the selected root to its actual entryId and keeps unrelated loaded entries', () => {
    // 可见根条目不变成伪 Map/Node，邻域也不替换其他已加载库条目。
    const view = relations('entry-a')
    const snapshot = snapshotOf(view)
    const layout = evidenceReadRelationScene(summaries(), entry('entry-a'), view, catalog)
    expect(layout.nodes).toHaveLength(7)
    expect(layout.nodes.find((/* 当前真实展示节点。 */ item) => /* 库根以实际 entryId 选择。 */ item.id === 'entry-a'))
      .toMatchObject({ title: '0 · 确定错误', summary: '原 Claim 完全错误。' })
    expect(layout.nodes.some((/* 当前真实展示节点。 */ item) => /* 另一条目仍保留浏览身份。 */ item.id === 'entry-b')).toBe(true)
    expect(evidenceReadRelationSceneKey(view.entryId, snapshot.rootKey, snapshot.rootKey)).toBe('entry-a')
    expect(new Set(layout.nodes.map((/* 当前真实展示节点。 */ item) => /* 验证每个视觉身份独立。 */ item.id)).size).toBe(layout.nodes.length)
  })

  it('keeps a withdrawn selected root visible when the active search no longer includes it', () => {
    // 撤回详情仍可读，邻域根必须保留真正库身份和固定判断而非伪来源节点。
    const root = { ...entry('entry-a'), revision: 2, status: 'withdrawn' as const, statusReason: '后续撤回' }
    const activeItems = summaries().filter((/* 当前默认活动列表条目。 */ item) => /* 真实已撤回条目已不在默认搜索。 */ item.id !== root.id)
    const layout = evidenceReadRelationScene(activeItems, root, relations(root.id), catalog)
    expect(layout.nodes.find((/* 当前可见实际展示节点。 */ item) => /* 撤回根仍保持条目 entryId。 */ item.id === root.id))
      .toMatchObject({ title: '0 · 确定错误', stale: true, summary: '原 Claim 完全错误。' })
    expect(layout.edges.some((/* 当前已保存关系。 */ edge) => /* 固定邻域仍连到实际根。 */ edge.from === root.id || edge.to === root.id)).toBe(true)
  })

  it('keeps actual successor and reference edges distinct from payload and selected basis references', () => {
    // 层级只来自真实 successor，payload 与人工选择的 node 依据为引用关系。
    const view = relations('entry-a')
    const snapshot = snapshotOf(view)
    const layout = evidenceReadRelationScene(summaries(), entry('entry-a'), view, catalog)
    expect(layout.edges).toHaveLength(7)
    expect(layout.edges.map((/* 服务端快照投影后的关系。 */ edge) => /* 统计结构与引用关系，不解析标题。 */ edge.kind))
      .toEqual(['successor', 'successor', 'successor', 'successor', 'reference', 'reference', 'reference'])
    const ids = new Set(layout.nodes.map((/* 场景已保存端点。 */ item) => /* 所有关系必须引用可见端点。 */ item.id))
    expect(layout.edges.every((/* 快照的一条真实或明确派生引用。 */ edge) => /* 不出现未保存端点。 */ ids.has(edge.from) && ids.has(edge.to))).toBe(true)
    expect(snapshot.edges[1]).toMatchObject({ kind: 'graph', edge: { sourceAnchors: [{ sourceRevision: 4, quote: '原始新闻第一行' }] } })
  })

  it('does not merge same named nodes across maps or revisions', () => {
    // 基于复合 key 的视觉身份区分同名跨 Map 和同 Map 历史版本。
    const view = relations('entry-a')
    const snapshot = snapshotOf(view)
    const oldClaim = relationNode('map-a', node('claim', 2, 'factcheck.claim', { content: '更早 Claim 正文' }), 'dependency')
    snapshot.nodes.push(oldClaim)
    const layout = evidenceReadRelationScene(summaries(), entry('entry-a'), view, catalog)
    const keys = snapshot.nodes.filter((/* 原名相同的固定快照节点。 */ item) => /* 此用例刻意保留多个 claim 身份。 */ item.ref.nodeId === 'claim')
      .map((/* 带 Map 和版本的真实身份。 */ item) => /* 取得展示复合 key，不按 nodeId 合并。 */ evidenceReadRelationSceneKey(view.entryId, item.key, snapshot.rootKey))
    expect(new Set(keys).size).toBe(3)
    expect(keys.filter((/* 本用例复合展示 key。 */ key) => /* 只有根可使用库条目身份。 */ key === 'entry-a')).toHaveLength(1)
    expect(layout.nodes).toHaveLength(8)
  })

  it('reads a neighbor page from saved payload and preserves Opinion score 0.5', () => {
    // 邻域单页只投影已保存 Opinion，与库根 0 判断没有赋值关系。
    const snapshot = snapshotOf(relations('entry-a'))
    const opinion = snapshot.nodes.find((/* 固定邻域节点。 */ item) => /* 读取核查下游 Opinion。 */ item.ref.nodeId === 'opinion')
    if (!opinion) throw new Error(RelationTestMessage.MISSING_NODE)
    const presentation = evidenceReadRelationPresentation(opinion, catalog)
    expect(presentation.heading).toBe('核查意见')
    expect(presentation.fields.map((/* 固定正文的只读字段。 */ field) => /* 保留原理由与原小数值。 */ field.value)).toEqual(['原核查依据', 0.5])
    expect(presentation).not.toHaveProperty('confidence')
    expect(opinion.nodeSnapshot.payload.score).toBe(0.5)
  })

  it('shows old snapshot null explicitly and projects no historical relation from current data', () => {
    // 旧条目缺少快照与独立 Claim 无边是两个不同状态，界面必须明示。
    const old = { ...relations('entry-a'), snapshot: null }
    expect(evidenceReadRelationScene(summaries(), entry('entry-a'), old, catalog).edges).toEqual([])
    expect(evidenceReadRelationScene(summaries(), entry('entry-a'), old, catalog).nodes).toHaveLength(2)
    expect(evidenceReadRelationNotice(old)).toContain('未保存')
    const isolated = relations('entry-a')
    const snapshot = snapshotOf(isolated)
    snapshot.nodes = snapshot.nodes.filter((/* 已保存固定节点。 */ item) => /* 真实独立 Claim 只保留根。 */ item.key === snapshot.rootKey)
    snapshot.edges = []
    expect(evidenceReadRelationNotice(isolated)).not.toContain('未保存')
  })

  it('marks a bounded truncated snapshot while retaining only actual saved nodes', () => {
    // 捕获达到边界只标记不完整，不补全 128/256 之外的伪端点。
    const view = relations('entry-a')
    snapshotOf(view).truncated = true
    expect(evidenceReadRelationNotice(view)).toContain('截断')
    expect(evidenceReadRelationScene(summaries(), entry('entry-a'), view, catalog).nodes).toHaveLength(7)
    expect(evidenceReadRelationScene(summaries(), entry('entry-a'), view, catalog).edges).toHaveLength(7)
  })
})

describe('091 relation reads share current selection identity', () => {
  // 用独立受控响应覆盖 get/relations 并行和旧身份成功、失败隔离。
  it('starts detail and relations together and exposes the fixed detail before slower relations finish', async () => {
    // 关系请求不能等待 get 完成，慢关系也不能阻止阅读固定根正文。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    expect(callAt(f, 'evidence.get').params).toEqual({ workspaceId: 'workspace-a', entryId: 'entry-a' })
    expect(callAt(f, 'evidence.relations').params).toEqual({ workspaceId: 'workspace-a', entryId: 'entry-a' })
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    await settle()
    expect(f.state.entry.value?.id).toBe('entry-a')
    expect(f.state.detailLoading.value).toBe(false)
    expect(f.state.relationsLoading.value).toBe(true)
    callAt(f, 'evidence.relations').resolve(relations('entry-a'))
    await selecting
    expect(f.state.relations.value?.entryId).toBe('entry-a')
    expect(f.state.relationsLoading.value).toBe(false)
    f.state.dispose()
  })

  it('keeps a fixed detail readable when relation loading fails and clears prior neighborhood', async () => {
    // 关系失败显示在关系错误通道，不借当前 Map 伪补历史，也不抹掉合法 get 正文。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    callAt(f, 'evidence.relations').reject(new ClientError({ status: 503, code: 'RELATIONS_FAILED', message: RelationTestMessage.RELATION_UNAVAILABLE, retryable: true }))
    await selecting
    expect(f.state.entry.value?.id).toBe('entry-a')
    expect(f.state.relations.value).toBeNull()
    expect(f.state.relationsError.value?.code).toBe('RELATIONS_FAILED')
    expect(f.reads.every((/* 实际发出的公开请求。 */ read) => /* 没有普通 Map 正文读取。 */ read.method.startsWith('evidence.'))).toBe(true)
    f.state.dispose()
  })

  it.each(['entryId', 'workspaceId'] as const)('rejects a valid shaped detail returned for another %s', async (
    /* 公共响应形状合法但与当前请求不符的身份字段。 */ mismatch,
  ) => {
    // 最后关联边界拒绝另一库根或工作区正文，不因数据结构合法就接纳。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    const wrong = entry('entry-a')
    if (mismatch === 'entryId') wrong.id = 'other-entry'
    else wrong.workspaceId = 'other-workspace'
    callAt(f, 'evidence.get').resolve(wrong)
    callAt(f, 'evidence.relations').resolve(relations('entry-a'))
    expect(await selecting).toBe(false)
    expect(f.state.entry.value).toBeNull()
    expect(f.state.error.value?.code).toBe('INVALID_RESPONSE')
    expect(f.state.relations.value).toBeNull()
    expect(f.state.selectedRelationNode.value).toBeNull()
    f.state.dispose()
  })

  it.each(['digest', 'root-ref'] as const)('rejects relation association with mismatched %s after relations finish first', async (
    /* 两份合法结构之间摘要或固定根版本不符。 */ mismatch,
  ) => {
    // 慢 get 返回后才完成关联校验，之前不能暴露未绑定邻域；根正文仍可读。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    const root = entry('entry-a')
    const view = relations('entry-a')
    if (mismatch === 'digest') view.contentDigest = 'different-fixed-digest'
    else {
      root.claim.origin.revision = 4
      root.claim.nodeSnapshot.revision = 4
    }
    callAt(f, 'evidence.relations').resolve(view)
    await settle()
    expect(f.state.relations.value).toBeNull()
    callAt(f, 'evidence.get').resolve(root)
    await selecting
    expect(f.state.entry.value?.id).toBe('entry-a')
    expect(f.state.relations.value).toBeNull()
    expect(f.state.relationsError.value?.code).toBe('INVALID_RESPONSE')
    expect(f.state.selectedRelationNode.value).toBeNull()
    f.state.dispose()
  })

  it('ignores late relation success and unauthorized failure after switching entry', async () => {
    // A 的关系迟到不能盖住 B 的快照，旧 401 也不退出 B 的有效会话。
    const f = fixture()
    completeSearch(f)
    await settle()
    const first = f.state.select('entry-a')
    const latest = f.state.select('entry-b')
    expect(callAt(f, 'evidence.get', 0).signal?.aborted).toBe(true)
    expect(callAt(f, 'evidence.relations', 0).signal?.aborted).toBe(true)
    callAt(f, 'evidence.get', 1).resolve(entry('entry-b'))
    callAt(f, 'evidence.relations', 1).resolve(relations('entry-b'))
    await latest
    callAt(f, 'evidence.get', 0).resolve(entry('entry-a'))
    callAt(f, 'evidence.relations', 0).reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: RelationTestMessage.OLD_UNAUTHORIZED, retryable: false }))
    await first
    expect(f.state.entry.value?.id).toBe('entry-b')
    expect(f.state.relations.value?.entryId).toBe('entry-b')
    expect(f.state.relationsError.value).toBeNull()
    expect(f.onUnauthorized).not.toHaveBeenCalled()
    f.state.dispose()
  })

  it('notifies the session owner when the current relation request returns unauthorized', async () => {
    // 当前选择的关系认证失败仍属于会话退出边界，不能当作旧关系错误丢掉。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    callAt(f, 'evidence.relations').reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: RelationTestMessage.RELATION_UNAVAILABLE, retryable: true }))
    await selecting
    expect(f.onUnauthorized).toHaveBeenCalledOnce()
    expect(f.state.relationsError.value?.status).toBe(401)
    expect(f.state.canRetry.value).toBe(false)
    f.state.dispose()
  })

  it.each(['workspaceId', 'userId', 'connectionKey'] as const)('isolates late relation results after changing %s', async (
    /* 本用例改变的读取身份字段。 */ field,
  ) => {
    // 关系与 get 使用同一窗口身份边界，另一工作区不能接纳旧关系正文。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    f.context.value[field] = `other-${field}`
    expect(callAt(f, 'evidence.get').signal?.aborted).toBe(true)
    expect(callAt(f, 'evidence.relations').signal?.aborted).toBe(true)
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    callAt(f, 'evidence.relations').resolve(relations('entry-a'))
    await selecting
    expect(f.state.entry.value).toBeNull()
    expect(f.state.relations.value).toBeNull()
    expect(f.state.selectedRelationNode.value).toBeNull()
    f.state.dispose()
  })

  it('selects a saved neighbor without a new network read and keeps root library identity', async () => {
    // 邻域选择属于固定关系包，不能把 Opinion key 发给 evidence.get 或普通 Map。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    const view = relations('entry-a')
    const snapshot = snapshotOf(view)
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    callAt(f, 'evidence.relations').resolve(view)
    await selecting
    const opinion = snapshot.nodes.find((/* 当前固定关系节点。 */ item) => /* 选择真实核查下游。 */ item.ref.nodeId === 'opinion')
    if (!opinion) throw new Error(RelationTestMessage.MISSING_NODE)
    const before = f.reads.length
    expect(f.state.selectRelation(opinion.key)).toBe(true)
    expect(f.state.selectedId.value).toBe('entry-a')
    expect(f.state.entry.value?.confidence).toBe(0)
    expect(f.state.selectedRelationNode.value?.nodeSnapshot.payload.score).toBe(0.5)
    expect(f.reads).toHaveLength(before)
    expect(f.state.selectRelation('unknown-key')).toBe(false)
    expect(f.state.selectedRelationNode.value?.key).toBe(opinion.key)
    expect(f.state.selectRelation(snapshot.rootKey)).toBe(true)
    expect(f.state.selectedRelationNode.value).toBeNull()
    expect(f.state.selectRelation(null)).toBe(true)
    f.state.dispose()
  })

  it('clears a neighbor selection immediately when another root entry is selected', async () => {
    // B 的 get 尚在读取时也不显示 A 的 Opinion 固定正文。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selectingA = f.state.select('entry-a')
    const viewA = relations('entry-a')
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    callAt(f, 'evidence.relations').resolve(viewA)
    await selectingA
    const opinion = snapshotOf(viewA).nodes.find((/* A 已保存邻域。 */ item) => /* A 的下游 Opinion。 */ item.ref.nodeId === 'opinion')
    if (!opinion) throw new Error(RelationTestMessage.MISSING_NODE)
    f.state.selectRelation(opinion.key)
    const selectingB = f.state.select('entry-b')
    expect(f.state.selectedRelationNode.value).toBeNull()
    expect(f.state.relations.value).toBeNull()
    callAt(f, 'evidence.get', 1).resolve(entry('entry-b'))
    callAt(f, 'evidence.relations', 1).resolve({ ...relations('entry-b'), snapshot: null })
    await selectingB
    expect(f.state.relations.value?.snapshot).toBeNull()
    expect(f.state.selectRelation(opinion.key)).toBe(false)
    f.state.dispose()
  })

  it('keeps same identity neighbor data while leaving the library and refreshes it on return', async () => {
    // 同身份切 Map 保留固定邻域选择；返回库后重新取得关系并丢弃离开时的读取。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    const view = relations('entry-a')
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    callAt(f, 'evidence.relations').resolve(view)
    await selecting
    const opinion = snapshotOf(view).nodes.find((/* 本选择已保存的邻域节点。 */ item) => /* 保留原下游选择。 */ item.ref.nodeId === 'opinion')
    if (!opinion) throw new Error(RelationTestMessage.MISSING_NODE)
    f.state.selectRelation(opinion.key)
    f.context.value.active = false
    expect(f.state.selectedRelationNode.value?.key).toBe(opinion.key)
    expect(f.state.relations.value?.entryId).toBe('entry-a')
    const inactiveReads = f.reads.length
    f.context.value.active = true
    expect(f.reads.length).toBeGreaterThan(inactiveReads)
    callAt(f, 'evidence.search', 1).resolve({ items: summaries(), nextCursor: null, libraryRevision: 3 })
    callAt(f, 'evidence.get', 1).resolve({ ...entry('entry-a'), revision: 2, status: 'withdrawn', statusReason: '当前状态已撤回' })
    callAt(f, 'evidence.relations', 1).resolve(relations('entry-a'))
    await settle()
    expect(f.state.entry.value?.status).toBe('withdrawn')
    expect(f.state.selectedRelationNode.value?.key).toBe(opinion.key)
    f.state.dispose()
  })

  it('cancels both reads and ignores late relation errors after state disposal', async () => {
    // 窗口销毁后关系读取与详情一起取消，旧 401 不通知已退出的会话。
    const f = fixture()
    completeSearch(f)
    await settle()
    const selecting = f.state.select('entry-a')
    f.state.dispose()
    expect(callAt(f, 'evidence.get').signal?.aborted).toBe(true)
    expect(callAt(f, 'evidence.relations').signal?.aborted).toBe(true)
    callAt(f, 'evidence.get').resolve(entry('entry-a'))
    callAt(f, 'evidence.relations').reject(new ClientError({ status: 401, code: 'UNAUTHORIZED', message: RelationTestMessage.OLD_UNAUTHORIZED, retryable: false }))
    await selecting
    expect(f.state.relations.value).toBeNull()
    expect(f.state.entry.value).toBeNull()
    expect(f.state.relationsLoading.value).toBe(false)
    expect(f.onUnauthorized).not.toHaveBeenCalled()
  })
})
