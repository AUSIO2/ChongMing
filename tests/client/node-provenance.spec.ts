// C12先行：只按保存来源和产物映射解释节点身份，不猜运行或重算发布。
import { describe, expect, it } from 'vitest'

import type { GraphNode } from '../../contracts/graph'
import type { GraphOperation, GraphRun } from '../../contracts/graph-run'
import { runCreateRun } from '../../backend/modules/graph/run-state'
import { libraryTestCatalog, libraryTestDocument, libraryTestStartInput, LIBRARY_TEST_AGENT, LIBRARY_TEST_OUTPUT, LIBRARY_TEST_TIME } from '../backend/fixtures/library-claims'
import { nodeReadOrigin, provenanceMatchOperation, provenanceReadNode, type OperationOriginTarget } from '../../apps/ui/features/graph/node-origin'

enum ProvenanceTestMessage { RUN_MISSING = 'Expected provenance fixture Run', OPERATION_MISSING = 'Expected provenance fixture Operation' }

function provenanceFixture(): { run: GraphRun; operation: GraphOperation; node: GraphNode } {
  // 复用真实冻结规格，只固定前端要核对的已完成候选及产物身份。
  const { document, input } = libraryTestDocument()
  runCreateRun(document, libraryTestStartInput(document, input.id, []), {
    definitions: libraryTestCatalog(), agents: [LIBRARY_TEST_AGENT], tools: [], maxSlots: 4, libraryClaimSets: [],
  }, LIBRARY_TEST_TIME)
  const run = document.runs[0]
  if (!run) throw new Error(ProvenanceTestMessage.RUN_MISSING)
  const operation = run.operations[0]
  if (!operation) throw new Error(ProvenanceTestMessage.OPERATION_MISSING)
  operation.status = 'completed'
  operation.stages[0].results = [{ mode: 'outputs', workId: 'work-a', stageId: 'assess', slotId: 'slot-a',
    acceptedAt: LIBRARY_TEST_TIME, reason: '保存的生成说明', outputs: [{ key: 'a', port: 'opinion', typeRef: { ...LIBRARY_TEST_OUTPUT },
      payload: { score: 0, reason: '保存正文' }, nodeId: 'node-a' }] }]
  operation.outputRefs = [{ id: 'node-a', revision: 0, workId: 'work-a', key: 'a', port: 'opinion' }]
  const node: GraphNode = { id: 'node-a', revision: 0, typeId: LIBRARY_TEST_OUTPUT.id, typeVersion: LIBRARY_TEST_OUTPUT.version,
    payload: { score: 0, reason: '保存正文' }, createdAt: LIBRARY_TEST_TIME, updatedAt: LIBRARY_TEST_TIME,
    producer: { operationId: operation.id, transitionRef: { ...operation.transitionRef }, stageId: 'assess', workId: 'work-a',
      agentRef: { ...LIBRARY_TEST_AGENT.ref }, agentName: '生成时保存的名称' } }
  return { run, operation, node }
}

function producerTarget(
  /* 保存来源的当前节点，不借用后续选中的节点。 */ node: GraphNode,
): Extract<OperationOriginTarget, { kind: 'producer' }> {
  // 固定一个导航目标，纯匹配测试不依赖来源卡投影实现。
  if (!node.producer) throw new Error(ProvenanceTestMessage.OPERATION_MISSING)
  return { kind: 'producer', operationId: node.producer.operationId, node: {
    id: node.id, revision: node.revision, typeId: node.typeId, typeVersion: node.typeVersion, producer: structuredClone(node.producer),
  } }
}

function reuseTarget(
  /* 原运行中已经完成的直接来源处理项。 */ operation: GraphOperation,
): Extract<OperationOriginTarget, { kind: 'reuse' }> {
  // 只固定直接来源ID和本次保存的复制映射，不递归查更早运行。
  return { kind: 'reuse', operationId: operation.id, source: { id: 'reused-operation', transitionRef: { ...operation.transitionRef },
    specHash: operation.specHash, outputRefs: structuredClone(operation.outputRefs) } }
}

