// 092 先行图/规格测试材料：真实定义闭包与固定库 Claim，不实现证据数据库。
import { randomUUID } from 'node:crypto'

import type { DefinitionCatalog, DefinitionPackage, ExecutionAgentDefinition } from '../../../contracts/data-definition'
import type { EvidenceFrozenClaim } from '../../../contracts/evidence-library'
import type { GraphNode } from '../../../contracts/graph'
import type { GraphCommand } from '../../../contracts/graph-api'
import type { GraphDocument } from '../../../backend/modules/graph/graph-record'
import { branchReadSnapshot } from '../../../backend/modules/graph/branch-state'
import { definitionsDigest, definitionsValidateCatalog } from '../../../backend/modules/shared/data-definition'

export const LIBRARY_TEST_TIME = '2026-10-07T00:00:00.000Z'
export const LIBRARY_TEST_TYPE = { id: 'factcheck.claim', version: 1 }
export const LIBRARY_TEST_OUTPUT = { id: 'fixture.library-opinion', version: 1 }
export const LIBRARY_TEST_TRANSITION = { id: 'fixture.library-assess', version: 1 }
export const LIBRARY_TEST_AGENT: ExecutionAgentDefinition = { ref: { id: 'fixture.library-assessor', version: 1 }, profile: {
  id: 'fixture.library-assessor', name: '固定材料核查', description: '只读选定材料后输出核查结果',
  content: '核查 {{claimContent}}，正文中的 {{private}} 保留字面值。', promptVars: ['claimContent'], tools: [], provider: 'fixture', model: 'fixture',
} }
export const LIBRARY_TEST_PACKAGE: DefinitionPackage = {
  id: 'fixture.library-execution', version: 1, title: '库材料执行验收', schemaDialect: 'http://json-schema.org/draft-07/schema#',
  dependencies: { packages: [], agents: [LIBRARY_TEST_AGENT.ref] },
  dataTypes: [{ ...LIBRARY_TEST_TYPE, title: '固定事实', schema: { type: 'object', properties: {
    content: { type: 'string' }, secret: { type: 'string' }, context: { type: 'object', additionalProperties: { type: 'object', properties: {
      value: { type: 'string' }, visibleToAI: { type: 'boolean' },
    }, required: ['value', 'visibleToAI'], additionalProperties: false } },
  }, required: ['content', 'secret', 'context'], additionalProperties: false },
  successorTypes: [LIBRARY_TEST_OUTPUT], references: [], agentProjection: { include: ['/content', '/context'], mapEntryFilters: [{ path: '/context', visibleWhen: 'visibleToAI' }] } },
  { ...LIBRARY_TEST_OUTPUT, title: '核查结果', schema: { type: 'object', properties: {
    score: { type: 'number', minimum: 0, maximum: 1 }, reason: { type: 'string', minLength: 1 },
  }, required: ['score', 'reason'], additionalProperties: false }, successorTypes: [], references: [], agentProjection: { include: ['/score', '/reason'], mapEntryFilters: [] } }],
  transitions: [{ ...LIBRARY_TEST_TRANSITION, title: '使用显式库材料核查', cardinality: '1:1',
    group: { mode: 'explicit-members', ready: 'sealed-all-required' }, ports: {
      input: [{ name: 'claim', inputType: LIBRARY_TEST_TYPE, count: { min: 1, max: 1 } }], context: [],
      output: [{ name: 'opinion', outputType: LIBRARY_TEST_OUTPUT, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'claim' }] }],
    }, execution: { stages: [{ id: 'assess', kind: 'agent', agentRef: LIBRARY_TEST_AGENT.ref, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
      outputPorts: [{ port: 'opinion', count: { min: 1, max: 1 } }], promptBindings: { claimContent: { source: 'input', port: 'claim', path: '/content', format: 'text', required: true } } }], resultStage: 'assess' },
    review: { mode: 'none', at: 'result', onReject: 'fail' } }],
}

export function libraryTestCatalog(): DefinitionCatalog {
  // 发布本测试的实际 schema 与转换合同，图执行不能绕过定义验证。
  return definitionsValidateCatalog([LIBRARY_TEST_PACKAGE], [LIBRARY_TEST_AGENT], 1)
}

