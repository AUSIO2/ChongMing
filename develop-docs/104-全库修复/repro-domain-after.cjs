// 104 修复验收对照；保留103原工件不变：只使用进程内 GraphStore/records 替身；不打开用户数据库、不改受审源码。
// 在仓库根运行：node --import tsx develop-docs/104-全库修复/repro-domain-after.cjs
const fs = require('node:fs')
const path = require('node:path')
const { createRequire } = require('node:module')
const { randomUUID } = require('node:crypto')
const ts = require('typescript')
const root = path.resolve(__dirname, '../..')
const localRequire = createRequire(path.join(root, 'package.json'))
const { assetsCreateService } = localRequire('./backend/modules/assets/asset-service.ts')
const { definitionsValidateCatalog } = localRequire('./backend/modules/shared/data-definition.ts')
const { graphParseNodes } = localRequire('./backend/modules/shared/data-reference-index.ts')
const { graphInputReadPayload } = localRequire('./backend/modules/graph/graph-input.ts')
const { runReadData, runUpdatePause } = localRequire('./backend/modules/graph/run-state.ts')

// 在内存编译已有测试的纯fixture前缀，避免复制生产实现，也不注册或执行Vitest用例。
function readFixture(relative, describeName, exports) {
  const file = path.join(root, relative)
  const prefix = fs.readFileSync(file, 'utf8').split(`describe('${describeName}'`)[0]
    .replace(/import[^\n]*from 'vitest'\n/, '')
  const source = prefix + `\nexport { ${exports.join(', ')} }\n`
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const module = { exports: {} }
  new Function('require', 'module', 'exports', code)(createRequire(file), module, module.exports)
  return module.exports
}

function report(id, result) {
  console.log(JSON.stringify({ id, ...result }))
}

