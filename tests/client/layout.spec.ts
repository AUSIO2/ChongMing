// 图布局测试：验证阶段列、共享节点、树坐标、意见分支及未保存产物的投影。
import { describe, expect, it } from 'vitest'
import type { GraphEdge, GraphNode, GraphRun } from '../../contracts/graph'
import { graphCanProcessNode, graphReadCanvasLayout, graphReadCanvasNeighbor, graphReadOperationProgress, graphReadRunProgress } from '../../apps/ui/features/graph/graph-layout'

const time = '2026-09-11T00:00:00.000Z'
function layoutCreateNode(
  /* 测试用真实节点身份，供边引用和布局稳定性断言。 */ id: string,
  /* 测试构造的节点类型与业务数据，原样附入节点而不修改。 */ data: GraphNode['data']
): GraphNode {
  // 创建带固定版本和时间的真实节点，用于可重复布局测试。
  return { id, data, revision: 0, createdAt: time, updatedAt: time }
}
function layoutCreateEdge(
  /* 测试关系身份，用于核对布局保留原边。 */ id: string,
  /* 关系起点的真实节点身份，保持领域方向。 */ from: string,
  /* 关系终点的真实节点身份，保持领域方向。 */ to: string,
  /* 关系类型，默认 mentions，可显式构造派生、核查或关联边。 */ kind: GraphEdge['kind'] = 'mentions'
): GraphEdge {
  // 创建带固定版本和时间的图关系。
  return { id, from, to, kind, revision: 0, createdAt: time, updatedAt: time }
}

