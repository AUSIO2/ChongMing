// 只读审计复现：仅构造进程内数据，不访问数据库或写入受审实现。
const path = require('node:path')
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { createRequire } = require('node:module')
const root = path.resolve(__dirname, '../..')
const load = createRequire(path.join(root, 'package.json'))
const { inputReadObject } = load('./backend/modules/shared/input-validation.ts')
const { definitionsReadPackage, definitionsValidateCatalog, definitionsValidatePayload, definitionsFreezeExecution } = load('./backend/modules/shared/data-definition.ts')
const { DEFAULT_DEFINITION_PACKAGE, DEFAULT_WORKSPACE_SEED: seed } = load('./apps/config/default-prompts.ts')
const { runCreateRun } = load('./backend/modules/graph/run-state.ts')
const { branchReadSnapshot } = load('./backend/modules/graph/branch-state.ts')

const output = []
for (const key of ['', 'unexpected']) {
  try {
    const parsed = inputReadObject({ required: 'valid', [key]: 1 }, ['required'], 'audit')
    output.push({ case: 'unknown-object-key', key, accepted: true, keys: Object.keys(parsed) })
  } catch (error) { output.push({ case: 'unknown-object-key', key, accepted: false, code: error.code }) }
}
assert.equal(output[0].accepted, true)
assert.equal(output[1].accepted, false)

const labels = Object.fromEntries([['__proto__', '原型同名标签'], ['normal', '普通标签']])
const source = { id: 'audit.labels', version: 1, title: 'labels', schemaDialect: 'http://json-schema.org/draft-07/schema#',
  dataTypes: [{ id: 'audit.choice', version: 1, title: 'choice', schema: { type: 'object',
    properties: { choice: { type: 'string', enum: ['__proto__', 'normal'] } }, required: ['choice'], additionalProperties: false },
    references: [], successorTypes: [], presentation: { enumLabels: { '/choice': labels } }, agentProjection: { include: ['/choice'], mapEntryFilters: [] } }],
  transitions: [], dependencies: { packages: [], agents: [] } }
const labelCatalog = definitionsValidateCatalog([definitionsReadPackage(source)])
const parsedLabels = labelCatalog.dataTypes[0].presentation.enumLabels['/choice']
output.push({ case: 'enum-label-own-key', sourceOwnProto: Object.hasOwn(labels, '__proto__'),
  parsedOwnProto: Object.hasOwn(parsedLabels, '__proto__'), parsedKeys: Object.keys(parsedLabels) })
assert.equal(Object.hasOwn(parsedLabels, '__proto__'), false)
for (const field of ['fieldLabels', 'enumLabels']) {
  const changed = structuredClone(source)
  changed.dataTypes[0].presentation = { [field]: Object.fromEntries([['__proto__', field === 'fieldLabels' ? '配置标签' : { normal: '普通标签' }]]) }
  const parsed = definitionsReadPackage(changed).dataTypes[0].presentation[field]
  output.push({ case: 'presentation-map-own-key', field, accepted: true, inputOwnProto: true,
    parsedOwnProto: Object.hasOwn(parsed, '__proto__'), ordinaryPrototype: Object.getPrototypeOf(parsed) === Object.prototype })
  assert.equal(Object.hasOwn(parsed, '__proto__'), false)
}

const agents = [seed.parse, seed.split.router, ...seed.split.agents, seed.split.merger, seed.router, ...seed.agents, seed.merger]
  .map(profile => ({ ref: { id: profile.id, version: 0 }, profile }))
