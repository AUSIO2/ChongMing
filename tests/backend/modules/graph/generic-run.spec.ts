import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { DefinitionPackage, ExecutionAgentDefinition } from '../../../../contracts/data-definition'
import type { GraphNode } from '../../../../contracts/graph'
import { definitionsReadPackage, definitionsValidateCatalog } from '../../../../backend/modules/shared/data-definition'
import type { GraphDocument } from '../../../../backend/modules/graph/graph-record'
import { runCreateRun, runReadData, runUpdateProposal, type GraphRunStartContext } from '../../../../backend/modules/graph/run-state'
import { workReadItems } from '../../../../backend/modules/graph/work-state'
import { branchReadSnapshot } from '../../../../backend/modules/graph/branch-state'

const inputType = { id: 'demo.text', version: 1 }
const outputType = { id: 'demo.summary', version: 1 }
const transitionRef = { id: 'demo.summarize', version: 1 }
const selectionTransitionRef = { id: 'demo.select-summary', version: 1 }
const agentRef = { id: 'demo.agent', version: 1 }
const agent: ExecutionAgentDefinition = { ref: agentRef, profile: {
  id: agentRef.id, name: 'Summarizer', description: 'Summarizes text', content: 'Summarize {{text}}',
  tools: [], provider: 'fixture', model: 'fixture', promptVars: ['text'],
} }
const packageDefinition: DefinitionPackage = {
  id: 'demo', version: 1, title: 'Demo', schemaDialect: 'http://json-schema.org/draft-07/schema#',
  dependencies: { packages: [], agents: [agentRef] },
  dataTypes: [
    { ...inputType, title: 'Text', schema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
      successorTypes: [outputType], references: [], agentProjection: { include: ['/text'], mapEntryFilters: [] } },
    { ...outputType, title: 'Summary', schema: { type: 'object', properties: {
      text: { type: 'string', minLength: 1 }, nextId: { type: 'string', format: 'uuid' },
    }, required: ['text'], additionalProperties: false }, successorTypes: [],
    references: [{ path: '/nextId', target: { kind: 'node', types: [outputType] } }],
    agentProjection: { include: ['/text'], mapEntryFilters: [] } },
  ],
  transitions: [{
    ...transitionRef, title: 'Summarize', cardinality: '1:1', group: { mode: 'explicit-members', ready: 'sealed-all-required' },
    ports: {
      input: [{ name: 'document', inputType, count: { min: 1, max: 1 } }], context: [],
      output: [{ name: 'summary', outputType, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'document' }] }],
    },
    execution: { stages: [{ id: 'summarize', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
      outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
      promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } }], resultStage: 'summarize' },
    review: { mode: 'none', at: 'result', onReject: 'fail' },
  }, {
    ...selectionTransitionRef, title: 'Select summary', cardinality: '1:1', group: { mode: 'explicit-members', ready: 'sealed-all-required' },
    ports: {
      input: [{ name: 'document', inputType, count: { min: 1, max: 1 } }], context: [],
      output: [{ name: 'summary', outputType, count: { min: 1, max: 1 }, successorOf: [{ source: 'input', port: 'document' }] }],
    },
    execution: { stages: [
      { id: 'draft-a', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
        outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
        promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } },
      { id: 'draft-b', kind: 'agent', agentRef, dependsOn: [], ready: 'all-dependencies', resultMode: 'outputs',
        outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
        promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } },
      { id: 'select', kind: 'agent', agentRef, dependsOn: ['draft-a', 'draft-b'], ready: 'all-dependencies', resultMode: 'selection',
        outputPorts: [{ port: 'summary', count: { min: 1, max: 1 } }],
        promptBindings: { text: { source: 'input', port: 'document', path: '/text', format: 'text', required: true } } },
    ], resultStage: 'select' },
    review: { mode: 'none', at: 'result', onReject: 'fail' },
    publication: { includeReferencedCandidates: true, candidateStages: ['draft-a', 'draft-b'] },
  }],
}

function fixture(): { document: GraphDocument; input: GraphNode } {
  const now = '2026-09-28T00:00:00.000Z'
  const input: GraphNode = { id: randomUUID(), revision: 0, typeId: inputType.id, typeVersion: inputType.version,
    payload: { text: 'A long report' }, createdAt: now, updatedAt: now }
  return { input, document: { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Demo', nodes: [input], edges: [],
    runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now } }
}

function branchProof(document: GraphDocument, rootIds: string[]) {
  const branch = branchReadSnapshot(document, rootIds)
  return { rootIds: branch.scope.rootIds, expectedVersion: branch.version }
}