describe('Client data graph layout', () => {
  // 覆盖阶段树的处理起点、共享节点、分支位置、意见恢复和进度投影。
  it('selects only usable scope roots for each processing boundary', () => {
    // 验证不同处理终点只接受合适的输入节点，并保持真实边方向。
    const nodes = [layoutCreateNode('source', { kind: 'source', locator: { kind: 'url', url: 'https://example.com' }, label: null }),
      layoutCreateNode('news', { kind: 'news', content: 'News', context: {} }), layoutCreateNode('claim', { kind: 'claim', content: 'Claim', category: null }),
      layoutCreateNode('verification', { kind: 'verification', score: 1, reason: 'Evidence', reportIds: [], opinions: [] })]
    expect(nodes.filter(/* 不同业务类型的候选真实节点，检验新闻终点的起点筛选。 */ node =>
      /* 筛选可处理到新闻阶段的起点。 */
      graphCanProcessNode(node, 'news')).map(/* 新闻终点筛出的有效节点，提取身份供集合断言。 */ node =>
      /* 提取新闻阶段合格起点标识。 */
      node.id)).toEqual(['source'])
    expect(nodes.filter(/* 不同业务类型的候选真实节点，检验事实终点的起点筛选。 */ node =>
      /* 筛选可处理到事实阶段的起点。 */
      graphCanProcessNode(node, 'claims')).map(/* 事实终点筛出的有效节点，提取身份供集合断言。 */ node =>
      /* 提取事实阶段合格起点标识。 */
      node.id)).toEqual(['source', 'news'])
    expect(nodes.filter(/* 不同业务类型的候选真实节点，检验核查终点的起点筛选。 */ node =>
      /* 筛选可处理到核查阶段的起点。 */
      graphCanProcessNode(node, 'verified')).map(/* 核查终点筛出的有效节点，提取身份供集合断言。 */ node =>
      /* 提取核查阶段合格起点标识。 */
      node.id)).toEqual(['source', 'news', 'claim'])
    const layout = graphReadCanvasLayout({ nodes, edges: [layoutCreateEdge('derived', 'news', 'source', 'derived-from')] })
    expect(layout.edges.find(/* 布局输出的连线，用测试关系身份查找原始派生边。 */ edge => /* 查找被投影的原始派生关系。 */ edge.id === 'derived')).toMatchObject({ from: 'news', to: 'source', kind: 'derived-from' })
  })

  it('places shared nodes once and draws every real edge, including reverse and same-column relations', () => {
    // 验证共享节点只放置一次、全部真实边保留，逆向与同列关系可绘制且结果稳定。
    const nodes = [
      layoutCreateNode('news-a', { kind: 'news', content: 'Source A', context: {} }),
      layoutCreateNode('news-b', { kind: 'news', content: 'Source B', context: {} }),
      layoutCreateNode('claim', { kind: 'claim', content: 'Shared claim', category: null }),
      layoutCreateNode('verification', { kind: 'verification', score: 0.5, reason: 'Explicit merger conclusion', reportIds: [], opinions: [] }),
    ]
    const edges = [layoutCreateEdge('a-c', 'news-a', 'claim'), layoutCreateEdge('b-c', 'news-b', 'claim'),
      layoutCreateEdge('v-c', 'verification', 'claim', 'verifies'), layoutCreateEdge('a-b', 'news-a', 'news-b', 'related-to')]
    const layout = graphReadCanvasLayout({ nodes, edges })
    expect(layout.nodes.filter(/* 布局输出的画布节点，用 synthetic 区分真实节点。 */ item =>
      /* 筛选画布中的真实节点。 */
      !item.synthetic).map(/* 已筛选出的真实画布节点，读取其归属真实节点身份。 */ item =>
      /* 提取真实节点身份以检查没有重复投影。 */
      item.node.id)).toEqual(['news-a', 'news-b', 'claim', 'verification'])
    expect(layout.nodes.filter(/* 布局输出的画布节点，检查共享事实只有一个真实位置。 */ item => /* 检查共享事实仅有一个真实画布节点。 */ !item.synthetic && item.node.id === 'claim')).toHaveLength(1)
    expect(layout.edges.filter(/* 布局输出的连线，按 kind 排除合成分支。 */ edge => /* 排除合成分支，只统计真实关系。 */ edge.kind !== 'branch')).toHaveLength(edges.length)
    expect(layout.edges.find(/* 布局输出的连线，用原核查边身份核对真实方向。 */ edge => /* 查找核查结论指向事实的原关系。 */ edge.id === 'v-c')).toMatchObject({ from: 'verification', to: 'claim' })
    expect(new Set(layout.edges.map(/* 布局输出的连线，提取路径字符串检查重合。 */ edge => /* 提取连线路径以检查并行关系没有完全重叠。 */ edge.path)).size).toBe(layout.edges.length)
    expect(layout.edges.every(/* 布局输出的连线，检查路径是否含非有限数值。 */ edge => /* 检测连线路径是否包含无效数值。 */ !/NaN|Infinity/.test(edge.path))).toBe(true)
    expect(graphReadCanvasLayout({ nodes: [...nodes].reverse(), edges: [...edges].reverse() })).toEqual(layout)
    expect(layout.nodes.find(/* 布局输出的节点，用导航函数给出的身份寻找下一焦点。 */ item =>
      /* 定位向右导航得到的画布节点并核对其阶段类型。 */
      item.id === graphReadCanvasNeighbor(layout, 'news-a', 'ArrowRight'))?.kind).toBe('splitAgent')
    expect(graphReadCanvasNeighbor(layout, 'news-b', 'ArrowUp')).toBe('news-a')
    expect(graphReadCanvasNeighbor(layout, 'news-a', 'ArrowLeft')).toBeNull()
  })

  it('handles empty graphs and each supported kind without a legacy parent tree', () => {
    // 验证空图返回空布局，各节点类型无需旧父树也能落在画布范围内。
    expect(graphReadCanvasLayout({ nodes: [], edges: [] })).toMatchObject({ nodes: [], edges: [], columns: [] })
    const nodes = [
      layoutCreateNode('source', { kind: 'source', locator: { kind: 'url', url: 'https://example.com' }, label: null }),
      layoutCreateNode('evidence', { kind: 'evidence', content: 'Archive excerpt', locator: { kind: 'url', url: 'https://example.com' }, capturedAt: time }),
    ]
    const layout = graphReadCanvasLayout({ nodes, edges: [] })
    expect(layout.columns.map(/* 布局生成的阶段列，提取类型核对次序。 */ column => /* 提取布局列类型，核对阶段顺序。 */ column.kind)).toEqual(['source', 'evidence'])
    expect(layout.nodes.every(/* 已完成布局的节点，坐标和尺寸用于画布边界断言。 */ node =>
      /* 确认每个节点及其尺寸都位于画布边界内。 */
      node.x >= 0 && node.y >= 0 && node.x + node.width <= layout.width && node.y + node.height <= layout.height)).toBe(true)
  })

  it('keeps independent news subtrees disjoint and centres each parent over its facts', () => {
    // 验证独立新闻子树互不重叠，父节点位于其事实子树中点。
    const news = ['a', 'b'].map(/* 测试新闻根身份，同时作为简短正文。 */ id => /* 创建两个独立新闻根节点。 */ layoutCreateNode(id, { kind: 'news', content: id, context: {} }))
    const claims = ['a1', 'a2', 'b1', 'b2'].map(/* 测试事实身份，首字符编码所属新闻根。 */ id => /* 创建分属两个新闻根的事实节点。 */ layoutCreateNode(id, { kind: 'claim', content: id, category: null }))
    const layout = graphReadCanvasLayout({ nodes: [...news, ...claims], edges: claims.map(/* 测试事实节点，根据身份首字符建立输入派生关系。 */ node =>
      /* 按标识首字母为事实建立指向其新闻输入的派生边。 */
      layoutCreateEdge(node.id, node.id, node.id[0], 'derived-from')) })
    const find = (
      /* 要断言坐标的画布身份，测试夹具保证它存在。 */ id: string
    ) => /* 取得指定标识的画布节点，供坐标断言。 */ layout.nodes.find(/* 布局候选节点，用指定身份查找坐标。 */ node => /* 匹配待核对坐标的节点标识。 */ node.id === id)!
    expect(find('a').y).toBeCloseTo((find('a1').y + find('a2').y) / 2)
    expect(find('b').y).toBeCloseTo((find('b1').y + find('b2').y) / 2)
    expect(find('a2').y + find('a2').height).toBeLessThan(find('b1').y)
    expect(layout.nodes.filter(/* 布局输出的画布节点，用阶段类型统计拆分投影。 */ node => /* 统计自动建立的拆分 Agent 投影。 */ node.kind === 'splitAgent')).toHaveLength(2)
    for (const node of layout.nodes) for (const other of layout.nodes) {
      if (node.id !== other.id && node.x === other.x) expect(Math.abs(node.y - other.y)).toBeGreaterThanOrEqual(node.height)
    }
  })

  it('restores all saved opinion branches even without a current run', () => {
    // 验证没有当前 Run 时仍能从已保存结论恢复完整意见分支。
    const claim = layoutCreateNode('claim', { kind: 'claim', content: 'Claim', category: null })
    const result = layoutCreateNode('result', { kind: 'verification', score: 0.5, reason: 'Summary', reportIds: ['r1', 'r2'],
      opinions: ['r1', 'r2'].map(/* 测试意见身份，同时用作槽位、Agent 和角度的稳定标签。 */ id =>
        /* 构造已保存的独立核查意见及其来源身份。 */
        ({ id, slotId: id, agentId: id, agentName: id, angle: id, tools: [], routeRevision: 1, score: 1, reason: 'Evidence ' + id, createdAt: time })) })
    const layout = graphReadCanvasLayout({ nodes: [claim, result], edges: [layoutCreateEdge('result-claim', 'result', 'claim', 'verifies')], run: null })
    const agents = layout.nodes.filter(/* 已恢复的画布节点，用类型筛选核查 Agent 投影。 */ node => /* 筛选恢复出的核查 Agent 投影。 */ node.kind === 'verifyAgent')
    const opinions = layout.nodes.filter(/* 已恢复的画布节点，用类型筛选意见投影。 */ node => /* 筛选恢复出的意见投影。 */ node.kind === 'opinion')
    expect(agents).toHaveLength(2)
    expect(opinions).toHaveLength(2)
    expect(agents.every(/* 核查 Agent 投影，检查其父身份和点击目标是否为原事实。 */ node => /* 确认 Agent 分支挂在事实下且点击选择原事实。 */ node.parentId === claim.id && node.selectId === claim.id)).toBe(true)
    expect(opinions.every(/* 已保存意见投影，检查点击目标是否为对应结论。 */ node => /* 确认已保存意见的点击目标为核查结论。 */ node.selectId === result.id)).toBe(true)
    expect(layout.nodes.find(/* 布局中的画布节点，用结论身份定位汇总坐标。 */ node => /* 找到汇总结论节点，核对其位于意见分支中点。 */ node.id === result.id)!.y).toBe((opinions[0].y + opinions[1].y) / 2)
    expect(layout.edges.filter(/* 布局连线，用显示终点统计汇入结论的分支数。 */ edge => /* 统计汇入已保存结论的连线。 */ edge.displayTo === result.id)).toHaveLength(2)
  })

  it('reports only persisted progress and does not turn collected reports into a final verdict', () => {
    // 验证收齐报告只表示待汇总，未经保存的新闻、事实和结论保持候选投影状态。
    const profile = { id: 'agent', name: 'Agent', description: 'Evidence', content: 'Review', tools: [], provider: 'fixture', model: 'fixture' }
    const run: GraphRun = {
      id: 'run', scope: { nodeIds: ['claim'] }, until: 'verified', paused: false, regenerate: false, mode: 'human-in-loop', status: 'running', createdAt: time, updatedAt: time,
      configuration: { router: profile, merger: profile, agents: [profile], tools: [], maxSlots: 2 },
      operations: [{ id: 'operation', kind: 'verify', targetId: 'claim', status: 'running', inputRefs: [], configurationHash: 'fixture', outputRefs: [], splitReports: [], contentDraft: null, route: null, draft: null, reports: [], review: null, resultNodeId: null }],
    }
    expect(graphReadRunProgress(run)).toContain('规划')
    run.operations[0].route = { revision: 1, approved: true, reason: 'Two angles', slots: ['one', 'two'].map(/* 测试路由槽位身份，同时作为角度标签。 */ id =>
      /* 创建两个独立核查角度的路由槽位。 */
      ({ id, agentId: 'agent', angle: id, priority: 'medium', hint: '', tools: [] })) }
    expect(graphReadRunProgress(run)).toBe('已收集 0 / 2 份意见')
    run.operations[0].reports = ['one', 'two'].map(/* 需要模拟报告的槽位身份，用于关联当前路由。 */ slotId =>
      /* 为每个角度构造当前路由版本的报告。 */
      ({ id: slotId, slotId, agentId: 'agent', agentName: 'Agent', angle: slotId, tools: [], routeRevision: 1, score: 1, reason: 'Evidence', createdAt: time }))
    expect(graphReadRunProgress(run)).toBe('意见已收齐，等待汇总结果')
    const claim = layoutCreateNode('claim', { kind: 'claim', content: 'Claim', category: null })
    const branches = graphReadCanvasLayout({ nodes: [claim], edges: [], run })
    expect(branches.nodes.filter(/* 运行布局节点，用阶段类型统计核查 Agent 分支。 */ node => /* 统计运行中的核查 Agent 投影。 */ node.kind === 'verifyAgent')).toHaveLength(2)
    expect(branches.nodes.filter(/* 运行布局节点，用阶段类型统计意见卡片。 */ node => /* 统计已收到报告对应的意见投影。 */ node.kind === 'opinion')).toHaveLength(2)
    expect(branches.nodes.every(/* 尚未形成结论的分支节点，检查仍指向原事实选择。 */ node => /* 确认未保存分支仍选择其原事实节点。 */ node.selectId === claim.id)).toBe(true)
    expect(branches.nodes.some(/* 运行布局节点，用类型检查是否提前虚构核查结论。 */ node => /* 检查尚未汇总时没有虚构核查结论节点。 */ node.kind === 'verification')).toBe(false)
    run.status = 'waiting'
    run.operations[0].status = 'waiting'
    run.operations[0].review = { id: 'review', kind: 'result', revision: 0, state: 'pending', decision: null, createdAt: time, answeredAt: null }
    expect(graphReadRunProgress(run)).toBe('等待保存处理结果')
    run.paused = true
    expect(graphReadRunProgress(run)).toBe('已暂停 · 0 / 1 项已完成')
    expect(graphReadCanvasLayout({ nodes: [claim], edges: [], run }).nodes.filter(/* 暂停后的布局节点，用类型筛选核查 Agent。 */ node =>
      /* 筛选暂停后仍保留的核查 Agent 投影。 */
      node.kind === 'verifyAgent').every(/* 已经筛出的核查 Agent 投影，检查报告提交状态文案。 */ node =>
      /* 确认已提交报告的分支仍显示已提交状态。 */
      node.status === '已提交')).toBe(true)
    expect(graphReadOperationProgress(run.operations[0])).toBe('等待保存处理结果')
    run.status = 'completed'
    run.operations[0].status = 'completed'
    expect(graphReadRunProgress(run)).toBe('处理已完成 · 1 / 1 项已完成')
    run.status = 'waiting'
    run.paused = false
    const operation = run.operations[0]
    operation.kind = 'parse'
    operation.status = 'waiting'
    operation.targetId = 'source'
    operation.contentDraft = { kind: 'parse', reason: 'Extract', news: [{ content: 'Candidate A', context: {} }, { content: 'Candidate B', context: {} }] }
    const source = layoutCreateNode('source', { kind: 'source', locator: { kind: 'url', url: 'https://example.com' }, label: null })
    const parse = graphReadCanvasLayout({ nodes: [source], edges: [], run })
    expect(parse.nodes.filter(/* 解析阶段画布节点，用类型统计解析 Agent。 */ node => /* 统计来源解析 Agent 投影。 */ node.kind === 'parseAgent')).toHaveLength(1)
    expect(parse.nodes.filter(/* 解析阶段画布节点，用类型统计新闻候选。 */ node => /* 统计解析草稿中的新闻候选投影。 */ node.kind === 'news')).toHaveLength(2)
    expect(parse.nodes.filter(/* 解析阶段画布节点，用类型挑选新闻候选供状态断言。 */ node =>
      /* 筛选新闻候选，检查其保存状态。 */
      node.kind === 'news').every(/* 新闻候选投影，检查合成标记、待保存状态和原来源身份。 */ node =>
      /* 确认新闻候选为待保存投影且仍选择原来源。 */
      node.synthetic && node.status === '待保存' && node.selectId === source.id)).toBe(true)
    operation.kind = 'split'
    operation.targetId = 'news'
    operation.contentDraft = { kind: 'split', reason: 'Select', reportIds: ['split-report'], selected: [{ reportId: 'split-report', index: 0 }] }
    operation.splitReports = [{ id: 'split-report', slotId: 'one', agentId: 'agent', agentName: 'Agent', angle: 'one', tools: [], routeRevision: 1, reason: 'Extract', createdAt: time,
      claims: [{ content: 'Selected', category: null }, { content: 'Excluded', category: null }] }]
    const news = layoutCreateNode('news', { kind: 'news', content: 'News', context: {} })
    const split = graphReadCanvasLayout({ nodes: [news], edges: [], run })
    expect(split.nodes.filter(/* 拆分阶段画布节点，用类型统计拆分 Agent。 */ node => /* 统计拆分阶段的 Agent 投影。 */ node.kind === 'splitAgent')).toHaveLength(2)
    expect(split.nodes.filter(/* 拆分阶段画布节点，用类型筛选候选事实。 */ node =>
      /* 筛选拆分报告中的候选事实投影。 */
      node.kind === 'claim').map(/* 候选事实投影，提取状态比较采用和排除的差别。 */ node =>
      /* 提取候选状态，核对已选择与未采用的差异。 */
      node.status)).toEqual(['待保存', '未采用'])

  })
})