const pkg = JSON.parse(JSON.stringify(DEFAULT_DEFINITION_PACKAGE).replaceAll('"port":"source"', '"port":"constructor"'))
const transition = pkg.transitions.find(item => item.id === 'factcheck.parse-source')
transition.ports.input[0].name = 'constructor'
const catalog = definitionsValidateCatalog([pkg], agents)
try {
  definitionsFreezeExecution({ catalog, transitionRef: { id: transition.id, version: 1 }, agents, tools: seed.tools, inputs: {}, context: {} })
  assert.fail('Expected the existing inherited binding defect')
} catch (error) {
  output.push({ case: 'missing-constructor-binding', error: error.name, code: error.code ?? null, message: error.message })
  assert.equal(error.name, 'TypeError')
}
const now = '2026-10-20T00:00:00.000Z', id = randomUUID()
const payload = definitionsValidatePayload(catalog, { id: 'factcheck.source', version: 1 }, { locator: { kind: 'url', url: 'https://fixture.example/source' }, label: null })
const document = { id: randomUUID(), workspaceId: randomUUID(), revision: 0, name: 'audit', nodes: [{ id, revision: 0,
  typeId: 'factcheck.source', typeVersion: 1, payload, createdAt: now, updatedAt: now }], edges: [], runs: [], runHistory: [], leases: {}, receipts: [], createdAt: now, updatedAt: now }
