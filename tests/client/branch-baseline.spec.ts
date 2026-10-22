// 文件职责：从公开配对/复用接口检验编辑基线的语义边界，不计算服务端 hash 或检查私有投影格式。
import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from '../../contracts/graph'
import type { GraphSnapshot } from '../../contracts/graph-api'
import type { GraphBranchSnapshot } from '../../contracts/graph-branch'
import { branchBaselineMatchesSnapshot, branchCreateBaseline, type BranchBaseline } from '../../apps/ui/features/graph/branch-baseline'

const ROOT = '11111111-1111-4111-8111-111111111111'
const CHILD = '22222222-2222-4222-8222-222222222222'
const OUTSIDE = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const TIME = '2026-10-18T00:00:00.000Z'
const SERVER_VERSION = 'a390e15ebd724891a390e15ebd724891a390e15ebd724891a390e15ebd724891'

enum BaselineFixtureError {
  NODE_MISSING = '基线语义夹具中缺少目标节点。',
  EDGE_MISSING = '基线语义夹具中缺少目标关系。',
  PAIR_REJECTED = '合法的同次基线夹具没有被接纳。',
}

function createNode(
  /* 图中稳定节点身份，不以相同正文合并身份。 */ id: string,
  /* 该节点已保存的内容版本。 */ revision: number,
): GraphNode {
  // 构造真实公共 DTO 形状，完整元信息可用于保守内容比较。
  return { id, revision, typeId: 'fixture.note', typeVersion: 1, payload: { content: `节点 ${id}` },
    createdAt: TIME, updatedAt: TIME }
}

function createEdge(
  /* 图内稳定关系身份。 */ id: string,
  /* successor 扩大闭包，reference 仅表达引用。 */ kind: GraphEdge['kind'],
  /* 实际关系起点。 */ from: string,
  /* 实际关系终点。 */ to: string,
): GraphEdge {
  // 保留关系版本、标签和时间，避免用仅有端点的简化对象替代边 DTO。
  return { id, revision: 1, kind, from, to, label: '已保存的关系', createdAt: TIME, updatedAt: TIME }
}

function createSnapshot(): GraphSnapshot {
  // A 根只有一个结构后继，另有邻接 reference 及跨入/跨出 payload 引用。
  const root = createNode(ROOT, 3)
  root.payload.sources = [OTHER]
  root.payloadReferences = [{ path: '/sources/0', targetId: OTHER }]
  const outside = createNode(OUTSIDE, 2)
  outside.payload.citations = [ROOT]
  outside.payloadReferences = [{ path: '/citations/0', targetId: ROOT }]
  return { mapId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', workspaceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    revision: 7, ownershipRevision: 4, ownerships: [], runControls: [], runs: [], name: '语义基线图', updatedAt: TIME,
    nodes: [root, createNode(CHILD, 4), outside, createNode(OTHER, 5)],
    edges: [createEdge('successor-a', 'successor', ROOT, CHILD),
      createEdge('reference-in', 'reference', OUTSIDE, ROOT), createEdge('reference-out', 'reference', CHILD, OTHER)] }
}

function createProof(): GraphBranchSnapshot {
  // 服务端 opaque version 是固定测试输入；数组故意不按身份排序，不在前端生成摘要。
  return { scope: { rootIds: [ROOT], nodeIds: [CHILD, ROOT], edgeIds: ['successor-a'] },
    version: SERVER_VERSION, mapRevision: 7, rootRevisions: { [ROOT]: 3 } }
}

function requireBaseline(
  /* 同次完整公共图快照。 */ snapshot: GraphSnapshot,
  /* 由服务器返回的单根版本证明。 */ proof: GraphBranchSnapshot,
): BranchBaseline {
  // 准备合法对照，缺失基线时明确失败，不以空对象冒充已验证结果。
  const baseline = branchCreateBaseline(snapshot, proof, ROOT)
  if (!baseline) throw new Error(BaselineFixtureError.PAIR_REJECTED)
  return baseline
}

function findNode(
  /* 当前独立变体的公共快照。 */ snapshot: GraphSnapshot,
  /* 需要安排内容变化的真实图内身份。 */ id: string,
): GraphNode {
  // 只修改该用例拥有的克隆，缺失身份不得静默跳过测试前提。
  const node = snapshot.nodes.find((/* 快照中的一个实际节点。 */ item) => /* 按身份选取目标。 */ item.id === id)
  if (!node) throw new Error(BaselineFixtureError.NODE_MISSING)
  return node
}

