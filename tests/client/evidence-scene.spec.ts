// 共用场景布局回归：保护真实 Map 坐标，并验证库条目使用独立身份和实际关系。
import { describe, expect, it } from 'vitest'
import type { DefinitionCatalog } from '../../contracts/data-definition'
import type { GraphNode, GraphEdge } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import {
  graphArrangeScene, graphRead3DLayout, type GraphSceneNodeInput,
} from '../../apps/ui/features/graph/graph-3d-layout'

const time = '2026-10-06T00:00:00.000Z'
const catalog: DefinitionCatalog = {
  revision: 1,
  packages: [],
  index: [],
  dataTypes: [{
    id: 'demo.claim',
    version: 1,
    title: '陈述',
    schema: { type: 'object', properties: { body: { type: 'string' } }, required: ['body'], additionalProperties: false },
    successorTypes: [],
    presentation: { titlePath: '/body', summaryPath: '/body' },
    references: [],
    agentProjection: { include: ['/body'], mapEntryFilters: [] },
  }],
  transitions: [],
}

function claim(
  /* 测试 Map 中节点的稳定业务身份。 */
  id: string,
): GraphNode {
  // 建立已注册类型的真实 GraphNode，用于检查 Map 投影没有改变业务字段。
  return { id, revision: 0, typeId: 'demo.claim', typeVersion: 1, payload: { body: `陈述 ${id}` }, createdAt: time, updatedAt: time }
}

function edge(
  /* 已提交关系的稳定身份。 */
  id: string,
  /* 当前 Map 内的来源节点身份。 */
  from: string,
  /* 当前 Map 内的目标节点身份。 */
  to: string,
  /* 真实关系种类，默认后继。 */
  kind: GraphEdge['kind'] = 'successor',
): GraphEdge {
  // 构造带版本与时间的真实关系，允许额外孤立端点检验过滤边界。
  return { id, from, to, kind, revision: 0, createdAt: time, updatedAt: time }
}

function snapshot(
  /* 测试中已提交的真实图节点。 */
  nodes: GraphNode[],
  /* 测试中已提交的真实图关系。 */
  edges: GraphEdge[],
): GraphSnapshot {
  // 建立完整 Map 快照，只供真实 Map 投影路径使用，不用于证据条目的展示输入。
  return {
    mapId: 'map', workspaceId: 'workspace', revision: 1, name: '真实 Map', nodes, edges, runs: [],
    ownershipRevision: 0, ownerships: [], runControls: [], updatedAt: time,
  }
}

function entryNode(
  /* 库内独立条目身份，与来源 Claim 节点 ID 无关。 */
  id: string,
  /* 已固定的完整真假判断。 */
  confidence: 0 | 1,
): GraphSceneNodeInput {
  // 直接建立证据条目的展示投影，固定正文相同也不会合并不同条目。
  return {
    id, typeId: 'factcheck.claim', title: confidence === 0 ? '0 · 确定错误' : '1 · 确定正确',
    summary: '同一个原始陈述', stale: false, color: confidence === 0 ? '#9e4034' : '#557469', createdAt: time,
  }
}

describe('Map 与证据库共用场景布局', () => {
  // 从业务输入验证共用布局抽取后保留的可观察坐标与身份约定。
  it('真实 Map 保持后继层级、同层螺旋和精确定义展示', () => {
    // 为双起点共享后继与独立引用建立真实 Map，覆盖旧布局的两种关系。
    const a = claim('a')
    const b = claim('b')
    b.validity = 'stale'
    const result = claim('result')
    const graph = snapshot([result, b, a], [
      edge('a-result', 'a', 'result'), edge('b-result', 'b', 'result'), edge('a-b', 'a', 'b', 'reference'),
    ])
    const layout = graphRead3DLayout(graph, catalog)

    expect(layout.nodes.map((/* 已计算坐标的展示节点。 */ node) => /* 读取确定性的原有节点顺序。 */ node.id)).toEqual(['a', 'b', 'result'])
    expect(layout.nodes[0]).toMatchObject({ id: 'a', title: '陈述', summary: '陈述 a', stale: false, x: 0, y: 0, z: 0 })
    expect(layout.nodes[1]).toMatchObject({ id: 'b', stale: true, x: 0, y: -0.9438321639402493, z: 0.8646275766547505 })
    expect(layout.nodes[2]).toMatchObject({ id: 'result', x: 3.8, y: 0, z: 0 })
    expect(layout.edges).toEqual([
      { id: 'a-result', from: 'a', to: 'result', kind: 'successor' },
      { id: 'b-result', from: 'b', to: 'result', kind: 'successor' },
      { id: 'a-b', from: 'a', to: 'b', kind: 'reference' },
    ])
    expect(graphRead3DLayout({ ...graph, nodes: [...graph.nodes].reverse() }, catalog)).toEqual(layout)
    expect(graph.nodes).toEqual([result, b, a])
  })

  it('库内两个条目保留独立 entryId、0/1 标识和原文，不推造连线', () => {
    // 相同原始 Claim 的两种固定判断必须保持为两份可选择的库展示项。
    const falseEntry = entryNode('entry-false', 0)
    const trueEntry = entryNode('entry-true', 1)
    const input = [trueEntry, falseEntry]
    const layout = graphArrangeScene(input, [])

    expect(layout.nodes.map((/* 当前库中的展示节点。 */ node) => /* 检查使用库条目身份而非来源身份。 */ node.id)).toEqual(['entry-false', 'entry-true'])
    expect(layout.nodes[0]).toMatchObject({ title: '0 · 确定错误', summary: '同一个原始陈述', color: '#9e4034' })
    expect(layout.nodes[1]).toMatchObject({ title: '1 · 确定正确', summary: '同一个原始陈述', color: '#557469' })
    expect(layout.edges).toEqual([])
    expect(input).toEqual([trueEntry, falseEntry])
    expect(falseEntry).not.toHaveProperty('x')
    expect(layout.nodes[0]).not.toHaveProperty('createdAt')
  })

  it('只保留端点已载入的实际关系，并让后继环坐标保持有限', () => {
    // 构造真实后继环和指向未载入页的关系，验证布局不会发明可见端点。
    const a = entryNode('entry-a', 1)
    const b = entryNode('entry-b', 1)
    const edges = [
      { id: 'a-b', from: a.id, to: b.id, kind: 'successor' as const },
      { id: 'b-a', from: b.id, to: a.id, kind: 'successor' as const },
      { id: 'missing', from: a.id, to: 'not-loaded', kind: 'reference' as const },
    ]
    const layout = graphArrangeScene([a, b], edges)

    expect(layout.edges.map((/* 已保留的实际关系。 */ item) => /* 检查环关系保留且悬空关系排除。 */ item.id)).toEqual(['a-b', 'b-a'])
    expect(layout.nodes.every((/* 环中的当前展示节点。 */ node) =>
      /* 环仍处于基础层且有有限空间坐标。 */ node.x === 0 && Number.isFinite(node.y) && Number.isFinite(node.z))).toBe(true)
    expect(edges).toHaveLength(3)
    expect(layout.edges[0]).not.toBe(edges[0])
  })

  it('空 Map 和空库都产生无节点无关系的可展示布局', () => {
    // 空图与空库共享同一空布局语义，不需要伪造业务节点作为占位。
    expect(graphRead3DLayout(snapshot([], []), catalog)).toEqual({ nodes: [], edges: [] })
    expect(graphArrangeScene([], [])).toEqual({ nodes: [], edges: [] })
  })
})