describe('generic data execution', () => {
  it('rejects a missing or invalid run slot budget at the domain boundary', () => {
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    for (const maxSlots of [undefined, 0, 1.5, 33]) {
      const { document, input } = fixture()
      const context = { definitions: catalog, agents: [agent], tools: [], maxSlots } as unknown as GraphRunStartContext
      expect(() => runCreateRun(document, { mapId: document.id, id: randomUUID(), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
        id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
        context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
      }] } }, context, '2026-09-28T00:00:01.000Z')).toThrow()
      expect(document.runs).toEqual([])
    }
  })

  it('freezes a registered transition, derives its stage Work and publishes a typed successor', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent], 3)
    const now = '2026-09-28T00:00:01.000Z'
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, now)
    const work = workReadItems(document)
    expect(work).toHaveLength(1)
    expect(work[0]).toMatchObject({ stageId: 'summarize', slotId: 'summarize', specHash: document.runs[0].operations[0].specHash })
    const data = runReadData(document, work[0].operationId, work[0])
    expect(data.promptVariables).toEqual({ text: 'A long report' })
    expect(data.inputs.document).toMatchObject([{ node: { typeId: 'demo.text', payload: { text: 'A long report' } } }])
    const detached = structuredClone(document)
    expect(() => runUpdateProposal(detached, { mapId: detached.id, operationId: work[0].operationId, id: work[0].workId,
      specHash: work[0].specHash, kind: 'outputs', reason: 'Detached', outputs: [{ key: 'summary', port: 'summary', typeRef: outputType,
        payload: { text: 'Detached report' }, sourceKeys: [] }] }, work[0], '2026-09-28T00:00:01.500Z')).toThrow(/stage contract/i)
    const update = runUpdateProposal(document, { mapId: document.id, operationId: work[0].operationId, id: work[0].workId,
      specHash: work[0].specHash, kind: 'outputs', reason: 'Condensed', outputs: [{ key: 'summary', port: 'summary', typeRef: outputType,
        payload: { text: 'Short report' } }] }, work[0], '2026-09-28T00:00:02.000Z')
    expect(update.nodeIds).toHaveLength(1)
    expect(document.nodes.at(-1)).toMatchObject({ typeId: 'demo.summary', typeVersion: 1, payload: { text: 'Short report' } })
    expect(document.edges).toContainEqual(expect.objectContaining({ kind: 'successor', from: input.id, to: update.nodeIds[0] }))
    expect(document.runs[0]).toMatchObject({ status: 'completed', operations: [{ status: 'completed' }] })
    const firstOperationId = document.runs[0].operations[0].id
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:03.000Z')
    expect(workReadItems(document)).toEqual([])
    expect(document.runs[0]).toMatchObject({ status: 'completed', operations: [{ reusedFromOperationId: firstOperationId }] })
  })

  it('rejects payloads outside the frozen output schema before changing graph state', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'summary-step', transitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:01.000Z')
    const work = workReadItems(document)[0], before = structuredClone(document)
    expect(() => runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId,
      specHash: work.specHash, kind: 'outputs', reason: 'Invalid', outputs: [{ key: 'summary', port: 'summary', typeRef: outputType,
        payload: { unexpected: true } }] }, work, '2026-09-28T00:00:02.000Z')).toThrow(/Payload/)
    expect(document).toEqual(before)
  })

  it('runs independent Agent stages concurrently and only publishes the final selection', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'select-step', transitionRef: selectionTransitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:01.000Z')
    const drafts = workReadItems(document)
    expect(new Set(drafts.map(work => work.stageId))).toEqual(new Set(['draft-a', 'draft-b']))
    drafts.forEach((work, index) => runUpdateProposal(document, { mapId: document.id, operationId: work.operationId, id: work.workId,
      specHash: work.specHash, kind: 'outputs', reason: 'Draft', outputs: [{ key: `draft-${index}`, port: 'summary', typeRef: outputType,
        payload: { text: `Draft ${index}` } }] }, work, `2026-09-28T00:00:0${index + 2}.000Z`))
    const select = workReadItems(document)
    expect(select).toMatchObject([{ stageId: 'select', slotId: 'select' }])
    const candidates = runReadData(document, select[0].operationId, select[0]).priorStageResults
    const chosen = candidates.find(result => result.mode === 'outputs')!
    if (chosen.mode !== 'outputs') throw new Error('expected outputs')
    runUpdateProposal(document, { mapId: document.id, operationId: select[0].operationId, id: select[0].workId,
      specHash: select[0].specHash, kind: 'selection', reason: 'Best draft', selection: [{ workId: chosen.workId, key: chosen.outputs[0].key }] },
    select[0], '2026-09-28T00:00:05.000Z')
    expect(document.nodes.filter(node => node.typeId === outputType.id)).toHaveLength(1)
    expect(document.runs[0]?.status).toBe('completed')
  })

  it('rejects a cycle in the candidate dependency closure before formal publication', () => {
    const { document, input } = fixture()
    const catalog = definitionsValidateCatalog([packageDefinition], [agent])
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [input.id]), scope: { nodeIds: [input.id] }, mode: 'auto', plan: { steps: [{
      id: 'select-step', transitionRef: selectionTransitionRef, dependsOn: [], input: [{ port: 'document', source: { kind: 'scope', nodeIds: [input.id] } }],
      context: [], grouping: { mode: 'each' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents: [agent], tools: [], maxSlots: 4 }, '2026-09-28T00:00:01.000Z')
    const drafts = workReadItems(document)
    for (const [index, work] of drafts.entries()) runUpdateProposal(document, { mapId: document.id, operationId: work.operationId,
      id: work.workId, specHash: work.specHash, kind: 'outputs', reason: 'Draft', outputs: [{ key: `draft-${index}`, port: 'summary', typeRef: outputType,
        payload: index === 0 ? { text: 'Cycle', nextId: { candidate: { workId: work.workId, key: 'draft-0' } } } : { text: 'Other' } }] },
    work, `2026-09-28T00:00:0${index + 2}.000Z`)
    const select = workReadItems(document)[0]
    const cyclic = document.runs[0].operations[0].stages.find(stage => stage.stageId === 'draft-a')!.results[0]
    if (cyclic.mode !== 'outputs') throw new Error('expected outputs')
    const copy = structuredClone(document)
    expect(() => runUpdateProposal(copy, { mapId: copy.id, operationId: select.operationId, id: select.workId,
      specHash: select.specHash, kind: 'selection', reason: 'Choose cyclic draft', selection: [{ workId: cyclic.workId, key: cyclic.outputs[0].key }] },
    select, '2026-09-28T00:00:05.000Z')).toThrow(/cycle/i)
  })

  it('runs the default fact-check plan and atomically publishes opinions referenced by its verification', () => {
    const defaults = definitionsReadPackage(JSON.parse(readFileSync(new URL('../../../../resources/data-definitions/fact-checking.json', import.meta.url), 'utf8')))
    const variables: Record<string, string[]> = {
      'parse-extract': ['rawContent'], 'split-router': ['availableAgents', 'context', 'content'],
      'split-data': ['hint', 'context', 'content'], 'split-quote': ['hint', 'context', 'content'], 'split-causal': ['hint', 'context', 'content'],
      'split-merger': ['content', 'subResults'], 'verify-router': ['availableAgents', 'context', 'claimContent', 'originalContent'],
      sources: ['hint', 'context', 'claimContent', 'originalContent'], logic: ['hint', 'context', 'claimContent', 'originalContent'],
      numbers: ['hint', 'context', 'claimContent', 'originalContent'], 'verify-merger': ['claimContent', 'originalContent', 'opinions'],
    }
    const agents: ExecutionAgentDefinition[] = defaults.dependencies.agents.map(ref => ({ ref, profile: {
      id: ref.id, name: ref.id, description: ref.id, content: 'fixture', tools: [], provider: 'fixture', model: 'fixture', promptVars: variables[ref.id],
    } }))
    const catalog = definitionsValidateCatalog([defaults], agents)
    const now = '2026-09-28T00:00:00.000Z', claimId = randomUUID(), newsId = randomUUID()
    const claim: GraphNode = { id: claimId, revision: 0, typeId: 'factcheck.claim', typeVersion: 1,
      payload: { content: 'The claim', category: 'data' }, createdAt: now, updatedAt: now }
    const news: GraphNode = { id: newsId, revision: 0, typeId: 'factcheck.news', typeVersion: 1,
      payload: { content: 'Original report', context: { public: { value: 'visible', visibleToAI: true }, secret: { value: 'hidden', visibleToAI: false } } },
      createdAt: now, updatedAt: now }
    const document: GraphDocument = { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Fact check', nodes: [claim, news], edges: [],
      runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
    runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: branchProof(document, [claimId, newsId]), scope: { nodeIds: [claimId, newsId] }, mode: 'auto', plan: { steps: [{
      id: 'verify', transitionRef: { id: 'factcheck.verify-claim', version: 1 }, dependsOn: [],
      input: [{ port: 'claim', source: { kind: 'scope', nodeIds: [claimId] } }], context: [{ port: 'news', source: { kind: 'scope', nodeIds: [newsId] } }],
      grouping: { mode: 'all' }, onEmpty: 'fail',
    }] } }, { definitions: catalog, agents, tools: [], maxSlots: 5 }, now)
    const route = workReadItems(document)[0]
    const constrained = structuredClone(document)
    constrained.runs[0].maxAgentSlots = 1
    expect(() => runUpdateProposal(constrained, { mapId: constrained.id, operationId: route.operationId, id: route.workId,
      specHash: route.specHash, kind: 'plan', reason: 'Too many checks', slots: [
        { id: 'one', stageId: 'assess', agentRef: { id: 'sources', version: 0 }, angle: 'one', hint: '', priority: 'high', tools: [] },
        { id: 'two', stageId: 'assess', agentRef: { id: 'logic', version: 0 }, angle: 'two', hint: '', priority: 'medium', tools: [] },
      ] }, route, '2026-09-28T00:00:00.500Z')).toThrow(/plan slot/i)
    runUpdateProposal(document, { mapId: document.id, operationId: route.operationId, id: route.workId, specHash: route.specHash, kind: 'plan', reason: 'Two checks', slots: [
      { id: 'source-slot', stageId: 'assess', agentRef: { id: 'sources', version: 0 }, angle: 'sources', hint: 'Check sources', priority: 'high', tools: [] },
      { id: 'logic-slot', stageId: 'assess', agentRef: { id: 'logic', version: 0 }, angle: 'logic', hint: 'Check logic', priority: 'medium', tools: [] },
    ] }, route, '2026-09-28T00:00:01.000Z')
    const assess = workReadItems(document)
    expect(assess.map(work => work.slotId)).toEqual(['source-slot', 'logic-slot'])
    const assessed = runReadData(document, assess[0].operationId, assess[0])
    expect(assessed.promptVariables).toMatchObject({ hint: expect.stringContaining('Check sources') })
    expect(assessed.context.news[0].node.payload).toEqual({ content: 'Original report', context: { public: { value: 'visible', visibleToAI: true } } })
    for (const [index, work] of assess.entries()) runUpdateProposal(document, { mapId: document.id, operationId: work.operationId,
      id: work.workId, specHash: work.specHash, kind: 'outputs', reason: 'Opinion', outputs: [{ key: `opinion-${index}`, port: 'opinions',
        typeRef: { id: 'factcheck.opinion', version: 1 }, payload: { score: index ? 0.5 : 1, reason: `Reason ${index}`, evidenceIds: [] } }] },
    work, `2026-09-28T00:00:0${index + 2}.000Z`)
    const merge = workReadItems(document)[0]
    const prior = runReadData(document, merge.operationId, merge).priorStageResults.filter(result => result.mode === 'outputs')
    const opinionRefs = prior.flatMap(result => result.mode === 'outputs' ? result.outputs.map(output => ({ candidate: { workId: result.workId, key: output.key } })) : [])
    const referencedOpinions = [opinionRefs[0]]
    expect(() => runUpdateProposal(document, { mapId: document.id, operationId: merge.operationId, id: merge.workId, specHash: merge.specHash,
      kind: 'outputs', reason: 'Invalid reference location', outputs: [{ key: 'verification', port: 'verification',
        typeRef: { id: 'factcheck.verification', version: 1 }, payload: { score: 0.5, reason: opinionRefs[0], opinionIds: referencedOpinions } }] },
    merge, '2026-09-28T00:00:05.000Z')).toThrow(/stage contract/)
    runUpdateProposal(document, { mapId: document.id, operationId: merge.operationId, id: merge.workId, specHash: merge.specHash,
      kind: 'outputs', reason: 'Merged', outputs: [{ key: 'verification', port: 'verification', typeRef: { id: 'factcheck.verification', version: 1 },
        payload: { score: 0.5, reason: 'Merged result', opinionIds: referencedOpinions } }] }, merge, '2026-09-28T00:00:05.000Z')
    const opinions = document.nodes.filter(node => node.typeId === 'factcheck.opinion')
    const verification = document.nodes.find(node => node.typeId === 'factcheck.verification')!
    expect(opinions).toHaveLength(1)
    expect(verification.payload.opinionIds).toEqual(opinions.map(node => node.id))
    expect(document.edges.filter(edge => edge.to === verification.id).map(edge => edge.from)).toEqual(opinions.map(node => node.id))
    expect(document.runs[0]?.status).toBe('completed')
  })
})