function findEdge(
  /* 当前独立变体的公共快照。 */ snapshot: GraphSnapshot,
  /* 需要安排关系变化的稳定边身份。 */ id: string,
): GraphEdge {
  // 建立边确实存在的前提，避免可选链让变体实际没有发生改变。
  const edge = snapshot.edges.find((/* 快照中的一条实际边。 */ item) => /* 按稳定边身份定位。 */ item.id === id)
  if (!edge) throw new Error(BaselineFixtureError.EDGE_MISSING)
  return edge
}

function freezeFixture(
  /* 只属于本测试的无循环 DTO；冻结后 exported 能力必须只读它。 */ value: unknown,
): void {
  // 深度冻结输入以捕获原数组排序、对象改写等副作用，不检查内部实现细节。
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return
  Object.freeze(value)
  for (const nested of Object.values(value)) freezeFixture(nested)
}

describe('编辑基线公开语义回归', () => {
  // 这些测试在纯能力实现后补充，只记录契约回归，不补造实现前红灯历史。
  it('只接纳同次图版本、根版本和完整 successor 闭包的配对证明', () => {
    // 合法 reference 邻点不属于结构闭包；错版本、漏后继或错内部结构边都应拒绝。
    const snapshot = createSnapshot()
    const proof = createProof()
    expect(branchCreateBaseline(snapshot, proof, ROOT)).not.toBeNull()
    const wrongMapVersion = structuredClone(proof)
    wrongMapVersion.mapRevision--
    const wrongRootVersion = structuredClone(proof)
    wrongRootVersion.rootRevisions[ROOT]--
    const missingChild = structuredClone(proof)
    missingChild.scope.nodeIds = [ROOT]
    const missingEdge = structuredClone(proof)
    missingEdge.scope.edgeIds = []
    const referenceAsMember = structuredClone(proof)
    referenceAsMember.scope.nodeIds.push(OUTSIDE)
    for (const candidate of [wrongMapVersion, wrongRootVersion, missingChild, missingEdge, referenceAsMember]) {
      expect(branchCreateBaseline(snapshot, candidate, ROOT)).toBeNull()
    }
    expect(branchCreateBaseline(snapshot, proof, CHILD)).toBeNull()
  })

  it('无关根正文及全图 R/O 改变仍能使用原 server proof，不改其 mapRevision', () => {
    // 当前根事实完全未变时，全图元数据不能变成永久编辑门禁。
    const snapshot = createSnapshot()
    const proof = createProof()
    const baseline = requireBaseline(snapshot, proof)
    const next = structuredClone(snapshot)
    next.revision += 10
    next.ownershipRevision += 8
    next.name = '其他工作导致的图名变化'
    const outside = findNode(next, OUTSIDE)
    outside.payload.content = '只有外部正文改变，引用关系保持。'
    outside.revision++
    expect(branchBaselineMatchesSnapshot(baseline, next, ROOT)).toBe(true)
    expect(baseline.branch.version).toBe(SERVER_VERSION)
    expect(baseline.branch.mapRevision).toBe(7)
    expect(proof.mapRevision).toBe(7)
  })

  it('后继内容版本改变但根版本未变时，原证明不再适用', () => {
    // 只看根 revision 无法保护整棵分支，后继版本必须参与适用性判断。
    const snapshot = createSnapshot()
    const baseline = requireBaseline(snapshot, createProof())
    const next = structuredClone(snapshot)
    const child = findNode(next, CHILD)
    child.revision++
    child.payload.content = '后继发生真实内容变化。'
    next.revision++
    expect(findNode(next, ROOT).revision).toBe(findNode(snapshot, ROOT).revision)
    expect(branchBaselineMatchesSnapshot(baseline, next, ROOT)).toBe(false)
  })

  it('邻接 reference 与结构边新增、删除和修改均使原证明失效', () => {
    // 外部入边同样影响当前分支；新增后继即使原成员未改也不能复用旧闭包。
    const snapshot = createSnapshot()
    const baseline = requireBaseline(snapshot, createProof())
    const removedReference = structuredClone(snapshot)
    removedReference.edges = removedReference.edges.filter((/* 原图关系。 */ edge) => /* 删去真实边界入边。 */ edge.id !== 'reference-in')
    const addedReference = structuredClone(snapshot)
    addedReference.edges.push(createEdge('reference-new', 'reference', OTHER, ROOT))
    const editedReference = structuredClone(snapshot)
    const reference = findEdge(editedReference, 'reference-in')
    reference.label = '新的关系说明'
    reference.revision++
    const removedSuccessor = structuredClone(snapshot)
    removedSuccessor.edges = removedSuccessor.edges.filter((/* 原图关系。 */ edge) => /* 删去闭包内结构边。 */ edge.id !== 'successor-a')
    const addedSuccessor = structuredClone(snapshot)
    addedSuccessor.edges.push(createEdge('successor-new', 'successor', CHILD, OTHER))
    const changedKind = structuredClone(snapshot)
    findEdge(changedKind, 'successor-a').kind = 'reference'
    for (const candidate of [removedReference, addedReference, editedReference, removedSuccessor, addedSuccessor, changedKind]) {
      candidate.revision++
      expect(branchBaselineMatchesSnapshot(baseline, candidate, ROOT)).toBe(false)
    }
  })

  it('从全图新增或删除跨入、跨出的 payload 引用会使原证明失效', () => {
    // 外部节点 DTO 不在闭包中，仍必须发现它指向当前成员的派生引用变化。
    const snapshot = createSnapshot()
    const baseline = requireBaseline(snapshot, createProof())
    const incomingAdded = structuredClone(snapshot)
    const other = findNode(incomingAdded, OTHER)
    other.payload.citations = [ROOT]
    other.payloadReferences = [{ path: '/citations/0', targetId: ROOT }]
    other.revision++
    const incomingRemoved = structuredClone(snapshot)
    const outside = findNode(incomingRemoved, OUTSIDE)
    outside.payload.citations = []
    outside.payloadReferences = []
    outside.revision++
    const outgoingAdded = structuredClone(snapshot)
    const rootAdded = findNode(outgoingAdded, ROOT)
    rootAdded.payload.sources = [OTHER, OUTSIDE]
    rootAdded.payloadReferences = [{ path: '/sources/0', targetId: OTHER }, { path: '/sources/1', targetId: OUTSIDE }]
    rootAdded.revision++
    const outgoingRemoved = structuredClone(snapshot)
    const rootRemoved = findNode(outgoingRemoved, ROOT)
    rootRemoved.payload.sources = []
    rootRemoved.payloadReferences = []
    rootRemoved.revision++
    for (const candidate of [incomingAdded, incomingRemoved, outgoingAdded, outgoingRemoved]) {
      candidate.revision++
      expect(branchBaselineMatchesSnapshot(baseline, candidate, ROOT)).toBe(false)
    }
  })

  it('外部正文与完全外部引用变化不会扩大 reference 闭包或阻止当前根编辑', () => {
    // 保留跨入当前根的原引用，只新增外部到外部的关系，当前分支事实仍相等。
    const snapshot = createSnapshot()
    const baseline = requireBaseline(snapshot, createProof())
    const next = structuredClone(snapshot)
    const outside = findNode(next, OUTSIDE)
    outside.payload.content = '外部资料正文与当前根无关。'
    outside.payload.citations = [ROOT, OTHER]
    outside.payloadReferences = [{ path: '/citations/0', targetId: ROOT }, { path: '/citations/1', targetId: OTHER }]
    outside.revision++
    next.revision++
    expect(branchBaselineMatchesSnapshot(baseline, next, ROOT)).toBe(true)
  })

  it('即使正文和节点身份相同，不同图、工作区或所选根也不能复用', () => {
    // 业务身份不能由相同内容推断，闭包中的后继也不能冒充原选择根。
    const snapshot = createSnapshot()
    const baseline = requireBaseline(snapshot, createProof())
    const anotherMap = structuredClone(snapshot)
    anotherMap.mapId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
    const anotherWorkspace = structuredClone(snapshot)
    anotherWorkspace.workspaceId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    expect(branchBaselineMatchesSnapshot(baseline, anotherMap, ROOT)).toBe(false)
    expect(branchBaselineMatchesSnapshot(baseline, anotherWorkspace, ROOT)).toBe(false)
    expect(branchBaselineMatchesSnapshot(baseline, snapshot, CHILD)).toBe(false)
  })

  it('配对和复用不会修改输入 DTO、数组顺序或原始服务端证明', () => {
    // 冻结真实接口输入，并交换新快照数组顺序，验证只读能力而不观察私有 JSON 字段。
    const snapshot = createSnapshot()
    const proof = createProof()
    const snapshotBefore = structuredClone(snapshot)
    const proofBefore = structuredClone(proof)
    freezeFixture(snapshot)
    freezeFixture(proof)
    const baseline = requireBaseline(snapshot, proof)
    const reordered = structuredClone(snapshot)
    reordered.nodes.reverse()
    reordered.edges.reverse()
    freezeFixture(reordered)
    expect(branchBaselineMatchesSnapshot(baseline, reordered, ROOT)).toBe(true)
    expect(snapshot).toEqual(snapshotBefore)
    expect(proof).toEqual(proofBefore)
    expect(baseline.branch.version).toBe(SERVER_VERSION)
    expect(baseline.branch.mapRevision).toBe(7)
  })
})