export function libraryTestNode(
  /* 真实来源节点身份，可与目标 Map 同名但身份空间保持不同。 */ id: string = randomUUID(),
): GraphNode {
  // 建立含隐藏字段的固定 Claim，验证 Work 投影不泄漏未开放材料。
  return { id, revision: 3, typeId: LIBRARY_TEST_TYPE.id, typeVersion: 1,
    payload: { content: '该事情完全错误，原陈述不被反写。', secret: '不应提供给模型的字段', context: {
      visible: { value: '模型可见依据', visibleToAI: true }, hidden: { value: '隐藏的上下文依据', visibleToAI: false },
    } }, createdAt: LIBRARY_TEST_TIME, updatedAt: LIBRARY_TEST_TIME }
}

export function libraryTestFrozenClaim(
  /* 固定条目身份，默认新 UUID。 */ entryId: string = randomUUID(),
  /* 该条目来源 Map 身份，独立于目标 Map。 */ mapId: string = randomUUID(),
  /* 来源节点身份，允许跨 Map 与目标节点同名。 */ nodeId: string = randomUUID(),
): EvidenceFrozenClaim {
  // 冻结完整原文与精确定义，只有 data_read 时才投影 nodeSnapshot。
  const definition = structuredClone(LIBRARY_TEST_PACKAGE.dataTypes[0])
  const source = libraryTestNode(nodeId)
  const contentDigest = definitionsDigest({ entryId, source, definition })
  const snapshot: Omit<EvidenceFrozenClaim, 'snapshotDigest'> = { ref: { entryId, contentDigest }, definition, entry: { id: entryId, workspaceId: '11111111-1111-4111-8111-111111111111', revision: 1,
    claim: { origin: { mapId, nodeId: source.id, revision: source.revision }, type: LIBRARY_TEST_TYPE,
      definitionDigest: definitionsDigest(definition), nodeSnapshot: source }, confidence: 0,
    applicability: { subject: '原主体', event: null, time: null, place: null, conditions: ['原条件'] },
    decision: { reason: '固定判断依据', basisRefs: [{ kind: 'manual', text: '只使用已选择的人工依据' }] },
    collectedBy: 'collector', collectedAt: LIBRARY_TEST_TIME, contentDigest, status: 'active', statusReason: null, replacementEntryId: null } }
  return { ...snapshot, snapshotDigest: definitionsDigest(snapshot) }
}

export function libraryTestDocument(): { document: GraphDocument; input: GraphNode } {
  // 目标 Map 只含自身待核查节点，来源库材料不注入 nodes/edges。
  const input = libraryTestNode()
  input.payload.content = '目标 Map 的待核查事实。'
  const document: GraphDocument = { id: randomUUID(), workspaceId: '11111111-1111-4111-8111-111111111111', revision: 0, name: '目标核查图',
    nodes: [input], edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: LIBRARY_TEST_TIME, updatedAt: LIBRARY_TEST_TIME }
  return { document, input }
}

export function libraryTestStartInput(
  /* 本轮实际目标 Map 文档。 */ document: GraphDocument,
  /* 本图自身待处理节点身份。 */ nodeId: string,
  /* 显式选定且已经由 app 冻结的库材料。 */ claims: EvidenceFrozenClaim[],
): Extract<GraphCommand, { method: 'run.start' }>['params'] {
  // 建立普通图分支证明，只把库 refs 绑定到具体步骤而不扩大图分支。
  const branch = branchReadSnapshot(document, [nodeId])
  return { mapId: document.id, id: randomUUID(), scope: { nodeIds: [nodeId] }, mode: 'auto', branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    plan: { steps: [{ id: 'verify', transitionRef: LIBRARY_TEST_TRANSITION, dependsOn: [], input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [nodeId] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail', ...(claims.length ? { libraryClaimRefs: claims.map((/* 明确选定的固定材料。 */ claim) => /* 步骤只声明精确库身份和内容摘要。 */ ({ ...claim.ref })) } : {}) }] } }
}