async function main() {
  const json = graphInputReadPayload(JSON.parse('{"__proto__":{"marker":"own value"}}'), 'audit')
  report('D04-json-key', { ownProtoField: Object.hasOwn(json, '__proto__'),
    ordinaryPrototype: Object.getPrototypeOf(json) === Object.prototype,
    inheritedMarker: json.marker, keys: Object.keys(json) })

  const locator = { type: 'object', properties: { assetId: { type: 'string' }, mediaType: { type: 'string' } },
    required: ['assetId', 'mediaType'], additionalProperties: false }
  const pkg = { id: 'audit.assets', version: 1, title: 'Assets', schemaDialect: 'http://json-schema.org/draft-07/schema#',
    dependencies: { packages: [], agents: [] }, transitions: [], dataTypes: [
      { id: 'audit.single', version: 1, title: 'Single', schema: { type: 'object', properties: { locator },
        required: ['locator'], additionalProperties: false }, references: [{ path: '/locator/assetId', target: { kind: 'asset' } }],
        successorTypes: [], agentProjection: { include: ['/locator'], mapEntryFilters: [] } },
      { id: 'audit.array', version: 1, title: 'Array', schema: { type: 'object', properties: { locators: { type: 'array', items: locator } },
        required: ['locators'], additionalProperties: false }, references: [{ path: '/locators/*/assetId', target: { kind: 'asset' } }],
        successorTypes: [], agentProjection: { include: ['/locators'], mapEntryFilters: [] } },
    ] }
  const catalog = definitionsValidateCatalog([pkg], [])
  const asset = { _id: 'asset', workspaceId: 'workspace', state: 'ready', mediaType: 'text/plain' }
  const assets = assetsCreateService({ blobs: {}, records: () => ({ get: async () => asset }) }, {}, {}, { readUrl: async () => '' })
  for (const [typeId, payload] of [
    ['audit.single', { locator: { assetId: 'asset', mediaType: 'application/pdf' } }],
    ['audit.array', { locators: [{ assetId: 'asset', mediaType: 'application/pdf' }] }],
  ]) {
    const parsed = graphParseNodes(catalog, [{ id: 'node', revision: 0, typeId, typeVersion: 1, payload,
      createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' }])
    try {
      await assets.assertInternalReferences('workspace', parsed)
      report('D03-media', { typeId, result: 'ACCEPTED' })
    } catch (error) { report('D03-media', { typeId, result: error.code }) }
  }

  let catalogCompilations = 0
  const deleted = { _id: 'asset', workspaceId: 'workspace', state: 'ready', sha256: 'a'.repeat(64) }
  const tables = { control_assets: { get: async () => deleted, replace: async () => {} },
    asset_receipts: { get: async () => null, insert: async () => {} },
    graphv3: { list: async () => ['one', 'two', 'three'].map(id => ({ _id: id, nodes: [] })) } }
  const deletion = assetsCreateService({ blobs: {}, records: name => tables[name] }, {}, {
    requireRole: async () => {}, definitions: async () => { catalogCompilations++; return definitionsValidateCatalog([], []) },
  }, { readUrl: async () => '' })
  await deletion.delete({ mutation: true, session: { inTransaction: () => true }, actor: { userId: 'owner' } },
    { requestId: 'request', method: 'asset.delete', params: { assetId: deleted._id, expectedSha256: deleted.sha256 } })
  report('D01-delete-catalog', { emptyGraphs: 3, catalogCompilations })

  const generic = readFixture('tests/backend/modules/graph/generic-run.spec.ts', 'generic data execution',
    ['fixture', 'packageDefinition', 'agent', 'branchProof', 'outputType', 'transitionRef', 'runCreateRun', 'runUpdateProposal', 'workReadItems'])
  const f = generic.fixture()
  generic.runCreateRun(f.document, { mapId: f.document.id, id: randomUUID(), branch: generic.branchProof(f.document, [f.input.id]),
    scope: { nodeIds: [f.input.id] }, mode: 'auto', plan: { steps: [{ id: 'summary-step', transitionRef: generic.transitionRef, dependsOn: [],
      input: [{ port: 'document', source: { kind: 'scope', nodeIds: [f.input.id] } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail' }] } },
  { definitions: definitionsValidateCatalog([generic.packageDefinition], [generic.agent]), agents: [generic.agent], tools: [], maxSlots: 4 },
  '2026-09-28T00:00:01.000Z')
  const type = f.document.runs[0].definitions.dataTypes.find(item => item.id === generic.outputType.id)
  const schema = type.schema, traces = []
  Object.defineProperty(type, 'schema', { enumerable: true, configurable: true, get() {
    traces.push(new Error().stack.split('\n').filter(line => /runValidateStageOutputs|runCreateOutputs/.test(line)).map(line => line.trim()))
    return schema
  } })
  const work = generic.workReadItems(f.document)[0]
  const published = generic.runUpdateProposal(f.document, { mapId: f.document.id, operationId: work.operationId, id: work.workId,
    specHash: work.specHash, kind: 'outputs', reason: 'Same attempt', outputs: [{ key: 'summary', port: 'summary',
      typeRef: generic.outputType, payload: { text: 'Short report' } }] }, work, '2026-09-28T00:00:02.000Z')
  report('D02-auto-parse', { published: published.nodeIds.length, outputSchemaReads: traces.length, traces })

  const projection = generic.fixture(), projectionPackage = structuredClone(generic.packageDefinition)
  projectionPackage.transitions = [projectionPackage.transitions[0]]
  const projectionType = projectionPackage.dataTypes.find(item => item.id === projection.input.typeId)
  projectionType.schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"object","properties":{"audit103":{"type":"string"}},"required":["audit103"],"additionalProperties":false}},"required":["__proto__"],"additionalProperties":false}')
  projectionType.agentProjection = { include: ['/__proto__/audit103'], mapEntryFilters: [] }
  projectionPackage.transitions[0].execution.stages[0].promptBindings.text.path = '/__proto__/audit103'
  projection.input.payload = JSON.parse('{"__proto__":{"audit103":"projected value"}}')
  try {
    generic.runCreateRun(projection.document, { mapId: projection.document.id, id: randomUUID(),
      branch: generic.branchProof(projection.document, [projection.input.id]), scope: { nodeIds: [projection.input.id] }, mode: 'auto',
      plan: { steps: [{ id: 'projection', transitionRef: generic.transitionRef, dependsOn: [],
        input: [{ port: 'document', source: { kind: 'scope', nodeIds: [projection.input.id] } }],
        context: [], grouping: { mode: 'each' }, onEmpty: 'fail' }] } },
    { definitions: definitionsValidateCatalog([projectionPackage], [generic.agent]), agents: [generic.agent], tools: [], maxSlots: 4 },
    '2026-09-28T00:00:01.000Z')
    const projectionWork = generic.workReadItems(projection.document)[0]
    const data = runReadData(projection.document, projectionWork.operationId, projectionWork)
    report('D04-projection-key', { projectedOwnKeys: Object.keys(data.inputs.document[0].node.payload),
      globalPrototypeMarker: Object.prototype.audit103, prompt: data.promptVariables.text })
  } finally { delete Object.prototype.audit103 }

  const explicit = generic.fixture(), explicitPackage = structuredClone(generic.packageDefinition)
  explicitPackage.transitions = [explicitPackage.transitions[0]]
  explicitPackage.transitions[0].ports.input[0].name = 'constructor'
  explicitPackage.transitions[0].ports.output[0].successorOf[0].port = 'constructor'
  explicitPackage.transitions[0].execution.stages[0].promptBindings.text.port = 'constructor'
  try {
    generic.runCreateRun(explicit.document, { mapId: explicit.document.id, id: randomUUID(),
      branch: generic.branchProof(explicit.document, [explicit.input.id]), scope: { nodeIds: [explicit.input.id] }, mode: 'auto',
      plan: { steps: [{ id: 'explicit', transitionRef: generic.transitionRef, dependsOn: [],
        input: [{ port: 'constructor', source: { kind: 'scope', nodeIds: [explicit.input.id] } }], context: [],
        grouping: { mode: 'explicit', groups: [{ id: 'empty', members: {} }] }, onEmpty: 'skip' }] } },
    { definitions: definitionsValidateCatalog([explicitPackage], [generic.agent]), agents: [generic.agent], tools: [], maxSlots: 4 },
    '2026-09-28T00:00:01.000Z')
    report('D04-explicit-members', { outcome: explicit.document.runs[0].status })
  } catch (error) { report('D04-explicit-members', { error: error.name, code: error.code ?? null, message: error.message }) }

  const source = readFixture('tests/backend/modules/graph/source-read-concurrency.spec.ts', 'source-text input freezing',
    ['sourceAgents', 'sourceStore', 'graphCreateService', 'runCreateRun', 'branchReadSnapshot', 'workReadItems', 'DEFAULT_DEFINITION_PACKAGE'])
  const now = '2026-09-28T00:00:00.000Z'
  const nodes = [0, 1].map(index => ({ id: randomUUID(), revision: 0, typeId: 'factcheck.source', typeVersion: 1,
    payload: { locator: { kind: 'url', url: 'https://example.com/source-' + index }, label: 'source ' + index }, createdAt: now, updatedAt: now }))
  const document = { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'Read authorization', nodes, edges: [], runs: [],
    runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
  const agents = source.sourceAgents(), definitions = definitionsValidateCatalog([source.DEFAULT_DEFINITION_PACKAGE], agents)
  const branch = source.branchReadSnapshot(document, nodes.map(node => node.id))
  source.runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: { rootIds: branch.scope.rootIds, expectedVersion: branch.version },
    scope: { nodeIds: nodes.map(node => node.id) }, mode: 'auto', plan: { steps: [{ id: 'parse', transitionRef: { id: 'factcheck.parse-source', version: 1 },
      dependsOn: [], input: [{ port: 'source', source: { kind: 'scope', nodeIds: nodes.map(node => node.id) } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail' }] } },
  { definitions, agents, tools: [], maxSlots: 4 }, now)
  const run = document.runs[0]
  document.ownershipRevision = 1
  document.branchOwnerships = { [run.id]: { leaseId: run.id, kind: 'run', rootIds: branch.scope.rootIds,
    ownerUserId: randomUUID(), holderId: randomUUID(), fence: 1, expiresAt: null, leaseMs: null, runId: run.id } }
  document.ownershipReceipts = []
  const works = source.workReadItems(document), grant = { ...works[0], hostId: 'host', holderId: randomUUID(), fence: 1,
    leaseMs: 60_000, expiresAt: '2999-01-01T00:00:00.000Z' }
  document.leases[grant.workId] = grant
  const memory = source.sourceStore(document), fetched = []
  const service = source.graphCreateService(memory.store, { readSource: async (workspaceId, node) => {
    fetched.push(node.id)
    return 'another operation source body'
  } })
  try {
    await service.readData(document.id, works[1].operationId, { workId: grant.workId, holderId: grant.holderId, fence: grant.fence })
    report('D06-read-operation', { result: 'UNEXPECTED_SUCCESS' })
  } catch (error) {
    const current = memory.current(), target = current.runs[0].operations.find(operation => operation.id === works[1].operationId)
    report('D06-read-operation', { error: error.code, readSourceCalls: fetched.length, fetchedOtherNode: fetched.includes(nodes[1].id),
      otherOperationCacheKeys: Object.keys(target.externalInputs).length,
      sourceReceipts: current.receipts.filter(receipt => receipt.method === 'source.read').length })
  }
  const rootIds = run.branchState.scope.rootIds
  let branchRootReads = 0
  Object.defineProperty(run.branchState.scope, 'rootIds', { enumerable: true, configurable: true,
    get() { branchRootReads++; return rootIds } })
  runUpdatePause(document, run.id, true, '2026-09-28T00:00:03.000Z')
  report('D10-pause-branch', { operations: run.operations.length, branchRootReads })
}

main().catch(error => { console.error(error); process.exitCode = 1 })