describe('C12 saved node provenance and exact Operation matching', () => {
  // 来源卡与来源运行共用保存记录，缺失信息不会变成人工或同名猜测。
  it('retains the established import generated manual unknown classification priority', () => {
    // 导入、生成与人工元数据允许并存，既有分类顺序继续保持。
    const { node } = provenanceFixture()
    node.manualOrigin = { userId: 'creator' }
    node.importedFrom = { bundleId: 'bundle-a', nodeId: 'original-node', revision: 0 }
    expect(nodeReadOrigin(node)).toBe('导入')
    delete node.importedFrom
    expect(nodeReadOrigin(node)).toBe('自动生成')
    delete node.producer
    expect(nodeReadOrigin(node)).toBe('人工创建')
    delete node.manualOrigin
    expect(nodeReadOrigin(node)).toBe('来源未知')
  })

  it('shows saved manual identity and creation time without a local Operation target', () => {
    // 用户ID保留原值，不冒充当前成员姓名，也不把编辑时间当创建时间。
    const { node } = provenanceFixture()
    delete node.producer
    node.manualOrigin = { userId: 'original-user' }
    node.updatedAt = '2026-10-20T00:00:00.000Z'
    const result = provenanceReadNode(node)
    expect(result).toMatchObject({ label: '人工创建', target: null })
    expect(result.rows).toEqual(expect.arrayContaining([{ label: '创建用户', value: 'original-user' }, { label: '创建时间', value: LIBRARY_TEST_TIME }]))
  })

  it('explains unknown legacy origin without inventing a creator or source target', () => {
    // 历史节点缺省来源明确显示未知，不把无producer解释成人工。
    const { node } = provenanceFixture()
    delete node.producer
    expect(provenanceReadNode(node)).toMatchObject({ label: '来源未知', target: null,
      rows: [{ label: '来源说明', value: '未保存创建来源信息' }] })
  })

  it('retains saved agent names and version zero and detaches the navigation target', () => {
    // 生成名称和版本来自producer，后续节点变化不重写已发出的来源意图。
    const { node } = provenanceFixture()
    if (!node.producer) throw new Error(ProvenanceTestMessage.OPERATION_MISSING)
    node.producer.agentRef.version = 0
    node.producer.transitionRef.version = 0
    const result = provenanceReadNode(node)
    expect(result.label).toBe('自动生成')
    expect(result.rows).toEqual(expect.arrayContaining([
      { label: '智能体', value: `生成时保存的名称 · ${LIBRARY_TEST_AGENT.ref.id} · v0` },
      { label: '转换', value: `${node.producer.transitionRef.id} · v0` },
      { label: '阶段', value: 'assess' }, { label: '工作项', value: 'work-a' },
    ]))
    expect(result.target).toEqual(producerTarget(node))
    node.producer.agentName = '后来改变的名称'
    node.revision = 4
    expect(result.target).toMatchObject({ kind: 'producer', node: { revision: 0, producer: { agentName: '生成时保存的名称' } } })
  })

  it('gives imported metadata priority and exposes preserved package records without a local jump', () => {
    // 包内记录可能已被重映射，仅展示保留字段，不把它们当本地图运行身份。
    const { node } = provenanceFixture()
    node.manualOrigin = { userId: 'package-user' }
    node.importedFrom = { bundleId: 'bundle-a', nodeId: 'original-node', revision: 0 }
    const result = provenanceReadNode(node)
    expect(result).toMatchObject({ label: '导入', target: null })
    expect(result.rows).toEqual(expect.arrayContaining([
      { label: '数据包', value: 'bundle-a' }, { label: '原节点', value: 'original-node' }, { label: '原版本', value: '0' },
    ]))
    expect(result.packageRows).toEqual(expect.arrayContaining([
      { label: '智能体', value: `生成时保存的名称 · ${LIBRARY_TEST_AGENT.ref.id} · v1` }, { label: '创建用户', value: 'package-user' },
    ]))
  })

  it('does not synthesize a package record and keeps generated origin after content editing', () => {
    // 导入没有旧元数据就不造保留记录；编辑生成正文也不会改变创建来源。
    const { node } = provenanceFixture()
    node.payload.reason = '人工编辑后的正文'
    node.revision += 1
    expect(provenanceReadNode(node)).toMatchObject({ label: '自动生成', target: { kind: 'producer', node: { revision: 1 } } })
    delete node.producer
    node.importedFrom = { bundleId: 'bundle-a', nodeId: 'original-node', revision: 2 }
    expect(provenanceReadNode(node).packageRows).toBeUndefined()
  })

  it('matches a saved published candidate while retaining a different current node revision', () => {
    // 来源产出版本0仍可定位；当前版本变化只用于页面并列说明。
    const { run, operation, node } = provenanceFixture()
    node.revision = 3
    expect(provenanceMatchOperation(run, producerTarget(node))).toEqual({ ok: true, operation, outputRevision: 0 })
  })

  it('rejects mismatched producer identity conversion output mapping and candidate metadata', () => {
    // 每次只破坏一项保存对应关系，不接受同名Operation或另一候选。
    const changes: Array<(/* 本次独立来源夹具。 */ f: ReturnType<typeof provenanceFixture>) => void> = [
      (/* 来源夹具。 */ f) => { /* 替换Operation身份。 */ f.operation.id = 'other-operation' },
      (/* 来源夹具。 */ f) => { /* 替换转换版本。 */ f.operation.transitionRef.version += 1 },
      (/* 来源夹具。 */ f) => { /* 替换产物节点。 */ f.operation.outputRefs[0].id = 'other-node' },
      (/* 来源夹具。 */ f) => { /* 替换产物Work映射。 */ f.operation.outputRefs[0].workId = 'other-work' },
      (/* 来源夹具。 */ f) => { /* 替换产物候选键。 */ f.operation.outputRefs[0].key = 'other-key' },
      (/* 来源夹具。 */ f) => { /* 替换产物端口。 */ f.operation.outputRefs[0].port = 'other-port' },
      (/* 来源夹具。 */ f) => { /* 替换保存结果阶段。 */ f.operation.stages[0].results[0].stageId = 'other-stage' },
      (/* 来源夹具。 */ f) => { /* 替换当前精确类型版本。 */ f.node.typeVersion += 1 },
      (/* 来源夹具。 */ f) => { /* 删除所有接纳候选。 */ f.operation.stages[0].results = [] },
      (/* 来源夹具。 */ f) => { /* 制造重复候选身份。 */ f.operation.stages[0].results.push(structuredClone(f.operation.stages[0].results[0])) },
      (/* 来源夹具。 */ f) => { /* 制造同名Operation歧义。 */ f.run.operations.push(structuredClone(f.operation)) },
    ]
    for (const change of changes) {
      const f = provenanceFixture()
      const target = producerTarget(f.node)
      change(f)
      if (f.node.typeVersion !== target.node.typeVersion) target.node.typeVersion = f.node.typeVersion
      expect(provenanceMatchOperation(f.run, target)).toEqual({ ok: false })
    }
  })

  it('rejects an unrelated target operation even when the supplied node producer belongs to the run', () => {
    // 目标Operation与producer必须同时对应，不从其它身份猜测跳转。
    const { run, node } = provenanceFixture()
    const target = producerTarget(node)
    target.operationId = 'other-operation'
    expect(provenanceMatchOperation(run, target)).toEqual({ ok: false })
  })

  it('matches only the direct completed reuse source and compares saved mappings without page order', () => {
    // 直接来源本身可复用更早结果，本次匹配不追更早ID或重算候选选择。
    const { run, operation } = provenanceFixture()
    operation.reusedFromOperationId = 'even-earlier-operation'
    operation.outputRefs.push({ id: 'node-b', revision: 2, workId: 'work-b', key: 'b', port: 'opinion' })
    const target = reuseTarget(operation)
    target.source.outputRefs.reverse()
    expect(provenanceMatchOperation(run, target)).toEqual({ ok: true, operation })
  })

  it('rejects reuse sources with wrong status frozen spec conversion or saved product mapping', () => {
    // 对照的是保存产物映射，不把可执行性判断或发布集合计算搬到前端。
    const changes: Array<(/* 本次独立来源夹具。 */ f: ReturnType<typeof provenanceFixture>) => void> = [
      (/* 来源夹具。 */ f) => { /* 未完成不构成复用来源。 */ f.operation.status = 'waiting' },
      (/* 来源夹具。 */ f) => { /* 冻结摘要不一致。 */ f.operation.specHash = 'other-spec' },
      (/* 来源夹具。 */ f) => { /* 转换不一致。 */ f.operation.transitionRef.id = 'other-transition' },
      (/* 来源夹具。 */ f) => { /* 复制产物版本不一致。 */ f.operation.outputRefs[0].revision += 1 },
      (/* 来源夹具。 */ f) => { /* 复制产物缺失。 */ f.operation.outputRefs = [] },
    ]
    for (const change of changes) {
      const f = provenanceFixture()
      const target = reuseTarget(f.operation)
      change(f)
      expect(provenanceMatchOperation(f.run, target)).toEqual({ ok: false })
    }
  })

  it('leaves the saved Run node and target untouched after reading provenance', () => {
    // 两个纯投影都不修改保存对象，也不把生成来源改成人工。
    const { run, node } = provenanceFixture()
    const target = producerTarget(node)
    const before = structuredClone({ run, node, target })
    provenanceReadNode(node)
    provenanceMatchOperation(run, target)
    expect({ run, node, target }).toEqual(before)
  })
})