const branch = branchReadSnapshot(document, [id])
try {
  runCreateRun(document, { mapId: document.id, id: randomUUID(), branch: { rootIds: [id], expectedVersion: branch.version },
    scope: { nodeIds: [id] }, mode: 'auto', plan: { steps: [{ id: 'one', transitionRef: { id: transition.id, version: 1 }, dependsOn: [],
      input: [{ port: 'constructor', source: { kind: 'scope', nodeIds: [id] } }], context: [], grouping: { mode: 'each' }, onEmpty: 'fail' }] } },
  { definitions: catalog, agents, tools: seed.tools, maxSlots: 4 }, now)
  assert.fail('Expected the existing inherited grouping defect')
} catch (error) {
  output.push({ case: 'valid-constructor-port-run', validPublishedCatalog: true, validSourcePayload: true,
    error: error.name, code: error.code ?? null, message: error.message })
  assert.equal(error.name, 'TypeError')
}
async function reproduceEvidenceFreeze() {
  const { evidenceCreateService } = load('./backend/modules/evidence-library/evidence-service.ts')
  const claimId = randomUUID(), mapId = randomUUID(), workspaceId = randomUUID()
  let payloadReads = 0, definitionClones = 0
  const claimPayload = { get content() { payloadReads++; return 'A fixed auditable claim' }, category: null }
  const claimNode = { id: claimId, revision: 0, typeId: 'factcheck.claim', typeVersion: 1, payload: claimPayload, createdAt: now, updatedAt: now }
  const map = { id: mapId, workspaceId, nodes: [claimNode], edges: [], deletedAt: null }
  const tables = new Map()
  const database = {
    records(name) {
      if (!tables.has(name)) tables.set(name, new Map())
      const table = tables.get(name)
      return {
        async get(id) { return table.has(id) ? table.get(id) : null },
        async first(filter) { for (const row of table.values()) if (Object.entries(filter).every(([key, value]) => row[key] === value)) return row; return null },
        async insert(row) { assert.equal(table.has(row._id), false); table.set(row._id, row) },
        async replace(row) { table.set(row._id, row) },
        async index() {},
      }
    },
    graph() { return { async read(id) { return id === mapId ? map : null } } },
    async now() { return Date.parse(now) },
  }
  const service = evidenceCreateService(database, { async requireRole() { return { id: workspaceId } }, async definitions() { return catalog } }, { async conflicts() { return [] } })
  const definition = catalog.dataTypes.find(type => type.id === 'factcheck.claim' && type.version === 1)
  const originalClone = global.structuredClone
  global.structuredClone = function (value, ...rest) {
    if (value === definition) definitionClones++
    return originalClone(value, ...rest)
  }
  try {
    const result = await service.dispatch({ actor: { userId: randomUUID(), displayName: 'audit', hostAdmin: false },
      mutation: true, session: { inTransaction() { return true } } }, {
      method: 'evidence.collect', requestId: randomUUID(), params: { workspaceId, claim: { mapId, nodeId: claimId, revision: 0 },
        confidence: 1, applicability: { subject: null, event: null, place: null, time: null, conditions: [] }, reason: 'audit', basisRefs: [] },
    })
    const observation = { case: 'evidence-freeze-duplicate-work', accepted: result.data.entry.id.length > 0, payloadReads, definitionClones }
    assert.equal(payloadReads, 2)
    assert.equal(definitionClones, 2)
    return observation
  } finally { global.structuredClone = originalClone }
}
async function reproduceFixtureOwnership() {
  const fs = require('node:fs'), ts = load('typescript')
  const filename = path.join(root, 'tests/backend/fixtures/graph-api.ts')
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createGraphApi')
  assert.ok(declaration)
  const body = ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  let opened = 0, closed = 0
  const fixture = new Function('rabbitCreateFixture', 'MongoMemoryReplSet', 'var exports = {};\n' + body + '\nreturn createGraphApi;')(
    async () => { opened++; return { queue: {}, async close() { closed++ } } },
    { async create() { throw new Error('controlled Mongo initialization failure') } },
  )
  let problem
  try { await fixture(1000, {}) } catch (error) { problem = error }
  assert.equal(problem.message, 'controlled Mongo initialization failure')
  assert.equal(opened, 1)
  assert.equal(closed, 0)
  return { case: 'test-fixture-startup-ownership', source: 'tests/backend/fixtures/graph-api.ts:createGraphApi (exact function body transpiled in memory)',
    controlledMongoFailure: true, acquiredBrokerCount: opened, cleanupCallsBeforeRejection: closed }
}
async function reproduceCleanupOrdering() {
  const fs = require('node:fs'), ts = load('typescript')
  function readFunction(file, name) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    assert.ok(declaration)
    return ts.transpileModule(declaration.getText(source), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  }
  const brokerBody = readFunction('tests/backend/fixtures/rabbitmq.ts', 'rabbitCreateBroker')
  const makeBroker = new Function('deps', 'var exports = {}; const {process,path,randomBytes,randomUUID,rabbitReadEngine,mkdtemp,tmpdir,rabbitExecute,rm,image}=deps;\n' + brokerBody + '\nreturn rabbitCreateBroker;')({
    process: { env: {} }, path, randomBytes: require('node:crypto').randomBytes, randomUUID,
    async rabbitReadEngine() {}, async mkdtemp() { return '/tmp/audit-inert-resource' }, tmpdir() { return '/tmp' },
    async rabbitExecute() { throw new Error('primary broker initialization failure') },
    async rm() { throw new Error('secondary temporary cleanup failure') }, image: 'inert-not-started',
  })
  let brokerError
  try { await makeBroker() } catch (error) { brokerError = error }
  assert.equal(brokerError.message, 'secondary temporary cleanup failure')

  const file = 'scripts/check-desktop-runtime.ts'
  const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true)
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'desktopCheckRuntime')
  const ownedTry = declaration.body.statements.find(node => ts.isTryStatement(node) && node.finallyBlock)
  assert.ok(ownedTry)
  const wrapper = `async function reproduce(){try{throw new Error('primary runtime assertion failure')}finally${ownedTry.finallyBlock.getText(source)}}`
  const body = ts.transpileModule(wrapper, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  let providerClosed = false
  const execute = new Function('gateway', 'service', 'provider', body + '; return reproduce;')(
    { async disconnect() {} }, { async close() { throw new Error('secondary service cleanup failure') } },
    { closeAllConnections() { providerClosed = true } },
  )
  let runtimeError
  try { await execute() } catch (error) { runtimeError = error }
  assert.equal(runtimeError.message, 'secondary service cleanup failure')
  assert.equal(providerClosed, false)
  return { case: 'verification-cleanup-error-ordering', exactSourceBodies: true, realProcessesStarted: 0,
    brokerObservedError: brokerError.message, runtimeObservedError: runtimeError.message, providerClosed }
}
async function main() {
  // 含全局计数器的复现按顺序运行，避免审计夹具之间干扰。
  output.push(await reproduceEvidenceFreeze())
  output.push(await reproduceFixtureOwnership())
  output.push(await reproduceCleanupOrdering())
  console.log(JSON.stringify(output, null, 2))
}
main().catch(error => { console.error(error); process.exitCode = 1 })
